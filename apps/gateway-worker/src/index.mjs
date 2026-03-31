import { Buffer } from 'node:buffer';

import { createMatrixUnrecognizedErrorBody } from '../../../packages/contracts/src/index.mjs';
import {
  createD1ControlPlanePersistence,
} from '../../../packages/control-plane/src/index.mjs';
import {
  RemoteServerDO,
  RoomDO,
  UserDO,
  buildLocalMediaObjectKey,
  buildMediaConfig,
  buildMxcUri,
  buildRemoteMediaObjectKey,
  buildThumbnailBody,
  buildThumbnailDescriptor,
  computeLegacyUnauthAccessFlag,
  createCanonicalFilterHash,
  createRequestFingerprint,
  createRequestContext,
  ensureDerivedSchema,
  enqueueDerivedWork,
  extractPublicRoomsQuery,
  getDerivedPersistence,
  getWellKnownCacheEntry,
  loadWorkerRuntimeConfig,
  normalizeDownloadOptions,
  normalizeLocalMediaObjectMetadata,
  normalizeRemoteMediaObjectMetadata,
  parseLegacyUnauthFreezeAt,
  querySearchIndex,
  queryUserDirectory,
  readBodyWithDigest,
  putWellKnownCacheEntry,
  teeBodyStreamWithDigest,
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
  DEFAULT_ROOM_VERSION,
  deriveCreateRoomIdentity,
  resolveRequestedRoomVersion,
} from '../../../packages/runtime-core/src/room-domain.mjs';
import { canonicalJsonHash } from '../../../packages/runtime-core/src/fingerprints.mjs';
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

function getControlPlanePersistence(env) {
  if (!env.__CONTROL_PLANE_PERSISTENCE__) {
    env.__CONTROL_PLANE_PERSISTENCE__ = createD1ControlPlanePersistence(env.MATRIX_CONTROL_D1);
  }
  return env.__CONTROL_PLANE_PERSISTENCE__;
}

function resolveConfiguredMaxUploadBytes(env) {
  const configured = Number.parseInt(env.MATRIX_MEDIA_MAX_UPLOAD_BYTES, 10);
  const zoneLimit = /^[0-9]+$/.test(String(env.CF_ZONE_BODY_LIMIT_BYTES ?? '').trim())
    ? Number.parseInt(env.CF_ZONE_BODY_LIMIT_BYTES, 10)
    : Number.POSITIVE_INFINITY;
  return Math.min(configured, zoneLimit);
}

function encodePublicRoomsCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePublicRoomsCursor(value) {
  if (value == null || value === '') {
    return null;
  }
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

function isPublicDirectoryRowComplete(row) {
  return row != null
    && typeof row.room_id === 'string'
    && typeof row.join_rules === 'string'
    && typeof row.history_visibility === 'string'
    && Number.isInteger(row.room_serial)
    && Number.isInteger(row.visibility_watermark)
    && typeof row.is_public === 'boolean';
}

function isPublicDirectoryRowCurrent(derivedRow, truthRow) {
  return derivedRow.room_serial === truthRow.room_serial
    && derivedRow.visibility_watermark === truthRow.visibility_watermark
    && derivedRow.is_public === truthRow.is_public
    && derivedRow.join_rules === truthRow.join_rules
    && derivedRow.history_visibility === truthRow.history_visibility
    && derivedRow.world_readable === truthRow.world_readable
    && derivedRow.guest_can_join === truthRow.guest_can_join
    && (derivedRow.canonical_alias ?? null) === (truthRow.canonical_alias ?? null);
}

async function listRegisteredRoomIds(env) {
  const persistence = getControlPlanePersistence(env);
  await persistence.ensureSchema();
  const rows = await persistence.listShardRegistry({});
  return rows
    .filter((row) => row.shard_type === 'RoomDO' && row.disabled_at == null)
    .map((row) => row.shard_key);
}

async function hasActiveGlobalRebuild(env) {
  const persistence = getControlPlanePersistence(env);
  await persistence.ensureSchema();
  const jobs = await persistence.listJobs({
    job_type: 'rebuild',
    internal_states: ['pending', 'checkpointed', 'scanning'],
    limit: 100,
  });
  return jobs.some((job) => job.scope?.scope_kind === 'global');
}

async function resolveValidatedPublicRoomRow(env, roomId, {
  derivedRow = null,
  forceTruth = false,
} = {}) {
  const roomDo = getRoomDoStub(env, roomId);
  const truthResult = await roomDo.getPublicRoomDirectoryEntry({
    room_id: roomId,
    updated_at: new Date().toISOString(),
  });
  if (!truthResult?.ok || !truthResult.entry || truthResult.entry.is_public !== true) {
    return null;
  }
  if (forceTruth || !isPublicDirectoryRowComplete(derivedRow) || !isPublicDirectoryRowCurrent(derivedRow, truthResult.entry)) {
    return truthResult.entry;
  }
  return derivedRow;
}

function applyPublicRoomsQuery(rows, {
  limit = 10,
  since = null,
  searchTerm = null,
} = {}) {
  const normalizedLimit = Number.isInteger(limit) ? limit : 10;
  const cursor = decodePublicRoomsCursor(since);
  const offset = cursor?.offset == null ? 0 : Number.parseInt(cursor.offset, 10);
  const loweredSearchTerm = typeof searchTerm === 'string' ? searchTerm.toLowerCase() : '';
  const filteredRows = rows
    .filter((row) => row.is_public === true)
    .filter((row) => loweredSearchTerm.length === 0 || (
      (row.name ?? '').toLowerCase().includes(loweredSearchTerm)
      || (row.topic ?? '').toLowerCase().includes(loweredSearchTerm)
      || (row.canonical_alias ?? '').toLowerCase().includes(loweredSearchTerm)
      || row.room_id.toLowerCase().includes(loweredSearchTerm)
    ))
    .sort((left, right) => right.joined_members - left.joined_members || left.room_id.localeCompare(right.room_id));
  const page = filteredRows.slice(offset, offset + normalizedLimit);
  return {
    chunk: page.map((row) => ({
      room_id: row.room_id,
      name: row.name ?? undefined,
      topic: row.topic ?? undefined,
      canonical_alias: row.canonical_alias ?? undefined,
      avatar_url: row.avatar_url ?? undefined,
      num_joined_members: row.joined_members,
      world_readable: row.world_readable === true,
      guest_can_join: row.guest_can_join === true,
      join_rule: row.join_rules ?? 'invite',
    })),
    next_batch: offset + normalizedLimit < filteredRows.length
      ? encodePublicRoomsCursor({ offset: offset + normalizedLimit })
      : undefined,
    prev_batch: offset > 0
      ? encodePublicRoomsCursor({ offset: Math.max(0, offset - normalizedLimit) })
      : undefined,
    total_room_count_estimate: filteredRows.length,
  };
}

async function queryPublicRoomsWithTruthFallback(env, queryInput) {
  await ensureDerivedSchema(env);
  const derived = getDerivedPersistence(env);
  const derivedRows = await derived.publicRoomDirectory.list();
  const derivedByRoomId = new Map(derivedRows.map((row) => [row.room_id, row]));
  const rebuildInProgress = await hasActiveGlobalRebuild(env);
  const roomIds = await listRegisteredRoomIds(env);
  const validatedRows = [];
  for (const roomId of roomIds) {
    const row = await resolveValidatedPublicRoomRow(env, roomId, {
      derivedRow: derivedByRoomId.get(roomId) ?? null,
      forceTruth: rebuildInProgress,
    });
    if (row) {
      validatedRows.push(row);
    }
  }
  return applyPublicRoomsQuery(validatedRows, queryInput);
}

async function resolveRoomAliasWithTruthFallback(env, alias) {
  const normalizedAlias = String(alias);
  await ensureDerivedSchema(env);
  const derived = getDerivedPersistence(env);
  const derivedRows = await derived.publicRoomDirectory.list();
  const firstDerivedMatch = derivedRows.find((row) => row.canonical_alias === normalizedAlias) ?? null;
  if (firstDerivedMatch) {
    const validated = await resolveValidatedPublicRoomRow(env, firstDerivedMatch.room_id, {
      derivedRow: firstDerivedMatch,
      forceTruth: true,
    });
    if (validated?.canonical_alias === normalizedAlias) {
      return validated;
    }
  }
  for (const roomId of await listRegisteredRoomIds(env)) {
    if (firstDerivedMatch?.room_id === roomId) {
      continue;
    }
    const roomDo = getRoomDoStub(env, roomId);
    const resolved = await roomDo.resolveRoomAlias({ alias: normalizedAlias });
    if (!resolved?.ok || resolved.room_id == null) {
      continue;
    }
    const validated = await resolveValidatedPublicRoomRow(env, resolved.room_id, {
      forceTruth: true,
    });
    if (validated?.canonical_alias === normalizedAlias) {
      return validated;
    }
  }
  return null;
}

function getMediaFreezePolicy(env) {
  if (!('__MEDIA_FREEZE_POLICY__' in env)) {
    env.__MEDIA_FREEZE_POLICY__ = parseLegacyUnauthFreezeAt(env.MATRIX_MEDIA_LEGACY_UNAUTH_FREEZE_AT);
  }
  return env.__MEDIA_FREEZE_POLICY__;
}

async function deleteMediaObjectBestEffort(env, objectKey) {
  if (typeof objectKey !== 'string' || objectKey.length === 0) {
    return false;
  }
  if (!env?.MATRIX_MEDIA_BUCKET || typeof env.MATRIX_MEDIA_BUCKET.delete !== 'function') {
    return false;
  }
  try {
    await env.MATRIX_MEDIA_BUCKET.delete(objectKey);
    return true;
  } catch {
    return false;
  }
}

function normalizeRemoteMediaFetchError(error, {
  serverName,
  mediaId,
} = {}) {
  if (error?.code === 'content_too_large' || error?.code === 'quota_exceeded' || error?.code === 'backpressure') {
    return error;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return Object.assign(new Error(`Remote media fetch timed out for mxc://${serverName}/${mediaId}`), {
      code: 'backpressure',
      retryable: true,
    });
  }
  return Object.assign(new Error(
    error?.message ?? `Remote media fetch failed for mxc://${serverName}/${mediaId}`,
  ), {
    code: 'backpressure',
    retryable: true,
  });
}

async function dispatchDerivedWork(env, requestedBy, workItems) {
  if (!Array.isArray(workItems) || workItems.length === 0) {
    return;
  }
  try {
    await enqueueDerivedWork(env, {
      schema_version: 1,
      batch_id: `gateway_${Date.now()}`,
      requested_by: requestedBy,
      work_items: workItems,
    });
  } catch {
    // Derived projection must not block truth-path completion.
  }
}

function toResponseBody(body) {
  if (body == null) {
    return null;
  }
  if (typeof body === 'string' || body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return body;
  }
  return String(body);
}

function buildMediaResponse(object, {
  filename = null,
  contentType = null,
} = {}) {
  const headers = new Headers();
  const resolvedContentType = contentType
    ?? object.httpMetadata?.contentType
    ?? object.httpMetadata?.content_type
    ?? object.customMetadata?.content_type
    ?? 'application/octet-stream';
  headers.set('content-type', resolvedContentType);
  if (filename) {
    headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }
  return new Response(toResponseBody(object.body), {
    status: 200,
    headers,
  });
}

async function withMediaKeyBackoff(env, objectKey, operation) {
  const cache = env.MATRIX_EDGE_CACHE;
  const cacheKey = `media_write_backoff:${objectKey}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = cache && typeof cache.get === 'function'
      ? await cache.get(cacheKey)
      : null;
    if (!existing) {
      try {
        if (cache && typeof cache.put === 'function') {
          await cache.put(cacheKey, JSON.stringify({ locked_at: new Date().toISOString() }), {
            expirationTtl: 5,
          });
        }
        return await operation();
      } finally {
        await cache?.delete?.(cacheKey);
      }
    }
    await sleep(10 + Math.floor(Math.random() * 25));
  }
  throw {
    code: 'quota_exceeded',
    message: `Media object ${objectKey} is busy; retry later`,
  };
}

function isLegacyUnauthMediaAllowed(metadata) {
  return metadata?.legacy_unauth_access_flag === true;
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

function normalizePathRoomId(pathValue) {
  const decoded = decodePathComponent(pathValue);
  if (!decoded || !decoded.startsWith('!')) {
    return null;
  }
  return decoded;
}

function isReadableRoomSyncMembershipBucket(membershipBucket) {
  return membershipBucket === 'join' || membershipBucket === 'leave';
}

function buildRoomClientContext(access, routeTemplate, txnIdOrRequestHash) {
  return {
    user_id: access.session.user_id,
    device_id: access.session.device_id,
    route_template: routeTemplate,
    txn_id_or_request_hash: txnIdOrRequestHash,
  };
}

function isObjectRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

async function loadIgnoredUserIds(userDo) {
  const ignoredUserIds = new Set();
  const ignoredList = await userDo.getGlobalAccountData({
    type: 'm.ignored_user_list',
  });
  if (!ignoredList?.ok || !isObjectRecord(ignoredList.content)) {
    return ignoredUserIds;
  }
  const ignoredUsers = isObjectRecord(ignoredList.content.ignored_users)
    ? ignoredList.content.ignored_users
    : null;
  if (!ignoredUsers) {
    return ignoredUserIds;
  }
  for (const userId of Object.keys(ignoredUsers)) {
    if (typeof userId === 'string' && userId.length > 0) {
      ignoredUserIds.add(userId);
    }
  }
  return ignoredUserIds;
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
  if (error.code === 'unsupported_room_version') {
    return matrixErrorResponse(400, 'M_UNSUPPORTED_ROOM_VERSION', error.message ?? 'Unsupported room version');
  }
  if (error.code === 'incompatible_room_version') {
    return matrixErrorResponse(400, 'M_INCOMPATIBLE_ROOM_VERSION', error.message ?? 'Incompatible room version');
  }
  if (error.code === 'room_not_found' || error.code === 'event_not_found') {
    return matrixErrorResponse(404, 'M_NOT_FOUND', error.message ?? 'Requested room resource does not exist');
  }
  if (error.code === 'room_forbidden' || error.code === 'not_allowed') {
    return matrixErrorResponse(403, 'M_FORBIDDEN', error.message ?? 'The room operation is not allowed');
  }
  if (error.code === 'bad_json' || error.code === 'invalid_event') {
    return matrixErrorResponse(400, 'M_BAD_JSON', error.message ?? 'Request body must be a JSON object');
  }
  if (error.code === 'unknown_session' || error.code === 'invalid_token') {
    return matrixErrorResponse(401, 'M_UNKNOWN_TOKEN', error.message ?? 'Unknown or unsupported token');
  }
  if (error.code === 'invalid_cursor' || error.code === 'filter_mismatch' || error.code === 'cursor_from_future') {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message ?? 'Invalid sync token');
  }
  if (error.code === 'content_too_large') {
    return matrixErrorResponse(413, 'M_TOO_LARGE', error.message ?? 'Media body exceeds the configured limit');
  }
  if (error.code === 'quota_exceeded') {
    return matrixErrorResponse(429, 'M_LIMIT_EXCEEDED', error.message ?? 'Rate or quota limit exceeded');
  }
  if (error.code === 'upload_not_found' || error.code === 'media_not_found') {
    return matrixErrorResponse(404, 'M_NOT_FOUND', error.message ?? 'Requested media does not exist');
  }
  if (error.code === 'media_forbidden') {
    return matrixErrorResponse(403, 'M_FORBIDDEN', error.message ?? 'The requested media is not accessible');
  }
  if (error.code === 'backpressure' || error.retryable === true) {
    return matrixErrorResponse(503, 'M_UNKNOWN', error.message ?? 'Temporary internal backpressure');
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
  const registryResult = await getUserDoStub(env, targetUserId).ensureShardRegistry({
    user_id: targetUserId,
    now: new Date().toISOString(),
  });
  if (!registryResult?.ok) {
    return mapInternalErrorToResponse(registryResult?.error);
  }
  await dispatchDerivedWork(env, 'gateway.register', [{
    work_type: 'user_directory',
    idempotency_key: `user_directory:${targetUserId}`,
    scope: {
      scope_kind: 'user_id',
      scope_id: targetUserId,
    },
    source_refs: {
      user_id: targetUserId,
    },
    enqueued_at: new Date().toISOString(),
  }]);
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
  await dispatchDerivedWork(env, 'gateway.deactivate', [{
    work_type: 'user_directory',
    idempotency_key: `user_directory:${stage.user_id}`,
    scope: {
      scope_kind: 'user_id',
      scope_id: stage.user_id,
    },
    source_refs: {
      user_id: stage.user_id,
    },
    enqueued_at: new Date().toISOString(),
  }]);
  return jsonResponse(result.response);
}

async function handleProfileDocumentRead(env, pathUserId, keyName = null) {
  const targetUserId = normalizePathUserId(pathUserId, env);
  if (!targetUserId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Profile does not exist');
  }
  const userDo = getUserDoStub(env, targetUserId);
  let result;
  if (keyName == null) {
    result = await userDo.getProfileDocument({ user_id: targetUserId });
  } else {
    const decodedKeyName = decodePathComponent(keyName);
    if (!decodedKeyName) {
      return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid profile key');
    }
    result = await userDo.getProfileField({ user_id: targetUserId, key_name: decodedKeyName });
  }
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
    await dispatchDerivedWork(env, 'gateway.profile.delete', [{
      work_type: 'user_directory',
      idempotency_key: `user_directory:${targetUserId}`,
      scope: {
        scope_kind: 'user_id',
        scope_id: targetUserId,
      },
      source_refs: {
        user_id: targetUserId,
      },
      enqueued_at: new Date().toISOString(),
    }]);
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
  await dispatchDerivedWork(env, 'gateway.profile.put', [{
    work_type: 'user_directory',
    idempotency_key: `user_directory:${targetUserId}`,
    scope: {
      scope_kind: 'user_id',
      scope_id: targetUserId,
    },
    source_refs: {
      user_id: targetUserId,
    },
    enqueued_at: new Date().toISOString(),
  }]);
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

function readLocalMediaMetadata(object) {
  return normalizeLocalMediaObjectMetadata({
    first_ingested_at: object.customMetadata?.first_ingested_at ?? new Date().toISOString(),
    legacy_unauth_access_flag: object.customMetadata?.legacy_unauth_access_flag === 'true',
    content_type: object.customMetadata?.content_type ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
    byte_size: object.customMetadata?.byte_size == null
      ? (object.size ?? 0)
      : Number.parseInt(object.customMetadata.byte_size, 10),
    content_hash: object.customMetadata?.content_hash ?? null,
  });
}

function readRemoteMediaMetadata(object, originServerName) {
  return normalizeRemoteMediaObjectMetadata({
    first_cached_at: object.customMetadata?.first_cached_at ?? new Date().toISOString(),
    legacy_unauth_access_flag: object.customMetadata?.legacy_unauth_access_flag === 'true',
    origin_server_name: object.customMetadata?.origin_server_name ?? originServerName,
    content_type: object.customMetadata?.content_type ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
    byte_size: object.customMetadata?.byte_size == null
      ? (object.size ?? 0)
      : Number.parseInt(object.customMetadata.byte_size, 10),
    content_hash: object.customMetadata?.content_hash ?? null,
  });
}

async function queueMediaDerivedWork(env, {
  mxcUri,
  sourceKind,
  r2ObjectKey,
  contentType,
  byteSize = null,
  contentHash = null,
  variants,
  requestedBy,
}) {
  await dispatchDerivedWork(env, requestedBy, [{
    work_type: 'media_thumbnail',
    idempotency_key: mxcUri,
    scope: {
      scope_kind: 'global',
      scope_id: null,
    },
    source_refs: {
      mxc_uri: mxcUri,
      source_kind: sourceKind,
      r2_object_key: r2ObjectKey,
      content_type: contentType,
      ...(byteSize == null ? {} : { byte_size: byteSize }),
      ...(contentHash == null ? {} : { content_hash: contentHash }),
      variants,
    },
    enqueued_at: new Date().toISOString(),
  }]);
}

async function handleMediaConfigRequest(request, env) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  return jsonResponse(buildMediaConfig(resolveConfiguredMaxUploadBytes(env)));
}

async function commitLocalMediaUpload(request, env, access, {
  mediaId = null,
  requireExisting = false,
} = {}) {
  const url = new URL(request.url);
  const filename = url.searchParams.get('filename') ?? null;
  const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
  const declaredSize = /^[0-9]+$/.test(request.headers.get('content-length') ?? '')
    ? Number.parseInt(request.headers.get('content-length'), 10)
    : 0;
  const grantResult = await access.user_do.beginMediaUpload({
    user_id: access.session.user_id,
    device_id: access.session.device_id,
    filename,
    content_type: contentType,
    declared_size: declaredSize,
    max_bytes: resolveConfiguredMaxUploadBytes(env),
    ...(mediaId == null ? {} : { media_id: mediaId }),
    ...(requireExisting ? { require_existing: true } : {}),
  });
  if (!grantResult?.ok) {
    return {
      ok: false,
      response: mapInternalErrorToResponse(grantResult?.error),
    };
  }
  const grant = grantResult.grant;
  let bodyInfo;
  const uploadedAt = new Date().toISOString();
  const legacyFlag = computeLegacyUnauthAccessFlag(uploadedAt, getMediaFreezePolicy(env));
  const objectKey = buildLocalMediaObjectKey(grant.media_id);
  try {
    const streamedBody = teeBodyStreamWithDigest(request, {
      maxBytes: grant.max_bytes,
    });
    if (streamedBody) {
      const [, streamedInfo] = await Promise.all([
        withMediaKeyBackoff(env, objectKey, () => env.MATRIX_MEDIA_BUCKET.put(objectKey, streamedBody.upload_stream, {
          customMetadata: {
            first_ingested_at: uploadedAt,
            legacy_unauth_access_flag: legacyFlag ? 'true' : 'false',
            content_type: contentType,
          },
          httpMetadata: {
            contentType,
          },
        })),
        streamedBody.digest_promise,
      ]);
      bodyInfo = streamedInfo;
    } else {
      bodyInfo = await readBodyWithDigest(request, {
        maxBytes: grant.max_bytes,
      });
      await withMediaKeyBackoff(env, objectKey, () => env.MATRIX_MEDIA_BUCKET.put(objectKey, bodyInfo.bytes, {
        customMetadata: {
          first_ingested_at: uploadedAt,
          legacy_unauth_access_flag: legacyFlag ? 'true' : 'false',
          content_type: contentType,
        },
        httpMetadata: {
          contentType,
        },
      }));
    }
  } catch (error) {
    const reverted = await deleteMediaObjectBestEffort(env, objectKey);
    await access.user_do.finalizeMediaUpload({
      pending_upload_id: grant.pending_upload_id,
      finalize_state: reverted ? 'reverted' : 'orphaned',
      ...(reverted ? {} : { r2_object_key: objectKey }),
      error_message: error.message ?? 'R2 upload failed',
      upload_completed_at: uploadedAt,
    });
    return {
      ok: false,
      response: mapInternalErrorToResponse(error),
    };
  }
  const finalize = await access.user_do.finalizeMediaUpload({
    pending_upload_id: grant.pending_upload_id,
    finalize_state: 'completed',
    r2_object_key: buildLocalMediaObjectKey(grant.media_id),
    byte_size: bodyInfo.byte_size,
    content_type: contentType,
    sha256: bodyInfo.sha256,
    upload_completed_at: uploadedAt,
  });
  if (!finalize?.ok) {
    await access.user_do.finalizeMediaUpload({
      pending_upload_id: grant.pending_upload_id,
      finalize_state: 'orphaned',
      r2_object_key: objectKey,
      error_message: finalize?.error?.message ?? 'Finalize failed after object write',
      upload_completed_at: uploadedAt,
    });
    return {
      ok: false,
      response: mapInternalErrorToResponse(finalize?.error),
    };
  }
  await queueMediaDerivedWork(env, {
    mxcUri: finalize.ack.mxc_uri,
    sourceKind: 'local',
    r2ObjectKey: buildLocalMediaObjectKey(grant.media_id),
    contentType,
    byteSize: bodyInfo.byte_size,
    contentHash: bodyInfo.sha256,
    variants: [{ width: 96, height: 96, method: 'scale', animated: false }],
    requestedBy: 'gateway.media.upload',
  });
  return {
    ok: true,
    response: jsonResponse({
      content_uri: finalize.ack.mxc_uri,
    }),
  };
}

async function handleMediaCreateRequest(request, env) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const grantResult = await access.user_do.beginMediaUpload({
    user_id: access.session.user_id,
    device_id: access.session.device_id,
    content_type: 'application/octet-stream',
    declared_size: 0,
    reservation_only: true,
  });
  if (!grantResult?.ok) {
    return mapInternalErrorToResponse(grantResult?.error);
  }
  return jsonResponse({
    content_uri: grantResult.grant.mxc_uri,
    unused_expires_at: grantResult.grant.expires_at,
  });
}

async function handleMediaUploadRequest(request, env, {
  mediaId = null,
  requireExisting = false,
} = {}) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const committed = await commitLocalMediaUpload(request, env, access, {
    mediaId,
    requireExisting,
  });
  return committed.response;
}

async function fetchRemoteMediaIntoCache(env, {
  serverName,
  mediaId,
  timeoutMs,
} = {}) {
  const normalizedServerName = String(serverName);
  const objectKey = buildRemoteMediaObjectKey(normalizedServerName, mediaId);
  const existing = await env.MATRIX_MEDIA_BUCKET.get(objectKey);
  if (existing) {
    return {
      object: existing,
      metadata: readRemoteMediaMetadata(existing, normalizedServerName),
      object_key: objectKey,
      cache_status: 'hit',
      source_kind: 'remote_cache',
    };
  }
  if (String(env.FF_MEDIA_REMOTE_FETCH ?? 'false').trim().toLowerCase() !== 'true') {
    return null;
  }
  const remoteUrl = `https://${normalizedServerName}/_matrix/media/v3/download/${encodeURIComponent(normalizedServerName)}/${encodeURIComponent(mediaId)}`;
  const fetchImpl = typeof env.__REMOTE_MEDIA_FETCH__ === 'function'
    ? env.__REMOTE_MEDIA_FETCH__
    : fetch;
  const fetched = await withMediaKeyBackoff(env, objectKey, async () => {
    const secondCheck = await env.MATRIX_MEDIA_BUCKET.get(objectKey);
    if (secondCheck) {
      return {
        object: secondCheck,
        metadata: readRemoteMediaMetadata(secondCheck, normalizedServerName),
        object_key: objectKey,
        cache_status: 'hit',
        source_kind: 'remote_cache',
      };
    }
    const response = await fetchImpl(remoteUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw Object.assign(new Error(`Remote media fetch failed with status ${response.status}`), {
        code: 'backpressure',
        retryable: true,
      });
    }
    try {
      let bodyInfo;
      const cachedAt = new Date().toISOString();
      const legacyFlag = computeLegacyUnauthAccessFlag(cachedAt, getMediaFreezePolicy(env));
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const streamedBody = teeBodyStreamWithDigest(response, {
        maxBytes: resolveConfiguredMaxUploadBytes(env),
      });
      if (streamedBody) {
        const [, streamedInfo] = await Promise.all([
          env.MATRIX_MEDIA_BUCKET.put(objectKey, streamedBody.upload_stream, {
            customMetadata: {
              first_cached_at: cachedAt,
              legacy_unauth_access_flag: legacyFlag ? 'true' : 'false',
              origin_server_name: normalizedServerName,
              content_type: contentType,
            },
            httpMetadata: {
              contentType,
            },
          }),
          streamedBody.digest_promise,
        ]);
        bodyInfo = streamedInfo;
      } else {
        bodyInfo = await readBodyWithDigest(response, {
          maxBytes: resolveConfiguredMaxUploadBytes(env),
        });
        await env.MATRIX_MEDIA_BUCKET.put(objectKey, bodyInfo.bytes, {
          customMetadata: {
            first_cached_at: cachedAt,
            legacy_unauth_access_flag: legacyFlag ? 'true' : 'false',
            origin_server_name: normalizedServerName,
            content_type: contentType,
          },
          httpMetadata: {
            contentType,
          },
        });
      }
      const cachedObject = await env.MATRIX_MEDIA_BUCKET.get(objectKey);
      await queueMediaDerivedWork(env, {
        mxcUri: buildMxcUri(normalizedServerName, mediaId),
        sourceKind: 'remote_cache',
        r2ObjectKey: objectKey,
        contentType,
        byteSize: bodyInfo.byte_size,
        contentHash: bodyInfo.sha256,
        variants: [{ width: 96, height: 96, method: 'scale', animated: false }],
        requestedBy: 'gateway.media.remote_fetch',
      });
      return cachedObject == null ? null : {
        object: cachedObject,
        metadata: readRemoteMediaMetadata(cachedObject, normalizedServerName),
        object_key: objectKey,
        cache_status: 'miss_filled',
        source_kind: 'remote_cache',
      };
    } catch (error) {
      await deleteMediaObjectBestEffort(env, objectKey);
      throw normalizeRemoteMediaFetchError(error, {
        serverName: normalizedServerName,
        mediaId,
      });
    }
  });
  return fetched;
}

async function resolveMediaObject(env, {
  serverName,
  mediaId,
  allowRemote,
  timeoutMs,
  legacyCompatibility = false,
} = {}) {
  if (serverName === env.MATRIX_SERVER_NAME) {
    const objectKey = buildLocalMediaObjectKey(mediaId);
    const object = await env.MATRIX_MEDIA_BUCKET.get(objectKey);
    if (!object) {
      return null;
    }
    const metadata = readLocalMediaMetadata(object);
    if (legacyCompatibility && !isLegacyUnauthMediaAllowed(metadata)) {
      return null;
    }
    return {
      object,
      metadata,
      object_key: objectKey,
      source_kind: 'local',
    };
  }
  const cached = await env.MATRIX_MEDIA_BUCKET.get(buildRemoteMediaObjectKey(serverName, mediaId));
  if (cached) {
    const metadata = readRemoteMediaMetadata(cached, serverName);
    if (legacyCompatibility && !isLegacyUnauthMediaAllowed(metadata)) {
      return null;
    }
    return {
      object: cached,
      metadata,
      object_key: buildRemoteMediaObjectKey(serverName, mediaId),
      source_kind: 'remote_cache',
    };
  }
  if (!allowRemote || legacyCompatibility) {
    return null;
  }
  return fetchRemoteMediaIntoCache(env, {
    serverName,
    mediaId,
    timeoutMs,
  });
}

async function handleMediaDownloadRequest(request, env, {
  serverName,
  mediaId,
  fileName = null,
  legacyCompatibility = false,
} = {}) {
  if (!legacyCompatibility) {
    const access = await requireAccessSession(request, env);
    if (!access.ok) {
      return access.response;
    }
  }
  const url = new URL(request.url);
  let options;
  try {
    options = normalizeDownloadOptions(url);
  } catch (error) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message);
  }
  let objectHandle;
  try {
    objectHandle = await resolveMediaObject(env, {
      serverName,
      mediaId,
      allowRemote: options.allow_remote,
      timeoutMs: options.timeout_ms,
      legacyCompatibility,
    });
  } catch (error) {
    return mapInternalErrorToResponse(error);
  }
  if (!objectHandle?.object) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Media does not exist');
  }
  return buildMediaResponse(objectHandle.object, {
    filename: fileName,
    contentType: objectHandle.metadata.content_type,
  });
}

