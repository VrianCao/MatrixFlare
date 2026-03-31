function stableString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePolicyOverrides(env) {
  const raw = stableString(env?.ABUSE_GUARD_POLICY_JSON);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildRetryHeaders(retryAfterMs) {
  const retrySeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return {
    'retry-after': String(retrySeconds),
  };
}

export function createMatrixRateLimitResponse(retryAfterMs, message = 'Rate limit exceeded') {
  return new Response(
    JSON.stringify({
      errcode: 'M_LIMIT_EXCEEDED',
      error: message,
      retry_after_ms: retryAfterMs,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...buildRetryHeaders(retryAfterMs),
      },
    },
  );
}

export function ensureGatewayAbuseGuardStore(env) {
  if (!env.__MATRIX_GATEWAY_ABUSE_GUARD__) {
    env.__MATRIX_GATEWAY_ABUSE_GUARD__ = new Map();
  }
  return env.__MATRIX_GATEWAY_ABUSE_GUARD__;
}

const DEFAULT_POLICIES = Object.freeze({
  gateway_public_entry: Object.freeze({ limit: 120, window_ms: 60_000 }),
  gateway_register: Object.freeze({ limit: 24, window_ms: 60_000 }),
  gateway_login: Object.freeze({ limit: 60, window_ms: 60_000 }),
  gateway_refresh: Object.freeze({ limit: 120, window_ms: 60_000 }),
  gateway_media: Object.freeze({ limit: 180, window_ms: 60_000 }),
  gateway_search: Object.freeze({ limit: 60, window_ms: 60_000 }),
  gateway_room_write: Object.freeze({ limit: 240, window_ms: 60_000 }),
  userdo_register: Object.freeze({ limit: 4, window_ms: 60_000 }),
  userdo_login: Object.freeze({ limit: 8, window_ms: 60_000 }),
  userdo_refresh: Object.freeze({ limit: 20, window_ms: 60_000 }),
  userdo_media: Object.freeze({ limit: 8, window_ms: 60_000 }),
  roomdo_send: Object.freeze({ limit: 120, window_ms: 10_000 }),
  roomdo_membership: Object.freeze({ limit: 48, window_ms: 30_000 }),
});

export function resolveAbusePolicy(env, policyId) {
  const base = DEFAULT_POLICIES[policyId];
  if (!base) {
    throw new RangeError(`Unknown abuse policy: ${policyId}`);
  }
  const override = parsePolicyOverrides(env)[policyId];
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return base;
  }
  const limit = Number.isInteger(override.limit) && override.limit >= 1 ? override.limit : base.limit;
  const windowMs = Number.isInteger(override.window_ms) && override.window_ms >= 1 ? override.window_ms : base.window_ms;
  return {
    limit,
    window_ms: windowMs,
  };
}

function resolveClientAddress(request) {
  const direct = stableString(request.headers.get('cf-connecting-ip'))
    || stableString(request.headers.get('x-forwarded-for')).split(',')[0]?.trim()
    || stableString(request.headers.get('x-real-ip'));
  return direct || 'unknown';
}

