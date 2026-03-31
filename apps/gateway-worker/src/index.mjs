import { createMatrixUnrecognizedErrorBody } from '../../../packages/contracts/src/index.mjs';
import {
  RemoteServerDO,
  RoomDO,
  UserDO,
  createCanonicalFilterHash,
  createRequestFingerprint,
  createRequestContext,
  getWellKnownCacheEntry,
  loadWorkerRuntimeConfig,
  putWellKnownCacheEntry,
} from '../../../packages/runtime-core/src/index.mjs';
import {
  buildProfileCapabilities,
  filterEventList,
  normalizeFilterDefinition,
  normalizeSyncTimeout,
  parseSyncToken,
  registerSyncWaiter,
} from '../../../packages/runtime-core/src/client-domain.mjs';
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

function getRoomDoStub(env, roomId) {
  const namespace = env.ROOM_DO;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new TypeError('env.ROOM_DO must expose a Durable Object namespace');
  }
  return namespace.get(namespace.idFromName(roomId));
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
    capabilities: buildProfileCapabilities(),
  };
}

function decodePathComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizePathUserId(pathValue, env) {
  const decoded = decodePathComponent(pathValue);
  if (!decoded) {
    return null;
  }
  try {
    const localpart = normalizeLocalUserIdentifier(decoded, env.MATRIX_SERVER_NAME);
    return buildLocalUserId(localpart, env.MATRIX_SERVER_NAME);
  } catch {
    return null;
  }
}

function ensureSelfAccess(access, pathUserId) {
  if (access.session.user_id !== pathUserId) {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'This route is only available for the authenticated user');
  }
  return null;
}

function expectSingleProperty(body, propertyName) {
  if (!(propertyName in body)) {
    return {
      ok: false,
      response: matrixErrorResponse(400, 'M_MISSING_PARAM', `${propertyName} is required`),
    };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== propertyName) {
    return {
      ok: false,
      response: matrixErrorResponse(400, 'M_BAD_JSON', `Request body must contain exactly the ${propertyName} property`),
    };
  }
  return {
    ok: true,
    value: body[propertyName],
  };
}

function mapInternalErrorToResponse(error) {
  if (!error || typeof error !== 'object') {
    return matrixErrorResponse(500, 'M_UNKNOWN', 'Internal error');
  }
  if (error.code === 'idempotency_conflict') {
    return matrixErrorResponse(409, 'M_CONFLICT', error.message ?? 'Idempotency conflict');
  }
  if (error.code === 'target_not_local') {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message ?? 'Target user is not local');
  }
  if (error.code === 'unknown_session' || error.code === 'invalid_token') {
    return matrixErrorResponse(401, 'M_UNKNOWN_TOKEN', error.message ?? 'Unknown or unsupported token');
  }
  if (error.code === 'invalid_cursor' || error.code === 'filter_mismatch' || error.code === 'cursor_from_future') {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message ?? 'Invalid sync token');
  }
  return matrixErrorResponse(500, 'M_UNKNOWN', error.message ?? 'Internal error');
}