async function handleMediaThumbnailRequest(request, env, {
  serverName,
  mediaId,
  legacyCompatibility = false,
} = {}) {
  if (!legacyCompatibility) {
    const access = await requireAccessSession(request, env);
    if (!access.ok) {
      return access.response;
    }
  }
  const url = new URL(request.url);
  let options;
  try {
    options = normalizeDownloadOptions(url, {
      requireThumbnail: true,
    });
  } catch (error) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message);
  }
  let source;
  try {
    source = await resolveMediaObject(env, {
      serverName,
      mediaId,
      allowRemote: options.allow_remote,
      timeoutMs: options.timeout_ms,
      legacyCompatibility,
    });
  } catch (error) {
    return mapInternalErrorToResponse(error);
  }
  if (!source?.object) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Media does not exist');
  }
  const descriptor = buildThumbnailDescriptor({
    sourceKind: source.source_kind === 'remote_cache' ? 'remote' : 'local',
    originServerName: source.source_kind === 'remote_cache' ? serverName : null,
    mediaId,
    width: options.width,
    height: options.height,
    method: options.method,
    animated: options.animated === true,
  });
  let thumbnail = await env.MATRIX_MEDIA_BUCKET.get(descriptor.key);
  if (!thumbnail) {
    try {
      const sourceBytes = typeof source.object.arrayBuffer === 'function'
        ? Buffer.from(await source.object.arrayBuffer())
        : Buffer.from(await source.object.text(), 'utf8');
      const thumbnailBody = buildThumbnailBody(sourceBytes, {
        width: options.width,
        height: options.height,
        method: options.method,
        animated: options.animated === true,
      });
      await withMediaKeyBackoff(env, descriptor.key, () => env.MATRIX_MEDIA_BUCKET.put(descriptor.key, thumbnailBody, {
        customMetadata: {
          ...descriptor.metadata,
          created_at: new Date().toISOString(),
          legacy_unauth_access_flag: isLegacyUnauthMediaAllowed(source.metadata) ? 'true' : 'false',
        },
        httpMetadata: {
          contentType: source.metadata.content_type,
        },
      }));
      thumbnail = await env.MATRIX_MEDIA_BUCKET.get(descriptor.key);
    } catch (error) {
      return mapInternalErrorToResponse(error);
    }
  }
  if (!thumbnail) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Thumbnail does not exist');
  }
  if (legacyCompatibility && thumbnail.customMetadata?.legacy_unauth_access_flag !== 'true') {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Thumbnail does not exist');
  }
  return buildMediaResponse(thumbnail, {
    contentType: source.metadata.content_type,
  });
}