export function classifyGatewayRequest(method, pathname) {
  if (
    pathname === '/.well-known/matrix/client'
    || pathname === '/.well-known/matrix/server'
    || pathname === '/_matrix/client/versions'
    || pathname === '/_matrix/client/v3/register/available'
    || pathname === '/_matrix/client/v1/register/m.login.registration_token/validity'
  ) {
    return {
      route_family: 'public-entry',
      gateway_policy_id: method === 'GET' ? 'gateway_public_entry' : null,
    };
  }
  if (pathname === '/_matrix/client/v3/register') {
    return {
      route_family: 'register',
      gateway_policy_id: method === 'POST' ? 'gateway_register' : null,
    };
  }
  if (pathname === '/_matrix/client/v3/login') {
    return {
      route_family: method === 'GET' ? 'public-entry' : 'login',
      gateway_policy_id: method === 'POST' ? 'gateway_login' : 'gateway_public_entry',
    };
  }
  if (pathname === '/_matrix/client/v3/refresh') {
    return {
      route_family: 'refresh',
      gateway_policy_id: 'gateway_refresh',
    };
  }
  if (pathname === '/_matrix/client/v3/search'
    || pathname === '/_matrix/client/v3/user_directory/search'
    || pathname === '/_matrix/client/v3/publicRooms'
    || /^\/_matrix\/client\/v3\/rooms\/[^/]+\/hierarchy$/.test(pathname)) {
    return {
      route_family: 'search',
      gateway_policy_id: 'gateway_search',
    };
  }
  if (
    pathname === '/_matrix/client/v1/media/config'
    || /^\/_matrix\/client\/v1\/media\/(?:download|thumbnail)\//.test(pathname)
    || /^\/_matrix\/media\/[^/]+\/(?:config|create|upload|download|thumbnail)/.test(pathname)
  ) {
    return {
      route_family: 'media',
      gateway_policy_id: 'gateway_media',
    };
  }
  if (
    pathname === '/_matrix/client/v3/createRoom'
    || /^\/_matrix\/client\/v3\/join\/[^/]+$/.test(pathname)
    || /^\/_matrix\/client\/v3\/knock\/[^/]+$/.test(pathname)
    || /^\/_matrix\/client\/v3\/rooms\/[^/]+\/(?:send|state|redact|join|leave|invite|ban|unban|kick|typing|receipt)/.test(pathname)
    || /^\/_matrix\/client\/v3\/rooms\/[^/]+\/forget$/.test(pathname)
  ) {
    return {
      route_family: 'room-write',
      gateway_policy_id: 'gateway_room_write',
    };
  }
  if (pathname === '/_matrix/client/v3/sync') {
    return {
      route_family: 'sync',
      gateway_policy_id: null,
    };
  }
  if (pathname.startsWith('/_matrix/client/')) {
    return {
      route_family: 'client-route',
      gateway_policy_id: null,
    };
  }
  if (pathname.startsWith('/_matrix/')) {
    return {
      route_family: 'matrix-route',
      gateway_policy_id: null,
    };
  }
  return {
    route_family: 'public-edge',
    gateway_policy_id: null,
  };
}

export function enforceGatewayAbuseGuard(request, env, classification = classifyGatewayRequest(request.method, new URL(request.url).pathname)) {
  if (!classification?.gateway_policy_id) {
    return null;
  }
  const policy = resolveAbusePolicy(env, classification.gateway_policy_id);
  const clientAddress = resolveClientAddress(request);
  const nowMs = Date.now();
  const bucketKey = `${classification.gateway_policy_id}|ip:${clientAddress}`;
  const store = ensureGatewayAbuseGuardStore(env);
  const existing = store.get(bucketKey) ?? [];
  const windowStart = nowMs - policy.window_ms;
  const recentHits = existing.filter((timestamp) => timestamp > windowStart);
  if (recentHits.length >= policy.limit) {
    const retryAfterMs = Math.max(1, policy.window_ms - (nowMs - recentHits[0]));
    return createMatrixRateLimitResponse(retryAfterMs, `Rate limit exceeded for ${classification.route_family}`);
  }
  recentHits.push(nowMs);
  store.set(bucketKey, recentHits);
  return null;
}

export function ensureSemanticQuotaStore(host) {
  if (!host.__MATRIX_SEMANTIC_QUOTAS__) {
    host.__MATRIX_SEMANTIC_QUOTAS__ = new Map();
  }
  return host.__MATRIX_SEMANTIC_QUOTAS__;
}

export function enforceSemanticQuota(host, env, {
  policy_id,
  key,
  now_iso = new Date().toISOString(),
  message = 'Rate limit exceeded',
}) {
  const policy = resolveAbusePolicy(env, policy_id);
  const store = ensureSemanticQuotaStore(host);
  const nowMs = Date.parse(now_iso);
  const windowStart = nowMs - policy.window_ms;
  const bucketKey = `${policy_id}|${key}`;
  const existing = store.get(bucketKey) ?? [];
  const recentHits = existing.filter((timestamp) => timestamp > windowStart);
  if (recentHits.length >= policy.limit) {
    const retryAfterMs = Math.max(1, policy.window_ms - (nowMs - recentHits[0]));
    return {
      ok: false,
      retry_after_ms: retryAfterMs,
      response: createMatrixRateLimitResponse(retryAfterMs, message),
    };
  }
  recentHits.push(nowMs);
  store.set(bucketKey, recentHits);
  return {
    ok: true,
  };
}
