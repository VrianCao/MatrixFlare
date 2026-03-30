import { createMatrixUnrecognizedErrorBody } from '../../../packages/contracts/src/index.mjs';
import {
  RemoteServerDO,
  RoomDO,
  UserDO,
  createRequestFingerprint,
  createRequestContext,
  getWellKnownCacheEntry,
  loadWorkerRuntimeConfig,
  putWellKnownCacheEntry,
} from '../../../packages/runtime-core/src/index.mjs';
import {
  DEFAULT_UIA_CHALLENGE_TTL_MS,
  buildLocalUserId,
  extractLoginLocalpart,
  getAccessTokenUserIdHint,
  getRefreshTokenUserIdHint,
  hashOpaqueToken,
  issueUiaChallengeToken,
  normalizeLocalUserIdentifier,
  verifyUiaChallengeToken,
} from '../../../packages/runtime-core/src/user-identity.mjs';

const STUB_ROUTE_MATCHERS = Object.freeze([
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/register\/(?:email|msisdn)\/requestToken$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/account\/password\/(?:email|msisdn)\/requestToken$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/joined_rooms$/ },
  { methods: ['GET', 'PUT', 'DELETE'], pattern: /^\/_matrix\/client\/v3\/directory\/room\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/rooms\/[^/]+\/aliases$/ },
  { methods: ['GET', 'PUT'], pattern: /^\/_matrix\/client\/v3\/directory\/list\/room\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v1\/room_summary\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/notifications$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/pushers$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/pushers\/set$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/rooms\/[^/]+\/upgrade$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/rooms\/[^/]+\/report$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/rooms\/[^/]+\/report\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/users\/[^/]+\/report$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v1\/media\/preview_url$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/media\/v3\/preview_url$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/login\/sso\/redirect$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/login\/sso\/redirect\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v1\/login\/get_token$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/account\/3pid$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/account\/3pid$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/account\/3pid\/(?:add|bind|delete|email\/requestToken|msisdn\/requestToken|unbind)$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/thirdparty\/protocols$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/thirdparty\/protocol\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/thirdparty\/location(?:\/[^/]+)?$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/thirdparty\/user(?:\/[^/]+)?$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/admin\/whois\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/_matrix\/client\/v3\/user\/[^/]+\/openid\/request_token$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/voip\/turnServer$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/events(?:\/[^/]+)?$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/initialSync$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v3\/rooms\/[^/]+\/initialSync$/ },
  { methods: ['GET'], pattern: /^\/_matrix\/client\/v1\/auth_metadata$/ },
]);

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function matrixErrorResponse(status, errcode, error, extra = null, headers = {}) {
  return jsonResponse(
    {
      errcode,
      error,
      ...(extra ?? {}),
    },
    status,
    headers,
  );
}

function stubRouteResponse() {
  return jsonResponse(createMatrixUnrecognizedErrorBody(), 404);
}

function isStubbedClientRoute(method, pathname) {
  return STUB_ROUTE_MATCHERS.some((matcher) => matcher.methods.includes(method) && matcher.pattern.test(pathname));
}

async function readJsonObject(request) {
  const bodyText = await request.text();
  if (bodyText.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('request body must be a JSON object');
    }
    return parsed;
  } catch {
    return matrixErrorResponse(400, 'M_BAD_JSON', 'Request body must be a JSON object');
  }
}

function getBearerToken(request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function getUserDoStub(env, userId) {
  const namespace = env.USER_DO;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new TypeError('env.USER_DO must expose a Durable Object namespace');
  }
  return namespace.get(namespace.idFromName(userId));
}

function getOptionalUiaLocalpart(auth, serverName) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return null;
  }
  try {
    if (typeof auth.user === 'string' && auth.user.trim().length > 0) {
      return normalizeLocalUserIdentifier(auth.user, serverName);
    }
    if (
      auth.identifier
      && typeof auth.identifier === 'object'
      && !Array.isArray(auth.identifier)
      && auth.identifier.type === 'm.id.user'
      && typeof auth.identifier.user === 'string'
    ) {
      return normalizeLocalUserIdentifier(auth.identifier.user, serverName);
    }
  } catch {
    return null;
  }
  return null;
}