function buildRoomSummaryFromDirectoryRow(row) {
  if (!row) {
    return null;
  }
  return {
    room_id: row.room_id,
    canonical_alias: row.canonical_alias ?? undefined,
    name: row.name ?? undefined,
    topic: row.topic ?? undefined,
    avatar_url: row.avatar_url ?? undefined,
    num_joined_members: row.joined_members ?? 0,
    world_readable: row.world_readable === true,
    guest_can_join: row.guest_can_join === true,
    join_rule: row.join_rules ?? 'invite',
  };
}

async function handleSearchRequest(request, env) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const roomEvents = body.search_categories?.room_events;
  if (!roomEvents || typeof roomEvents !== 'object' || Array.isArray(roomEvents)) {
    return matrixErrorResponse(400, 'M_BAD_JSON', 'search_categories.room_events is required');
  }
  const searchTerm = typeof roomEvents.search_term === 'string' ? roomEvents.search_term : '';
  if (searchTerm.length === 0) {
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'search_term is required');
  }
  const rows = await querySearchIndex(env, {
    searchTerm,
    roomIds: Array.isArray(roomEvents.filter?.rooms) ? roomEvents.filter.rooms : null,
    limit: Number.isInteger(roomEvents.filter?.limit) ? roomEvents.filter.limit : 10,
    nextBatch: roomEvents.next_batch ?? null,
  });
  const results = [];
  const state = {};
  for (const row of rows.rows) {
    const roomDo = getRoomDoStub(env, row.room_id);
    const eventResult = await roomDo.queryRoom({
      kind: 'event',
      room_id: row.room_id,
      requester_user_id: access.session.user_id,
      event_id: row.event_id,
    });
    let event = eventResult?.ok ? eventResult.event ?? null : null;
    if (!event && eventResult?.error?.code === 'archive_missing') {
      try {
        event = (await roomDo.loadRoomEventForRebuild(row.event_id)).event ?? null;
      } catch {
        event = null;
      }
    }
    if (!event) {
      continue;
    }
    results.push({
      rank: row.origin_server_ts,
      result: event,
      context: {
        events_before: [],
        events_after: [],
        start: null,
        end: null,
        profile_info: {},
      },
    });
    if (!state[row.room_id]) {
      state[row.room_id] = [];
    }
  }
  return jsonResponse({
    search_categories: {
      room_events: {
        count: results.length,
        results,
        state,
        groups: {
          room_id: {
            groups: {},
          },
        },
        highlights: [searchTerm],
        next_batch: rows.next_batch ?? undefined,
      },
    },
  });
}

