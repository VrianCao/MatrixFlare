function stableString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS = Object.freeze({
  gateway_public_entry: Object.freeze({
    binding_name: 'GATEWAY_PUBLIC_ENTRY_RATE_LIMITER',
    default_namespace_id: '84081001',
    limit: 120,
    period_seconds: 60,
  }),
  gateway_register: Object.freeze({
    binding_name: 'GATEWAY_REGISTER_RATE_LIMITER',
    default_namespace_id: '84081002',
    limit: 24,
    period_seconds: 60,
  }),
  gateway_login: Object.freeze({
    binding_name: 'GATEWAY_LOGIN_RATE_LIMITER',
    default_namespace_id: '84081003',
    limit: 60,
    period_seconds: 60,
  }),
  gateway_refresh: Object.freeze({
    binding_name: 'GATEWAY_REFRESH_RATE_LIMITER',
    default_namespace_id: '84081004',
    limit: 120,
    period_seconds: 60,
  }),
  gateway_media: Object.freeze({
    binding_name: 'GATEWAY_MEDIA_RATE_LIMITER',
    default_namespace_id: '84081005',
    limit: 180,
    period_seconds: 60,
  }),
  gateway_search: Object.freeze({
    binding_name: 'GATEWAY_SEARCH_RATE_LIMITER',
    default_namespace_id: '84081006',
    limit: 60,
    period_seconds: 60,
  }),
  gateway_room_write: Object.freeze({
    binding_name: 'GATEWAY_ROOM_WRITE_RATE_LIMITER',
    default_namespace_id: '84081007',
    limit: 240,
    period_seconds: 60,
  }),
});

const STRICT_GATEWAY_RATE_LIMIT_ENVIRONMENTS = Object.freeze(new Set([
  'ci-integration',
  'staging',
  'pre-release',
]));
const LOCAL_GATEWAY_RATE_LIMIT_ENVIRONMENTS = Object.freeze(new Set([
  'local',
  'environment_name-placeholder',
]));

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
  ...Object.fromEntries(
    Object.entries(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS).map(([policyId, definition]) => [
      policyId,
      Object.freeze({
        limit: definition.limit,
        window_ms: definition.period_seconds * 1000,
      }),
    ]),
  ),
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

function requiresStrictGatewayRateLimitBinding(env) {
  const environmentName = stableString(env?.ENVIRONMENT_NAME);
  if (STRICT_GATEWAY_RATE_LIMIT_ENVIRONMENTS.has(environmentName)) {
    return true;
  }
  if (environmentName.length === 0 || LOCAL_GATEWAY_RATE_LIMIT_ENVIRONMENTS.has(environmentName)) {
    return false;
  }
  return true;
}

export function classifyGatewayRequest(method, pathname) {
  if (
    pathname === '/.well-known/matrix/client'
    || pathname === '/.well-known/matrix/server'
    || pathname === '/_matrix/client/versions'
    || /^\/_matrix\/client\/(?:r0|v1|v3)\/register\/available$/.test(pathname)
    || pathname === '/_matrix/client/v1/register/m.login.registration_token/validity'
  ) {
    return {
      route_family: 'public-entry',
      gateway_policy_id: method === 'GET' ? 'gateway_public_entry' : null,
    };
  }
  if (/^\/_matrix\/client\/(?:r0|v1|v3)\/register$/.test(pathname)) {
    return {
      route_family: method === 'GET' ? 'public-entry' : 'register',
      gateway_policy_id: method === 'POST' ? 'gateway_register' : method === 'GET' ? 'gateway_public_entry' : null,
    };
  }
  if (/^\/_matrix\/client\/(?:r0|v1|v3)\/login$/.test(pathname)) {
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
  const bindingDefinition = GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS[classification.gateway_policy_id] ?? null;
  if (bindingDefinition != null) {
    const binding = env?.[bindingDefinition.binding_name];
    if (binding != null && typeof binding.limit === 'function') {
      return Promise.resolve(binding.limit({
        key: resolveClientAddress(request),
      })).then((result) => {
        if (result == null || typeof result.success !== 'boolean') {
          throw new TypeError(`${bindingDefinition.binding_name}.limit() must resolve to an object with boolean success`);
        }
        if (result.success) {
          return null;
        }
        const policy = resolveAbusePolicy(env, classification.gateway_policy_id);
        return createMatrixRateLimitResponse(policy.window_ms, `Rate limit exceeded for ${classification.route_family}`);
      });
    }
    if (requiresStrictGatewayRateLimitBinding(env)) {
      return Promise.reject(new Error(`Missing required Workers rate-limit binding ${bindingDefinition.binding_name} for ${stableString(env?.ENVIRONMENT_NAME) || 'unknown environment'}`));
    }
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
  return Promise.resolve(null);
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