function buildRequestFingerprint(routeTemplate, principalId, body) {
  return createRequestFingerprint({
    method: 'POST',
    routeTemplate,
    principalId,
    body,
  });
}

function getUiaSecretValue(env) {
  return env.UIA_ROOT_KEY_RING;
}

function isRegistrationEnabled(env) {
  return String(env.MATRIX_REGISTRATION_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

function getRegistrationTokenSet(env) {
  const raw = env.MATRIX_REGISTRATION_TOKENS;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return new Set();
  }
  return new Set(raw.split(',').map((token) => token.trim()).filter(Boolean));
}

async function requireAccessSession(request, env) {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return {
      ok: false,
      response: matrixErrorResponse(401, 'M_MISSING_TOKEN', 'Missing access token'),
    };
  }

  let hintedUserId;
  try {
    hintedUserId = getAccessTokenUserIdHint(accessToken);
  } catch {
    return {
      ok: false,
      response: matrixErrorResponse(401, 'M_UNKNOWN_TOKEN', 'Unknown or unsupported token'),
    };
  }

  const userDo = getUserDoStub(env, hintedUserId);
  const result = await userDo.resolveSession({
    access_token_hash: hashOpaqueToken(accessToken),
    presented_at: new Date().toISOString(),
  });
  if (!result?.ok) {
    return {
      ok: false,
      response: matrixErrorResponse(401, 'M_UNKNOWN_TOKEN', 'Unknown or unsupported token'),
    };
  }
  return {
    ok: true,
    access_token: accessToken,
    user_do: userDo,
    session: result.session,
  };
}

function buildCapabilitiesResponse() {
  return {
    capabilities: {
      'm.change_password': { enabled: true },
      'm.3pid_changes': { enabled: false },
      'm.get_login_token': { enabled: false },
      'm.profile_fields': {
        enabled: false,
        allowed: [],
      },
      'm.set_avatar_url': { enabled: false },
      'm.set_displayname': { enabled: false },
    },
  };
}

function buildUiaChallengeResponse(env, routeFamily, method, authSubjectHint = null) {
  const { token } = issueUiaChallengeToken({
    secretValue: getUiaSecretValue(env),
    routeFamily,
    method,
    authSubjectHint,
    ttlMs: DEFAULT_UIA_CHALLENGE_TTL_MS,
  });
  return jsonResponse({
    flows: [
      {
        stages: [routeFamily === 'register' ? 'm.login.dummy' : 'm.login.password'],
      },
    ],
    params: {},
    completed: [],
    session: token,
  }, 401);
}

function verifyRouteBoundUia(env, sessionToken, routeFamily, method) {
  const verification = verifyUiaChallengeToken({
    token: sessionToken,
    secretValue: getUiaSecretValue(env),
    expectedRouteFamily: routeFamily,
    expectedMethod: method,
  });
  if (verification.valid) {
    return verification.payload;
  }

  // Accept legacy signed UIA tokens during the rollout window where older
  // deployments still issued them from the session key ring.
  if (typeof sessionToken === 'string' && sessionToken.split('.').length === 4) {
    const legacySecretValue = env.SESSION_ROOT_KEY_RING;
    if (typeof legacySecretValue === 'string' && legacySecretValue.length > 0) {
      const legacyVerification = verifyUiaChallengeToken({
        token: sessionToken,
        secretValue: legacySecretValue,
        expectedRouteFamily: routeFamily,
        expectedMethod: method,
      });
      if (legacyVerification.valid) {
        return legacyVerification.payload;
      }
    }
  }

  return null;
}