async function handleUserDirectorySearchRequest(request, env) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const searchTerm = typeof body.search_term === 'string' ? body.search_term : '';
  if (searchTerm.length === 0) {
    return matrixErrorResponse(400, 'M_MISSING_PARAM', 'search_term is required');
  }
  const ignoredUserIds = await loadIgnoredUserIds(access.user_do);
  const result = await queryUserDirectory(env, {
    searchTerm,
    limit: Number.isInteger(body.limit) ? body.limit : 10,
    ignoredUserIds,
  });
  return jsonResponse(result);
}

async function handlePublicRoomsRequest(request, env, { method }) {
  if (method === 'POST') {
    const access = await requireAccessSession(request, env);
    if (!access.ok) {
      return access.response;
    }
  }
  let queryInput;
  try {
    if (method === 'GET') {
      const url = new URL(request.url);
      queryInput = extractPublicRoomsQuery({
        limit: url.searchParams.get('limit') == null ? 10 : Number.parseInt(url.searchParams.get('limit'), 10),
        since: url.searchParams.get('since') ?? null,
        filter: {
          generic_search_term: url.searchParams.get('search_term') ?? null,
        },
      });
    } else {
      const body = await readJsonObject(request);
      if (body instanceof Response) {
        return body;
      }
      queryInput = extractPublicRoomsQuery(body);
    }
  } catch (error) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message);
  }
  const result = await queryPublicRoomsWithTruthFallback(env, queryInput);
  return jsonResponse(result);
}

async function handleRoomHierarchyRequest(request, env, roomId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  if (!decodedRoomId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Room does not exist');
  }
  await ensureDerivedSchema(env);
  const derived = getDerivedPersistence(env);
  const roomDo = getRoomDoStub(env, decodedRoomId);
  const stateResult = await roomDo.queryRoom({
    kind: 'state',
    room_id: decodedRoomId,
    requester_user_id: access.session.user_id,
  });
  if (!stateResult?.ok) {
    return mapInternalErrorToResponse(stateResult?.error);
  }
  const currentRow = await resolveValidatedPublicRoomRow(env, decodedRoomId, {
    derivedRow: await derived.publicRoomDirectory.get({ room_id: decodedRoomId }),
    forceTruth: true,
  });
  const childrenState = (stateResult.state ?? [])
    .filter((event) => event.type === 'm.space.child')
    .map((event) => event.state_key)
    .filter((childRoomId) => typeof childRoomId === 'string' && childRoomId.startsWith('!'));
  const children = [];
  for (const childRoomId of childrenState) {
    const row = await resolveValidatedPublicRoomRow(env, childRoomId, {
      derivedRow: await derived.publicRoomDirectory.get({ room_id: childRoomId }),
      forceTruth: true,
    });
    if (row) {
      children.push(buildRoomSummaryFromDirectoryRow(row));
    }
  }
  return jsonResponse({
    room: buildRoomSummaryFromDirectoryRow(currentRow) ?? {
      room_id: decodedRoomId,
    },
    children,
    inaccessible_children: childrenState.filter((childRoomId) => !children.some((entry) => entry.room_id === childRoomId)),
  });
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

async function admitRoomClientEvent(roomDo, {
  roomId,
  roomVersion = null,
  requestFingerprint,
  candidateEvent,
}) {
  const result = await roomDo.admitEvent({
    request_kind: 'client',
    room_id: roomId,
    room_version: roomVersion,
    request_fingerprint: requestFingerprint,
    candidate_event: candidateEvent,
  });
  if (!result?.ok) {
    return {
      ok: false,
      response: mapInternalErrorToResponse(result?.error),
    };
  }
  const registryResult = await roomDo.ensureShardRegistry({
    room_id: roomId,
    now: new Date().toISOString(),
  });
  if (!registryResult?.ok) {
    return {
      ok: false,
      response: mapInternalErrorToResponse(registryResult?.error),
    };
  }
  return {
    ok: true,
    result,
  };
}

async function handleCreateRoom(request, env) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  let roomVersion;
  try {
    roomVersion = resolveRequestedRoomVersion(body.room_version ?? DEFAULT_ROOM_VERSION);
  } catch (error) {
    return matrixErrorResponse(400, 'M_UNSUPPORTED_ROOM_VERSION', error.message);
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'POST',
    routeTemplate: '/_matrix/client/v3/createRoom',
    principalId: access.session.user_id,
    body,
  });
  const identity = deriveCreateRoomIdentity({
    creator_user_id: access.session.user_id,
    room_version: roomVersion,
    request_fingerprint: requestFingerprint,
    server_name: env.MATRIX_SERVER_NAME,
  });
  const directoryVisibility = body.visibility === 'public' || body.preset === 'public_chat'
    ? 'public'
    : 'private';
  const roomDo = getRoomDoStub(env, identity.room_id);

  const createResult = await admitRoomClientEvent(roomDo, {
    roomId: identity.room_id,
    roomVersion,
    requestFingerprint,
    candidateEvent: {
      type: 'm.room.create',
      sender: access.session.user_id,
      state_key: '',
      content: {
        ...(isObjectRecord(body.creation_content) ? structuredClone(body.creation_content) : {}),
        creator: access.session.user_id,
        room_version: roomVersion,
      },
      unsigned: {
        public: {
          directory_visibility: directoryVisibility,
        },
        client_context: buildRoomClientContext(access, '/_matrix/client/v3/createRoom', requestFingerprint),
      },
    },
  });
  if (!createResult.ok) {
    return createResult.response;
  }

  const creatorJoinFingerprint = createRequestFingerprint({
    method: 'POST',
    routeTemplate: '/_matrix/client/v3/createRoom#creator_join',
    principalId: access.session.user_id,
    body: { room_id: identity.room_id },
  });
  const creatorJoinResult = await admitRoomClientEvent(roomDo, {
    roomId: identity.room_id,
    roomVersion,
    requestFingerprint: creatorJoinFingerprint,
    candidateEvent: {
      type: 'm.room.member',
      sender: access.session.user_id,
      state_key: access.session.user_id,
      content: {
        membership: 'join',
      },
      unsigned: {
        client_context: buildRoomClientContext(access, '/_matrix/client/v3/createRoom#creator_join', creatorJoinFingerprint),
      },
    },
  });
  if (!creatorJoinResult.ok) {
    return creatorJoinResult.response;
  }

  const joinRule = body.preset === 'public_chat' ? 'public' : (body.preset === 'trusted_private_chat' ? 'invite' : 'invite');
  const stateBootstrapEvents = [
    {
      type: 'm.room.power_levels',
      content: {
        users: {
          [access.session.user_id]: 100,
        },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
        ...(isObjectRecord(body.power_level_content_override) ? structuredClone(body.power_level_content_override) : {}),
      },
    },
    {
      type: 'm.room.join_rules',
      content: {
        join_rule: joinRule,
      },
    },
    ...(typeof body.name === 'string' && body.name.length > 0
      ? [{ type: 'm.room.name', content: { name: body.name } }]
      : []),
    ...(typeof body.topic === 'string' && body.topic.length > 0
      ? [{ type: 'm.room.topic', content: { topic: body.topic } }]
      : []),
    ...(typeof body.room_alias_name === 'string' && body.room_alias_name.trim().length > 0
      ? [{
        type: 'm.room.canonical_alias',
        content: {
          alias: `#${body.room_alias_name.trim()}:${env.MATRIX_SERVER_NAME}`,
        },
      }]
      : []),
    ...(Array.isArray(body.initial_state)
      ? body.initial_state.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      : []),
  ];
  for (let index = 0; index < stateBootstrapEvents.length; index += 1) {
    const event = stateBootstrapEvents[index];
    const stateKey = typeof event.state_key === 'string' ? event.state_key : '';
    const fingerprint = createRequestFingerprint({
      method: 'PUT',
      routeTemplate: '/_matrix/client/v3/createRoom#state_bootstrap',
      principalId: access.session.user_id,
      body: {
        room_id: identity.room_id,
        event_type: event.type,
        state_key: stateKey,
        content: event.content,
        index,
      },
    });
    const bootstrapResult = await admitRoomClientEvent(roomDo, {
      roomId: identity.room_id,
      roomVersion,
      requestFingerprint: fingerprint,
      candidateEvent: {
        type: event.type,
        sender: access.session.user_id,
        state_key: stateKey,
        content: structuredClone(event.content ?? {}),
        unsigned: {
          client_context: buildRoomClientContext(access, '/_matrix/client/v3/createRoom#state_bootstrap', fingerprint),
        },
      },
    });
    if (!bootstrapResult.ok) {
      return bootstrapResult.response;
    }
  }

  for (const invitedUser of Array.isArray(body.invite) ? body.invite : []) {
    const invitedUserId = normalizePathUserId(invitedUser, env);
    if (!invitedUserId) {
      return matrixErrorResponse(400, 'M_INVALID_PARAM', `Invite target ${invitedUser} is not local or not valid`);
    }
    const fingerprint = createRequestFingerprint({
      method: 'POST',
      routeTemplate: '/_matrix/client/v3/createRoom#invite',
      principalId: access.session.user_id,
      body: {
        room_id: identity.room_id,
        user_id: invitedUserId,
      },
    });
    const inviteResult = await admitRoomClientEvent(roomDo, {
      roomId: identity.room_id,
      roomVersion,
      requestFingerprint: fingerprint,
      candidateEvent: {
        type: 'm.room.member',
        sender: access.session.user_id,
        state_key: invitedUserId,
        content: {
          membership: 'invite',
        },
        unsigned: {
          client_context: buildRoomClientContext(access, '/_matrix/client/v3/createRoom#invite', fingerprint),
        },
      },
    });
    if (!inviteResult.ok) {
      return inviteResult.response;
    }
  }

  return jsonResponse({
    room_id: identity.room_id,
  });
}