function hasVisibleSyncChanges(batch, {
  since_token,
  full_state,
  parsed_since_pos,
}) {
  return (
    since_token == null
    || full_state
    || batch.account_data_events.length > 0
    || batch.presence_events.length > 0
    || batch.to_device_events.length > 0
    || (batch.room_deltas?.length ?? 0) > 0
    || (batch.room_account_data_deltas?.length ?? 0) > 0
    || (batch.room_ephemeral_deltas?.length ?? 0) > 0
    || batch.to_stream_pos > parsed_since_pos
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function resolveSyncFilter(access, url) {
  const filterParam = url.searchParams.get('filter');
  if (filterParam == null || filterParam === '') {
    return {
      ok: true,
      filter_json: {},
      filter_hash: createCanonicalFilterHash({}),
    };
  }
  if (filterParam.startsWith('{')) {
    try {
      const parsed = JSON.parse(filterParam);
      const normalized = normalizeFilterDefinition(parsed);
      return {
        ok: true,
        filter_json: normalized,
        filter_hash: createCanonicalFilterHash(normalized),
      };
    } catch {
      return {
        ok: false,
        response: matrixErrorResponse(400, 'M_BAD_JSON', 'filter must be a valid JSON object'),
      };
    }
  }

  const stored = await access.user_do.getStoredFilter({
    filter_id: filterParam,
  });
  if (!stored.ok) {
    return {
      ok: false,
      response: jsonResponse(stored.matrix_error.body, stored.matrix_error.status),
    };
  }
  return {
    ok: true,
    filter_json: stored.filter,
    filter_hash: stored.filter_hash,
  };
}

function ensureRoomProjectionTarget(targets, roomId) {
  if (!targets.has(roomId)) {
    targets.set(roomId, {
      room_id: roomId,
      room_pos: 0,
      membership_bucket: null,
      timeline_event_ids: new Set(),
      state_event_ids: new Set(),
      account_data_events: new Map(),
      ephemeral_events: [],
      limited: false,
      prev_batch: null,
      notification_count: null,
      highlight_count: null,
      unread_thread_notifications: null,
    });
  }
  return targets.get(roomId);
}

function mergeRoomDeltaIntoTarget(target, delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    return;
  }
  if (Number.isInteger(delta.room_pos) && delta.room_pos > target.room_pos) {
    target.room_pos = delta.room_pos;
  }
  if (typeof delta.membership_bucket === 'string' && delta.membership_bucket.length > 0) {
    target.membership_bucket = delta.membership_bucket;
  }
  for (const eventId of Array.isArray(delta.timeline_event_ids) ? delta.timeline_event_ids : []) {
    if (typeof eventId === 'string' && eventId.length > 0) {
      target.timeline_event_ids.add(eventId);
    }
  }
  for (const eventId of Array.isArray(delta.state_event_ids) ? delta.state_event_ids : []) {
    if (typeof eventId === 'string' && eventId.length > 0) {
      target.state_event_ids.add(eventId);
    }
  }
  if (Array.isArray(delta.ephemeral_events)) {
    target.ephemeral_events.push(...structuredClone(delta.ephemeral_events));
  }
  if (delta.limited === true) {
    target.limited = true;
  }
  if (typeof delta.prev_batch === 'string' && delta.prev_batch.length > 0) {
    target.prev_batch = delta.prev_batch;
  }
  if (Number.isInteger(delta.notification_count) && delta.notification_count >= 0) {
    target.notification_count = delta.notification_count;
  }
  if (Number.isInteger(delta.highlight_count) && delta.highlight_count >= 0) {
    target.highlight_count = delta.highlight_count;
  }
  if (delta.unread_thread_notifications && typeof delta.unread_thread_notifications === 'object' && !Array.isArray(delta.unread_thread_notifications)) {
    target.unread_thread_notifications = structuredClone(delta.unread_thread_notifications);
  }
}

function buildRoomSyncEntry(projection, target) {
  if (!projection) {
    return null;
  }
  const entry = {};
  if (projection.membership_bucket === 'invite') {
    entry.invite_state = {
      events: structuredClone(projection.state_events ?? []),
    };
    return entry;
  }
  if (projection.membership_bucket === 'knock') {
    entry.knock_state = {
      events: structuredClone(projection.state_events ?? []),
    };
    return entry;
  }
  if (projection.timeline_events?.length > 0 || projection.limited === true || target.prev_batch) {
    entry.timeline = {
      events: structuredClone(projection.timeline_events ?? []),
      limited: projection.limited === true,
      ...(target.prev_batch ? { prev_batch: target.prev_batch } : {}),
    };
  }
  if (projection.state_after_events != null) {
    entry.state_after = {
      events: structuredClone(projection.state_after_events),
    };
  } else if (projection.state_events?.length > 0) {
    entry.state = {
      events: structuredClone(projection.state_events),
    };
  }
  const accountDataEvents = [...target.account_data_events.values()];
  if (accountDataEvents.length > 0 || projection.account_data_events?.length > 0) {
    entry.account_data = {
      events: [
        ...structuredClone(projection.account_data_events ?? []),
        ...structuredClone(accountDataEvents),
      ],
    };
  }
  const ephemeralEvents = projection.ephemeral_events?.length > 0
    ? structuredClone(projection.ephemeral_events)
    : structuredClone(target.ephemeral_events ?? []);
  if (ephemeralEvents.length > 0) {
    entry.ephemeral = {
      events: ephemeralEvents,
    };
  }
  if (projection.unread_notifications) {
    entry.unread_notifications = structuredClone(projection.unread_notifications);
  }
  if (projection.unread_thread_notifications) {
    entry.unread_thread_notifications = structuredClone(projection.unread_thread_notifications);
  }
  if (projection.summary && Object.keys(projection.summary).length > 0) {
    entry.summary = structuredClone(projection.summary);
  }
  return entry;
}

async function assembleSyncResponse(env, batch, {
  user_id,
  filter_json,
  filter_hash,
  initial_sync = false,
} = {}) {
  const response = {
    next_batch: batch.next_batch,
    device_lists: {
      changed: [],
      left: [],
    },
    device_one_time_keys_count: {},
    device_unused_fallback_key_types: [],
  };

  if (batch.account_data_events.length > 0) {
    response.account_data = {
      events: batch.account_data_events,
    };
  }
  if (batch.presence_events.length > 0) {
    response.presence = {
      events: batch.presence_events,
    };
  }
  if (batch.to_device_events.length > 0) {
    response.to_device = {
      events: batch.to_device_events,
    };
  }

  const roomTargets = new Map();
  const roomFilter = filter_json?.room && typeof filter_json.room === 'object' && !Array.isArray(filter_json.room)
    ? filter_json.room
    : {};
  const roomAccountDataFilter = roomFilter.account_data && typeof roomFilter.account_data === 'object' && !Array.isArray(roomFilter.account_data)
    ? roomFilter.account_data
    : null;

  if (initial_sync || batch.full_state === true) {
    for (const snapshotEntry of batch.room_membership_snapshot ?? []) {
      const target = ensureRoomProjectionTarget(roomTargets, snapshotEntry.room_id);
      target.room_pos = snapshotEntry.room_pos ?? target.room_pos;
      target.membership_bucket = snapshotEntry.membership_bucket ?? target.membership_bucket;
    }
  }

  for (const delta of batch.room_deltas ?? []) {
    if (!delta?.room_id) {
      continue;
    }
    const target = ensureRoomProjectionTarget(roomTargets, delta.room_id);
    mergeRoomDeltaIntoTarget(target, delta);
  }

  for (const delta of batch.room_account_data_deltas ?? []) {
    if (!delta?.room_id || !delta.event) {
      continue;
    }
    const filteredEvents = filterEventList([delta.event], roomAccountDataFilter);
    if (filteredEvents.length === 0) {
      continue;
    }
    const target = ensureRoomProjectionTarget(roomTargets, delta.room_id);
    target.account_data_events.set(delta.event.type, structuredClone(filteredEvents[0]));
  }

  for (const delta of batch.room_ephemeral_deltas ?? []) {
    if (!delta?.room_id || !delta.event) {
      continue;
    }
    const target = ensureRoomProjectionTarget(roomTargets, delta.room_id);
    target.ephemeral_events.push(structuredClone(delta.event));
  }

  const joined = {};
  const invited = {};
  const knocked = {};
  const left = {};

  for (const target of roomTargets.values()) {
    try {
      const roomDo = getRoomDoStub(env, target.room_id);
      const projectionResult = await roomDo.projectForSync({
        user_id,
        room_id: target.room_id,
        room_pos: target.room_pos,
        membership_bucket: target.membership_bucket,
        filter_hash,
        filter_flags: batch.filter_flags,
        full_state: batch.full_state === true || initial_sync,
        use_state_after: batch.use_state_after === true,
        timeline_event_ids: [...target.timeline_event_ids],
        state_event_ids: [...target.state_event_ids],
        ephemeral_events: target.ephemeral_events,
        notification_count: target.notification_count,
        highlight_count: target.highlight_count,
        unread_thread_notifications: target.unread_thread_notifications,
        limited: target.limited,
        prev_batch: target.prev_batch,
      });
      if (!projectionResult?.ok) {
        return {
          ok: false,
          error: projectionResult?.error ?? {
            code: 'internal',
            message: `RoomDO projection failed for ${target.room_id}`,
          },
        };
      }
      const projection = projectionResult.projection;
      if (!projection) {
        continue;
      }
      const roomEntry = buildRoomSyncEntry(projection, target);
      if (!roomEntry) {
        continue;
      }
      if (projection.membership_bucket === 'join') {
        joined[target.room_id] = roomEntry;
      } else if (projection.membership_bucket === 'invite') {
        invited[target.room_id] = roomEntry;
      } else if (projection.membership_bucket === 'knock') {
        knocked[target.room_id] = roomEntry;
      } else if (projection.membership_bucket === 'leave') {
        left[target.room_id] = roomEntry;
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code ?? 'internal',
          message: error?.message ?? `RoomDO projection failed for ${target.room_id}`,
        },
      };
    }
  }

  const rooms = {};
  if (Object.keys(joined).length > 0) {
    rooms.join = joined;
  }
  if (Object.keys(invited).length > 0) {
    rooms.invite = invited;
  }
  if (Object.keys(knocked).length > 0) {
    rooms.knock = knocked;
  }
  if (Object.keys(left).length > 0) {
    rooms.leave = left;
  }
  if (Object.keys(rooms).length > 0) {
    response.rooms = rooms;
  }

  return {
    ok: true,
    response,
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

async function handleProfileDocumentRead(env, pathUserId, keyName = null) {
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Profile does not exist');
  }
  const userDo = getUserDoStub(env, targetUserId);
  const result = keyName == null
    ? await userDo.getProfileDocument({ user_id: targetUserId })
    : await userDo.getProfileField({ user_id: targetUserId, key_name: decodePathComponent(keyName) });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.profile);
}