function resolvePasswordUiaContext({
  env,
  auth,
  accessSession,
  hintedLocalpart,
}) {
  if (!auth || auth.type !== 'm.login.password' || typeof auth.session !== 'string') {
    return { ok: false, reason: 'challenge' };
  }

  const payload = verifyRouteBoundUia(env, auth.session, auth.route_family, 'POST');
  if (!payload) {
    return { ok: false, reason: 'challenge' };
  }

  let localpart;
  try {
    localpart = accessSession
      ? normalizeLocalUserIdentifier(accessSession.user_id, env.MATRIX_SERVER_NAME)
      : hintedLocalpart;
  } catch {
    return { ok: false, reason: 'challenge' };
  }

  if (!localpart) {
    return { ok: false, reason: 'challenge' };
  }

  const expectedUserId = buildLocalUserId(localpart, env.MATRIX_SERVER_NAME);
  if (payload.auth_subject_hint && payload.auth_subject_hint !== expectedUserId) {
    return {
      ok: false,
      response: matrixErrorResponse(403, 'M_FORBIDDEN', 'UIA session subject binding mismatch'),
    };
  }
  if (accessSession && accessSession.user_id !== expectedUserId) {
    return {
      ok: false,
      response: matrixErrorResponse(403, 'M_FORBIDDEN', 'UIA subject does not match the access token subject'),
    };
  }

  return {
    ok: true,
    localpart,
    user_id: expectedUserId,
    user_do: getUserDoStub(env, expectedUserId),
    payload,
  };
}

async function handleWellKnownClient(url, env) {
  const host = url.host;
  const cache = env.MATRIX_EDGE_CACHE ?? null;
  if (cache) {
    const cached = await getWellKnownCacheEntry(cache, {
      kind: 'client',
      host,
    });
    if (cached?.response_json) {
      return jsonResponse(cached.response_json, 200, {
        'cache-control': 'public, max-age=3600',
      });
    }
  }

  const responseBody = {
    'm.homeserver': {
      base_url: env.MATRIX_PUBLIC_BASE_URL,
    },
  };
  if (cache) {
    await putWellKnownCacheEntry(cache, {
      kind: 'client',
      host,
      response_json: responseBody,
      cached_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }, {
      expirationTtl: 3600,
    });
  }
  return jsonResponse(responseBody, 200, {
    'cache-control': 'public, max-age=3600',
  });
}

function handleWellKnownServer(env) {
  return jsonResponse({
    'm.server': env.MATRIX_WELL_KNOWN_SERVER ?? env.MATRIX_SERVER_NAME,
  }, 200, {
    'cache-control': 'public, max-age=3600',
  });
}

async function handleRegisterAvailable(url, env) {
  if (!isRegistrationEnabled(env)) {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'Registration is currently disabled', null, {
      'cache-control': 'no-store',
    });
  }
  const username = url.searchParams.get('username');
  if (!username) {
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'username is required', null, {
      'cache-control': 'no-store',
    });
  }
  let localpart;
  try {
    localpart = normalizeLocalUserIdentifier(username, env.MATRIX_SERVER_NAME);
  } catch {
    return matrixErrorResponse(400, 'M_INVALID_USERNAME', 'The requested username is not valid', null, {
      'cache-control': 'no-store',
    });
  }
  const result = await getUserDoStub(env, buildLocalUserId(localpart, env.MATRIX_SERVER_NAME)).checkRegistrationAvailability({
    localpart,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status, {
      'cache-control': 'no-store',
    });
  }
  return jsonResponse({ available: result.available }, 200, {
    'cache-control': 'no-store',
  });
}

function handleRegistrationTokenValidity(url, env) {
  if (!isRegistrationEnabled(env)) {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'Registration is currently disabled');
  }
  const token = url.searchParams.get('token') ?? '';
  return jsonResponse({
    valid: getRegistrationTokenSet(env).has(token),
  });
}