async function handleRoomMembershipRequest(request, env, {
  kind,
  roomIdOrAlias = null,
  roomId = null,
}) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const body = request.method === 'POST'
    ? await readJsonObject(request)
    : {};
  if (body instanceof Response) {
    return body;
  }
  let decodedRoomId = roomId != null
    ? normalizePathRoomId(roomId)
    : normalizePathRoomId(roomIdOrAlias);
  if (!decodedRoomId && roomIdOrAlias != null) {
    const decodedAlias = decodePathComponent(roomIdOrAlias);
    if (decodedAlias?.startsWith('#')) {
      const aliasEntry = await resolveRoomAliasWithTruthFallback(env, decodedAlias);
      decodedRoomId = aliasEntry?.room_id ?? null;
    }
  }
  if (!decodedRoomId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Room does not exist');
  }
  if (kind === 'forget') {
    const roomDo = getRoomDoStub(env, decodedRoomId);
    const projectionResult = await roomDo.projectForSync({
      user_id: access.session.user_id,
      room_id: decodedRoomId,
      filter_flags: {
        include_leave: true,
      },
      timeline_event_ids: [],
      state_event_ids: [],
    });
    if (!projectionResult?.ok) {
      return mapInternalErrorToResponse(projectionResult?.error);
    }
    const authoritativeProjection = projectionResult.projection;
    if (authoritativeProjection?.membership_bucket !== 'leave') {
      return matrixErrorResponse(403, 'M_FORBIDDEN', 'Room must be left before it can be forgotten');
    }
    const result = await access.user_do.forgetRoom({
      user_id: access.session.user_id,
      room_id: decodedRoomId,
      room_pos: authoritativeProjection.room_pos ?? null,
      authoritative_membership_bucket: authoritativeProjection.membership_bucket,
      request_fingerprint: createRequestFingerprint({
        method: 'POST',
        routeTemplate: '/_matrix/client/v3/rooms/{roomId}/forget',
        principalId: access.session.user_id,
        body: {
          room_id: decodedRoomId,
        },
      }),
    });
    if (!result.ok) {
      return jsonResponse(result.matrix_error.body, result.matrix_error.status);
    }
    return jsonResponse({});
  }

  const roomDo = getRoomDoStub(env, decodedRoomId);
  let targetUserId = access.session.user_id;
  let membership = kind;
  const routeTemplateByKind = {
    join: roomId != null ? '/_matrix/client/v3/rooms/{roomId}/join' : '/_matrix/client/v3/join/{roomIdOrAlias}',
    leave: '/_matrix/client/v3/rooms/{roomId}/leave',
    invite: '/_matrix/client/v3/rooms/{roomId}/invite',
    ban: '/_matrix/client/v3/rooms/{roomId}/ban',
    unban: '/_matrix/client/v3/rooms/{roomId}/unban',
    kick: '/_matrix/client/v3/rooms/{roomId}/kick',
    knock: '/_matrix/client/v3/knock/{roomIdOrAlias}',
  };

  if (['invite', 'ban', 'unban', 'kick'].includes(kind)) {
    targetUserId = normalizePathUserId(body.user_id, env);
    if (!targetUserId) {
      return matrixErrorResponse(400, 'M_INVALID_PARAM', 'user_id must be a local Matrix user ID');
    }
  }
  if (kind === 'unban' || kind === 'kick' || kind === 'leave') {
    membership = 'leave';
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'POST',
    routeTemplate: routeTemplateByKind[kind],
    principalId: access.session.user_id,
    body: {
      room_id: decodedRoomId,
      target_user_id: targetUserId,
      membership,
      reason: body.reason ?? null,
    },
  });
  const result = await admitRoomClientEvent(roomDo, {
    roomId: decodedRoomId,
    requestFingerprint,
    candidateEvent: {
      type: 'm.room.member',
      sender: access.session.user_id,
      state_key: targetUserId,
      content: {
        membership,
        ...(body.reason == null ? {} : { reason: body.reason }),
      },
      unsigned: {
        client_context: buildRoomClientContext(access, routeTemplateByKind[kind], requestFingerprint),
      },
    },
  });
  if (!result.ok) {
    return result.response;
  }
  if (kind === 'join') {
    return jsonResponse({
      room_id: decodedRoomId,
    });
  }
  return jsonResponse({});
}

async function handleRoomSendEvent(request, env, roomId, eventType, txnId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  const decodedEventType = decodePathComponent(eventType);
  const decodedTxnId = decodePathComponent(txnId);
  if (!decodedRoomId || !decodedEventType || !decodedTxnId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid room send path');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'PUT',
    routeTemplate: '/_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}',
    principalId: access.session.user_id,
    body: {
      room_id: decodedRoomId,
      event_type: decodedEventType,
      txn_id: decodedTxnId,
      content: body,
    },
  });
  const result = await admitRoomClientEvent(getRoomDoStub(env, decodedRoomId), {
    roomId: decodedRoomId,
    requestFingerprint,
    candidateEvent: {
      type: decodedEventType,
      sender: access.session.user_id,
      content: body,
      unsigned: {
        client_context: buildRoomClientContext(
          access,
          '/_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}',
          decodedTxnId,
        ),
      },
    },
  });
  if (!result.ok) {
    return result.response;
  }
  return jsonResponse({
    event_id: result.result.event_id,
  });
}