async function handleProfileFieldWrite(request, env, pathUserId, keyName, { method }) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Profile does not exist');
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  const decodedKeyName = decodePathComponent(keyName);
  if (!decodedKeyName) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid profile key');
  }
  if (method === 'DELETE') {
    const result = await access.user_do.deleteProfileField({
      user_id: targetUserId,
      key_name: decodedKeyName,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }

  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const shape = expectSingleProperty(body, decodedKeyName);
  if (!shape.ok) {
    return shape.response;
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'PUT',
    routeTemplate: '/_matrix/client/v3/profile/{userId}/{keyName}',
    principalId: targetUserId,
    body: {
      key_name: decodedKeyName,
      value: shape.value,
    },
  });
  const result = await access.user_do.putProfileField({
    user_id: targetUserId,
    key_name: decodedKeyName,
    value: shape.value,
    request_fingerprint: requestFingerprint,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse({});
}

async function handleGlobalAccountDataRequest(request, env, pathUserId, type, { method }) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'User does not exist');
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  const decodedType = decodePathComponent(type);
  if (!decodedType) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid account data type');
  }
  if (method === 'GET') {
    const result = await access.user_do.getGlobalAccountData({ type: decodedType });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse(result.content);
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await access.user_do.putGlobalAccountData({
    user_id: targetUserId,
    type: decodedType,
    content: body,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse({});
}

async function handleRoomAccountDataRequest(request, env, pathUserId, roomId, type, { method }) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'User does not exist');
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  const decodedRoomId = decodePathComponent(roomId);
  const decodedType = decodePathComponent(type);
  if (!decodedRoomId || !decodedType) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid room account data path');
  }
  if (method === 'GET') {
    const result = await access.user_do.getRoomAccountData({
      room_id: decodedRoomId,
      type: decodedType,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse(result.content);
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await access.user_do.putRoomAccountData({
    user_id: targetUserId,
    room_id: decodedRoomId,
    type: decodedType,
    content: body,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse({});
}

async function handleTagsRequest(request, env, pathUserId, roomId, tag = null, { method }) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'User does not exist');
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  const decodedRoomId = decodePathComponent(roomId);
  if (!decodedRoomId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid room ID');
  }
  if (tag == null) {
    const result = await access.user_do.getTags({
      room_id: decodedRoomId,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({ tags: result.tags });
  }
  const decodedTag = decodePathComponent(tag);
  if (!decodedTag) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid tag name');
  }
  if (method === 'DELETE') {
    const result = await access.user_do.deleteTag({
      user_id: targetUserId,
      room_id: decodedRoomId,
      tag: decodedTag,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await access.user_do.putTag({
    user_id: targetUserId,
    room_id: decodedRoomId,
    tag: decodedTag,
    content: body,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse({});
}

async function handleReadMarkersRequest(request, env, roomId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = decodePathComponent(roomId);
  if (!decodedRoomId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid room ID');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await access.user_do.applyReadMarkers({
    user_id: access.session.user_id,
    room_id: decodedRoomId,
    content: body,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse({});
}

async function handlePresenceRequest(request, env, pathUserId, { method }) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Presence state does not exist');
  }
  const userDo = getUserDoStub(env, targetUserId);
  if (method === 'GET') {
    const result = await userDo.getPresence({
      user_id: targetUserId,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse(result.content);
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await access.user_do.setPresence({
    user_id: targetUserId,
    presence: body.presence,
    status_msg: body.status_msg ?? null,
    currently_active: body.currently_active === true,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse({});
}

async function handleFilterRequest(request, env, pathUserId, filterId = null, { method }) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'User does not exist');
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  if (filterId == null) {
    const body = await readJsonObject(request);
    if (body instanceof Response) {
      return body;
    }
    const result = await access.user_do.storeFilter({
      user_id: targetUserId,
      filter_json: body,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({ filter_id: result.filter_id });
  }
  const decodedFilterId = decodePathComponent(filterId);
  if (!decodedFilterId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid filter ID');
  }
  const result = await access.user_do.getStoredFilter({
    filter_id: decodedFilterId,
  });
  if (!result.ok) {
    return jsonResponse(result.matrix_error.body, result.matrix_error.status);
  }
  return jsonResponse(result.filter);
}

async function handlePushRulesRequest(request, env, {
  kind = null,
  ruleId = null,
  subresource = null,
} = {}) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  if (!kind) {
    const result = await access.user_do.getPushRules({
      user_id: access.session.user_id,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse(subresource === 'global' ? result.global : { global: result.global });
  }

  const decodedRuleId = decodePathComponent(ruleId);
  if (!decodedRuleId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid push rule ID');
  }
  if (request.method === 'GET' && subresource == null) {
    const result = await access.user_do.getPushRule({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse(result.rule);
  }
  if (request.method === 'DELETE' && subresource == null) {
    const result = await access.user_do.deletePushRule({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }

  if (request.method === 'PUT' && subresource == null) {
    const body = await readJsonObject(request);
    if (body instanceof Response) {
      return body;
    }
    const result = await access.user_do.putPushRule({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
      before: new URL(request.url).searchParams.get('before') ?? null,
      after: new URL(request.url).searchParams.get('after') ?? null,
      body,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }

  if (request.method === 'GET' && subresource === 'actions') {
    const result = await access.user_do.getPushRule({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({ actions: result.rule.actions ?? [] });
  }
  if (request.method === 'PUT' && subresource === 'actions') {
    const body = await readJsonObject(request);
    if (body instanceof Response) {
      return body;
    }
    const result = await access.user_do.setPushRuleActions({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
      actions: body.actions,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }
  if (request.method === 'GET' && subresource === 'enabled') {
    const result = await access.user_do.getPushRule({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({ enabled: result.rule.enabled !== false });
  }
  if (request.method === 'PUT' && subresource === 'enabled') {
    const body = await readJsonObject(request);
    if (body instanceof Response) {
      return body;
    }
    const result = await access.user_do.setPushRuleEnabled({
      user_id: access.session.user_id,
      kind,
      rule_id: decodedRuleId,
      enabled: body.enabled,
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }

  return matrixErrorResponse(404, 'M_UNRECOGNIZED', 'Unrecognized or unsupported endpoint');
}

async function handleSendToDevice(request, env, eventType, txnId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedEventType = decodePathComponent(eventType);
  const decodedTxnId = decodePathComponent(txnId);
  if (!decodedEventType || !decodedTxnId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid sendToDevice path');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  if (!body.messages || typeof body.messages !== 'object' || Array.isArray(body.messages)) {
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'messages is required');
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'PUT',
    routeTemplate: '/_matrix/client/v3/sendToDevice/{eventType}/{txnId}',
    principalId: access.session.user_id,
    body: {
      event_type: decodedEventType,
      txn_id: decodedTxnId,
      messages: body.messages,
    },
  });

  for (const [targetUserKey, deviceMessages] of Object.entries(body.messages)) {
    const targetUserId = normalizePathUserId(targetUserKey, env);
    if (!targetUserId) {
      return matrixErrorResponse(400, 'M_INVALID_PARAM', `Target user ${targetUserKey} is not local or not valid`);
    }
    if (!deviceMessages || typeof deviceMessages !== 'object' || Array.isArray(deviceMessages)) {
      return matrixErrorResponse(400, 'M_BAD_JSON', `messages.${targetUserKey} must be an object`);
    }
    const targetResult = await getUserDoStub(env, targetUserId).enqueueToDevice({
      sender_user_id: access.session.user_id,
      event_type: decodedEventType,
      txn_id: decodedTxnId,
      request_fingerprint: requestFingerprint,
      device_messages: deviceMessages,
    });
    if (!targetResult.ok) {
      return mapInternalErrorToResponse(targetResult.error);
    }
  }
  return jsonResponse({});
}

async function handleSync(request, env, url) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }

  const filterResolution = await resolveSyncFilter(access, url);
  if (!filterResolution.ok) {
    return filterResolution.response;
  }
  const timeoutMs = normalizeSyncTimeout(url.searchParams.get('timeout'));
  const fullState = url.searchParams.get('full_state') === 'true';
  const useStateAfter = url.searchParams.get('use_state_after') === 'true';
  const setPresence = url.searchParams.get('set_presence') ?? 'online';
  if (!['online', 'offline', 'unavailable'].includes(setPresence)) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Presence must be one of online, offline, or unavailable');
  }

  const sinceToken = url.searchParams.get('since') ?? null;
  const parsedToken = parseSyncToken(sinceToken, {
    expected_user_id: access.session.user_id,
    expected_device_id: access.session.device_id,
    secret_value: env.SESSION_ROOT_KEY_RING,
  });
  if (!parsedToken.ok) {
    return jsonResponse(parsedToken.matrix_error.body, parsedToken.matrix_error.status);
  }

  const collectRequest = {
    user_id: access.session.user_id,
    session_id: access.session.session_id,
    since_token: sinceToken,
    filter_json: filterResolution.filter_json,
    filter_hash: filterResolution.filter_hash,
    full_state: fullState,
    use_state_after: useStateAfter,
  };

  const collectAndAssemble = async () => {
    const collected = await access.user_do.collectSince(collectRequest);
    if (!collected.ok) {
      return {
        ok: false,
        response: jsonResponse(collected.matrix_error.body, collected.matrix_error.status),
      };
    }
    const assembled = await assembleSyncResponse(env, collected.batch, {
      user_id: access.session.user_id,
      filter_json: filterResolution.filter_json,
      filter_hash: filterResolution.filter_hash,
      initial_sync: sinceToken == null || sinceToken === '',
    });
    if (!assembled.ok) {
      return {
        ok: false,
        response: mapInternalErrorToResponse(assembled.error),
      };
    }
    return {
      ok: true,
      collected,
      assembled,
    };
  };

  let syncSnapshot = await collectAndAssemble();
  if (!syncSnapshot.ok) {
    return syncSnapshot.response;
  }
  const presenceResult = await access.user_do.syncPresence({
    user_id: access.session.user_id,
    presence: setPresence,
  });
  if (!presenceResult.ok) {
    return jsonResponse(presenceResult.matrix_error.body, presenceResult.matrix_error.status);
  }
  if (presenceResult.response?.changed === true) {
    syncSnapshot = await collectAndAssemble();
    if (!syncSnapshot.ok) {
      return syncSnapshot.response;
    }
  }

  if (hasVisibleSyncChanges(syncSnapshot.collected.batch, {
    since_token: sinceToken,
    full_state: fullState,
    parsed_since_pos: parsedToken.since_pos,
  }) || timeoutMs === 0) {
    return jsonResponse(syncSnapshot.assembled.response);
  }

  const waiterKey = JSON.stringify({
    user_id: access.session.user_id,
    session_id: access.session.session_id,
    device_id: access.session.device_id,
    since_kind: sinceToken == null ? 'initial' : 'incremental',
    since_pos: parsedToken.since_pos,
    filter_hash: filterResolution.filter_hash,
    full_state: fullState,
    use_state_after: useStateAfter,
    set_presence: setPresence,
    timeout_ms_normalized: timeoutMs,
  });
  const waiter = registerSyncWaiter(env, {
    user_id: access.session.user_id,
    session_id: access.session.session_id,
    waiter_key: waiterKey,
    timeout_ms: timeoutMs,
  });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      syncSnapshot = await collectAndAssemble();
      if (!syncSnapshot.ok) {
        waiter.cancel();
        return syncSnapshot.response;
      }
      waiter.cancel();
      return jsonResponse(syncSnapshot.assembled.response);
    }

    const waitOutcome = await Promise.race([
      waiter.promise,
      sleep(Math.min(remainingMs, 250)).then(() => ({ reason: 'poll' })),
    ]);

    syncSnapshot = await collectAndAssemble();
    if (!syncSnapshot.ok) {
      waiter.cancel();
      return syncSnapshot.response;
    }

    if (hasVisibleSyncChanges(syncSnapshot.collected.batch, {
      since_token: sinceToken,
      full_state: fullState,
      parsed_since_pos: parsedToken.since_pos,
    })) {
      waiter.cancel();
      return jsonResponse(syncSnapshot.assembled.response);
    }

    if (waitOutcome.reason !== 'poll') {
      waiter.cancel();
      return jsonResponse(syncSnapshot.assembled.response);
    }
  }
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

  const profileDocumentMatch = /^\/_matrix\/client\/v3\/profile\/([^/]+)$/.exec(pathname);
  if (profileDocumentMatch && method === 'GET') {
    return handleProfileDocumentRead(env, profileDocumentMatch[1], null);
  }
  const profileFieldMatch = /^\/_matrix\/client\/v3\/profile\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (profileFieldMatch && method === 'GET') {
    return handleProfileDocumentRead(env, profileFieldMatch[1], profileFieldMatch[2]);
  }
  if (profileFieldMatch && ['PUT', 'DELETE'].includes(method)) {
    return handleProfileFieldWrite(request, env, profileFieldMatch[1], profileFieldMatch[2], { method });
  }

  const globalAccountDataMatch = /^\/_matrix\/client\/v3\/user\/([^/]+)\/account_data\/([^/]+)$/.exec(pathname);
  if (globalAccountDataMatch && ['GET', 'PUT'].includes(method)) {
    return handleGlobalAccountDataRequest(request, env, globalAccountDataMatch[1], globalAccountDataMatch[2], { method });
  }
  const roomAccountDataMatch = /^\/_matrix\/client\/v3\/user\/([^/]+)\/rooms\/([^/]+)\/account_data\/([^/]+)$/.exec(pathname);
  if (roomAccountDataMatch && ['GET', 'PUT'].includes(method)) {
    return handleRoomAccountDataRequest(
      request,
      env,
      roomAccountDataMatch[1],
      roomAccountDataMatch[2],
      roomAccountDataMatch[3],
      { method },
    );
  }
  const tagsMatch = /^\/_matrix\/client\/v3\/user\/([^/]+)\/rooms\/([^/]+)\/tags\/?$/.exec(pathname);
  if (tagsMatch && method === 'GET') {
    return handleTagsRequest(request, env, tagsMatch[1], tagsMatch[2], null, { method });
  }
  const tagMatch = /^\/_matrix\/client\/v3\/user\/([^/]+)\/rooms\/([^/]+)\/tags\/([^/]+)$/.exec(pathname);
  if (tagMatch && ['PUT', 'DELETE'].includes(method)) {
    return handleTagsRequest(request, env, tagMatch[1], tagMatch[2], tagMatch[3], { method });
  }
  const readMarkersMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/read_markers$/.exec(pathname);
  if (readMarkersMatch && method === 'POST') {
    return handleReadMarkersRequest(request, env, readMarkersMatch[1]);
  }

  const presenceMatch = /^\/_matrix\/client\/v3\/presence\/([^/]+)\/status$/.exec(pathname);
  if (presenceMatch && ['GET', 'PUT'].includes(method)) {
    return handlePresenceRequest(request, env, presenceMatch[1], { method });
  }

  const filterCreateMatch = /^\/_matrix\/client\/v3\/user\/([^/]+)\/filter$/.exec(pathname);
  if (filterCreateMatch && method === 'POST') {
    return handleFilterRequest(request, env, filterCreateMatch[1], null, { method });
  }
  const filterGetMatch = /^\/_matrix\/client\/v3\/user\/([^/]+)\/filter\/([^/]+)$/.exec(pathname);
  if (filterGetMatch && method === 'GET') {
    return handleFilterRequest(request, env, filterGetMatch[1], filterGetMatch[2], { method });
  }

  if ((pathname === '/_matrix/client/v3/pushrules' || pathname === '/_matrix/client/v3/pushrules/') && method === 'GET') {
    return handlePushRulesRequest(request, env);
  }
  if ((pathname === '/_matrix/client/v3/pushrules/global' || pathname === '/_matrix/client/v3/pushrules/global/') && method === 'GET') {
    return handlePushRulesRequest(request, env, { subresource: 'global' });
  }
  const pushRuleActionsMatch = /^\/_matrix\/client\/v3\/pushrules\/global\/([^/]+)\/([^/]+)\/(actions|enabled)$/.exec(pathname);
  if (pushRuleActionsMatch && ['GET', 'PUT'].includes(method)) {
    return handlePushRulesRequest(request, env, {
      kind: pushRuleActionsMatch[1],
      ruleId: pushRuleActionsMatch[2],
      subresource: pushRuleActionsMatch[3],
    });
  }
  const pushRuleMatch = /^\/_matrix\/client\/v3\/pushrules\/global\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (pushRuleMatch && ['GET', 'PUT', 'DELETE'].includes(method)) {
    return handlePushRulesRequest(request, env, {
      kind: pushRuleMatch[1],
      ruleId: pushRuleMatch[2],
    });
  }

  const sendToDeviceMatch = /^\/_matrix\/client\/v3\/sendToDevice\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (sendToDeviceMatch && method === 'PUT') {
    return handleSendToDevice(request, env, sendToDeviceMatch[1], sendToDeviceMatch[2]);
  }

  if (pathname === '/_matrix/client/v3/sync' && method === 'GET') {
    return handleSync(request, env, url);
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