async function handleRegister(request, env) {
  if (!isRegistrationEnabled(env)) {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'Registration is currently disabled');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const registrationTokens = getRegistrationTokenSet(env);
  if (registrationTokens.size > 0 && !registrationTokens.has(body.registration_token ?? '')) {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'Registration token is invalid');
  }

  const username = body.username;
  if (typeof username !== 'string' || username.trim().length === 0) {
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'username is required');
  }

  let localpart;
  try {
    localpart = normalizeLocalUserIdentifier(username, env.MATRIX_SERVER_NAME);
  } catch {
    return matrixErrorResponse(400, 'M_INVALID_USERNAME', 'The requested username is not valid');
  }
  const targetUserId = buildLocalUserId(localpart, env.MATRIX_SERVER_NAME);

  const auth = body.auth;
  if (!auth || auth.type !== 'm.login.dummy' || typeof auth.session !== 'string') {
    return buildUiaChallengeResponse(env, 'register', 'POST', targetUserId);
  }

  const uiaPayload = verifyRouteBoundUia(env, auth.session, 'register', 'POST');
  if (!uiaPayload) {
    return buildUiaChallengeResponse(env, 'register', 'POST', targetUserId);
  }
  if (uiaPayload.auth_subject_hint && uiaPayload.auth_subject_hint !== targetUserId) {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'UIA session subject binding mismatch');
  }

  const bodyForFingerprint = {
    username: localpart,
    password: body.password ?? null,
    device_id: body.device_id ?? null,
    initial_device_display_name: body.initial_device_display_name ?? null,
    registration_token: body.registration_token ?? null,
  };
  const requestFingerprint = buildRequestFingerprint('/_matrix/client/v3/register', null, bodyForFingerprint);
  const registerResult = await getUserDoStub(env, buildLocalUserId(localpart, env.MATRIX_SERVER_NAME)).register({
    localpart,
    password: body.password,
    device_id: body.device_id ?? null,
    initial_device_display_name: body.initial_device_display_name ?? null,
    request_fingerprint: requestFingerprint,
    uia_nonce: uiaPayload.nonce,
  });
  if (!registerResult.ok) {
    return jsonResponse(registerResult.matrix_error.body, registerResult.matrix_error.status);
  }
  return jsonResponse(registerResult.response);
}

async function handleLogin(request, env) {
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  if (body.type !== 'm.login.password') {
    return matrixErrorResponse(400, 'M_UNKNOWN', 'Unknown login type');
  }
  let localpart;
  try {
    localpart = extractLoginLocalpart(body, env.MATRIX_SERVER_NAME);
  } catch {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'Invalid username or password');
  }
  const result = await getUserDoStub(env, buildLocalUserId(localpart, env.MATRIX_SERVER_NAME)).login({
    localpart,
    password: body.password ?? '',
    device_id: body.device_id ?? null,
    initial_device_display_name: body.initial_device_display_name ?? null,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.response);
}

async function handleRefresh(request, env) {
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const refreshToken = body.refresh_token ?? null;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'refresh_token is required');
  }
  let hintedUserId;
  try {
    hintedUserId = getRefreshTokenUserIdHint(refreshToken);
  } catch {
    return matrixErrorResponse(401, 'M_UNKNOWN_TOKEN', 'Unknown or unsupported token');
  }
  const result = await getUserDoStub(env, hintedUserId).refreshSession({
    refresh_token: refreshToken,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.response);
}

async function handleLogout(request, env, { all = false } = {}) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const result = all
    ? await access.user_do.logoutAllSessions({ user_id: access.session.user_id })
    : await access.user_do.logoutSession({ session_id: access.session.session_id });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.response);
}

async function handleWhoAmI(request, env) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  return jsonResponse({
    user_id: access.session.user_id,
    device_id: access.session.device_id,
    is_guest: access.session.is_guest,
  });
}