async function handleRoomStateWrite(request, env, roomId, eventType, stateKey = '') {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  const decodedEventType = decodePathComponent(eventType);
  const decodedStateKey = stateKey == null ? '' : (decodePathComponent(stateKey) ?? null);
  if (!decodedRoomId || !decodedEventType || decodedStateKey == null) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid room state path');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'PUT',
    routeTemplate: '/_matrix/client/v3/rooms/{roomId}/state/{eventType}/{stateKey}',
    principalId: access.session.user_id,
    body: {
      room_id: decodedRoomId,
      event_type: decodedEventType,
      state_key: decodedStateKey,
      content: body,
    },
  });
  const stateWriteDedupeKey = canonicalJsonHash({
    room_id: decodedRoomId,
    event_type: decodedEventType,
    state_key: decodedStateKey,
  });
  const result = await admitRoomClientEvent(getRoomDoStub(env, decodedRoomId), {
    roomId: decodedRoomId,
    requestFingerprint,
    candidateEvent: {
      type: decodedEventType,
      sender: access.session.user_id,
      state_key: decodedStateKey,
      content: body,
      unsigned: {
        client_context: buildRoomClientContext(
          access,
          '/_matrix/client/v3/rooms/{roomId}/state/{eventType}/{stateKey}',
          stateWriteDedupeKey,
        ),
      },
    },
  });
  if (!result.ok) {
    return result.response;
  }
  return jsonResponse({
    event_id: result.result.event_id,
  });
}

async function handleRoomRedaction(request, env, roomId, eventId, txnId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  const decodedEventId = decodePathComponent(eventId);
  const decodedTxnId = decodePathComponent(txnId);
  if (!decodedRoomId || !decodedEventId || !decodedTxnId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid room redaction path');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const requestFingerprint = createRequestFingerprint({
    method: 'PUT',
    routeTemplate: '/_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}',
    principalId: access.session.user_id,
    body: {
      room_id: decodedRoomId,
      event_id: decodedEventId,
      txn_id: decodedTxnId,
      content: body,
    },
  });
  const result = await admitRoomClientEvent(getRoomDoStub(env, decodedRoomId), {
    roomId: decodedRoomId,
    requestFingerprint,
    candidateEvent: {
      type: 'm.room.redaction',
      sender: access.session.user_id,
      redacts: decodedEventId,
      content: body,
      unsigned: {
        client_context: buildRoomClientContext(
          access,
          '/_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}',
          decodedTxnId,
        ),
      },
    },
  });
  if (!result.ok) {
    return result.response;
  }
  return jsonResponse({
    event_id: result.result.event_id,
  });
}

async function handleRoomQueryRequest(request, env, roomId, {
  kind,
  eventId = null,
  eventType = null,
  stateKey = '',
  relType = null,
  relationEventType = null,
}) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  if (!decodedRoomId) {
    return matrixErrorResponse(404, 'M_NOT_FOUND', 'Room does not exist');
  }
  const roomVisibility = await access.user_do.getRoomSyncMembership({
    user_id: access.session.user_id,
    room_id: decodedRoomId,
  });
  if (!roomVisibility?.ok) {
    return mapInternalErrorToResponse(roomVisibility?.error);
  }
  if (roomVisibility.entry?.membership_bucket === 'forgotten') {
    return matrixErrorResponse(403, 'M_FORBIDDEN', 'The room is not visible to this user');
  }
  const url = new URL(request.url);
  const limit = url.searchParams.get('limit');
  const roomDo = getRoomDoStub(env, decodedRoomId);
  const result = await roomDo.queryRoom({
    kind,
    room_id: decodedRoomId,
    requester_user_id: access.session.user_id,
    event_id: eventId == null ? null : decodePathComponent(eventId),
    timestamp: url.searchParams.get('ts') == null ? null : Number.parseInt(url.searchParams.get('ts'), 10),
    limit: limit == null ? 10 : Number.parseInt(limit, 10),
    cursor: {
      from: url.searchParams.get('from') ?? null,
      dir: url.searchParams.get('dir') ?? null,
      event_type: kind === 'relations'
        ? (relationEventType == null ? null : decodePathComponent(relationEventType))
        : (eventType == null ? null : decodePathComponent(eventType)),
      state_key: stateKey == null ? '' : (decodePathComponent(stateKey) ?? ''),
      rel_type: relType == null ? null : decodePathComponent(relType),
    },
  });
  if (!result?.ok) {
    return mapInternalErrorToResponse(result?.error);
  }
  if (kind === 'timeline' || kind === 'relations' || kind === 'threads') {
    return jsonResponse({
      chunk: result.chunk ?? [],
      start: result.start ?? null,
      end: result.end ?? null,
    });
  }
  if (kind === 'context') {
    return jsonResponse({
      event: result.event,
      events_before: result.events_before ?? [],
      events_after: result.events_after ?? [],
      state: result.state ?? [],
      start: result.start ?? null,
      end: result.end ?? null,
    });
  }
  if (kind === 'event') {
    return jsonResponse(result.event);
  }
  if (kind === 'state') {
    if (eventType != null) {
      return jsonResponse(result.event?.content ?? {});
    }
    return jsonResponse(result.state ?? []);
  }
  if (kind === 'members') {
    return jsonResponse({
      chunk: result.chunk ?? [],
    });
  }
  if (kind === 'joined_members') {
    return jsonResponse({
      joined: result.joined ?? {},
    });
  }
  if (kind === 'timestamp_lookup') {
    return jsonResponse({
      event_id: result.event?.event_id ?? null,
      origin_server_ts: result.event?.origin_server_ts ?? null,
    });
  }
  return matrixErrorResponse(404, 'M_UNRECOGNIZED', 'Unrecognized or unsupported endpoint');
}

async function handleRoomTyping(request, env, roomId, userId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  const targetUserId = normalizePathUserId(userId, env);
  if (!decodedRoomId || !targetUserId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid typing path');
  }
  const selfError = ensureSelfAccess(access, targetUserId);
  if (selfError) {
    return selfError;
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  if (body.typing === true && (!Number.isInteger(body.timeout ?? 30_000) || (body.timeout ?? 30_000) < 1)) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'timeout must be a positive integer');
  }
  try {
    const result = await getRoomDoStub(env, decodedRoomId).setTyping({
      room_id: decodedRoomId,
      user_id: targetUserId,
      typing: body.typing === true,
      timeout_ms: body.timeout ?? 30_000,
    });
    if (!result?.ok) {
      return mapInternalErrorToResponse(result?.error);
    }
    return jsonResponse({});
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return matrixErrorResponse(400, 'M_INVALID_PARAM', error.message);
    }
    throw error;
  }
}