async function handlePasswordChange(request, env) {
  const accessToken = getBearerToken(request);
  let accessSession = null;
  let accessFailureResponse = null;

  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  if (accessToken) {
    const access = await requireAccessSession(request, env);
    if (access.ok) {
      accessSession = access;
    } else {
      accessFailureResponse = access.response;
    }
  }
  const auth = body.auth && typeof body.auth === 'object' && !Array.isArray(body.auth)
    ? { ...body.auth, route_family: 'account/password' }
    : null;
  const hintedLocalpart = getOptionalUiaLocalpart(auth, env.MATRIX_SERVER_NAME);
  if (!accessSession && !hintedLocalpart) {
    if (accessFailureResponse) {
      return accessFailureResponse;
    }
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'user or identifier.user is required when no access token is supplied');
  }
  const authSubjectHint = accessSession?.session.user_id ?? buildLocalUserId(hintedLocalpart, env.MATRIX_SERVER_NAME);
  if (!auth || auth.type !== 'm.login.password' || typeof auth.session !== 'string') {
    return buildUiaChallengeResponse(env, 'account/password', 'POST', authSubjectHint);
  }

  const stage = resolvePasswordUiaContext({
    env,
    auth,
    accessSession: accessSession?.session ?? null,
    hintedLocalpart,
  });
  if (!stage.ok) {
    return stage.response ?? buildUiaChallengeResponse(env, 'account/password', 'POST', authSubjectHint);
  }

  const requestFingerprint = buildRequestFingerprint('/_matrix/client/v3/account/password', stage.user_id, {
    new_password: body.new_password ?? null,
    logout_devices: body.logout_devices === false ? false : true,
  });

  const replay = await stage.user_do.resolvePhase04PasswordChangeReplay({
    user_id: stage.user_id,
    request_fingerprint: requestFingerprint,
    uia_nonce: stage.payload.nonce,
  });
  if (!replay.ok) {
    return jsonResponse(replay.matrix_error.body, replay.matrix_error.status);
  }
  if (replay.handled) {
    return jsonResponse(replay.response);
  }

  const verification = await stage.user_do.verifyPasswordAuth({
    localpart: stage.localpart,
    password: auth.password ?? '',
  });
  if (!verification.ok) {
    return jsonResponse(verification.matrix_error.body, verification.matrix_error.status);
  }

  const result = await stage.user_do.changePassword({
    user_id: stage.user_id,
    current_session_id: accessSession?.session.session_id ?? null,
    new_password: body.new_password ?? null,
    logout_devices: body.logout_devices,
    request_fingerprint: requestFingerprint,
    uia_nonce: stage.payload.nonce,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.response);
}

async function handleDeactivateAccount(request, env) {
  const accessToken = getBearerToken(request);
  let accessSession = null;
  let accessFailureResponse = null;

  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  if (accessToken) {
    const access = await requireAccessSession(request, env);
    if (access.ok) {
      accessSession = access;
    } else {
      accessFailureResponse = access.response;
    }
  }
  const auth = body.auth && typeof body.auth === 'object' && !Array.isArray(body.auth)
    ? { ...body.auth, route_family: 'account/deactivate' }
    : null;
  const hintedLocalpart = getOptionalUiaLocalpart(auth, env.MATRIX_SERVER_NAME);
  if (!accessSession && !hintedLocalpart) {
    if (accessFailureResponse) {
      return accessFailureResponse;
    }
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'user or identifier.user is required when no access token is supplied');
  }
  const authSubjectHint = accessSession?.session.user_id ?? buildLocalUserId(hintedLocalpart, env.MATRIX_SERVER_NAME);
  if (!auth || auth.type !== 'm.login.password' || typeof auth.session !== 'string') {
    return buildUiaChallengeResponse(env, 'account/deactivate', 'POST', authSubjectHint);
  }

  const stage = resolvePasswordUiaContext({
    env,
    auth,
    accessSession: accessSession?.session ?? null,
    hintedLocalpart,
  });
  if (!stage.ok) {
    return stage.response ?? buildUiaChallengeResponse(env, 'account/deactivate', 'POST', authSubjectHint);
  }

  const requestFingerprint = buildRequestFingerprint('/_matrix/client/v3/account/deactivate', stage.user_id, {
    erase: body.erase === true,
  });

  const replay = await stage.user_do.resolvePhase04DeactivateReplay({
    user_id: stage.user_id,
    request_fingerprint: requestFingerprint,
    uia_nonce: stage.payload.nonce,
  });
  if (!replay.ok) {
    return jsonResponse(replay.matrix_error.body, replay.matrix_error.status);
  }
  if (replay.handled) {
    return jsonResponse(replay.response);
  }

  const verification = await stage.user_do.verifyPasswordAuth({
    localpart: stage.localpart,
    password: auth.password ?? '',
  });
  if (!verification.ok) {
    return jsonResponse(verification.matrix_error.body, verification.matrix_error.status);
  }

  const result = await stage.user_do.deactivateAccount({
    user_id: stage.user_id,
    erase: body.erase === true,
    request_fingerprint: requestFingerprint,
    uia_nonce: stage.payload.nonce,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.response);
}