async function handleRoomReceipt(request, env, roomId, receiptType, eventId) {
  const access = await requireAccessSession(request, env);
  if (!access.ok) {
    return access.response;
  }
  const decodedRoomId = normalizePathRoomId(roomId);
  const decodedReceiptType = decodePathComponent(receiptType);
  const decodedEventId = decodePathComponent(eventId);
  if (!decodedRoomId || !decodedReceiptType || !decodedEventId) {
    return matrixErrorResponse(400, 'M_INVALID_PARAM', 'Invalid receipt path');
  }
  const body = await readJsonObject(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await getRoomDoStub(env, decodedRoomId).applyReceipt({
    room_id: decodedRoomId,
    user_id: access.session.user_id,
    receipt_type: decodedReceiptType,
    event_id: decodedEventId,
    thread_id: typeof body.thread_id === 'string' ? body.thread_id : '',
    receipt_ts: Number.isInteger(body.ts) ? body.ts : Date.now(),
  });
  if (!result?.ok) {
    return mapInternalErrorToResponse(result?.error);
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

  if (pathname === '/_matrix/client/v1/media/config' && method === 'GET') {
    return handleMediaConfigRequest(request, env);
  }
  const currentMediaDownloadMatch = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (currentMediaDownloadMatch && method === 'GET') {
    return handleMediaDownloadRequest(request, env, {
      serverName: decodePathComponent(currentMediaDownloadMatch[1]),
      mediaId: decodePathComponent(currentMediaDownloadMatch[2]),
      fileName: currentMediaDownloadMatch[3] == null ? null : decodePathComponent(currentMediaDownloadMatch[3]),
      legacyCompatibility: false,
    });
  }
  const currentMediaThumbnailMatch = /^\/_matrix\/client\/v1\/media\/thumbnail\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (currentMediaThumbnailMatch && method === 'GET') {
    return handleMediaThumbnailRequest(request, env, {
      serverName: decodePathComponent(currentMediaThumbnailMatch[1]),
      mediaId: decodePathComponent(currentMediaThumbnailMatch[2]),
      legacyCompatibility: false,
    });
  }
  if (/^\/_matrix\/media\/[^/]+\/config$/.test(pathname) && method === 'GET') {
    return handleMediaConfigRequest(request, env);
  }
  if (/^\/_matrix\/media\/[^/]+\/create$/.test(pathname) && method === 'POST') {
    return handleMediaCreateRequest(request, env);
  }
  if (/^\/_matrix\/media\/[^/]+\/upload$/.test(pathname) && method === 'POST') {
    return handleMediaUploadRequest(request, env);
  }
  const uploadByIdMatch = /^\/_matrix\/media\/[^/]+\/upload\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (uploadByIdMatch && method === 'PUT') {
    const serverName = decodePathComponent(uploadByIdMatch[1]);
    const mediaId = decodePathComponent(uploadByIdMatch[2]);
    if (serverName !== env.MATRIX_SERVER_NAME) {
      return matrixErrorResponse(404, 'M_NOT_FOUND', 'Only locally reserved MXC URIs are supported');
    }
    return handleMediaUploadRequest(request, env, {
      mediaId,
      requireExisting: true,
    });
  }
  const compatMediaDownloadMatch = /^\/_matrix\/media\/[^/]+\/download\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (compatMediaDownloadMatch && method === 'GET') {
    return handleMediaDownloadRequest(request, env, {
      serverName: decodePathComponent(compatMediaDownloadMatch[1]),
      mediaId: decodePathComponent(compatMediaDownloadMatch[2]),
      fileName: compatMediaDownloadMatch[3] == null ? null : decodePathComponent(compatMediaDownloadMatch[3]),
      legacyCompatibility: true,
    });
  }
  const compatMediaThumbnailMatch = /^\/_matrix\/media\/[^/]+\/thumbnail\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (compatMediaThumbnailMatch && method === 'GET') {
    return handleMediaThumbnailRequest(request, env, {
      serverName: decodePathComponent(compatMediaThumbnailMatch[1]),
      mediaId: decodePathComponent(compatMediaThumbnailMatch[2]),
      legacyCompatibility: true,
    });
  }

  if (pathname === '/_matrix/client/v3/search' && method === 'POST') {
    return handleSearchRequest(request, env);
  }
  if (pathname === '/_matrix/client/v3/user_directory/search' && method === 'POST') {
    return handleUserDirectorySearchRequest(request, env);
  }
  if (pathname === '/_matrix/client/v3/publicRooms' && method === 'GET') {
    return handlePublicRoomsRequest(request, env, { method });
  }
  if (pathname === '/_matrix/client/v3/publicRooms' && method === 'POST') {
    return handlePublicRoomsRequest(request, env, { method });
  }

  if (pathname === '/_matrix/client/v3/createRoom' && method === 'POST') {
    return handleCreateRoom(request, env);
  }
  const roomJoinByAliasMatch = /^\/_matrix\/client\/v3\/join\/([^/]+)$/.exec(pathname);
  if (roomJoinByAliasMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'join',
      roomIdOrAlias: roomJoinByAliasMatch[1],
    });
  }
  const roomJoinMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/join$/.exec(pathname);
  if (roomJoinMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'join',
      roomId: roomJoinMatch[1],
    });
  }
  const roomLeaveMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/leave$/.exec(pathname);
  if (roomLeaveMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'leave',
      roomId: roomLeaveMatch[1],
    });
  }
  const roomInviteMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/invite$/.exec(pathname);
  if (roomInviteMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'invite',
      roomId: roomInviteMatch[1],
    });
  }
  const roomBanMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/ban$/.exec(pathname);
  if (roomBanMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'ban',
      roomId: roomBanMatch[1],
    });
  }
  const roomUnbanMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/unban$/.exec(pathname);
  if (roomUnbanMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'unban',
      roomId: roomUnbanMatch[1],
    });
  }
  const roomKickMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/kick$/.exec(pathname);
  if (roomKickMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'kick',
      roomId: roomKickMatch[1],
    });
  }
  const roomKnockMatch = /^\/_matrix\/client\/v3\/knock\/([^/]+)$/.exec(pathname);
  if (roomKnockMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'knock',
      roomIdOrAlias: roomKnockMatch[1],
    });
  }
  const roomForgetMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/forget$/.exec(pathname);
  if (roomForgetMatch && method === 'POST') {
    return handleRoomMembershipRequest(request, env, {
      kind: 'forget',
      roomId: roomForgetMatch[1],
    });
  }
  const roomSendMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (roomSendMatch && method === 'PUT') {
    return handleRoomSendEvent(request, env, roomSendMatch[1], roomSendMatch[2], roomSendMatch[3]);
  }
  const roomStateWithKeyMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (roomStateWithKeyMatch && method === 'PUT') {
    return handleRoomStateWrite(request, env, roomStateWithKeyMatch[1], roomStateWithKeyMatch[2], roomStateWithKeyMatch[3]);
  }
  const roomStateWithoutKeyWriteMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)$/.exec(pathname);
  if (roomStateWithoutKeyWriteMatch && method === 'PUT') {
    return handleRoomStateWrite(request, env, roomStateWithoutKeyWriteMatch[1], roomStateWithoutKeyWriteMatch[2], '');
  }
  const roomRedactMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (roomRedactMatch && method === 'PUT') {
    return handleRoomRedaction(request, env, roomRedactMatch[1], roomRedactMatch[2], roomRedactMatch[3]);
  }
  const roomMessagesMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/.exec(pathname);
  if (roomMessagesMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomMessagesMatch[1], {
      kind: 'timeline',
    });
  }
  const roomContextMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/context\/([^/]+)$/.exec(pathname);
  if (roomContextMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomContextMatch[1], {
      kind: 'context',
      eventId: roomContextMatch[2],
    });
  }
  const roomEventMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/event\/([^/]+)$/.exec(pathname);
  if (roomEventMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomEventMatch[1], {
      kind: 'event',
      eventId: roomEventMatch[2],
    });
  }
  const roomStateAllMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state$/.exec(pathname);
  if (roomStateAllMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomStateAllMatch[1], {
      kind: 'state',
    });
  }
  if (roomStateWithKeyMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomStateWithKeyMatch[1], {
      kind: 'state',
      eventType: roomStateWithKeyMatch[2],
      stateKey: roomStateWithKeyMatch[3],
    });
  }
  if (roomStateWithoutKeyWriteMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomStateWithoutKeyWriteMatch[1], {
      kind: 'state',
      eventType: roomStateWithoutKeyWriteMatch[2],
      stateKey: '',
    });
  }
  const roomMembersMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/members$/.exec(pathname);
  if (roomMembersMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomMembersMatch[1], {
      kind: 'members',
    });
  }
  const roomJoinedMembersMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/.exec(pathname);
  if (roomJoinedMembersMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomJoinedMembersMatch[1], {
      kind: 'joined_members',
    });
  }
  const roomRelationsFullMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/relations\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (roomRelationsFullMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomRelationsFullMatch[1], {
      kind: 'relations',
      eventId: roomRelationsFullMatch[2],
      relType: roomRelationsFullMatch[3],
      relationEventType: roomRelationsFullMatch[4],
    });
  }
  const roomRelationsTypedMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (roomRelationsTypedMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomRelationsTypedMatch[1], {
      kind: 'relations',
      eventId: roomRelationsTypedMatch[2],
      relType: roomRelationsTypedMatch[3],
    });
  }
  const roomRelationsMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/relations\/([^/]+)$/.exec(pathname);
  if (roomRelationsMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomRelationsMatch[1], {
      kind: 'relations',
      eventId: roomRelationsMatch[2],
    });
  }
  const roomThreadsMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/threads$/.exec(pathname);
  if (roomThreadsMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomThreadsMatch[1], {
      kind: 'threads',
    });
  }
  const roomTimestampMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/timestamp_to_event$/.exec(pathname);
  if (roomTimestampMatch && method === 'GET') {
    return handleRoomQueryRequest(request, env, roomTimestampMatch[1], {
      kind: 'timestamp_lookup',
    });
  }
  const roomHierarchyMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/hierarchy$/.exec(pathname);
  if (roomHierarchyMatch && method === 'GET') {
    return handleRoomHierarchyRequest(request, env, roomHierarchyMatch[1]);
  }
  const roomTypingMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/typing\/([^/]+)$/.exec(pathname);
  if (roomTypingMatch && method === 'PUT') {
    return handleRoomTyping(request, env, roomTypingMatch[1], roomTypingMatch[2]);
  }
  const roomReceiptMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/receipt\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (roomReceiptMatch && method === 'POST') {
    return handleRoomReceipt(request, env, roomReceiptMatch[1], roomReceiptMatch[2], roomReceiptMatch[3]);
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