async function handleRequest(request, env) {
  const config = loadWorkerRuntimeConfig('gateway-worker', env);
  const requestContext = createRequestContext({
    workerName: 'gateway-worker',
    workerVersion: config.text.WORKER_VERSION_ID,
    request,
    routeFamily: 'public-edge',
  });

  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  requestContext.logger.info('gateway.request.start', {
    method,
    path: pathname,
  });

  if (pathname === '/.well-known/matrix/client' && method === 'GET') {
    return handleWellKnownClient(url, env);
  }
  if (pathname === '/.well-known/matrix/server' && method === 'GET') {
    return handleWellKnownServer(env);
  }

  if (isStubbedClientRoute(method, pathname)) {
    return stubRouteResponse();
  }

  if (pathname === '/_matrix/client/versions' && method === 'GET') {
    return jsonResponse({
      versions: ['v1.17'],
      unstable_features: {},
    });
  }
  if (pathname === '/_matrix/client/v3/login' && method === 'GET') {
    return jsonResponse({
      flows: [
        { type: 'm.login.password' },
      ],
    }, 200, {
      'cache-control': 'public, max-age=60',
    });
  }
  if (pathname === '/_matrix/client/v3/register/available' && method === 'GET') {
    return handleRegisterAvailable(url, env);
  }
  if (pathname === '/_matrix/client/v1/register/m.login.registration_token/validity' && method === 'GET') {
    return handleRegistrationTokenValidity(url, env);
  }
  if (pathname === '/_matrix/client/v3/login' && method === 'POST') {
    return handleLogin(request, env);
  }
  if (pathname === '/_matrix/client/v3/register' && method === 'POST') {
    return handleRegister(request, env);
  }
  if (pathname === '/_matrix/client/v3/refresh' && method === 'POST') {
    return handleRefresh(request, env);
  }
  if (pathname === '/_matrix/client/v3/logout' && method === 'POST') {
    return handleLogout(request, env, { all: false });
  }
  if (pathname === '/_matrix/client/v3/logout/all' && method === 'POST') {
    return handleLogout(request, env, { all: true });
  }
  if (pathname === '/_matrix/client/v3/account/whoami' && method === 'GET') {
    return handleWhoAmI(request, env);
  }
  if (pathname === '/_matrix/client/v3/capabilities' && method === 'GET') {
    const access = await requireAccessSession(request, env);
    if (!access.ok) {
      return access.response;
    }
    return jsonResponse(buildCapabilitiesResponse());
  }
  if (pathname === '/_matrix/client/v3/account/password' && method === 'POST') {
    return handlePasswordChange(request, env);
  }
  if (pathname === '/_matrix/client/v3/account/deactivate' && method === 'POST') {
    return handleDeactivateAccount(request, env);
  }

  if (pathname.startsWith('/_matrix/')) {
    return stubRouteResponse();
  }

  return new Response('Not found', { status: 404 });
}

const fetch = async (request, env) => handleRequest(request, env);

export { RemoteServerDO, RoomDO, UserDO };

export default {
  fetch,
};
