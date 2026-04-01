import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import {
  REMOTE_SERVER_DO_SCHEMA_VERSION,
  createRemoteServerDurableObjectPersistence,
} from './remote-server-persistence.mjs';
import {
  ROOM_DO_SCHEMA_VERSION,
  createRoomDurableObjectPersistence,
} from './room-persistence.mjs';
import {
  bindSqlStorageTransactionSync,
  normalizeInteger,
  normalizeString,
  withSqliteTransaction,
} from './persistence-common.mjs';
import {
  DEFAULT_ROOM_VERSION,
  buildRoomStateTupleKey,
  decodeRoomCursor,
  deriveCreateRoomIdentity,
  deriveDeterministicEventId,
  encodeRoomCursor,
  isSupportedRoomVersion,
  redactEventForRoomVersion,
  resolveRequestedRoomVersion,
} from './room-domain.mjs';
import { createAsyncTaskContext, createRequestContext } from './structured-logging.mjs';
import {
  incrementMetric,
  observeMetric,
} from './telemetry.mjs';
import { loadWorkerRuntimeConfig } from './runtime-manifest.mjs';
import { enforceSemanticQuota } from './abuse-guard.mjs';
import {
  DEFAULT_ACCESS_TOKEN_TTL_MS,
  DEFAULT_REFRESH_TOKEN_TTL_MS,
  buildLocalUserId,
  extractLoginLocalpart,
  generateDeviceId,
  generateSessionId,
  getRefreshTokenUserIdHint,
  hashOpaqueToken,
  hashPassword,
  issueAccessToken,
  issueRefreshToken,
  normalizeLocalpart,
  normalizeLocalUserIdentifier,
  parseSessionRootKeyRing,
  verifyPassword,
} from './user-identity.mjs';
import {
  PROFILE_KEY_AVATAR_URL,
  PROFILE_KEY_DISPLAYNAME,
  PROFILE_KEY_TIMEZONE,
  assertProfileDocumentSize,
  assertPushRulesStorageLimits,
  buildPushRuleWriteRecord,
  buildPushRulesAccountDataEvent,
  buildPushRulesView,
  computePushRulePriorityIndex,
  createStoredFilterEnvelope,
  filterEventList,
  getNextPushRulePriorityIndex,
  getSyncFilterFlags,
  isAllowedProfileKey,
  issueSyncToken,
  normalizeFilterDefinition,
  normalizeStoredFilterId,
  parseSyncToken,
  reindexPushRuleRows,
  validateProfileFieldValue,
  validatePushRuleId,
  validatePushRuleKind,
  wakeSyncWaiters,
} from './client-domain.mjs';
import {
  USER_DO_SCHEMA_VERSION,
  createUserDurableObjectPersistence,
} from './user-persistence.mjs';
import { canonicalJsonHash, makeId } from './fingerprints.mjs';
import {
  DEFAULT_MEDIA_ORPHAN_RETENTION_MS,
  DEFAULT_MEDIA_PENDING_UPLOAD_TTL_MS,
  buildMxcUri,
} from './media-domain.mjs';
import { enqueueDerivedWork, RUNTIME_JOB_SCHEMA_VERSION } from './runtime-jobs.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function createMatrixError(status, errcode, error, extra = null) {
  return {
    ok: false,
    matrix_error: {
      status,
      body: {
        errcode,
        error,
        ...(extra ?? {}),
      },
    },
  };
}

function createSuccessResult(payload = {}) {
  return {
    ok: true,
    ...payload,
  };
}

function mapPushRuleWriteErrorToMatrixError(error) {
  try {
    const decoded = JSON.parse(error.message);
    if (decoded?.errcode) {
      return createMatrixError(decoded.status, decoded.errcode, decoded.error);
    }
  } catch {
    // Fall through to the generic invalid-parameter envelope.
  }
  return createMatrixError(400, 'M_INVALID_PARAM', error?.message ?? 'Invalid push rule update');
}

function isoAfter(nowIso, ttlMs) {
  return new Date(Date.parse(nowIso) + ttlMs).toISOString();
}

function toMillisOrInfinity(value) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function sessionRowToPutRecord(session, overrides = {}) {
  const next = {
    ...session,
    ...overrides,
  };
  return {
    session_id: next.session_id,
    access_token_hash: next.access_token_hash ?? null,
    refresh_token_hash: next.refresh_token_hash ?? null,
    device_id: next.device_id,
    auth_version: next.auth_version,
    session_epoch: next.session_epoch ?? 0,
    is_guest: next.is_guest ?? false,
    created_at: next.created_at,
    updated_at: next.updated_at,
    expires_at: next.expires_at ?? null,
    refresh_expires_at: next.refresh_expires_at ?? null,
    revoked_at: next.revoked_at ?? null,
    record_json: next.record ?? {},
  };
}

function deviceRowToPutRecord(device, overrides = {}) {
  const next = {
    ...device,
    ...overrides,
  };
  return {
    device_id: next.device_id,
    display_name: next.display_name ?? null,
    created_at: next.created_at,
    updated_at: next.updated_at,
    last_seen_at: next.last_seen_at ?? null,
    last_seen_ip: next.last_seen_ip ?? null,
    deleted_at: next.deleted_at ?? null,
    record_json: next.record ?? {},
  };
}

function principalRowToPutRecord(principal, overrides = {}) {
  const next = {
    ...principal,
    ...overrides,
  };
  return {
    user_id: next.user_id,
    localpart: next.localpart,
    user_type: next.user_type ?? null,
    password_hash_or_null: next.password_hash_or_null ?? null,
    password_login_enabled: next.password_login_enabled ?? true,
    created_at: next.created_at,
    deactivated_at_or_null: next.deactivated_at_or_null ?? null,
    erase_requested_flag: next.erase_requested_flag ?? false,
    auth_version: next.auth_version,
    registration_source: next.registration_source ?? null,
    record: next.record ?? {},
  };
}

function readPhase04Meta(principal) {
  const candidate = principal?.record?.phase04;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }
  return candidate;
}

function mergePhase04Meta(principal, patch) {
  const existing = readPhase04Meta(principal);
  return {
    ...(principal?.record ?? {}),
    phase04: {
      ...existing,
      ...patch,
    },
  };
}

function makeTokenResponse({
  userId,
  deviceId,
  accessToken,
  refreshToken,
}) {
  return {
    user_id: userId,
    access_token: accessToken,
    device_id: deviceId,
    refresh_token: refreshToken,
    expires_in_ms: DEFAULT_ACCESS_TOKEN_TTL_MS,
  };
}

function findSessionByHashedToken(persistence, fieldName, hashedToken) {
  return persistence.sessions.list().find((session) => session[fieldName] === hashedToken) ?? null;
}

function getSessionTokenRevision(session) {
  return Number.isInteger(session?.record?.token_revision) && session.record.token_revision >= 0
    ? session.record.token_revision
    : 0;
}

function getSessionTokenRootKeyVersion(session) {
  return typeof session?.record?.token_root_key_version === 'string' && session.record.token_root_key_version.length > 0
    ? session.record.token_root_key_version
    : null;
}

function issueSessionTokens(env, {
  userId,
  sessionId,
  tokenRevision,
  tokenRootKeyVersion = null,
}) {
  const resolvedTokenRootKeyVersion = tokenRootKeyVersion ?? parseSessionRootKeyRing(env.SESSION_ROOT_KEY_RING).active_version;
  return {
    accessToken: issueAccessToken(userId, {
      sessionId,
      tokenRevision,
      secretValue: env.SESSION_ROOT_KEY_RING,
      tokenRootKeyVersion: resolvedTokenRootKeyVersion,
    }),
    refreshToken: issueRefreshToken(userId, {
      sessionId,
      tokenRevision,
      secretValue: env.SESSION_ROOT_KEY_RING,
      tokenRootKeyVersion: resolvedTokenRootKeyVersion,
    }),
    tokenRootKeyVersion: resolvedTokenRootKeyVersion,
  };
}

function isSessionUsable({
  session,
  principal,
  runtimeState,
  device,
  nowIso,
}) {
  if (!session) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'invalid_token',
        message: 'Session token does not exist',
        retryable: false,
      }),
    };
  }
  if (!principal) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'unknown_session',
        message: 'User principal does not exist',
        retryable: false,
      }),
    };
  }
  if (principal.deactivated_at_or_null) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'deactivated_account',
        message: 'The account has been deactivated',
        retryable: false,
      }),
    };
  }
  if (session.revoked_at) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'invalid_token',
        message: 'The session has been revoked',
        retryable: false,
      }),
    };
  }
  if (toMillisOrInfinity(session.expires_at) <= Date.parse(nowIso)) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'expired_session',
        message: 'The session has expired',
        retryable: false,
      }),
    };
  }
  if (session.auth_version !== principal.auth_version || session.session_epoch !== runtimeState.session_epoch) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'expired_session',
        message: 'The session is behind the current authentication epoch',
        retryable: false,
      }),
    };
  }
  if (!device || device.deleted_at) {
    return {
      valid: false,
      error: createInternalErrorEnvelope({
        code: 'unknown_session',
        message: 'The session device no longer exists',
        retryable: false,
      }),
    };
  }
  return {
    valid: true,
  };
}

function resolvePasswordUserId({ sessionContext, localpart, serverName }) {
  if (sessionContext?.user_id) {
    return sessionContext.user_id;
  }
  return buildLocalUserId(localpart, serverName);
}

function getProfileRowsOrderedByVersion(persistence) {
  return persistence.profileDocument.list().slice().sort((left, right) => {
    return left.profile_version - right.profile_version || left.key_name.localeCompare(right.key_name);
  });
}

function getNextProfileVersion(persistence) {
  return getProfileRowsOrderedByVersion(persistence).reduce((maxValue, row) => {
    return Math.max(maxValue, row.profile_version);
  }, 0) + 1;
}

function serializeProfileDocumentFromPersistence(persistence) {
  const document = {};
  for (const row of persistence.profileDocument.list()) {
    document[row.key_name] = structuredClone(row.value);
  }
  return document;
}

function buildDefaultPresenceRecord(userId, now) {
  return {
    user_id: userId,
    presence: 'offline',
    status_msg: null,
    currently_active: false,
    last_active_at: now,
    presence_version: 1,
    updated_at: now,
    record: {},
  };
}

function buildPresenceContent({
  userId,
  presenceRecord,
  profileDocument,
  now,
}) {
  const effectivePresence = presenceRecord ?? buildDefaultPresenceRecord(userId, now);
  return {
    presence: effectivePresence.presence,
    currently_active: effectivePresence.currently_active,
    ...(effectivePresence.status_msg == null ? {} : { status_msg: effectivePresence.status_msg }),
    ...(effectivePresence.last_active_at == null ? {} : { last_active_at: effectivePresence.last_active_at }),
    ...(profileDocument.displayname == null ? {} : { displayname: profileDocument.displayname }),
    ...(profileDocument.avatar_url == null ? {} : { avatar_url: profileDocument.avatar_url }),
  };
}

function buildGlobalAccountDataEvent(type, content) {
  return {
    type,
    content: structuredClone(content ?? {}),
  };
}

function buildRoomAccountDataEvent(roomId, type, content) {
  return {
    room_id: roomId,
    type,
    content: structuredClone(content ?? {}),
  };
}

function buildToDeviceEvent(entry) {
  return {
    sender: entry.sender_user_id,
    type: entry.event_type,
    content: structuredClone(entry.payload ?? {}),
  };
}

const ROOM_SYNC_VISIBLE_BUCKETS = new Set(['join', 'invite', 'knock', 'leave']);
const SHARD_REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shard_registry (
  shard_type TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (shard_type, shard_key)
);
`;
const REGISTRY_RETRY_BASE_MS = 2_000;
const REGISTRY_RETRY_MAX_MS = 60_000;
const MEDIA_CLEANUP_RETRY_MS = 60_000;

async function ensureShardRegistrySchema(env) {
  const db = env?.MATRIX_CONTROL_D1;
  if (!db || typeof db.prepare !== 'function') {
    throw createInternalErrorEnvelope({
      code: 'internal',
      message: 'Missing MATRIX_CONTROL_D1 binding for shard registry barrier',
      retryable: false,
    });
  }
  if (!env.__SHARD_REGISTRY_SCHEMA_READY__) {
    // D1 prepared statements are the stable request-path API; `exec()` is documented as a less-safe
    // maintenance/one-shot surface and local runtimes can diverge on its return-shape semantics.
    const prepared = db.prepare(SHARD_REGISTRY_SCHEMA_SQL);
    const runnable = typeof prepared?.run === 'function'
      ? prepared
      : typeof prepared?.bind === 'function'
        ? prepared.bind()
        : null;
    if (!runnable || typeof runnable.run !== 'function') {
      throw createInternalErrorEnvelope({
        code: 'internal',
        message: 'MATRIX_CONTROL_D1 prepare() must return a runnable prepared statement',
        retryable: false,
      });
    }
    env.__SHARD_REGISTRY_SCHEMA_READY__ = runnable.run();
  }
  await env.__SHARD_REGISTRY_SCHEMA_READY__;
  return db;
}

async function upsertShardRegistryBarrier(env, {
  shardType,
  shardKey,
  schemaVersion,
  nowIso,
}) {
  const db = await ensureShardRegistrySchema(env);
  await db.prepare(`
    INSERT INTO shard_registry (
      shard_type, shard_key, created_at, last_seen_at, schema_version, disabled_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(shard_type, shard_key) DO UPDATE SET
      last_seen_at = CASE
        WHEN shard_registry.last_seen_at > excluded.last_seen_at THEN shard_registry.last_seen_at
        ELSE excluded.last_seen_at
      END,
      schema_version = CASE
        WHEN shard_registry.schema_version > excluded.schema_version THEN shard_registry.schema_version
        ELSE excluded.schema_version
      END,
      disabled_at = CASE
        WHEN shard_registry.disabled_at IS NULL THEN excluded.disabled_at
        WHEN excluded.disabled_at IS NULL THEN shard_registry.disabled_at
        WHEN shard_registry.disabled_at > excluded.disabled_at THEN shard_registry.disabled_at
        ELSE excluded.disabled_at
      END
  `).bind(
    normalizeString(shardType, 'shardType'),
    normalizeString(shardKey, 'shardKey'),
    normalizeString(nowIso, 'nowIso'),
    normalizeString(nowIso, 'nowIso'),
    normalizeInteger(schemaVersion, 'schemaVersion', { min: 1 }),
    null,
  ).run();
}

function readRegistryRetryMarker(record) {
  const marker = record?.registry_upsert_pending;
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    ? structuredClone(marker)
    : null;
}

function clearRegistryRetryMarker(record) {
  const next = {
    ...(record ?? {}),
  };
  delete next.registry_upsert_pending;
  return next;
}

function withRegistryRetryMarker(record, marker) {
  return {
    ...(record ?? {}),
    registry_upsert_pending: structuredClone(marker),
  };
}

function getRegistryRetryAtMillis(marker) {
  const nextRetryAt = typeof marker?.next_retry_at === 'string' ? marker.next_retry_at : '';
  const retryAtMs = Date.parse(nextRetryAt);
  return Number.isFinite(retryAtMs) ? retryAtMs : null;
}

function buildRegistryRetryMarker({
  existingMarker = null,
  shardType,
  shardKey,
  schemaVersion,
  nowIso,
  error,
}) {
  const previousAttemptCount = Number.isInteger(existingMarker?.attempt_count) && existingMarker.attempt_count >= 0
    ? existingMarker.attempt_count
    : 0;
  const attemptCount = previousAttemptCount + 1;
  const delayMs = Math.min(
    REGISTRY_RETRY_BASE_MS * (2 ** Math.min(attemptCount - 1, 5)),
    REGISTRY_RETRY_MAX_MS,
  );
  return {
    shard_type: normalizeString(shardType, 'shardType'),
    shard_key: normalizeString(shardKey, 'shardKey'),
    schema_version: normalizeInteger(schemaVersion, 'schemaVersion', { min: 1 }),
    attempt_count: attemptCount,
    first_failed_at: typeof existingMarker?.first_failed_at === 'string'
      ? existingMarker.first_failed_at
      : normalizeString(nowIso, 'nowIso'),
    last_failed_at: normalizeString(nowIso, 'nowIso'),
    next_retry_at: new Date(Date.parse(nowIso) + delayMs).toISOString(),
    last_error: error?.message ?? String(error ?? 'Shard registry barrier failed'),
  };
}

function createShardRegistryBarrierError({ shardType, shardKey, error }) {
  if (error?.code && error?.message) {
    return error;
  }
  return createInternalErrorEnvelope({
    code: 'backpressure',
    message: `Shard registry upsert failed for ${shardType}/${shardKey}: ${error?.message ?? String(error)}`,
    retryable: true,
    details: {
      shard_type: shardType,
      shard_key: shardKey,
    },
  });
}

function getUserMediaLifecycleNextAlarm(userDo, nowIso) {
  return sweepPendingUploadGrants(userDo, nowIso, { applyChanges: false }).next_alarm_at;
}

function earlierIso(leftIso, rightIso) {
  if (leftIso == null) {
    return rightIso ?? null;
  }
  if (rightIso == null) {
    return leftIso;
  }
  return Date.parse(leftIso) <= Date.parse(rightIso) ? leftIso : rightIso;
}

function getUserDoStub(env, userId) {
  const namespace = env?.USER_DO;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new TypeError('env.USER_DO must expose a Durable Object namespace');
  }
  return namespace.get(namespace.idFromName(userId));
}

function getRoomDoStub(env, roomId) {
  const namespace = env?.ROOM_DO;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new TypeError('env.ROOM_DO must expose a Durable Object namespace');
  }
  return namespace.get(namespace.idFromName(roomId));
}

function normalizeRoomMembershipBucket(value, { allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError('membership_bucket must be present');
  }
  const normalized = normalizeString(value, 'membership_bucket');
  if (normalized === 'ban') {
    return 'leave';
  }
  if (['join', 'invite', 'knock', 'leave', 'forgotten'].includes(normalized)) {
    return normalized;
  }
  throw new TypeError('membership_bucket must be one of join, invite, knock, leave, ban, or forgotten');
}

function readRoomSyncMembershipMap(principal) {
  const candidate = principal?.record?.room_sync_memberships;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }
  const entries = {};
  for (const [roomId, value] of Object.entries(candidate)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    try {
      const membershipBucket = normalizeRoomMembershipBucket(value.membership_bucket, { allowNull: false });
      entries[roomId] = {
        room_id: roomId,
        membership_bucket: membershipBucket,
        room_pos: Number.isInteger(value.room_pos) && value.room_pos >= 0 ? value.room_pos : 0,
        updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
      };
    } catch {
      continue;
    }
  }
  return entries;
}

function readForgottenRoomTombstones(principal) {
  const candidate = principal?.record?.forgotten_room_tombstones;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }
  const entries = {};
  for (const [roomId, value] of Object.entries(candidate)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    entries[roomId] = {
      room_id: roomId,
      room_pos: Number.isInteger(value.room_pos) && value.room_pos >= 0 ? value.room_pos : 0,
      updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
    };
  }
  return entries;
}

function listRoomSyncMembershipEntries(principal) {
  return Object.values(readRoomSyncMembershipMap(principal))
    .filter((entry) => ROOM_SYNC_VISIBLE_BUCKETS.has(entry.membership_bucket))
    .sort((left, right) => {
      return left.room_pos - right.room_pos || left.room_id.localeCompare(right.room_id);
    });
}

function mergeRoomSyncMembershipRecord(principal, {
  room_id,
  membership_bucket,
  room_pos = 0,
  updated_at = new Date().toISOString(),
}) {
  const existing = readRoomSyncMembershipMap(principal);
  const forgotten = readForgottenRoomTombstones(principal);
  const normalizedRoomId = normalizeString(room_id, 'room_id');
  const normalizedBucket = normalizeRoomMembershipBucket(membership_bucket, { allowNull: false });
  if (normalizedBucket === 'forgotten') {
    delete existing[normalizedRoomId];
    forgotten[normalizedRoomId] = {
      room_id: normalizedRoomId,
      room_pos: normalizeInteger(room_pos, 'room_pos', { min: 0 }),
      updated_at: normalizeString(updated_at, 'updated_at'),
    };
  } else {
    existing[normalizedRoomId] = {
      room_id: normalizedRoomId,
      membership_bucket: normalizedBucket,
      room_pos: normalizeInteger(room_pos, 'room_pos', { min: 0 }),
      updated_at: normalizeString(updated_at, 'updated_at'),
    };
    delete forgotten[normalizedRoomId];
  }
  return {
    ...(principal?.record ?? {}),
    room_sync_memberships: existing,
    forgotten_room_tombstones: forgotten,
  };
}

function uniqueStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function normalizeRoomFanoutDelta(delta = {}) {
  return {
    room_id: normalizeString(delta.room_id, 'delta.room_id'),
    room_pos: normalizeInteger(delta.room_pos, 'delta.room_pos', { min: 1 }),
    user_id: normalizeString(delta.user_id, 'delta.user_id'),
    membership_bucket: normalizeRoomMembershipBucket(delta.membership_bucket, { allowNull: false }),
    event_id: delta.event_id == null ? null : normalizeString(delta.event_id, 'delta.event_id'),
    origin_server_ts: Number.isInteger(delta.origin_server_ts) && delta.origin_server_ts >= 0
      ? delta.origin_server_ts
      : null,
    timeline_event_ids: uniqueStringArray(delta.timeline_event_ids),
    state_event_ids: uniqueStringArray(delta.state_event_ids),
    limited: delta.limited === true,
    prev_batch: typeof delta.prev_batch === 'string' && delta.prev_batch.length > 0 ? delta.prev_batch : null,
    notification_count: Number.isInteger(delta.notification_count) && delta.notification_count >= 0
      ? delta.notification_count
      : null,
    highlight_count: Number.isInteger(delta.highlight_count) && delta.highlight_count >= 0
      ? delta.highlight_count
      : null,
    unread_thread_notifications: delta.unread_thread_notifications && typeof delta.unread_thread_notifications === 'object'
      ? structuredClone(delta.unread_thread_notifications)
      : null,
    summary: delta.summary && typeof delta.summary === 'object' && !Array.isArray(delta.summary)
      ? structuredClone(delta.summary)
      : null,
    ephemeral_events: Array.isArray(delta.ephemeral_events)
      ? structuredClone(delta.ephemeral_events)
      : [],
  };
}

function buildRoomFanoutDedupeKey(delta) {
  return `${delta.room_id}|${delta.room_pos}|${delta.user_id}`;
}

function parseSnapshotRoomPos(snapshot) {
  if (Number.isInteger(snapshot?.record?.room_pos) && snapshot.record.room_pos >= 1) {
    return snapshot.record.room_pos;
  }
  if (typeof snapshot?.snapshot_id !== 'string') {
    return null;
  }
  const match = /^snapshot-(\d+)$/.exec(snapshot.snapshot_id);
  if (!match) {
    return null;
  }
  return normalizeInteger(Number.parseInt(match[1], 10), 'snapshot.room_pos', { min: 1 });
}

function buildProfileRefreshEventId(roomId, userId, profileVersion) {
  return `$profile_refresh_${Buffer.from(`${roomId}|${userId}|${profileVersion}`, 'utf8').toString('base64url')}`;
}

function getProfileRefreshInfo(candidateEvent) {
  if (!isObjectRecord(candidateEvent?.unsigned?.public)) {
    return null;
  }
  const propagationKind = candidateEvent.unsigned.public.propagation_kind;
  const profileVersion = candidateEvent.unsigned.public.profile_version;
  if (propagationKind !== 'profile_refresh' || !Number.isInteger(profileVersion)) {
    return null;
  }
  return {
    profileVersion,
  };
}

function isStaleProfileRefreshOutboxItem(persistence, item) {
  if (item?.record?.propagation_kind !== 'profile_refresh') {
    return false;
  }
  const userId = item?.record?.profile_owner_user_id ?? item?.user_id ?? item?.delta?.user_id ?? null;
  const itemProfileVersion = Number.isInteger(item?.record?.profile_version) ? item.record.profile_version : null;
  if (!userId || itemProfileVersion == null) {
    return false;
  }
  const membership = persistence.membershipProjection.get({ user_id: userId });
  return Number.isInteger(membership?.profile_version) && membership.profile_version > itemProfileVersion;
}

function parseCanonicalRoomEvent(row) {
  if (!row?.canonical_json) {
    return null;
  }
  return structuredClone(JSON.parse(row.canonical_json));
}

function buildRoomMemberRefreshEvent({
  roomId,
  userId,
  eventId,
  roomPos,
  displayname = null,
  avatarUrl = null,
  profileVersion,
  updatedAt,
}) {
  const content = {
    membership: 'join',
    ...(displayname == null ? {} : { displayname }),
    ...(avatarUrl == null ? {} : { avatar_url: avatarUrl }),
  };
  return {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    origin_server_ts: Date.parse(updatedAt),
    room_pos: roomPos,
    content,
    unsigned: {
      profile_version: profileVersion,
      propagation_kind: 'profile_refresh',
    },
  };
}

function buildRoomSyncSummary(persistence) {
  const memberships = persistence.membershipProjection.list();
  const joinedMemberCount = memberships.filter((row) => row.membership === 'join').length;
  const invitedMemberCount = memberships.filter((row) => row.membership === 'invite').length;
  return {
    joined_member_count: joinedMemberCount,
    invited_member_count: invitedMemberCount,
  };
}

function buildRoomSyncSummaryFromSnapshot(roomDo, snapshotId) {
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    return buildRoomSyncSummary(roomDo.persistence);
  }
  let joinedMemberCount = 0;
  let invitedMemberCount = 0;
  for (const row of roomDo.persistence.stateEntries.list()) {
    if (row.snapshot_id !== snapshotId || row.event_type !== 'm.room.member') {
      continue;
    }
    const event = roomDo.loadRoomEventById(row.event_id).event;
    const membership = typeof event?.content?.membership === 'string' ? event.content.membership : null;
    if (membership === 'join') {
      joinedMemberCount += 1;
    } else if (membership === 'invite') {
      invitedMemberCount += 1;
    }
  }
  return {
    joined_member_count: joinedMemberCount,
    invited_member_count: invitedMemberCount,
  };
}

function cloneJson(value) {
  return value == null ? value : structuredClone(value);
}

function isObjectRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createRoomInternalError(code, message, { retryable = false, details = null } = {}) {
  return createInternalErrorEnvelope({
    code,
    message,
    retryable,
    details,
  });
}

function normalizeRoomEventType(value) {
  return normalizeString(value, 'event.type');
}

function normalizeRoomReadKind(value) {
  const normalized = normalizeString(value, 'request.kind');
  if (!['timeline', 'context', 'event', 'state', 'members', 'joined_members', 'relations', 'threads', 'timestamp_lookup'].includes(normalized)) {
    throw new TypeError('request.kind is not supported');
  }
  return normalized;
}

function normalizeRequestKind(value) {
  const normalized = normalizeString(value, 'request.request_kind');
  if (!['client', 'federation', 'repair', 'backfill', 'appservice'].includes(normalized)) {
    throw new TypeError('request.request_kind is not supported');
  }
  return normalized;
}

function stateKeyForEvent(candidateEvent) {
  return typeof candidateEvent?.state_key === 'string' ? candidateEvent.state_key : null;
}

function getRelationInfo(candidateEvent) {
  const relatesTo = candidateEvent?.content?.['m.relates_to'];
  if (!isObjectRecord(relatesTo) || typeof relatesTo.event_id !== 'string') {
    return {
      relates_to_event_id_or_null: null,
      relation_type_or_null: null,
      aggregation_event_type_or_null: null,
      thread_root_event_id_or_null: null,
    };
  }
  const relationType = typeof relatesTo.rel_type === 'string' ? relatesTo.rel_type : null;
  return {
    relates_to_event_id_or_null: relatesTo.event_id,
    relation_type_or_null: relationType,
    aggregation_event_type_or_null: relationType === 'm.annotation'
      ? (typeof candidateEvent?.type === 'string' ? candidateEvent.type : null)
      : null,
    thread_root_event_id_or_null: relationType === 'm.thread' ? relatesTo.event_id : null,
  };
}

function getRoomStateMapForSnapshot(persistence, snapshotId) {
  const stateMap = new Map();
  if (!snapshotId) {
    return stateMap;
  }
  for (const row of persistence.stateEntries.list().filter((entry) => entry.snapshot_id === snapshotId)) {
    stateMap.set(buildRoomStateTupleKey(row.event_type, row.state_key), row);
  }
  return stateMap;
}

function getTypedStateEvent(stateMap, eventType, stateKey = '') {
  return stateMap.get(buildRoomStateTupleKey(eventType, stateKey)) ?? null;
}

function getCreateEventFromStateMap(roomDo, stateMap) {
  const createState = getTypedStateEvent(stateMap, 'm.room.create', '');
  if (!createState) {
    return null;
  }
  return roomDo.loadRoomEventById(createState.event_id).event;
}

function getCurrentPowerLevelsContent(roomDo, stateMap) {
  const powerLevelsState = getTypedStateEvent(stateMap, 'm.room.power_levels', '');
  if (!powerLevelsState) {
    const createEvent = getCreateEventFromStateMap(roomDo, stateMap);
    const users = {};
    if (typeof createEvent?.sender === 'string' && createEvent.sender.length > 0) {
      users[createEvent.sender] = 100;
    }
    if (Array.isArray(createEvent?.content?.additional_creators)) {
      for (const userId of createEvent.content.additional_creators) {
        if (typeof userId === 'string' && userId.length > 0) {
          users[userId] = 100;
        }
      }
    }
    return {
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      users,
      events: {},
    };
  }
  const event = roomDo.loadRoomEventById(powerLevelsState.event_id).event;
  return isObjectRecord(event?.content) ? cloneJson(event.content) : {};
}

function getRoomCreators(roomDo, roomVersion, stateMap) {
  const createEvent = getCreateEventFromStateMap(roomDo, stateMap);
  if (!createEvent) {
    return [];
  }
  const creators = new Set();
  if (typeof createEvent.sender === 'string' && createEvent.sender.length > 0) {
    creators.add(createEvent.sender);
  }
  if (roomVersion === '12' && Array.isArray(createEvent.content?.additional_creators)) {
    for (const userId of createEvent.content.additional_creators) {
      if (typeof userId === 'string' && userId.length > 0) {
        creators.add(userId);
      }
    }
  }
  return [...creators];
}

function getUserPowerLevel(roomDo, roomVersion, stateMap, userId) {
  const creators = new Set(getRoomCreators(roomDo, roomVersion, stateMap));
  if (roomVersion === '12' && creators.has(userId)) {
    return Number.POSITIVE_INFINITY;
  }
  const powerLevels = getCurrentPowerLevelsContent(roomDo, stateMap);
  if (isObjectRecord(powerLevels.users) && Number.isInteger(powerLevels.users[userId])) {
    return powerLevels.users[userId];
  }
  return Number.isInteger(powerLevels.users_default) ? powerLevels.users_default : 0;
}

function getRequiredEventPowerLevel(roomDo, roomVersion, stateMap, candidateEvent) {
  const powerLevels = getCurrentPowerLevelsContent(roomDo, stateMap);
  if (candidateEvent?.type === 'm.room.redaction' && roomVersion !== '11') {
    return Number.isInteger(powerLevels.redact) ? powerLevels.redact : 50;
  }
  if (stateKeyForEvent(candidateEvent) != null) {
    if (isObjectRecord(powerLevels.events) && Number.isInteger(powerLevels.events[candidateEvent.type])) {
      return powerLevels.events[candidateEvent.type];
    }
    return Number.isInteger(powerLevels.state_default) ? powerLevels.state_default : 50;
  }
  if (isObjectRecord(powerLevels.events) && Number.isInteger(powerLevels.events[candidateEvent.type])) {
    return powerLevels.events[candidateEvent.type];
  }
  return Number.isInteger(powerLevels.events_default) ? powerLevels.events_default : 0;
}

function getJoinRule(roomDo, stateMap) {
  const joinRulesState = getTypedStateEvent(stateMap, 'm.room.join_rules', '');
  if (!joinRulesState) {
    return 'invite';
  }
  const event = roomDo.loadRoomEventById(joinRulesState.event_id).event;
  return typeof event?.content?.join_rule === 'string' ? event.content.join_rule : 'invite';
}

function getMembershipState(roomDo, stateMap, userId) {
  const stateEntry = getTypedStateEvent(stateMap, 'm.room.member', userId);
  if (!stateEntry) {
    return null;
  }
  const event = roomDo.loadRoomEventById(stateEntry.event_id).event;
  return {
    state_entry: stateEntry,
    event,
    membership: typeof event?.content?.membership === 'string' ? event.content.membership : null,
  };
}

function buildTypingEphemeralEvent(roomId, typingRows) {
  return {
    type: 'm.typing',
    room_id: roomId,
    content: {
      user_ids: typingRows
        .filter((row) => row.typing !== false)
        .map((row) => row.user_id)
        .sort((left, right) => left.localeCompare(right)),
    },
  };
}

function buildReceiptEphemeralEvent(roomId, receiptRow) {
  return {
    type: 'm.receipt',
    room_id: roomId,
    content: {
      [receiptRow.event_id]: {
        [receiptRow.receipt_type]: {
          [receiptRow.user_id]: {
            ts: receiptRow.receipt_ts ?? Date.now(),
            ...(receiptRow.thread_id ? { thread_id: receiptRow.thread_id } : {}),
          },
        },
      },
    },
  };
}

function mapMembershipVisibilityClass(membership) {
  if (membership === 'join') {
    return 'joined';
  }
  if (membership === 'invite') {
    return 'invited';
  }
  if (membership === 'knock') {
    return 'knocked';
  }
  if (membership === 'leave' || membership === 'ban') {
    return 'left';
  }
  return null;
}

function normalizePendingUploadState(value) {
  const normalized = normalizeString(value, 'pending_upload_state');
  if (!['pending', 'completed', 'reverted', 'orphaned', 'expired', 'cleaned'].includes(normalized)) {
    throw new RangeError('pending_upload_state is not supported');
  }
  return normalized;
}

function collectSearchableTextFragments(value, fragments = []) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      fragments.push(trimmed);
    }
    return fragments;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSearchableTextFragments(entry, fragments);
    }
    return fragments;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectSearchableTextFragments(entry, fragments);
    }
  }
  return fragments;
}

function buildSearchVectorText(event) {
  const fragments = [];
  if (typeof event?.type === 'string') {
    fragments.push(event.type);
  }
  if (typeof event?.sender === 'string') {
    fragments.push(event.sender);
  }
  collectSearchableTextFragments(event?.content ?? {}, fragments);
  return fragments.join('\n').trim();
}

function getSingleStateContent(roomDo, stateMap, eventType, stateKey = '') {
  const stateEntry = getTypedStateEvent(stateMap, eventType, stateKey);
  if (!stateEntry) {
    return null;
  }
  const event = roomDo.loadRoomEventById(stateEntry.event_id).event;
  return isObjectRecord(event?.content) ? cloneJson(event.content) : null;
}

function buildUserDirectoryProjection(userDo, updatedAt = new Date().toISOString()) {
  const principal = userDo.persistence.userPrincipal.get();
  if (!principal || principal.deactivated_at_or_null) {
    return null;
  }
  const profile = serializeProfileDocumentFromPersistence(userDo.persistence);
  const profileVersion = getNextProfileVersion(userDo.persistence) - 1;
  return {
    user_id: principal.user_id,
    displayname: typeof profile.displayname === 'string' ? profile.displayname : null,
    avatar_url: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
    profile_version: profileVersion > 0 ? profileVersion : 1,
    directory_visibility: principal.erase_requested_flag ? 'hidden' : 'visible',
    discovery_flags_json: {
      password_login_enabled: principal.password_login_enabled !== false,
      user_type: principal.user_type ?? null,
    },
    updated_at: updatedAt,
    record_json: {
      registration_source: principal.registration_source ?? null,
      deactivated_at_or_null: principal.deactivated_at_or_null ?? null,
      erase_requested_flag: principal.erase_requested_flag === true,
    },
  };
}

function resolveRoomDirectoryVisibility(roomDo, stateMap) {
  const createEvent = getCreateEventFromStateMap(roomDo, stateMap);
  const explicitVisibility = typeof createEvent?.unsigned?.directory_visibility === 'string'
    ? createEvent.unsigned.directory_visibility
    : (typeof createEvent?.unsigned?.public?.directory_visibility === 'string'
      ? createEvent.unsigned.public.directory_visibility
      : null);
  if (explicitVisibility === 'public') {
    return 'public';
  }
  return 'private';
}

function buildRoomDirectoryProjection(roomDo, {
  updatedAt = new Date().toISOString(),
} = {}) {
  const runtimeState = roomDo.persistence.getRuntimeState();
  const roomId = runtimeState?.room_id ?? null;
  if (!roomId) {
    return null;
  }
  const stateMap = roomDo.getCurrentStateMap();
  const createEvent = getCreateEventFromStateMap(roomDo, stateMap);
  const name = getSingleStateContent(roomDo, stateMap, 'm.room.name', '')?.name ?? null;
  const topic = getSingleStateContent(roomDo, stateMap, 'm.room.topic', '')?.topic ?? null;
  const avatarUrl = getSingleStateContent(roomDo, stateMap, 'm.room.avatar', '')?.url ?? null;
  const canonicalAlias = getSingleStateContent(roomDo, stateMap, 'm.room.canonical_alias', '')?.alias ?? null;
  const joinRules = getJoinRule(roomDo, stateMap);
  const historyVisibility = getSingleStateContent(roomDo, stateMap, 'm.room.history_visibility', '')?.history_visibility ?? 'shared';
  const guestCanJoin = getSingleStateContent(roomDo, stateMap, 'm.room.guest_access', '')?.guest_access === 'can_join';
  const worldReadable = historyVisibility === 'world_readable';
  const joinedMembers = [...stateMap.values()]
    .filter((entry) => entry.event_type === 'm.room.member')
    .map((entry) => roomDo.loadRoomEventById(entry.event_id).event)
    .filter((event) => event?.content?.membership === 'join')
    .length;
  const roomSerial = Math.max(0, (runtimeState?.next_room_pos ?? 1) - 1);
  const directoryVisibility = resolveRoomDirectoryVisibility(roomDo, stateMap);
  return {
    room_id: roomId,
    canonical_alias: typeof canonicalAlias === 'string' ? canonicalAlias : null,
    name: typeof name === 'string' ? name : null,
    topic: typeof topic === 'string' ? topic : null,
    avatar_url: typeof avatarUrl === 'string' ? avatarUrl : null,
    join_rules: joinRules,
    history_visibility: historyVisibility,
    world_readable: worldReadable,
    guest_can_join: guestCanJoin,
    joined_members: joinedMembers,
    room_serial: roomSerial,
    visibility_watermark: roomSerial,
    is_public: directoryVisibility === 'public',
    updated_at: updatedAt,
    record_json: {
      directory_visibility: directoryVisibility,
      room_version: runtimeState?.room_version ?? null,
      create_event_id: createEvent?.event_id ?? null,
    },
  };
}

function buildSearchIndexProjection(roomDo, eventId, updatedAt = new Date().toISOString()) {
  const metadata = roomDo.persistence.eventMetadata.get({ event_id: eventId });
  if (!metadata || metadata.soft_failed_flag === true || metadata.waiting_missing_flag === true) {
    return null;
  }
  const event = roomDo.loadRoomEventById(eventId).event;
  return {
    event_id: metadata.event_id,
    room_id: roomDo.persistence.getRuntimeState()?.room_id ?? event.room_id ?? null,
    event_type: metadata.event_type,
    origin_server_ts: metadata.origin_server_ts,
    sender_user_id: metadata.sender_user_id,
    search_vector_text: buildSearchVectorText(event),
    visibility_scope: metadata.membership_visibility_class ?? metadata.history_visibility_class ?? 'shared',
    updated_at: updatedAt,
    record_json: {
      room_pos: metadata.room_pos,
      room_version: metadata.record?.room_version ?? null,
      redacts_event_id_or_null: metadata.redacts_event_id_or_null ?? null,
      relates_to_event_id_or_null: metadata.relates_to_event_id_or_null ?? null,
    },
  };
}

function buildPendingUploadId(mediaId) {
  return `upload_${normalizeString(mediaId, 'mediaId')}`;
}

function buildPendingUploadGrantView(grantRecord, serverName) {
  const record = grantRecord?.record ?? {};
  const mediaId = grantRecord?.media_id ?? record.media_id ?? null;
  const mxcUri = mediaId ? buildMxcUri(serverName, mediaId) : null;
  return {
    pending_upload_id: grantRecord.pending_upload_id,
    max_bytes: grantRecord.max_bytes,
    allowed_content_types: Array.isArray(record.allowed_content_types) && record.allowed_content_types.length > 0
      ? record.allowed_content_types
      : (grantRecord.content_type ? [grantRecord.content_type] : ['application/octet-stream']),
    expires_at: grantRecord.expires_at,
    media_id: mediaId,
    mxc_uri: mxcUri,
  };
}

function sweepPendingUploadGrants(userDo, nowIso, { applyChanges = false } = {}) {
  const nowMs = Date.parse(normalizeString(nowIso, 'nowIso'));
  const orphanCleanup = [];
  let nextAlarmAtMs = Number.POSITIVE_INFINITY;
  for (const grant of userDo.persistence.pendingUploadGrants.list()) {
    const state = normalizePendingUploadState(grant.state);
    const expiresAtMs = Date.parse(grant.expires_at);
    if (state === 'pending') {
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
        if (applyChanges) {
          userDo.persistence.pendingUploadGrants.put({
            pending_upload_id: grant.pending_upload_id,
            media_id: grant.media_id,
            content_type: grant.content_type,
            max_bytes: grant.max_bytes,
            state: 'expired',
            granted_at: grant.granted_at,
            expires_at: grant.expires_at,
            finalized_at: nowIso,
            record_json: {
              ...(grant.record ?? {}),
              expired_at: nowIso,
            },
          });
        }
      } else if (Number.isFinite(expiresAtMs)) {
        nextAlarmAtMs = Math.min(nextAlarmAtMs, expiresAtMs);
      }
      continue;
    }
    if (state !== 'orphaned') {
      continue;
    }
    const orphanDeadlineMs = Date.parse(grant.finalized_at ?? grant.expires_at) + DEFAULT_MEDIA_ORPHAN_RETENTION_MS;
    if (Number.isFinite(orphanDeadlineMs) && orphanDeadlineMs <= nowMs) {
      const objectKey = typeof grant.record?.r2_object_key === 'string' ? grant.record.r2_object_key : null;
      if (objectKey) {
        orphanCleanup.push({
          pending_upload_id: grant.pending_upload_id,
          r2_object_key: objectKey,
        });
      }
      if (applyChanges) {
        userDo.persistence.pendingUploadGrants.put({
          pending_upload_id: grant.pending_upload_id,
          media_id: grant.media_id,
          content_type: grant.content_type,
          max_bytes: grant.max_bytes,
          state: 'orphaned',
          granted_at: grant.granted_at,
          expires_at: grant.expires_at,
          finalized_at: grant.finalized_at ?? nowIso,
          record_json: {
            ...(grant.record ?? {}),
            cleanup_requested_at: nowIso,
          },
        });
      }
      nextAlarmAtMs = Math.min(nextAlarmAtMs, nowMs + MEDIA_CLEANUP_RETRY_MS);
      continue;
    }
    if (Number.isFinite(orphanDeadlineMs)) {
      nextAlarmAtMs = Math.min(nextAlarmAtMs, orphanDeadlineMs);
    }
  }
  return {
    orphan_cleanup: orphanCleanup,
    next_alarm_at: Number.isFinite(nextAlarmAtMs) ? new Date(nextAlarmAtMs).toISOString() : null,
  };
}

function isReadableRoomMembership(membership) {
  return membership === 'join' || membership === 'leave';
}

function mapInternalCodeToMatrixError(error) {
  const code = error?.code ?? 'internal';
  if (code === 'idempotency_conflict') {
    return {
      status: 409,
      body: {
        errcode: 'M_CONFLICT',
        error: error?.message ?? 'Idempotency conflict',
      },
    };
  }
  if (code === 'target_not_local') {
    return {
      status: 400,
      body: {
        errcode: 'M_INVALID_PARAM',
        error: error?.message ?? 'Target user is not local',
      },
    };
  }
  if (code === 'unsupported_room_version') {
    return {
      status: 400,
      body: {
        errcode: 'M_UNSUPPORTED_ROOM_VERSION',
        error: error?.message ?? 'Unsupported room version',
      },
    };
  }
  if (code === 'incompatible_room_version') {
    return {
      status: 400,
      body: {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error: error?.message ?? 'Incompatible room version',
      },
    };
  }
  if (code === 'room_not_found' || code === 'event_not_found') {
    return {
      status: 404,
      body: {
        errcode: 'M_NOT_FOUND',
        error: error?.message ?? 'Requested room resource does not exist',
      },
    };
  }
  if (code === 'room_forbidden' || code === 'not_allowed') {
    return {
      status: 403,
      body: {
        errcode: 'M_FORBIDDEN',
        error: error?.message ?? 'The room operation is not allowed',
      },
    };
  }
  if (code === 'bad_json' || code === 'invalid_event') {
    return {
      status: 400,
      body: {
        errcode: 'M_BAD_JSON',
        error: error?.message ?? 'Invalid JSON payload',
      },
    };
  }
  if (code === 'unknown_session') {
    return {
      status: 401,
      body: {
        errcode: 'M_UNKNOWN_TOKEN',
        error: error?.message ?? 'Unknown session',
      },
    };
  }
  if (code === 'invalid_cursor' || code === 'filter_mismatch' || code === 'cursor_from_future') {
    return {
      status: 400,
      body: {
        errcode: 'M_INVALID_PARAM',
        error: error?.message ?? 'Invalid sync cursor',
      },
    };
  }
  if (code === 'integrity_failure') {
    return {
      status: 500,
      body: {
        errcode: 'M_UNKNOWN',
        error: error?.message ?? 'Integrity check failed',
      },
    };
  }
  return {
    status: 500,
    body: {
      errcode: 'M_UNKNOWN',
      error: error?.message ?? 'Internal error',
    },
  };
}

// Cloudflare DO method-call RPC only works when the target class inherits the runtime DurableObject base.
let DurableObjectRuntimeBase = typeof globalThis.DurableObject === 'function'
  ? globalThis.DurableObject
  : null;
if (typeof DurableObjectRuntimeBase !== 'function') {
  try {
    const cloudflareWorkersModule = await import('cloudflare:workers');
    if (typeof cloudflareWorkersModule?.DurableObject === 'function') {
      DurableObjectRuntimeBase = cloudflareWorkersModule.DurableObject;
    }
  } catch {
    // Node test environments do not expose the Workers runtime module.
  }
}
if (typeof DurableObjectRuntimeBase !== 'function') {
  DurableObjectRuntimeBase = class DurableObjectFallback {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  };
}

export class BaseDurableObject extends DurableObjectRuntimeBase {
  constructor(ctx, env, options) {
    super(ctx, env);
    this.ctx ??= ctx;
    this.env ??= env;
    this.options = options;
  }

  get config() {
    return loadWorkerRuntimeConfig(this.options.owningWorkerName, this.env);
  }

  async ensureCurrentness() {
    const storage = this.ctx?.storage;
    if (storage?.sql?.exec) {
      storage.sql.exec('SELECT 1');
      return;
    }
    if (typeof storage?.get === 'function') {
      await storage.get('__currentness_probe__');
    }
  }

  createRequestContext(request, routeFamily = `${this.options.routeFamilyPrefix}.fetch`) {
    return createRequestContext({
      workerName: this.options.owningWorkerName,
      workerVersion: this.config.text.WORKER_VERSION_ID,
      request,
      routeFamily,
    });
  }

  createAsyncTaskContext(routeFamily) {
    return createAsyncTaskContext({
      workerName: this.options.owningWorkerName,
      workerVersion: this.config.text.WORKER_VERSION_ID,
      routeFamily,
    });
  }

  createNotImplementedEnvelope(methodName, details = null) {
    return createInternalErrorEnvelope({
      code: 'unsupported_schema_version',
      message: `${this.options.className}.${methodName} is a Phase 01 runtime skeleton placeholder`,
      retryable: false,
      details,
    });
  }

  async fetch(request) {
    await this.ensureCurrentness();
    const requestContext = this.createRequestContext(request);
    requestContext.logger.warn('durable_object.placeholder.fetch', {
      authority_kind: this.options.authorityKind,
      class_name: this.options.className,
      method: request.method,
      path: new URL(request.url).pathname,
      outcome: 'placeholder',
    });

    return jsonResponse(
      {
        error: `${this.options.className} runtime skeleton placeholder`,
        request_id: requestContext.requestId,
        authority_kind: this.options.authorityKind,
      },
      503,
    );
  }

  requireSqlStorage() {
    const storage = this.ctx?.storage;
    const sql = storage?.sql;
    if (!sql || typeof sql.exec !== 'function') {
      throw new TypeError(`${this.options.className} requires SQLite-backed Durable Object storage`);
    }
    if (typeof storage?.transactionSync === 'function') {
      bindSqlStorageTransactionSync(sql, storage.transactionSync.bind(storage));
    }
    return sql;
  }

  observeAuthorityMetric(name, value, dimensions = {}) {
    return observeMetric(this.env, name, value, {
      authority_kind: this.options.authorityKind,
      class_name: this.options.className,
      ...dimensions,
    });
  }

  incrementAuthorityMetric(name, value = 1, dimensions = {}) {
    return incrementMetric(this.env, name, value, {
      authority_kind: this.options.authorityKind,
      class_name: this.options.className,
      ...dimensions,
    });
  }

  enforceSemanticQuota(policyId, key, {
    nowIso = new Date().toISOString(),
    message = 'Rate limit exceeded',
  } = {}) {
    return enforceSemanticQuota(this, this.env, {
      policy_id: policyId,
      key,
      now_iso: nowIso,
      message,
    });
  }
}

export class UserDO extends BaseDurableObject {
  static authorityKind = 'user';
  static schemaVersion = USER_DO_SCHEMA_VERSION;

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'UserDO',
      authorityKind: UserDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'userdo',
    });
  }

  get persistence() {
    if (!this._persistence) {
      this._persistence = createUserDurableObjectPersistence(this.requireSqlStorage());
    }
    return this._persistence;
  }

  async ensureSchema() {
    await this.persistence.ensureSchema();
    return this.persistence.getRuntimeState();
  }

  async resolveSession() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const accessTokenHash = typeof request?.access_token_hash === 'string' && request.access_token_hash.length > 0
      ? request.access_token_hash
      : null;
    const legacyAccessToken = typeof request?.access_token === 'string' && request.access_token.length > 0
      ? request.access_token
      : null;
    const now = request?.now ?? new Date().toISOString();
    if (!accessTokenHash && !legacyAccessToken) {
      return {
        ok: false,
        error: createInternalErrorEnvelope({
          code: 'invalid_token',
          message: 'access_token_hash must be present',
          retryable: false,
        }),
      };
    }

    const runtimeState = this.persistence.getRuntimeState();
    const principal = this.persistence.userPrincipal.get();
    if (!runtimeState.user_id && principal?.user_id) {
      this.persistence.setRuntimeIdentity({ user_id: principal.user_id, updated_at: now });
    }
    const refreshedRuntimeState = this.persistence.getRuntimeState();
    const session = findSessionByHashedToken(
      this.persistence,
      'access_token_hash',
      accessTokenHash ?? hashOpaqueToken(legacyAccessToken),
    );
    const device = session?.device_id ? this.persistence.devices.get(session.device_id) : null;
    const usability = isSessionUsable({
      session,
      principal,
      runtimeState: refreshedRuntimeState,
      device,
      nowIso: now,
    });
    if (!usability.valid) {
      return {
        ok: false,
        error: usability.error,
      };
    }

    return createSuccessResult({
      session: {
        user_id: principal.user_id,
        device_id: session.device_id,
        session_id: session.session_id,
        expires_at: session.expires_at,
        is_guest: session.is_guest,
        auth_version: session.auth_version,
        session_epoch: session.session_epoch,
      },
    });
  }

  async collectSince() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const sessionRootKeyRing = this.config.secrets.require('session_root_key_ring');
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const sessionId = normalizeString(request?.session_id, 'request.session_id');
    const filterDefinition = request?.filter_json == null
      ? {}
      : normalizeFilterDefinition(request.filter_json);
    const filterHash = request?.filter_hash == null ? null : normalizeString(request.filter_hash, 'request.filter_hash');
    const fullState = request?.full_state === true;
    const useStateAfter = request?.use_state_after === true;
    const parsedToken = parseSyncToken(request?.since_token ?? null, {
      expected_user_id: userId,
      secret_value: sessionRootKeyRing,
    });
    if (!parsedToken.ok) {
      return {
        ok: false,
        matrix_error: parsedToken.matrix_error,
      };
    }

    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(404, 'M_NOT_FOUND', 'User does not exist');
    }
    const session = this.persistence.sessions.get(sessionId);
    if (!session || session.revoked_at) {
      return {
        ok: false,
        matrix_error: {
          status: 401,
          body: {
            errcode: 'M_UNKNOWN_TOKEN',
            error: 'Unknown or unsupported token',
          },
        },
      };
    }
    const device = this.persistence.devices.get(session.device_id);
    if (!device || device.deleted_at) {
      return {
        ok: false,
        matrix_error: {
          status: 401,
          body: {
            errcode: 'M_UNKNOWN_TOKEN',
            error: 'Unknown or unsupported token',
          },
        },
      };
    }
    const parsedForDevice = parseSyncToken(request?.since_token ?? null, {
      expected_user_id: userId,
      expected_device_id: session.device_id,
      secret_value: sessionRootKeyRing,
    });
    if (!parsedForDevice.ok) {
      return {
        ok: false,
        matrix_error: parsedForDevice.matrix_error,
      };
    }
    if (parsedToken.filter_hash && filterHash && parsedToken.filter_hash !== filterHash) {
      return {
        ok: false,
        matrix_error: {
          status: 400,
          body: {
            errcode: 'M_INVALID_PARAM',
            error: 'Sync token was issued for a different filter',
          },
        },
      };
    }

    const now = request?.now ?? new Date().toISOString();
    const sincePos = parsedForDevice.since_pos;
    const upperBound = Math.max(0, (this.persistence.getRuntimeState()?.next_user_stream_pos ?? 1) - 1);
    if (sincePos > upperBound) {
      return {
        ok: false,
        matrix_error: {
          status: 400,
          body: {
            errcode: 'M_INVALID_PARAM',
            error: 'Sync token points past the current user stream',
          },
        },
      };
    }

    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.sessions.put(sessionRowToPutRecord(session, {
        updated_at: now,
        record: {
          ...(session.record ?? {}),
          last_seen_sync_pos: Math.max(
            Number.isInteger(session.record?.last_seen_sync_pos) ? session.record.last_seen_sync_pos : 0,
            sincePos,
          ),
          last_sync_at: now,
        },
      }));
      for (const entry of this.persistence.listToDeviceForDevice(session.device_id, { after_stream_pos: 0, limit: 10_000 })) {
        if (entry.stream_pos <= sincePos && !entry.acknowledged_at) {
          this.persistence.acknowledgeToDevice(session.device_id, entry.stream_pos, now);
        }
      }
    });

    const isInitial = request?.since_token == null || request.since_token === '';
    const deltaEntries = isInitial
      ? []
      : this.persistence.listUserStreamSince(sincePos, 10_000).filter((entry) => entry.stream_pos <= upperBound);
    const roomAccountDeltas = [];
    const roomFanoutDeltas = [];
    const roomEphemeralDeltas = [];
    const changedGlobalAccountTypes = new Set();
    let includePushRules = isInitial;
    let includePresence = isInitial;

    for (const entry of deltaEntries) {
      if (entry.stream_kind === 'global_account_data') {
        changedGlobalAccountTypes.add(entry.payload?.type);
      } else if (entry.stream_kind === 'push_rules') {
        includePushRules = true;
      } else if (entry.stream_kind === 'presence') {
        includePresence = true;
      } else if (entry.stream_kind === 'room_account_data') {
        roomAccountDeltas.push(entry.payload);
      } else if (entry.stream_kind === 'room_fanout') {
        roomFanoutDeltas.push(entry.payload);
      } else if (entry.stream_kind === 'room_ephemeral') {
        roomEphemeralDeltas.push(entry.payload);
      }
    }

    const accountDataEvents = [];
    if (isInitial) {
      for (const row of this.persistence.globalAccountData.list()) {
        accountDataEvents.push(buildGlobalAccountDataEvent(row.type, row.content));
      }
    } else {
      for (const type of changedGlobalAccountTypes) {
        if (!type) {
          continue;
        }
        const row = this.persistence.globalAccountData.get({ type });
        if (row) {
          accountDataEvents.push(buildGlobalAccountDataEvent(type, row.content));
        }
      }
    }
    if (includePushRules) {
      accountDataEvents.push(buildPushRulesAccountDataEvent(userId, this.persistence.pushRules.list()));
    }

    const profileDocument = serializeProfileDocumentFromPersistence(this.persistence);
    const effectivePresenceRecord = this.persistence.presence.get({ user_id: userId });
    const presenceEvents = includePresence
      ? [{
        sender: userId,
        type: 'm.presence',
        content: buildPresenceContent({
          userId,
          presenceRecord: effectivePresenceRecord,
          profileDocument,
          now,
        }),
      }]
      : [];
    const toDeviceEvents = this.persistence
      .listToDeviceForDevice(session.device_id, { after_stream_pos: sincePos, limit: 10_000 })
      .filter((entry) => entry.stream_pos <= upperBound)
      .map((entry) => buildToDeviceEvent(entry));

    const nextBatch = issueSyncToken({
      user_id: userId,
      device_id: session.device_id,
      user_stream_pos: upperBound,
      filter_hash: filterHash,
      secret_value: sessionRootKeyRing,
    });

    return createSuccessResult({
      batch: {
        user_id: userId,
        from_stream_pos: sincePos,
        to_stream_pos: upperBound,
        upper_bound_user_stream_pos: upperBound,
        entries: deltaEntries,
        limited: false,
        full_state: fullState,
        use_state_after: useStateAfter,
        filter_flags: getSyncFilterFlags(filterDefinition),
        account_data_events: filterEventList(accountDataEvents, filterDefinition.account_data),
        presence_events: filterEventList(presenceEvents, filterDefinition.presence),
        to_device_events: filterEventList(toDeviceEvents, filterDefinition.to_device),
        room_deltas: roomFanoutDeltas,
        room_account_data_deltas: roomAccountDeltas,
        room_ephemeral_deltas: roomEphemeralDeltas,
        room_membership_snapshot: (isInitial || fullState)
          ? listRoomSyncMembershipEntries(principal).filter((entry) => (
            entry.membership_bucket !== 'leave' || getSyncFilterFlags(filterDefinition).include_leave === true
          ))
          : [],
        next_batch: nextBatch,
      },
    });
  }

  async appendRoomFanout() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const principal = this.persistence.userPrincipal.get();
    const delta = normalizeRoomFanoutDelta(request);
    if (!principal || principal.user_id !== delta.user_id) {
      return {
        ok: false,
        error: createInternalErrorEnvelope({
          code: 'target_not_local',
          message: 'Target user does not exist on this homeserver',
          retryable: false,
        }),
      };
    }

    const forgottenRoom = readForgottenRoomTombstones(principal)[delta.room_id] ?? null;
    const forgottenRoomPos = Number.isInteger(forgottenRoom?.room_pos) ? forgottenRoom.room_pos : 0;
    const forgottenUpdatedAtMillis = typeof forgottenRoom?.updated_at === 'string'
      ? Date.parse(forgottenRoom.updated_at)
      : Number.NaN;
    const staleForgottenDelta = forgottenRoom && (
      delta.membership_bucket === 'leave'
      || delta.room_pos <= forgottenRoomPos
      || (
        forgottenRoomPos <= 0
        && (
          !Number.isInteger(delta.origin_server_ts)
          || !Number.isFinite(forgottenUpdatedAtMillis)
          || delta.origin_server_ts <= forgottenUpdatedAtMillis
        )
      )
    );
    if (staleForgottenDelta) {
      return createSuccessResult({
        ack: {
          accepted: true,
          accepted_at: request?.now ?? new Date().toISOString(),
          durable_stream_pos: null,
          suppressed: 'forgotten_room',
        },
      });
    }

    const dedupeKey = buildRoomFanoutDedupeKey(delta);
    const existing = this.persistence.userStream.list().find((entry) => entry.dedupe_key === dedupeKey);
    if (existing) {
      return createSuccessResult({
        ack: {
          accepted: true,
          accepted_at: existing.created_at,
          durable_stream_pos: existing.stream_pos,
        },
      });
    }

    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: principal.user_id,
        stream_kind: 'room_fanout',
        room_id: delta.room_id,
        event_id: delta.event_id,
        dedupe_key: dedupeKey,
        created_at: now,
        payload: delta,
      });
      wakePos = streamEntry.stream_pos;
      this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
        record: mergeRoomSyncMembershipRecord(principal, {
          room_id: delta.room_id,
          membership_bucket: delta.membership_bucket,
          room_pos: delta.room_pos,
          updated_at: now,
        }),
      }));
    });
    this.incrementAuthorityMetric('userdo.stream.append.count', 1, {
      stream_kind: 'room_fanout',
    });
    wakeSyncWaiters(this.env, {
      user_id: principal.user_id,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({
      ack: {
        accepted: true,
        accepted_at: now,
        durable_stream_pos: wakePos,
      },
    });
  }

  async appendRoomEphemeral() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const principal = this.persistence.userPrincipal.get();
    const userId = normalizeString(request?.user_id, 'request.user_id');
    if (!principal || principal.user_id !== userId) {
      return {
        ok: false,
        error: createRoomInternalError('target_not_local', 'Target user does not exist on this homeserver'),
      };
    }
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const event = isObjectRecord(request?.event) ? cloneJson(request.event) : null;
    if (!event) {
      return {
        ok: false,
        error: createRoomInternalError('bad_json', 'Ephemeral room event must be a JSON object'),
      };
    }
    const dedupeKey = normalizeString(
      request?.dedupe_key ?? canonicalJsonHash({
        room_id: roomId,
        user_id: userId,
        event,
      }),
      'request.dedupe_key',
    );
    const existing = this.persistence.userStream.list().find((entry) => entry.dedupe_key === dedupeKey);
    if (existing) {
      return createSuccessResult({
        ack: {
          accepted: true,
          accepted_at: existing.created_at,
          durable_stream_pos: existing.stream_pos,
        },
      });
    }
    const now = request?.now ?? new Date().toISOString();
    const streamEntry = this.persistence.appendUserStream({
      user_id: userId,
      stream_kind: 'room_ephemeral',
      room_id: roomId,
      event_id: typeof event.event_id === 'string' ? event.event_id : null,
      dedupe_key: dedupeKey,
      created_at: now,
      payload: {
        room_id: roomId,
        event,
      },
    });
    this.incrementAuthorityMetric('userdo.stream.append.count', 1, {
      stream_kind: 'room_ephemeral',
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: streamEntry.stream_pos,
    });
    return createSuccessResult({
      ack: {
        accepted: true,
        accepted_at: now,
        durable_stream_pos: streamEntry.stream_pos,
      },
    });
  }

  async inspectRoomFanout() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const roomPos = normalizeInteger(request?.room_pos, 'request.room_pos', { min: 1 });
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const dedupeKey = buildRoomFanoutDedupeKey({
      room_id: roomId,
      room_pos: roomPos,
      user_id: userId,
      membership_bucket: 'join',
      timeline_event_ids: [],
      state_event_ids: [],
    });
    const entry = this.persistence.userStream.list().find((candidate) => candidate.dedupe_key === dedupeKey) ?? null;
    return createSuccessResult({
      entry,
    });
  }

  async forgetRoom() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const principal = this.persistence.userPrincipal.get();
    const userId = normalizeString(request?.user_id, 'request.user_id');
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Room forget is only available to the authenticated user');
    }
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const dedupeKey = normalizeString(
      request?.request_fingerprint ?? canonicalJsonHash({ room_id: roomId, user_id: userId, kind: 'forget' }),
      'request.request_fingerprint',
    );
    const existing = this.persistence.userStream.list().find((entry) => entry.dedupe_key === dedupeKey);
    if (existing) {
      return createSuccessResult({
        response: {},
      });
    }
    const currentRoomSync = readRoomSyncMembershipMap(principal)[roomId] ?? null;
    const forgottenRoom = readForgottenRoomTombstones(principal)[roomId] ?? null;
    const authoritativeMembershipBucket = request?.authoritative_membership_bucket == null
      ? null
      : normalizeRoomMembershipBucket(request.authoritative_membership_bucket, { allowNull: true });
    const roomWasLeft = authoritativeMembershipBucket === 'leave'
      || currentRoomSync?.membership_bucket === 'leave'
      || forgottenRoom != null;
    if (currentRoomSync && currentRoomSync.membership_bucket !== 'leave' && authoritativeMembershipBucket !== 'leave') {
      return createMatrixError(403, 'M_FORBIDDEN', 'Room must be left before it can be forgotten');
    }
    if (!roomWasLeft) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Room must be left before it can be forgotten');
    }
    const forgetRoomPos = Number.isInteger(request?.room_pos)
      ? request.room_pos
      : currentRoomSync?.room_pos ?? forgottenRoom?.room_pos ?? 0;
    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'room_fanout',
        room_id: roomId,
        event_id: null,
        dedupe_key: dedupeKey,
        created_at: now,
        payload: {
          room_id: roomId,
          room_pos: forgetRoomPos,
          user_id: userId,
          membership_bucket: 'forgotten',
          timeline_event_ids: [],
          state_event_ids: [],
        },
      });
      wakePos = streamEntry.stream_pos;
      this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
        record: mergeRoomSyncMembershipRecord(principal, {
          room_id: roomId,
          membership_bucket: 'forgotten',
          room_pos: forgetRoomPos,
          updated_at: now,
        }),
      }));
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({
      response: {},
    });
  }

  async getRoomSyncMembership() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const principal = this.persistence.userPrincipal.get();
    const userId = request?.user_id == null
      ? principal?.user_id ?? null
      : normalizeString(request.user_id, 'request.user_id');
    if (!principal || principal.user_id !== userId) {
      return createSuccessResult({
        entry: null,
      });
    }
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const roomSyncMembership = readRoomSyncMembershipMap(principal)[roomId] ?? null;
    const forgottenRoom = readForgottenRoomTombstones(principal)[roomId] ?? null;
    return createSuccessResult({
      entry: roomSyncMembership ?? (forgottenRoom == null ? null : {
        room_id: roomId,
        membership_bucket: 'forgotten',
        room_pos: Number.isInteger(forgottenRoom.room_pos) ? forgottenRoom.room_pos : 0,
        updated_at: typeof forgottenRoom.updated_at === 'string' ? forgottenRoom.updated_at : null,
      }),
    });
  }

  async listRoomSyncMemberships() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const principal = this.persistence.userPrincipal.get();
    const userId = request?.user_id == null
      ? principal?.user_id ?? null
      : normalizeString(request.user_id, 'request.user_id');
    if (!principal || principal.user_id !== userId) {
      return createSuccessResult({
        entries: [],
      });
    }
    return createSuccessResult({
      entries: listRoomSyncMembershipEntries(principal),
    });
  }

  async enqueueToDevice() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const senderUserId = normalizeString(request?.sender_user_id, 'request.sender_user_id');
    const eventType = normalizeString(request?.event_type, 'request.event_type');
    const txnId = normalizeString(request?.txn_id, 'request.txn_id');
    const requestFingerprint = normalizeString(request?.request_fingerprint, 'request.request_fingerprint');
    const now = request?.now ?? new Date().toISOString();
    const principal = this.persistence.userPrincipal.get();
    if (!principal) {
      return {
        ok: false,
        error: createInternalErrorEnvelope({
          code: 'target_not_local',
          message: 'Target user does not exist on this homeserver',
          retryable: false,
        }),
      };
    }
    const devicePayloads = request?.device_messages && typeof request.device_messages === 'object' && !Array.isArray(request.device_messages)
      ? request.device_messages
      : {};
    const activeDevices = this.persistence.devices.list().filter((device) => !device.deleted_at);
    const expandedDevicePayloads = new Map();
    for (const [deviceId, payload] of Object.entries(devicePayloads)) {
      if (deviceId === '*') {
        for (const device of activeDevices) {
          expandedDevicePayloads.set(device.device_id, structuredClone(payload));
        }
        continue;
      }
      if (activeDevices.some((device) => device.device_id === deviceId)) {
        expandedDevicePayloads.set(deviceId, structuredClone(payload));
      }
    }

    const dedupeKey = `${senderUserId}|${eventType}|${txnId}`;
    const existing = this.persistence.toDeviceTxnDedupe.list().find((row) => row.txn_dedupe_key === dedupeKey)
      ?? this.persistence.toDeviceTxnDedupe.list().find((row) => (
        row.sender_user_id === senderUserId
        && row.event_type === eventType
        && row.txn_id === txnId
      ))
      ?? null;
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        return {
          ok: false,
          error: createInternalErrorEnvelope({
            code: 'idempotency_conflict',
            message: 'This sendToDevice transaction key was already used for different content',
            retryable: false,
          }),
        };
      }
      return createSuccessResult({
        ack: {
          accepted: true,
          accepted_at: existing.updated_at,
          durable_stream_pos: existing.result?.durable_stream_pos ?? 0,
        },
      });
    }

    let maxStreamPos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      for (const [targetDeviceId, payload] of expandedDevicePayloads.entries()) {
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: principal.user_id,
          stream_kind: 'to_device',
          created_at: now,
          payload: {
            sender_user_id: senderUserId,
            target_device_id: targetDeviceId,
            event_type: eventType,
            content: structuredClone(payload),
          },
        });
        this.persistence.enqueueToDeviceWithinTransaction({
          user_id: principal.user_id,
          target_device_id: targetDeviceId,
          stream_pos: streamEntry.stream_pos,
          sender_user_id: senderUserId,
          event_type: eventType,
          enqueued_at: now,
          payload: structuredClone(payload),
          record: {
            txn_id: txnId,
            request_fingerprint: requestFingerprint,
          },
        });
        maxStreamPos = Math.max(maxStreamPos, streamEntry.stream_pos);
      }
      this.persistence.toDeviceTxnDedupe.put({
        txn_dedupe_key: dedupeKey,
        sender_user_id: senderUserId,
        event_type: eventType,
        txn_id: txnId,
        request_fingerprint: requestFingerprint,
        terminal_state: 'accepted',
        created_at: now,
        updated_at: now,
        result_json: {
          durable_stream_pos: maxStreamPos,
          device_count: expandedDevicePayloads.size,
        },
        record_json: {},
      });
    });
    if (maxStreamPos > 0) {
      wakeSyncWaiters(this.env, {
        user_id: principal.user_id,
        user_stream_pos: maxStreamPos,
      });
    }
    return createSuccessResult({
      ack: {
        accepted: true,
        accepted_at: now,
        durable_stream_pos: maxStreamPos,
      },
    });
  }

  async propagateProfileMembershipRefresh({
    userId,
    profileVersion,
    profileDocument,
    now,
  }) {
    const principal = this.persistence.userPrincipal.get();
    const joinedRooms = listRoomSyncMembershipEntries(principal)
      .filter((entry) => entry.membership_bucket === 'join');
    for (const entry of joinedRooms) {
      try {
        const roomDo = getRoomDoStub(this.env, entry.room_id);
        await roomDo.enqueueProfileRefresh({
          room_id: entry.room_id,
          user_id: userId,
          profile_version: profileVersion,
          displayname: profileDocument.displayname ?? null,
          avatar_url: profileDocument.avatar_url ?? null,
          now,
        });
      } catch {
        // Profile propagation is asynchronous; a later room-fanout repair pass can re-drive missed refreshes.
      }
    }
  }

  async getProfileDocument() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Profile does not exist');
    }
    return createSuccessResult({
      profile: serializeProfileDocumentFromPersistence(this.persistence),
    });
  }

  async getProfileField() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const keyName = normalizeString(request?.key_name, 'request.key_name');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Profile does not exist');
    }
    const row = this.persistence.profileDocument.get({ key_name: keyName });
    if (!row) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Profile field does not exist');
    }
    return createSuccessResult({
      profile: {
        [keyName]: structuredClone(row.value),
      },
    });
  }

  async putProfileField() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const keyName = normalizeString(request?.key_name, 'request.key_name');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Profile updates are only allowed for the authenticated user');
    }
    const validation = validateProfileFieldValue(keyName, request?.value);
    if (!validation.ok) {
      return createMatrixError(validation.status, validation.errcode, validation.error);
    }
    const now = request?.now ?? new Date().toISOString();
    const previousDocument = serializeProfileDocumentFromPersistence(this.persistence);
    const nextDocument = {
      ...previousDocument,
      [validation.key_name]: structuredClone(validation.value),
    };
    const sizeCheck = assertProfileDocumentSize(nextDocument);
    if (!sizeCheck.ok) {
      return createMatrixError(sizeCheck.status, sizeCheck.errcode, sizeCheck.error);
    }
    const wasDisplayOrAvatar = [PROFILE_KEY_DISPLAYNAME, PROFILE_KEY_AVATAR_URL].includes(validation.key_name);
    const changed = JSON.stringify(previousDocument[validation.key_name]) !== JSON.stringify(validation.value);
    if (!changed) {
      return createSuccessResult({
        response: {
          profile_version: getNextProfileVersion(this.persistence) - 1,
        },
      });
    }

    let wakePos = 0;
    const sql = this.requireSqlStorage();
    const nextProfileVersion = getNextProfileVersion(this.persistence);
    withSqliteTransaction(sql, () => {
      for (const row of this.persistence.profileDocument.list()) {
        if (!(row.key_name in nextDocument)) {
          this.persistence.profileDocument.delete({ key_name: row.key_name });
        }
      }
      for (const [fieldName, fieldValue] of Object.entries(nextDocument)) {
        this.persistence.profileDocument.put({
          key_name: fieldName,
          profile_version: nextProfileVersion,
          updated_at: now,
          value_json: structuredClone(fieldValue),
          record_json: {
            request_fingerprint: request?.request_fingerprint ?? null,
          },
        });
      }
      if (wasDisplayOrAvatar) {
        const existingPresence = this.persistence.presence.get({ user_id: userId });
        const nextPresence = {
          ...(existingPresence ?? buildDefaultPresenceRecord(userId, now)),
          presence_version: existingPresence ? existingPresence.presence_version + 1 : 1,
          updated_at: now,
          last_active_at: existingPresence?.last_active_at ?? now,
          record: {
            ...(existingPresence?.record ?? {}),
            profile_version: nextProfileVersion,
          },
        };
        this.persistence.presence.put({
          user_id: userId,
          presence: nextPresence.presence,
          status_msg: nextPresence.status_msg,
          currently_active: nextPresence.currently_active,
          last_active_at: nextPresence.last_active_at,
          presence_version: nextPresence.presence_version,
          updated_at: now,
          record_json: nextPresence.record,
        });
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'presence',
          created_at: now,
          payload: {
            sender: userId,
            type: 'm.presence',
            content: buildPresenceContent({
              userId,
              presenceRecord: nextPresence,
              profileDocument: nextDocument,
              now,
            }),
          },
          record: {
            profile_version: nextProfileVersion,
            propagation_kind: 'profile_refresh',
          },
        });
        wakePos = streamEntry.stream_pos;
      }
    });
    if (wakePos > 0) {
      wakeSyncWaiters(this.env, {
        user_id: userId,
        user_stream_pos: wakePos,
      });
    }
    if (wasDisplayOrAvatar) {
      await this.propagateProfileMembershipRefresh({
        userId,
        profileVersion: nextProfileVersion,
        profileDocument: nextDocument,
        now,
      });
    }
    return createSuccessResult({
      response: {
        profile_version: nextProfileVersion,
      },
    });
  }

  async deleteProfileField() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const keyName = normalizeString(request?.key_name, 'request.key_name');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Profile updates are only allowed for the authenticated user');
    }
    if (!isAllowedProfileKey(keyName)) {
      return createMatrixError(400, 'M_INVALID_PARAM', 'Unsupported profile key');
    }
    const now = request?.now ?? new Date().toISOString();
    const previousDocument = serializeProfileDocumentFromPersistence(this.persistence);
    if (!(keyName in previousDocument)) {
      return createSuccessResult({ response: {} });
    }
    const nextDocument = { ...previousDocument };
    delete nextDocument[keyName];

    let wakePos = 0;
    const nextProfileVersion = getNextProfileVersion(this.persistence);
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.profileDocument.delete({ key_name: keyName });
      for (const [fieldName, fieldValue] of Object.entries(nextDocument)) {
        this.persistence.profileDocument.put({
          key_name: fieldName,
          profile_version: nextProfileVersion,
          updated_at: now,
          value_json: structuredClone(fieldValue),
          record_json: {
            request_fingerprint: request?.request_fingerprint ?? null,
          },
        });
      }
      if ([PROFILE_KEY_DISPLAYNAME, PROFILE_KEY_AVATAR_URL].includes(keyName)) {
        const existingPresence = this.persistence.presence.get({ user_id: userId });
        const nextPresence = {
          ...(existingPresence ?? buildDefaultPresenceRecord(userId, now)),
          presence_version: existingPresence ? existingPresence.presence_version + 1 : 1,
          updated_at: now,
          last_active_at: existingPresence?.last_active_at ?? now,
          record: {
            ...(existingPresence?.record ?? {}),
            profile_version: nextProfileVersion,
          },
        };
        this.persistence.presence.put({
          user_id: userId,
          presence: nextPresence.presence,
          status_msg: nextPresence.status_msg,
          currently_active: nextPresence.currently_active,
          last_active_at: nextPresence.last_active_at,
          presence_version: nextPresence.presence_version,
          updated_at: now,
          record_json: nextPresence.record,
        });
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'presence',
          created_at: now,
          payload: {
            sender: userId,
            type: 'm.presence',
            content: buildPresenceContent({
              userId,
              presenceRecord: nextPresence,
              profileDocument: nextDocument,
              now,
            }),
          },
          record: {
            profile_version: nextProfileVersion,
            propagation_kind: 'profile_refresh',
          },
        });
        wakePos = streamEntry.stream_pos;
      }
    });
    if (wakePos > 0) {
      wakeSyncWaiters(this.env, {
        user_id: userId,
        user_stream_pos: wakePos,
      });
    }
    if ([PROFILE_KEY_DISPLAYNAME, PROFILE_KEY_AVATAR_URL].includes(keyName)) {
      await this.propagateProfileMembershipRefresh({
        userId,
        profileVersion: nextProfileVersion,
        profileDocument: nextDocument,
        now,
      });
    }
    return createSuccessResult({
      response: {
        profile_version: nextProfileVersion,
      },
    });
  }

  async getGlobalAccountData() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const type = normalizeString(request?.type, 'request.type');
    const row = this.persistence.globalAccountData.get({ type });
    if (!row) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Account data event does not exist');
    }
    return createSuccessResult({
      content: structuredClone(row.content),
    });
  }

  async putGlobalAccountData() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const type = normalizeString(request?.type, 'request.type');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Account data updates are only allowed for the authenticated user');
    }
    if (!request?.content || typeof request.content !== 'object' || Array.isArray(request.content)) {
      return createMatrixError(400, 'M_BAD_JSON', 'Account data content must be a JSON object');
    }
    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.globalAccountData.put({
        type,
        content_hash: null,
        updated_at: now,
        content_json: structuredClone(request.content),
      });
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'global_account_data',
        created_at: now,
        payload: {
          type,
          event: buildGlobalAccountDataEvent(type, request.content),
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async getRoomAccountData() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const type = normalizeString(request?.type, 'request.type');
    const row = this.persistence.roomAccountData.get({ room_id: roomId, type });
    if (!row) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Room account data event does not exist');
    }
    return createSuccessResult({
      content: structuredClone(row.content),
    });
  }

  async putRoomAccountData() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const type = normalizeString(request?.type, 'request.type');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Account data updates are only allowed for the authenticated user');
    }
    if (!request?.content || typeof request.content !== 'object' || Array.isArray(request.content)) {
      return createMatrixError(400, 'M_BAD_JSON', 'Account data content must be a JSON object');
    }
    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.roomAccountData.put({
        room_id: roomId,
        type,
        content_hash: null,
        updated_at: now,
        content_json: structuredClone(request.content),
      });
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'room_account_data',
        room_id: roomId,
        created_at: now,
        payload: {
          room_id: roomId,
          type,
          event: buildRoomAccountDataEvent(roomId, type, request.content),
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async getTags() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const row = this.persistence.roomAccountData.get({ room_id: roomId, type: 'm.tag' });
    return createSuccessResult({
      tags: structuredClone(row?.content ?? {}),
    });
  }

  async putTag() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const tag = normalizeString(request?.tag, 'request.tag');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Tag updates are only allowed for the authenticated user');
    }
    if (!request?.content || typeof request.content !== 'object' || Array.isArray(request.content)) {
      return createMatrixError(400, 'M_BAD_JSON', 'Tag content must be a JSON object');
    }
    const now = request?.now ?? new Date().toISOString();
    const existing = this.persistence.roomAccountData.get({ room_id: roomId, type: 'm.tag' });
    const nextContent = {
      ...(existing?.content ?? {}),
      [tag]: structuredClone(request.content),
    };
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.roomAccountData.put({
        room_id: roomId,
        type: 'm.tag',
        content_hash: null,
        updated_at: now,
        content_json: nextContent,
      });
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'room_account_data',
        room_id: roomId,
        created_at: now,
        payload: {
          room_id: roomId,
          type: 'm.tag',
          event: buildRoomAccountDataEvent(roomId, 'm.tag', nextContent),
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async deleteTag() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const tag = normalizeString(request?.tag, 'request.tag');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Tag updates are only allowed for the authenticated user');
    }
    const now = request?.now ?? new Date().toISOString();
    const existing = this.persistence.roomAccountData.get({ room_id: roomId, type: 'm.tag' });
    const nextContent = { ...(existing?.content ?? {}) };
    delete nextContent[tag];
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.roomAccountData.put({
        room_id: roomId,
        type: 'm.tag',
        content_hash: null,
        updated_at: now,
        content_json: nextContent,
      });
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'room_account_data',
        room_id: roomId,
        created_at: now,
        payload: {
          room_id: roomId,
          type: 'm.tag',
          event: buildRoomAccountDataEvent(roomId, 'm.tag', nextContent),
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async applyReadMarkers() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const roomId = normalizeString(request?.room_id, 'request.room_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Read marker updates are only allowed for the authenticated user');
    }
    const content = request?.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return createMatrixError(400, 'M_BAD_JSON', 'Read markers content must be a JSON object');
    }
    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      if (typeof content['m.fully_read'] === 'string') {
        this.persistence.roomAccountData.put({
          room_id: roomId,
          type: 'm.fully_read',
          content_hash: null,
          updated_at: now,
          content_json: { event_id: content['m.fully_read'] },
        });
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'room_account_data',
          room_id: roomId,
          created_at: now,
          payload: {
            room_id: roomId,
            type: 'm.fully_read',
            event: buildRoomAccountDataEvent(roomId, 'm.fully_read', { event_id: content['m.fully_read'] }),
          },
        });
        wakePos = Math.max(wakePos, streamEntry.stream_pos);
      }
      if (typeof content['m.marked_unread'] === 'boolean') {
        this.persistence.roomAccountData.put({
          room_id: roomId,
          type: 'm.marked_unread',
          content_hash: null,
          updated_at: now,
          content_json: { unread: content['m.marked_unread'] },
        });
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'room_account_data',
          room_id: roomId,
          created_at: now,
          payload: {
            room_id: roomId,
            type: 'm.marked_unread',
            event: buildRoomAccountDataEvent(roomId, 'm.marked_unread', { unread: content['m.marked_unread'] }),
          },
        });
        wakePos = Math.max(wakePos, streamEntry.stream_pos);
      }
    });
    if (wakePos > 0) {
      wakeSyncWaiters(this.env, {
        user_id: userId,
        user_stream_pos: wakePos,
      });
    }
    return createSuccessResult({ response: {} });
  }

  async getPresence() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Presence state does not exist');
    }
    const now = request?.now ?? new Date().toISOString();
    return createSuccessResult({
      content: buildPresenceContent({
        userId,
        presenceRecord: this.persistence.presence.get({ user_id: userId }),
        profileDocument: serializeProfileDocumentFromPersistence(this.persistence),
        now,
      }),
    });
  }

  async syncPresence() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Presence updates are only allowed for the authenticated user');
    }
    const presence = normalizeString(request?.presence, 'request.presence');
    if (!['online', 'offline', 'unavailable'].includes(presence)) {
      return createMatrixError(400, 'M_INVALID_PARAM', 'Presence must be one of online, offline, or unavailable');
    }
    const now = request?.now ?? new Date().toISOString();
    const existing = this.persistence.presence.get({ user_id: userId });
    const nextStatusMessage = existing?.status_msg ?? null;
    const nextCurrentlyActive = presence === 'online';
    const nextLastActiveAt = presence === 'online'
      ? now
      : (existing?.last_active_at ?? now);
    const changed = (
      !existing
      || existing.presence !== presence
      || existing.currently_active !== nextCurrentlyActive
      || (existing.status_msg ?? null) !== nextStatusMessage
    );
    if (!changed) {
      return createSuccessResult({
        response: {
          changed: false,
        },
      });
    }

    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      const nextRecord = {
        ...(existing ?? buildDefaultPresenceRecord(userId, now)),
        presence,
        status_msg: nextStatusMessage,
        currently_active: nextCurrentlyActive,
        last_active_at: nextLastActiveAt,
        presence_version: existing ? existing.presence_version + 1 : 1,
        updated_at: now,
        record: existing?.record ?? {},
      };
      this.persistence.presence.put({
        user_id: userId,
        presence: nextRecord.presence,
        status_msg: nextRecord.status_msg,
        currently_active: nextRecord.currently_active,
        last_active_at: nextRecord.last_active_at,
        presence_version: nextRecord.presence_version,
        updated_at: now,
        record_json: nextRecord.record,
      });
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'presence',
        created_at: now,
        payload: {
          sender: userId,
          type: 'm.presence',
          content: buildPresenceContent({
            userId,
            presenceRecord: nextRecord,
            profileDocument: serializeProfileDocumentFromPersistence(this.persistence),
            now,
          }),
        },
        record: {
          source: 'sync_presence',
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({
      response: {
        changed: true,
      },
    });
  }

  async setPresence() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Presence updates are only allowed for the authenticated user');
    }
    const presence = normalizeString(request?.presence, 'request.presence');
    if (!['online', 'offline', 'unavailable'].includes(presence)) {
      return createMatrixError(400, 'M_INVALID_PARAM', 'Presence must be one of online, offline, or unavailable');
    }
    if (request?.status_msg != null && typeof request.status_msg !== 'string') {
      return createMatrixError(400, 'M_INVALID_PARAM', 'status_msg must be a string when present');
    }
    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      const existing = this.persistence.presence.get({ user_id: userId });
      const nextRecord = {
        ...(existing ?? buildDefaultPresenceRecord(userId, now)),
        presence,
        status_msg: request?.status_msg ?? null,
        currently_active: request?.currently_active === true || presence === 'online',
        last_active_at: now,
        presence_version: existing ? existing.presence_version + 1 : 1,
        updated_at: now,
        record: existing?.record ?? {},
      };
      this.persistence.presence.put({
        user_id: userId,
        presence: nextRecord.presence,
        status_msg: nextRecord.status_msg,
        currently_active: nextRecord.currently_active,
        last_active_at: nextRecord.last_active_at,
        presence_version: nextRecord.presence_version,
        updated_at: now,
        record_json: nextRecord.record,
      });
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'presence',
        created_at: now,
        payload: {
          sender: userId,
          type: 'm.presence',
          content: buildPresenceContent({
            userId,
            presenceRecord: nextRecord,
            profileDocument: serializeProfileDocumentFromPersistence(this.persistence),
            now,
          }),
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async storeFilter() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Filter updates are only allowed for the authenticated user');
    }
    let filterEnvelope;
    try {
      filterEnvelope = createStoredFilterEnvelope(request?.filter_json);
    } catch (error) {
      return createMatrixError(400, 'M_BAD_JSON', error.message);
    }
    const existing = this.persistence.storedFilters.get({ filter_id: filterEnvelope.filter_id });
    if (!existing) {
      this.persistence.storedFilters.put({
        filter_id: filterEnvelope.filter_id,
        filter_hash: filterEnvelope.filter_hash,
        schema_version: 1,
        created_at: request?.now ?? new Date().toISOString(),
        filter_json: filterEnvelope.filter_json,
        record_json: {},
      });
    }
    return createSuccessResult({
      filter_id: filterEnvelope.filter_id,
      filter_hash: filterEnvelope.filter_hash,
      filter: structuredClone(filterEnvelope.filter_json),
    });
  }

  async getStoredFilter() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const filterId = normalizeStoredFilterId(normalizeString(request?.filter_id, 'request.filter_id').replace(/^f_/, ''));
    const row = this.persistence.storedFilters.get({ filter_id: filterId });
    if (!row) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Filter does not exist');
    }
    return createSuccessResult({
      filter_id: row.filter_id,
      filter_hash: row.filter_hash,
      filter: structuredClone(row.filter),
    });
  }

  async getPushRules() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Push rules are only available to the authenticated user');
    }
    return createSuccessResult({
      global: buildPushRulesView(userId, this.persistence.pushRules.list()),
    });
  }

  async getPushRule() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    let kind;
    try {
      kind = validatePushRuleKind(request?.kind);
    } catch (error) {
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
    }
    const ruleId = normalizeString(request?.rule_id, 'request.rule_id');
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Push rules are only available to the authenticated user');
    }
    const view = buildPushRulesView(userId, this.persistence.pushRules.list());
    const rule = view[kind].find((candidate) => candidate.rule_id === ruleId);
    if (!rule) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Push rule does not exist');
    }
    return createSuccessResult({
      rule: structuredClone(rule),
    });
  }

  async putPushRule() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Push rules are only available to the authenticated user');
    }
    let kind;
    let ruleId;
    try {
      kind = validatePushRuleKind(request?.kind);
      ruleId = validatePushRuleId(request?.rule_id);
    } catch (error) {
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
    }
    let wakePos = 0;
    const now = request?.now ?? new Date().toISOString();
    let validatedRecord;
    try {
      validatedRecord = buildPushRuleWriteRecord({
        kind,
        rule_id: ruleId,
        body: request?.body ?? {},
        priority_index: 0,
        updated_at: now,
      });
    } catch (error) {
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
    }
    try {
      const sql = this.requireSqlStorage();
      withSqliteTransaction(sql, () => {
        const existingRows = this.persistence.pushRules.list();
        const priorityIndex = computePushRulePriorityIndex(existingRows, kind, {
          before: request?.before ?? null,
          after: request?.after ?? null,
          rule_id: ruleId,
        });
        this.persistence.pushRules.put({
          scope: 'global',
          kind,
          rule_id: ruleId,
          enabled: true,
          priority_class: 'user',
          priority_index: priorityIndex,
          updated_at: now,
          actions_json: structuredClone(validatedRecord.actions_json),
          conditions_json: structuredClone(validatedRecord.conditions_json),
          record_json: structuredClone(validatedRecord.record_json),
        });
        const reindexedRows = reindexPushRuleRows(this.persistence.pushRules.list(), kind);
        for (const row of reindexedRows) {
          this.persistence.pushRules.put({
            scope: row.scope,
            kind: row.kind,
            rule_id: row.rule_id,
            enabled: row.enabled,
            priority_class: row.priority_class,
            priority_index: row.priority_index,
            updated_at: now,
            actions_json: structuredClone(row.actions),
            conditions_json: structuredClone(row.conditions),
            record_json: structuredClone(row.record),
          });
        }
        const limitCheck = assertPushRulesStorageLimits(this.persistence.pushRules.list());
        if (!limitCheck.ok) {
          throw new Error(JSON.stringify(limitCheck));
        }
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'push_rules',
          created_at: now,
          payload: {
            type: 'm.push_rules',
          },
        });
        wakePos = streamEntry.stream_pos;
      });
    } catch (error) {
      return mapPushRuleWriteErrorToMatrixError(error);
    }
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async deletePushRule() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Push rules are only available to the authenticated user');
    }
    let kind;
    let ruleId;
    try {
      kind = validatePushRuleKind(request?.kind);
      ruleId = validatePushRuleId(request?.rule_id);
    } catch (error) {
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
    }
    const existing = this.persistence.pushRules.get({ scope: 'global', kind, rule_id: ruleId });
    if (!existing || existing.record?.default_rule === true) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Push rule does not exist');
    }
    const now = request?.now ?? new Date().toISOString();
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      this.persistence.pushRules.delete({ scope: 'global', kind, rule_id: ruleId });
      const reindexedRows = reindexPushRuleRows(this.persistence.pushRules.list(), kind);
      for (const row of reindexedRows) {
        this.persistence.pushRules.put({
          scope: row.scope,
          kind: row.kind,
          rule_id: row.rule_id,
          enabled: row.enabled,
          priority_class: row.priority_class,
          priority_index: row.priority_index,
          updated_at: now,
          actions_json: structuredClone(row.actions),
          conditions_json: structuredClone(row.conditions),
          record_json: structuredClone(row.record),
        });
      }
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'push_rules',
        created_at: now,
        payload: {
          type: 'm.push_rules',
        },
      });
      wakePos = streamEntry.stream_pos;
    });
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async setPushRuleEnabled() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Push rules are only available to the authenticated user');
    }
    let kind;
    let ruleId;
    try {
      kind = validatePushRuleKind(request?.kind);
      ruleId = validatePushRuleId(request?.rule_id, { allow_default: true });
    } catch (error) {
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
    }
    if (typeof request?.enabled !== 'boolean') {
      return createMatrixError(400, 'M_BAD_JSON', 'enabled must be a boolean');
    }
    const now = request?.now ?? new Date().toISOString();
    const existingCustom = this.persistence.pushRules.get({ scope: 'global', kind, rule_id: ruleId });
    const defaultRule = buildPushRulesView(userId, this.persistence.pushRules.list())[kind].find((rule) => rule.rule_id === ruleId);
    if (!existingCustom && !defaultRule) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Push rule does not exist');
    }
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    try {
      withSqliteTransaction(sql, () => {
        const nextRow = existingCustom
          ? {
            scope: existingCustom.scope,
            kind: existingCustom.kind,
            rule_id: existingCustom.rule_id,
            enabled: request.enabled,
            priority_class: existingCustom.priority_class,
            priority_index: existingCustom.priority_index,
            updated_at: now,
            actions_json: structuredClone(existingCustom.actions),
            conditions_json: structuredClone(existingCustom.conditions),
            record_json: structuredClone(existingCustom.record),
          }
          : {
            scope: 'global',
            kind,
            rule_id: ruleId,
            enabled: request.enabled,
            priority_class: 'default',
            priority_index: 0,
            updated_at: now,
            actions_json: structuredClone(defaultRule.actions ?? []),
            conditions_json: structuredClone(defaultRule.conditions ?? []),
            record_json: {
              default_rule: true,
              rule_kind: kind,
              pattern: defaultRule.pattern ?? null,
            },
          };
        this.persistence.pushRules.put(nextRow);
        const limitCheck = assertPushRulesStorageLimits(this.persistence.pushRules.list());
        if (!limitCheck.ok) {
          throw new Error(JSON.stringify(limitCheck));
        }
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'push_rules',
          created_at: now,
          payload: { type: 'm.push_rules' },
        });
        wakePos = streamEntry.stream_pos;
      });
    } catch (error) {
      return mapPushRuleWriteErrorToMatrixError(error);
    }
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async setPushRuleActions() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Push rules are only available to the authenticated user');
    }
    let kind;
    let ruleId;
    try {
      kind = validatePushRuleKind(request?.kind);
      ruleId = validatePushRuleId(request?.rule_id, { allow_default: true });
    } catch (error) {
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
    }
    if (!Array.isArray(request?.actions)) {
      return createMatrixError(400, 'M_BAD_JSON', 'actions must be an array');
    }
    const now = request?.now ?? new Date().toISOString();
    const existingCustom = this.persistence.pushRules.get({ scope: 'global', kind, rule_id: ruleId });
    const defaultRule = buildPushRulesView(userId, this.persistence.pushRules.list())[kind].find((rule) => rule.rule_id === ruleId);
    if (!existingCustom && !defaultRule) {
      return createMatrixError(404, 'M_NOT_FOUND', 'Push rule does not exist');
    }
    let wakePos = 0;
    const sql = this.requireSqlStorage();
    try {
      withSqliteTransaction(sql, () => {
        const nextRow = existingCustom
          ? {
            scope: existingCustom.scope,
            kind: existingCustom.kind,
            rule_id: existingCustom.rule_id,
            enabled: existingCustom.enabled,
            priority_class: existingCustom.priority_class,
            priority_index: existingCustom.priority_index,
            updated_at: now,
            actions_json: structuredClone(request.actions),
            conditions_json: structuredClone(existingCustom.conditions),
            record_json: structuredClone(existingCustom.record),
          }
          : {
            scope: 'global',
            kind,
            rule_id: ruleId,
            enabled: defaultRule.enabled !== false,
            priority_class: 'default',
            priority_index: 0,
            updated_at: now,
            actions_json: structuredClone(request.actions),
            conditions_json: structuredClone(defaultRule.conditions ?? []),
            record_json: {
              default_rule: true,
              rule_kind: kind,
              pattern: defaultRule.pattern ?? null,
            },
          };
        this.persistence.pushRules.put(nextRow);
        const limitCheck = assertPushRulesStorageLimits(this.persistence.pushRules.list());
        if (!limitCheck.ok) {
          throw new Error(JSON.stringify(limitCheck));
        }
        const streamEntry = this.persistence.appendUserStreamWithinTransaction({
          user_id: userId,
          stream_kind: 'push_rules',
          created_at: now,
          payload: { type: 'm.push_rules' },
        });
        wakePos = streamEntry.stream_pos;
      });
    } catch (error) {
      return mapPushRuleWriteErrorToMatrixError(error);
    }
    wakeSyncWaiters(this.env, {
      user_id: userId,
      user_stream_pos: wakePos,
    });
    return createSuccessResult({ response: {} });
  }

  async checkRegistrationAvailability() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    let localpart;
    try {
      localpart = normalizeLocalpart(request?.localpart);
    } catch {
      return createMatrixError(400, 'M_INVALID_USERNAME', 'The requested username is not valid');
    }
    const userId = buildLocalUserId(localpart, this.config.text.MATRIX_SERVER_NAME);
    const principal = this.persistence.userPrincipal.get();
    if (!this.persistence.getRuntimeState().user_id && principal?.user_id) {
      this.persistence.setRuntimeIdentity({ user_id: principal.user_id, updated_at: now });
    }
    if (principal?.user_id === userId) {
      return createMatrixError(400, 'M_USER_IN_USE', 'The requested username is already in use');
    }
    return createSuccessResult({ available: true });
  }

  async register() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    try {
      const [request = {}] = arguments;
      const now = request?.now ?? new Date().toISOString();
      let localpart;
      try {
        localpart = normalizeLocalpart(request?.localpart);
      } catch {
        return createMatrixError(400, 'M_INVALID_USERNAME', 'The requested username is not valid');
      }
      const semanticQuota = this.enforceSemanticQuota('userdo_register', `register:${localpart}`, {
        nowIso: now,
        message: 'Registration rate limit exceeded',
      });
      if (!semanticQuota.ok) {
        return createMatrixError(429, 'M_LIMIT_EXCEEDED', 'Registration rate limit exceeded', {
          retry_after_ms: semanticQuota.retry_after_ms,
        });
      }

      const userId = buildLocalUserId(localpart, this.config.text.MATRIX_SERVER_NAME);
      const requestFingerprint = request?.request_fingerprint ?? null;
      const uiaNonce = request?.uia_nonce ?? null;
      const password = request?.password;
      if (typeof password !== 'string' || password.trim().length === 0) {
        return createMatrixError(400, 'M_MISSING_PARAM', 'password must be present');
      }

      if (!this.persistence.getRuntimeState().user_id) {
        this.persistence.setRuntimeIdentity({ user_id: userId, updated_at: now });
      }

      const sql = this.requireSqlStorage();
      return withSqliteTransaction(sql, () => {
        const principal = this.persistence.userPrincipal.get();
        const phase04 = readPhase04Meta(principal);
        const isIdempotentRetry = Boolean(
          principal
          && phase04.registration?.uia_nonce === uiaNonce
          && phase04.registration?.request_fingerprint === requestFingerprint,
        );

        if (principal && !isIdempotentRetry) {
          return createMatrixError(400, 'M_USER_IN_USE', 'The requested username is already in use');
        }

        if (principal && isIdempotentRetry) {
          const existingRegistration = phase04.registration ?? null;
          const existingSession = existingRegistration?.session_id
            ? this.persistence.sessions.get(existingRegistration.session_id)
            : null;
          if (!existingSession || existingSession.revoked_at) {
            return createMatrixError(409, 'M_CONFLICT', 'Registration was already completed for this UIA session');
          }
          const tokenRevision = getSessionTokenRevision(existingSession);
          const tokenRootKeyVersion = getSessionTokenRootKeyVersion(existingSession);
          const { accessToken, refreshToken } = issueSessionTokens(this.env, {
            userId,
            sessionId: existingSession.session_id,
            tokenRevision,
            tokenRootKeyVersion,
          });
          return createSuccessResult({
            response: makeTokenResponse({
              userId,
              deviceId: existingRegistration?.device_id ?? existingSession.device_id,
              accessToken,
              refreshToken,
            }),
          });
        }

        if (!principal) {
          this.persistence.userPrincipal.put({
            user_id: userId,
            localpart,
            user_type: 'human',
            password_hash_or_null: hashPassword(password),
            password_login_enabled: true,
            created_at: now,
            deactivated_at_or_null: null,
            erase_requested_flag: false,
            auth_version: 1,
            registration_source: 'self-service',
            record: mergePhase04Meta(null, {
              registration: {
                uia_nonce: uiaNonce,
                request_fingerprint: requestFingerprint,
                completed_at: now,
              },
            }),
          });
        }

        const currentPrincipal = this.persistence.userPrincipal.get();
        const deviceId = typeof request?.device_id === 'string' && request.device_id.trim().length > 0
          ? request.device_id.trim()
          : generateDeviceId();
        const existingDevice = this.persistence.devices.get(deviceId);
        this.persistence.devices.put(deviceRowToPutRecord(existingDevice ?? {
          device_id: deviceId,
          display_name: request?.initial_device_display_name ?? null,
          created_at: now,
          updated_at: now,
          last_seen_at: now,
          last_seen_ip: null,
          deleted_at: null,
          record: {},
        }, {
          display_name: request?.initial_device_display_name ?? existingDevice?.display_name ?? null,
          updated_at: now,
          last_seen_at: now,
          deleted_at: null,
        }));

        const sessionId = generateSessionId();
        const tokenRevision = 0;
        const { accessToken, refreshToken, tokenRootKeyVersion } = issueSessionTokens(this.env, {
          userId,
          sessionId,
          tokenRevision,
        });
        const runtimeState = this.persistence.getRuntimeState();
        const sessionRecord = {
          session_id: sessionId,
          access_token_hash: hashOpaqueToken(accessToken),
          refresh_token_hash: hashOpaqueToken(refreshToken),
          device_id: deviceId,
          auth_version: currentPrincipal.auth_version,
          session_epoch: runtimeState.session_epoch,
          is_guest: false,
          created_at: now,
          updated_at: now,
          expires_at: isoAfter(now, DEFAULT_ACCESS_TOKEN_TTL_MS),
          refresh_expires_at: isoAfter(now, DEFAULT_REFRESH_TOKEN_TTL_MS),
          revoked_at: null,
          record: {
            route: 'register',
            token_revision: tokenRevision,
            token_root_key_version: tokenRootKeyVersion,
          },
        };
        this.persistence.sessions.put(sessionRowToPutRecord(sessionRecord));
        this.persistence.userPrincipal.put(principalRowToPutRecord(currentPrincipal, {
          record: mergePhase04Meta(currentPrincipal, {
            registration: {
              uia_nonce: uiaNonce,
              request_fingerprint: requestFingerprint,
              completed_at: now,
              session_id: sessionId,
              device_id: deviceId,
              token_revision: tokenRevision,
              token_root_key_version: tokenRootKeyVersion,
            },
          }),
        }));
        return createSuccessResult({
          response: makeTokenResponse({
            userId,
            deviceId,
            accessToken,
            refreshToken,
          }),
        });
      });
    } finally {
      this.observeAuthorityMetric('userdo.operation.latency_ms', Date.now() - startedAt, {
        operation: 'register',
      });
    }
  }

  async verifyPasswordAuth() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const localpart = normalizeLocalpart(request?.localpart);
    const userId = buildLocalUserId(localpart, this.config.text.MATRIX_SERVER_NAME);
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
    }
    if (principal.deactivated_at_or_null) {
      return createMatrixError(403, 'M_USER_DEACTIVATED', 'The user has been deactivated');
    }
    if (!principal.password_login_enabled || !verifyPassword(request?.password ?? '', principal.password_hash_or_null)) {
      return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
    }
    return createSuccessResult({
      user_id: principal.user_id,
      localpart: principal.localpart,
    });
  }

  async login() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    try {
      const [request = {}] = arguments;
      const now = request?.now ?? new Date().toISOString();
      let localpart;
      try {
        localpart = normalizeLocalpart(request?.localpart);
      } catch {
        return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
      }
      const semanticQuota = this.enforceSemanticQuota('userdo_login', `login:${localpart}`, {
        nowIso: now,
        message: 'Login rate limit exceeded',
      });
      if (!semanticQuota.ok) {
        return createMatrixError(429, 'M_LIMIT_EXCEEDED', 'Login rate limit exceeded', {
          retry_after_ms: semanticQuota.retry_after_ms,
        });
      }
      const passwordResult = await this.verifyPasswordAuth({
        localpart,
        password: request?.password ?? '',
      });
      if (!passwordResult.ok) {
        return passwordResult;
      }

      const userId = passwordResult.user_id;
      if (!this.persistence.getRuntimeState().user_id) {
        this.persistence.setRuntimeIdentity({ user_id: userId, updated_at: now });
      }

      const sql = this.requireSqlStorage();
      return withSqliteTransaction(sql, () => {
        const principal = this.persistence.userPrincipal.get();
        const deviceId = typeof request?.device_id === 'string' && request.device_id.trim().length > 0
          ? request.device_id.trim()
          : generateDeviceId();
        const existingDevice = this.persistence.devices.get(deviceId);
        this.persistence.devices.put(deviceRowToPutRecord(existingDevice ?? {
          device_id: deviceId,
          display_name: request?.initial_device_display_name ?? null,
          created_at: now,
          updated_at: now,
          last_seen_at: now,
          last_seen_ip: null,
          deleted_at: null,
          record: {},
        }, {
          display_name: request?.initial_device_display_name ?? existingDevice?.display_name ?? null,
          updated_at: now,
          last_seen_at: now,
          deleted_at: null,
        }));

        const sessionId = generateSessionId();
        const tokenRevision = 0;
        const { accessToken, refreshToken, tokenRootKeyVersion } = issueSessionTokens(this.env, {
          userId,
          sessionId,
          tokenRevision,
        });
        const runtimeState = this.persistence.getRuntimeState();
        this.persistence.sessions.put(sessionRowToPutRecord({
          session_id: sessionId,
          access_token_hash: hashOpaqueToken(accessToken),
          refresh_token_hash: hashOpaqueToken(refreshToken),
          device_id: deviceId,
          auth_version: principal.auth_version,
          session_epoch: runtimeState.session_epoch,
          is_guest: false,
          created_at: now,
          updated_at: now,
          expires_at: isoAfter(now, DEFAULT_ACCESS_TOKEN_TTL_MS),
          refresh_expires_at: isoAfter(now, DEFAULT_REFRESH_TOKEN_TTL_MS),
          revoked_at: null,
          record: {
            route: 'login',
            token_revision: tokenRevision,
            token_root_key_version: tokenRootKeyVersion,
          },
        }));
        return createSuccessResult({
          response: makeTokenResponse({
            userId,
            deviceId,
            accessToken,
            refreshToken,
          }),
        });
      });
    } finally {
      this.observeAuthorityMetric('userdo.operation.latency_ms', Date.now() - startedAt, {
        operation: 'login',
      });
    }
  }

  async refreshSession() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const refreshToken = request?.refresh_token ?? null;
    const now = request?.now ?? new Date().toISOString();
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    let hintedUserId;
    try {
      hintedUserId = getRefreshTokenUserIdHint(refreshToken);
    } catch {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    const principal = this.persistence.userPrincipal.get();
    const runtimeState = this.persistence.getRuntimeState();
    if (
      !principal
      || principal.user_id !== hintedUserId
      || principal.deactivated_at_or_null
    ) {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    const session = findSessionByHashedToken(this.persistence, 'refresh_token_hash', hashOpaqueToken(refreshToken));
    if (
      !session
      || session.revoked_at
      || toMillisOrInfinity(session.refresh_expires_at) <= Date.parse(now)
      || session.auth_version !== principal.auth_version
      || session.session_epoch !== runtimeState.session_epoch
    ) {
      return createMatrixError(401, 'M_UNKNOWN_TOKEN', 'Unknown refresh token');
    }

    const sql = this.requireSqlStorage();
    try {
      const semanticQuota = this.enforceSemanticQuota('userdo_refresh', `refresh:${session.session_id}`, {
        nowIso: now,
        message: 'Refresh rate limit exceeded',
      });
      if (!semanticQuota.ok) {
        return createMatrixError(429, 'M_LIMIT_EXCEEDED', 'Refresh rate limit exceeded', {
          retry_after_ms: semanticQuota.retry_after_ms,
        });
      }
      return withSqliteTransaction(sql, () => {
      const nextTokenRevision = getSessionTokenRevision(session) + 1;
      const { accessToken: nextAccessToken, refreshToken: nextRefreshToken, tokenRootKeyVersion } = issueSessionTokens(this.env, {
        userId: principal.user_id,
        sessionId: session.session_id,
        tokenRevision: nextTokenRevision,
      });
      this.persistence.sessions.put(sessionRowToPutRecord(session, {
        access_token_hash: hashOpaqueToken(nextAccessToken),
        refresh_token_hash: hashOpaqueToken(nextRefreshToken),
        updated_at: now,
        expires_at: isoAfter(now, DEFAULT_ACCESS_TOKEN_TTL_MS),
        refresh_expires_at: isoAfter(now, DEFAULT_REFRESH_TOKEN_TTL_MS),
        record: {
          ...(session.record ?? {}),
          refreshed_at: now,
          token_revision: nextTokenRevision,
          token_root_key_version: tokenRootKeyVersion,
        },
      }));
      return createSuccessResult({
        response: {
          access_token: nextAccessToken,
          expires_in_ms: DEFAULT_ACCESS_TOKEN_TTL_MS,
          refresh_token: nextRefreshToken,
        },
      });
      });
    } finally {
      this.observeAuthorityMetric('userdo.operation.latency_ms', Date.now() - startedAt, {
        operation: 'refreshSession',
      });
    }
  }

  async logoutSession() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const sessionId = request?.session_id ?? null;
    const now = request?.now ?? new Date().toISOString();
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'session_id must be present');
    }
    const session = this.persistence.sessions.get(sessionId);
    if (!session) {
      return createSuccessResult({ response: {} });
    }
    this.persistence.sessions.put(sessionRowToPutRecord(session, {
      revoked_at: now,
      updated_at: now,
    }));
    return createSuccessResult({ response: {} });
  }

  async logoutAllSessions() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      for (const session of this.persistence.sessions.list()) {
        if (!session.revoked_at) {
          this.persistence.sessions.put(sessionRowToPutRecord(session, {
            revoked_at: now,
            updated_at: now,
          }));
        }
      }
      return createSuccessResult({ response: {} });
    });
  }

  async scheduleMediaLifecycleAlarm(nextAlarmAt) {
    const effectiveAlarmAt = earlierIso(nextAlarmAt, this.getRegistryRetryMarker()?.next_retry_at ?? null);
    if (effectiveAlarmAt) {
      await this.ctx.storage.setAlarm(Date.parse(effectiveAlarmAt));
      return;
    }
    await this.ctx.storage.deleteAlarm?.();
  }

  getRegistryRetryMarker() {
    const principal = this.persistence.userPrincipal.get();
    return readRegistryRetryMarker(principal?.record);
  }

  persistRegistryRetryMarker(marker) {
    const principal = this.persistence.userPrincipal.get();
    if (!principal) {
      return null;
    }
    return this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
      record: marker == null
        ? clearRegistryRetryMarker(principal.record)
        : withRegistryRetryMarker(principal.record, marker),
    }));
  }

  async ensureShardRegistry() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const principal = this.persistence.userPrincipal.get();
    if (!principal?.user_id) {
      return createSuccessResult({
        registered: false,
      });
    }
    const now = normalizeString(request?.now ?? new Date().toISOString(), 'request.now');
    try {
      await upsertShardRegistryBarrier(this.env, {
        shardType: 'UserDO',
        shardKey: principal.user_id,
        schemaVersion: USER_DO_SCHEMA_VERSION,
        nowIso: now,
      });
      if (this.getRegistryRetryMarker()) {
        this.persistRegistryRetryMarker(null);
      }
      await this.scheduleMediaLifecycleAlarm(getUserMediaLifecycleNextAlarm(this, now));
      return createSuccessResult({
        registered: true,
        shard_type: 'UserDO',
        shard_key: principal.user_id,
      });
    } catch (error) {
      const mappedError = createShardRegistryBarrierError({
        shardType: 'UserDO',
        shardKey: principal.user_id,
        error,
      });
      this.persistRegistryRetryMarker(buildRegistryRetryMarker({
        existingMarker: this.getRegistryRetryMarker(),
        shardType: 'UserDO',
        shardKey: principal.user_id,
        schemaVersion: USER_DO_SCHEMA_VERSION,
        nowIso: now,
        error: mappedError,
      }));
      await this.scheduleMediaLifecycleAlarm(getUserMediaLifecycleNextAlarm(this, now));
      return {
        ok: false,
        error: mappedError,
      };
    }
  }

  async retryPendingShardRegistry({ now = new Date().toISOString() } = {}) {
    const principal = this.persistence.userPrincipal.get();
    const marker = this.getRegistryRetryMarker();
    if (!principal?.user_id || !marker) {
      return {
        attempted: false,
      };
    }
    const retryAtMs = getRegistryRetryAtMillis(marker);
    if (retryAtMs != null && retryAtMs > Date.parse(now)) {
      return {
        attempted: false,
        next_retry_at: marker.next_retry_at,
      };
    }
    try {
      await upsertShardRegistryBarrier(this.env, {
        shardType: 'UserDO',
        shardKey: principal.user_id,
        schemaVersion: USER_DO_SCHEMA_VERSION,
        nowIso: now,
      });
      this.persistRegistryRetryMarker(null);
      return {
        attempted: true,
        repaired: true,
      };
    } catch (error) {
      const mappedError = createShardRegistryBarrierError({
        shardType: 'UserDO',
        shardKey: principal.user_id,
        error,
      });
      const nextMarker = buildRegistryRetryMarker({
        existingMarker: marker,
        shardType: 'UserDO',
        shardKey: principal.user_id,
        schemaVersion: USER_DO_SCHEMA_VERSION,
        nowIso: now,
        error: mappedError,
      });
      this.persistRegistryRetryMarker(nextMarker);
      return {
        attempted: true,
        repaired: false,
        next_retry_at: nextMarker.next_retry_at,
      };
    }
  }

  async cleanupOrphanedMediaObjects(entries = [], { now = new Date().toISOString() } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return {
        cleaned: 0,
      };
    }
    const bucket = this.env.MATRIX_MEDIA_BUCKET;
    if (!bucket || typeof bucket.delete !== 'function') {
      return {
        cleaned: 0,
      };
    }
    const cleanedIds = [];
    for (const entry of entries) {
      if (typeof entry?.r2_object_key !== 'string' || entry.r2_object_key.length === 0) {
        continue;
      }
      try {
        await bucket.delete(entry.r2_object_key);
        cleanedIds.push(entry.pending_upload_id);
      } catch {
        const grant = this.persistence.pendingUploadGrants.get({ pending_upload_id: entry.pending_upload_id });
        if (!grant) {
          continue;
        }
        this.persistence.pendingUploadGrants.put({
          pending_upload_id: grant.pending_upload_id,
          media_id: grant.media_id,
          content_type: grant.content_type,
          max_bytes: grant.max_bytes,
          state: 'orphaned',
          granted_at: grant.granted_at,
          expires_at: grant.expires_at,
          finalized_at: grant.finalized_at,
          record_json: {
            ...(grant.record ?? {}),
            cleanup_last_failed_at: now,
          },
        });
      }
    }
    for (const pendingUploadId of cleanedIds) {
      const grant = this.persistence.pendingUploadGrants.get({ pending_upload_id: pendingUploadId });
      if (!grant || normalizePendingUploadState(grant.state) !== 'orphaned') {
        continue;
      }
      this.persistence.pendingUploadGrants.put({
        pending_upload_id: grant.pending_upload_id,
        media_id: grant.media_id,
        content_type: grant.content_type,
        max_bytes: grant.max_bytes,
        state: 'cleaned',
        granted_at: grant.granted_at,
        expires_at: grant.expires_at,
        finalized_at: grant.finalized_at,
        record_json: {
          ...(grant.record ?? {}),
          cleanup_completed_at: now,
        },
      });
    }
    return {
      cleaned: cleanedIds.length,
    };
  }

  async beginMediaUpload() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    try {
      const [request = {}] = arguments;
      const principal = this.persistence.userPrincipal.get();
      const userId = normalizeString(request?.user_id ?? principal?.user_id, 'request.user_id');
      if (!principal || principal.user_id !== userId || principal.deactivated_at_or_null) {
        return {
          ok: false,
          error: createInternalErrorEnvelope({
            code: 'target_not_local',
            message: 'Target user does not exist on this homeserver',
            retryable: false,
          }),
        };
      }
      const semanticQuota = this.enforceSemanticQuota('userdo_media', `media:${userId}`, {
        nowIso: request?.now ?? new Date().toISOString(),
        message: 'Media upload rate limit exceeded',
      });
      if (!semanticQuota.ok) {
        return {
          ok: false,
          error: createInternalErrorEnvelope({
            code: 'quota_exceeded',
            message: 'Media upload rate limit exceeded',
            retryable: true,
            details: {
              retry_after_ms: semanticQuota.retry_after_ms,
            },
          }),
        };
      }
      const declaredSize = normalizeInteger(request?.declared_size ?? 0, 'request.declared_size', { min: 0 });
      const maxBytes = normalizeInteger(
        request?.max_bytes ?? this.config.text.MATRIX_MEDIA_MAX_UPLOAD_BYTES,
        'request.max_bytes',
        { min: 1 },
      );
      if (declaredSize > maxBytes) {
        return {
          ok: false,
          error: createInternalErrorEnvelope({
            code: 'content_too_large',
            message: `Media upload exceeds the ${maxBytes} byte limit`,
            retryable: false,
          }),
        };
      }
      const contentType = normalizeString(request?.content_type ?? 'application/octet-stream', 'request.content_type');
      const now = request?.now ?? new Date().toISOString();
      let sweepResult = {
        orphan_cleanup: [],
        next_alarm_at: null,
      };
      let grant = null;
      const sql = this.requireSqlStorage();
      withSqliteTransaction(sql, () => {
        sweepResult = sweepPendingUploadGrants(this, now, { applyChanges: true });
        const mediaId = request?.media_id == null
          ? makeId('media')
          : normalizeString(request.media_id, 'request.media_id');
        const pendingUploadId = buildPendingUploadId(mediaId);
        const existingGrant = this.persistence.pendingUploadGrants.get({ pending_upload_id: pendingUploadId });
        if (existingGrant && normalizePendingUploadState(existingGrant.state) === 'pending') {
          const effectiveMaxBytes = Math.min(
            normalizeInteger(existingGrant.max_bytes, 'existingGrant.max_bytes', { min: 1 }),
            maxBytes,
          );
          if (declaredSize > effectiveMaxBytes) {
            throw createInternalErrorEnvelope({
              code: 'content_too_large',
              message: `Media upload exceeds the ${effectiveMaxBytes} byte limit`,
              retryable: false,
            });
          }
          grant = {
            ...buildPendingUploadGrantView(existingGrant, this.env.MATRIX_SERVER_NAME),
            max_bytes: effectiveMaxBytes,
          };
          return;
        }
        if (request?.require_existing === true) {
          throw createInternalErrorEnvelope({
            code: 'upload_not_found',
            message: `Pending upload ${pendingUploadId} does not exist`,
            retryable: false,
          });
        }
        const activePendingCount = this.persistence.pendingUploadGrants.list()
          .filter((row) => normalizePendingUploadState(row.state) === 'pending')
          .length;
        if (activePendingCount >= 8) {
          throw createInternalErrorEnvelope({
            code: 'quota_exceeded',
            message: 'Too many concurrent pending uploads',
            retryable: true,
          });
        }
        const expiresAt = isoAfter(now, DEFAULT_MEDIA_PENDING_UPLOAD_TTL_MS);
        const row = this.persistence.pendingUploadGrants.put({
          pending_upload_id: pendingUploadId,
          media_id: mediaId,
          content_type: contentType,
          max_bytes: maxBytes,
          state: 'pending',
          granted_at: now,
          expires_at: expiresAt,
          finalized_at: null,
          record_json: {
            allowed_content_types: [contentType],
            device_id: request?.device_id ?? null,
            filename: request?.filename ?? null,
            request_fingerprint: request?.request_fingerprint ?? null,
            reservation_only: request?.reservation_only === true,
            sha256: request?.sha256 ?? null,
          },
        });
        grant = buildPendingUploadGrantView(row, this.env.MATRIX_SERVER_NAME);
        const alarmAt = sweepResult.next_alarm_at == null
          ? expiresAt
          : (Date.parse(sweepResult.next_alarm_at) < Date.parse(expiresAt) ? sweepResult.next_alarm_at : expiresAt);
        sweepResult = {
          ...sweepResult,
          next_alarm_at: alarmAt,
        };
      });
      await this.cleanupOrphanedMediaObjects(sweepResult.orphan_cleanup, { now });
      await this.scheduleMediaLifecycleAlarm(getUserMediaLifecycleNextAlarm(this, now));
      return createSuccessResult({
        grant,
      });
    } finally {
      this.observeAuthorityMetric('userdo.operation.latency_ms', Date.now() - startedAt, {
        operation: 'beginMediaUpload',
      });
    }
  }

  async finalizeMediaUpload() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const pendingUploadId = normalizeString(request?.pending_upload_id, 'request.pending_upload_id');
    const finalizeState = normalizePendingUploadState(request?.finalize_state ?? 'completed');
    const now = normalizeString(request?.upload_completed_at ?? request?.now ?? new Date().toISOString(), 'request.upload_completed_at');
    let sweepResult = {
      orphan_cleanup: [],
      next_alarm_at: null,
    };
    let ack = null;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      sweepResult = sweepPendingUploadGrants(this, now, { applyChanges: true });
      const grant = this.persistence.pendingUploadGrants.get({ pending_upload_id: pendingUploadId });
      if (!grant) {
        throw createInternalErrorEnvelope({
          code: 'upload_not_found',
          message: `Pending upload ${pendingUploadId} does not exist`,
          retryable: false,
        });
      }
      const currentState = normalizePendingUploadState(grant.state);
      if (currentState === 'completed') {
        ack = {
          mxc_uri: grant.record?.mxc_uri ?? buildMxcUri(this.env.MATRIX_SERVER_NAME, grant.media_id),
          media_id: grant.media_id,
          catalog_visibility: 'pending',
          thumbnail_job_enqueued: false,
        };
        return;
      }
      if (currentState !== 'pending') {
        throw createInternalErrorEnvelope({
          code: 'upload_not_found',
          message: `Pending upload ${pendingUploadId} is already terminal`,
          retryable: false,
        });
      }
      const recordJson = {
        ...(grant.record ?? {}),
        finalized_at: now,
      };
      if (finalizeState === 'completed') {
        recordJson.r2_object_key = normalizeString(request?.r2_object_key, 'request.r2_object_key');
        recordJson.byte_size = normalizeInteger(request?.byte_size, 'request.byte_size', { min: 0 });
        recordJson.content_type = normalizeString(request?.content_type ?? grant.content_type, 'request.content_type');
        recordJson.sha256 = normalizeString(request?.sha256, 'request.sha256');
        recordJson.mxc_uri = buildMxcUri(this.env.MATRIX_SERVER_NAME, grant.media_id);
        ack = {
          mxc_uri: recordJson.mxc_uri,
          media_id: grant.media_id,
          catalog_visibility: 'pending',
          thumbnail_job_enqueued: false,
        };
      } else {
        recordJson.finalize_error = normalizeString(
          request?.error_message ?? (finalizeState === 'reverted' ? 'R2 upload failed' : 'Finalize failed after object write'),
          'request.error_message',
        );
        if (finalizeState === 'orphaned') {
          recordJson.r2_object_key = normalizeString(request?.r2_object_key, 'request.r2_object_key');
        }
      }
      this.persistence.pendingUploadGrants.put({
        pending_upload_id: grant.pending_upload_id,
        media_id: grant.media_id,
        content_type: recordJson.content_type ?? grant.content_type,
        max_bytes: grant.max_bytes,
        state: finalizeState,
        granted_at: grant.granted_at,
        expires_at: grant.expires_at,
        finalized_at: now,
        record_json: recordJson,
      });
      if (finalizeState === 'orphaned') {
        const orphanAlarmAt = new Date(Date.parse(now) + DEFAULT_MEDIA_ORPHAN_RETENTION_MS).toISOString();
        sweepResult = {
          ...sweepResult,
          next_alarm_at: sweepResult.next_alarm_at == null
            ? orphanAlarmAt
            : (Date.parse(sweepResult.next_alarm_at) < Date.parse(orphanAlarmAt) ? sweepResult.next_alarm_at : orphanAlarmAt),
        };
      }
    });
    await this.cleanupOrphanedMediaObjects(sweepResult.orphan_cleanup, { now });
    await this.scheduleMediaLifecycleAlarm(getUserMediaLifecycleNextAlarm(this, now));
    return createSuccessResult({
      ack,
    });
  }

  async getUserDirectoryEntry() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id == null
      ? this.persistence.userPrincipal.get()?.user_id ?? null
      : normalizeString(request.user_id, 'request.user_id');
    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createSuccessResult({
        entry: null,
      });
    }
    return createSuccessResult({
      entry: buildUserDirectoryProjection(this, request?.updated_at ?? new Date().toISOString()),
    });
  }

  async resolvePhase04PasswordChangeReplay() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id ?? null;
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    if (typeof userId !== 'string' || userId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'user_id must be present');
    }
    if (typeof requestFingerprint !== 'string' || requestFingerprint.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'request_fingerprint must be present');
    }
    if (typeof uiaNonce !== 'string' || uiaNonce.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'uia_nonce must be present');
    }

    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createSuccessResult({ handled: false });
    }

    const phase04 = readPhase04Meta(principal);
    const previousPasswordChange = phase04.password_change ?? null;
    if (previousPasswordChange?.uia_nonce !== uiaNonce) {
      return createSuccessResult({ handled: false });
    }
    if (previousPasswordChange.request_fingerprint === requestFingerprint) {
      return createSuccessResult({
        handled: true,
        response: {},
      });
    }
    return createMatrixError(409, 'M_CONFLICT', 'This UIA session was already used for a different password change');
  }

  async resolvePhase04DeactivateReplay() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id ?? null;
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    if (typeof userId !== 'string' || userId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'user_id must be present');
    }
    if (typeof requestFingerprint !== 'string' || requestFingerprint.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'request_fingerprint must be present');
    }
    if (typeof uiaNonce !== 'string' || uiaNonce.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'uia_nonce must be present');
    }

    const principal = this.persistence.userPrincipal.get();
    if (!principal || principal.user_id !== userId) {
      return createSuccessResult({ handled: false });
    }

    const phase04 = readPhase04Meta(principal);
    const previousDeactivate = phase04.deactivate ?? null;
    if (previousDeactivate?.uia_nonce !== uiaNonce) {
      return createSuccessResult({ handled: false });
    }
    if (previousDeactivate.request_fingerprint === requestFingerprint) {
      return createSuccessResult({
        handled: true,
        response: {
          id_server_unbind_result: 'success',
        },
      });
    }
    return createMatrixError(409, 'M_CONFLICT', 'This UIA session was already used for a different deactivation request');
  }

  async changePassword() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id ?? null;
    const now = request?.now ?? new Date().toISOString();
    const newPassword = request?.new_password ?? null;
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    if (typeof userId !== 'string' || userId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'user_id must be present');
    }
    if (typeof newPassword !== 'string' || newPassword.trim().length === 0) {
      return createMatrixError(400, 'M_MISSING_PARAM', 'new_password must be present');
    }
    if (typeof requestFingerprint !== 'string' || requestFingerprint.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'request_fingerprint must be present');
    }
    if (typeof uiaNonce !== 'string' || uiaNonce.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'uia_nonce must be present');
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const principal = this.persistence.userPrincipal.get();
      if (!principal || principal.user_id !== userId) {
        return createMatrixError(403, 'M_FORBIDDEN', 'Password change is not allowed');
      }
      if (principal.deactivated_at_or_null) {
        return createMatrixError(403, 'M_USER_DEACTIVATED', 'The user has been deactivated');
      }

      const phase04 = readPhase04Meta(principal);
      const previousPasswordChange = phase04.password_change ?? null;
      const nextPasswordHash = hashPassword(newPassword);
      if (previousPasswordChange?.uia_nonce === uiaNonce) {
        if (previousPasswordChange.request_fingerprint === requestFingerprint) {
          return createSuccessResult({ response: {} });
        }
        return createMatrixError(409, 'M_CONFLICT', 'This UIA session was already used for a different password change');
      }

      const nextAuthVersion = principal.auth_version + 1;
      this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
        password_hash_or_null: nextPasswordHash,
        password_login_enabled: true,
        auth_version: nextAuthVersion,
        record: mergePhase04Meta(principal, {
          password_change: {
            uia_nonce: uiaNonce,
            request_fingerprint: requestFingerprint,
            completed_at: now,
          },
        }),
      }));

      const keepSessionId = request?.current_session_id ?? null;
      const logoutDevices = request?.logout_devices !== false;
      for (const session of this.persistence.sessions.list()) {
        if (session.revoked_at) {
          continue;
        }
        const shouldKeep = keepSessionId && session.session_id === keepSessionId;
        this.persistence.sessions.put(sessionRowToPutRecord(session, {
          auth_version: nextAuthVersion,
          updated_at: now,
          revoked_at: logoutDevices && !shouldKeep ? now : session.revoked_at ?? null,
        }));
      }

      return createSuccessResult({ response: {} });
    });
  }

  async deactivateAccount() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const userId = request?.user_id ?? null;
    const now = request?.now ?? new Date().toISOString();
    const requestFingerprint = request?.request_fingerprint ?? null;
    const uiaNonce = request?.uia_nonce ?? null;
    const erase = request?.erase === true;
    if (typeof userId !== 'string' || userId.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'user_id must be present');
    }
    if (typeof requestFingerprint !== 'string' || requestFingerprint.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'request_fingerprint must be present');
    }
    if (typeof uiaNonce !== 'string' || uiaNonce.length === 0) {
      return createMatrixError(400, 'M_BAD_JSON', 'uia_nonce must be present');
    }

    const sql = this.requireSqlStorage();
    return withSqliteTransaction(sql, () => {
      const principal = this.persistence.userPrincipal.get();
      if (!principal || principal.user_id !== userId) {
        return createMatrixError(403, 'M_FORBIDDEN', 'Account deactivation is not allowed');
      }

      const phase04 = readPhase04Meta(principal);
      const previousDeactivate = phase04.deactivate ?? null;
      if (previousDeactivate?.uia_nonce === uiaNonce) {
        if (previousDeactivate.request_fingerprint === requestFingerprint) {
          return createSuccessResult({
            response: {
              id_server_unbind_result: 'success',
            },
          });
        }
        return createMatrixError(409, 'M_CONFLICT', 'This UIA session was already used for a different deactivation request');
      }

      const nextAuthVersion = principal.auth_version + 1;
      this.persistence.userPrincipal.put(principalRowToPutRecord(principal, {
        password_hash_or_null: null,
        password_login_enabled: false,
        deactivated_at_or_null: now,
        erase_requested_flag: erase,
        auth_version: nextAuthVersion,
        record: mergePhase04Meta(principal, {
          deactivate: {
            uia_nonce: uiaNonce,
            request_fingerprint: requestFingerprint,
            completed_at: now,
            erase,
          },
        }),
      }));

      for (const session of this.persistence.sessions.list()) {
        if (!session.revoked_at) {
          this.persistence.sessions.put(sessionRowToPutRecord(session, {
            revoked_at: now,
            updated_at: now,
            auth_version: nextAuthVersion,
          }));
        }
      }

      if (erase) {
        for (const row of this.persistence.globalAccountData.list()) {
          this.persistence.globalAccountData.delete(row.type);
        }
        for (const row of this.persistence.roomAccountData.list()) {
          this.persistence.roomAccountData.delete({
            room_id: row.room_id,
            type: row.type,
          });
        }
        for (const row of this.persistence.presence.list()) {
          this.persistence.presence.delete(row.user_id);
        }
        for (const row of this.persistence.profileDocument.list()) {
          this.persistence.profileDocument.delete({ key_name: row.key_name });
        }
        for (const row of this.persistence.pushRules.list()) {
          this.persistence.pushRules.delete({
            scope: row.scope,
            kind: row.kind,
            rule_id: row.rule_id,
          });
        }
      }

      return createSuccessResult({
        response: {
          id_server_unbind_result: 'success',
        },
      });
    });
  }

  async alarm(alarmInfo = {}) {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const now = new Date(
      Number.isFinite(alarmInfo?.scheduledTime)
        ? alarmInfo.scheduledTime
        : Date.now(),
    ).toISOString();
    const sql = this.requireSqlStorage();
    let sweepResult = {
      orphan_cleanup: [],
      next_alarm_at: null,
    };
    withSqliteTransaction(sql, () => {
      sweepResult = sweepPendingUploadGrants(this, now, { applyChanges: true });
    });
    await this.cleanupOrphanedMediaObjects(sweepResult.orphan_cleanup, { now });
    await this.retryPendingShardRegistry({ now });
    await this.scheduleMediaLifecycleAlarm(getUserMediaLifecycleNextAlarm(this, now));
  }
}

export class RoomDO extends BaseDurableObject {
  static authorityKind = 'room';
  static schemaVersion = ROOM_DO_SCHEMA_VERSION;

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'RoomDO',
      authorityKind: RoomDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'roomdo',
    });
  }

  get persistence() {
    if (!this._persistence) {
      this._persistence = createRoomDurableObjectPersistence(this.requireSqlStorage());
    }
    return this._persistence;
  }

  async ensureSchema() {
    await this.persistence.ensureSchema();
    return this.persistence.getRuntimeState();
  }

  resolveRoomVersionOrThrow(requestedRoomVersion = null, { requestKind = 'client' } = {}) {
    const runtimeState = this.persistence.getRuntimeState();
    const candidate = requestedRoomVersion ?? runtimeState?.room_version ?? DEFAULT_ROOM_VERSION;
    if (!isSupportedRoomVersion(candidate)) {
      throw createRoomInternalError(
        requestKind === 'federation' ? 'incompatible_room_version' : 'unsupported_room_version',
        `Room version ${candidate} is not supported`,
      );
    }
    return resolveRequestedRoomVersion(candidate);
  }

  getCurrentStateMap() {
    return getRoomStateMapForSnapshot(this.persistence, this.persistence.getRuntimeState()?.current_snapshot_id ?? null);
  }

  buildAuthEventIds(roomVersion, stateMap, candidateEvent) {
    const authEventIds = [];
    if (roomVersion === '11') {
      const createState = getTypedStateEvent(stateMap, 'm.room.create', '');
      if (createState) {
        authEventIds.push(createState.event_id);
      }
    }
    const senderMembership = getMembershipState(this, stateMap, candidateEvent.sender);
    if (senderMembership?.state_entry?.event_id) {
      authEventIds.push(senderMembership.state_entry.event_id);
    }
    const powerLevelsState = getTypedStateEvent(stateMap, 'm.room.power_levels', '');
    if (powerLevelsState) {
      authEventIds.push(powerLevelsState.event_id);
    }
    const joinRulesState = getTypedStateEvent(stateMap, 'm.room.join_rules', '');
    if (joinRulesState) {
      authEventIds.push(joinRulesState.event_id);
    }
    if (candidateEvent.type === 'm.room.member' && typeof candidateEvent.state_key === 'string' && candidateEvent.state_key !== candidateEvent.sender) {
      const targetMembership = getMembershipState(this, stateMap, candidateEvent.state_key);
      if (targetMembership?.state_entry?.event_id) {
        authEventIds.push(targetMembership.state_entry.event_id);
      }
    }
    return [...new Set(authEventIds.filter(Boolean))];
  }

  validateCandidateEventShape(roomVersion, candidateEvent) {
    if (!isObjectRecord(candidateEvent)) {
      throw createRoomInternalError('bad_json', 'candidate_event must be a JSON object');
    }
    const eventType = normalizeRoomEventType(candidateEvent.type);
    const sender = normalizeString(candidateEvent.sender, 'candidate_event.sender');
    if (!isObjectRecord(candidateEvent.content)) {
      throw createRoomInternalError('bad_json', 'candidate_event.content must be a JSON object');
    }
    const stateKey = stateKeyForEvent(candidateEvent);
    if (eventType === 'm.room.member' && stateKey == null) {
      throw createRoomInternalError('bad_json', 'm.room.member events require state_key');
    }
    if (eventType === 'm.room.create') {
      if (stateKey !== '') {
        throw createRoomInternalError('bad_json', 'm.room.create must use an empty state_key');
      }
      if (roomVersion === '12' && candidateEvent.room_id != null) {
        throw createRoomInternalError('bad_json', 'Room version 12 m.room.create must not include room_id');
      }
      if (candidateEvent.content.additional_creators != null) {
        if (!Array.isArray(candidateEvent.content.additional_creators)
          || !candidateEvent.content.additional_creators.every((entry) => typeof entry === 'string' && entry.length > 0)) {
          throw createRoomInternalError('bad_json', 'content.additional_creators must be an array of user IDs');
        }
      }
    }
    if (eventType === 'm.room.redaction' && typeof candidateEvent.redacts !== 'string') {
      throw createRoomInternalError('bad_json', 'm.room.redaction events require redacts');
    }
    return {
      eventType,
      sender,
      stateKey,
    };
  }

  authorizeMembershipEvent(roomVersion, stateMap, candidateEvent) {
    const senderUserId = candidateEvent.sender;
    const targetUserId = candidateEvent.state_key;
    const membership = normalizeString(candidateEvent.content.membership, 'candidate_event.content.membership');
    const routeTemplate = typeof candidateEvent?.unsigned?.client_context?.route_template === 'string'
      ? candidateEvent.unsigned.client_context.route_template
      : null;
    const senderMembership = getMembershipState(this, stateMap, senderUserId)?.membership ?? null;
    const targetMembership = getMembershipState(this, stateMap, targetUserId)?.membership ?? null;
    const joinRule = getJoinRule(this, stateMap);
    const senderPower = getUserPowerLevel(this, roomVersion, stateMap, senderUserId);
    const targetPower = getUserPowerLevel(this, roomVersion, stateMap, targetUserId);
    const powerLevels = getCurrentPowerLevelsContent(this, stateMap);
    const inviteLevel = Number.isInteger(powerLevels.invite) ? powerLevels.invite : 0;
    const banLevel = Number.isInteger(powerLevels.ban) ? powerLevels.ban : 50;
    const kickLevel = Number.isInteger(powerLevels.kick) ? powerLevels.kick : 50;
    const createEvent = getCreateEventFromStateMap(this, stateMap);

    if (membership === 'join') {
      if (senderUserId !== targetUserId) {
        throw createRoomInternalError('room_forbidden', 'Only the target user may join themselves');
      }
      if (targetMembership === 'ban') {
        throw createRoomInternalError('room_forbidden', 'Banned users may not join');
      }
      if (targetMembership === 'join') {
        return membership;
      }
      const creatorBootstrap = createEvent
        && senderUserId === createEvent.sender
        && targetMembership == null;
      if (creatorBootstrap || targetMembership === 'invite' || targetMembership === 'knock' || joinRule === 'public') {
        return membership;
      }
      throw createRoomInternalError('room_forbidden', 'User is not allowed to join this room');
    }

    if (membership === 'invite') {
      if (senderMembership !== 'join') {
        throw createRoomInternalError('room_forbidden', 'Only joined users may invite');
      }
      if (senderPower < inviteLevel) {
        throw createRoomInternalError('room_forbidden', 'Invites require invite power level');
      }
      if (targetMembership === 'ban') {
        throw createRoomInternalError('room_forbidden', 'Banned users may not be invited');
      }
      if (targetMembership === 'join') {
        throw createRoomInternalError('room_forbidden', 'Joined users may not be invited again');
      }
      return membership;
    }

    if (membership === 'knock') {
      if (senderUserId !== targetUserId) {
        throw createRoomInternalError('room_forbidden', 'Only the target user may knock');
      }
      if (targetMembership === 'ban') {
        throw createRoomInternalError('room_forbidden', 'Banned users may not knock');
      }
      if (['join', 'invite', 'knock'].includes(targetMembership ?? '')) {
        throw createRoomInternalError('room_forbidden', 'Users with active room membership may not knock');
      }
      if (joinRule !== 'knock') {
        throw createRoomInternalError('room_forbidden', 'This room does not allow knocking');
      }
      return membership;
    }

    if (membership === 'ban') {
      if (senderMembership !== 'join') {
        throw createRoomInternalError('room_forbidden', 'Only joined users may ban');
      }
      if (senderPower < banLevel || senderPower <= targetPower) {
        throw createRoomInternalError('room_forbidden', 'Ban power level is insufficient');
      }
      return membership;
    }

    if (membership === 'leave') {
      if (senderUserId === targetUserId) {
        if (targetMembership === 'ban') {
          throw createRoomInternalError('room_forbidden', 'Banned users may not unban themselves');
        }
        if (!['join', 'invite', 'knock', 'leave'].includes(targetMembership ?? '')) {
          throw createRoomInternalError('room_forbidden', 'Only current room members may leave');
        }
        return membership;
      }
      if (routeTemplate === '/_matrix/client/v3/rooms/{roomId}/unban') {
        if (targetMembership !== 'ban') {
          throw createRoomInternalError('room_forbidden', 'Target user is not banned');
        }
        if (senderPower < banLevel || senderPower <= targetPower) {
          throw createRoomInternalError('room_forbidden', 'Ban power level is insufficient');
        }
        return membership;
      }
      if (targetMembership === 'ban') {
        throw createRoomInternalError('room_forbidden', 'Banned users may only be changed via /unban');
      }
      if (senderMembership !== 'join') {
        throw createRoomInternalError('room_forbidden', 'Only joined users may kick');
      }
      if (!['join', 'invite', 'knock'].includes(targetMembership ?? '')) {
        throw createRoomInternalError('room_forbidden', 'Only joined, invited, or knocked users may be kicked');
      }
      if (senderPower < kickLevel || senderPower <= targetPower) {
        throw createRoomInternalError('room_forbidden', 'Kick power level is insufficient');
      }
      return membership;
    }

    throw createRoomInternalError('bad_json', `Unsupported membership transition: ${membership}`);
  }

  authorizeCandidateEvent(roomVersion, stateMap, candidateEvent) {
    if (candidateEvent.type === 'm.room.create') {
      if (getTypedStateEvent(stateMap, 'm.room.create', '')) {
        throw createRoomInternalError('room_forbidden', 'Room create may only happen once');
      }
      return;
    }

    const senderMembership = getMembershipState(this, stateMap, candidateEvent.sender)?.membership ?? null;
    if (candidateEvent.type === 'm.room.member') {
      this.authorizeMembershipEvent(roomVersion, stateMap, candidateEvent);
      return;
    }

    if (senderMembership !== 'join') {
      throw createRoomInternalError('room_forbidden', 'Only joined users may send room events');
    }

    if (candidateEvent.type === 'm.room.redaction') {
      const targetEvent = this.loadRoomEventById(candidateEvent.redacts).event;
      if (roomVersion !== '11') {
        const senderPower = getUserPowerLevel(this, roomVersion, stateMap, candidateEvent.sender);
        const redactLevel = getRequiredEventPowerLevel(this, roomVersion, stateMap, candidateEvent);
        if (candidateEvent.sender !== targetEvent.sender && senderPower < redactLevel) {
          throw createRoomInternalError('room_forbidden', 'Redaction power level is insufficient');
        }
        return;
      }
    }

    const senderPower = getUserPowerLevel(this, roomVersion, stateMap, candidateEvent.sender);
    const requiredLevel = getRequiredEventPowerLevel(this, roomVersion, stateMap, candidateEvent);
    if (senderPower < requiredLevel) {
      throw createRoomInternalError('room_forbidden', 'Power level is insufficient for this event');
    }
  }

  async admitEvent() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    try {
      const requestKind = normalizeRequestKind(request?.request_kind ?? 'client');
      const requestFingerprint = normalizeString(request?.request_fingerprint, 'request.request_fingerprint');
      const candidateEvent = isObjectRecord(request?.candidate_event) ? cloneJson(request.candidate_event) : null;
      const runtimeState = this.persistence.getRuntimeState();
      const requestedCreateRoomVersion = candidateEvent?.type === 'm.room.create'
        ? candidateEvent?.content?.room_version ?? null
        : null;
      const roomVersion = this.resolveRoomVersionOrThrow(
        request?.room_version ?? requestedCreateRoomVersion ?? runtimeState?.room_version ?? DEFAULT_ROOM_VERSION,
        { requestKind },
      );
      const { eventType, sender, stateKey } = this.validateCandidateEventShape(roomVersion, candidateEvent);
      const profileRefresh = eventType === 'm.room.member' ? getProfileRefreshInfo(candidateEvent) : null;
      const isCreateEvent = eventType === 'm.room.create';
      const createIdentity = isCreateEvent
        ? deriveCreateRoomIdentity({
          creator_user_id: sender,
          room_version: roomVersion,
          request_fingerprint: requestFingerprint,
          server_name: this.env.MATRIX_SERVER_NAME,
        })
        : null;
      const roomId = normalizeString(
        request?.room_id
          ?? candidateEvent?.room_id
          ?? createIdentity?.room_id
          ?? runtimeState?.room_id,
        'request.room_id',
      );
      if (profileRefresh == null) {
        const semanticQuota = this.enforceSemanticQuota(
          eventType === 'm.room.member' ? 'roomdo_membership' : 'roomdo_send',
          `${roomId}|${sender}`,
          {
            nowIso: request?.now ?? new Date().toISOString(),
            message: eventType === 'm.room.member' ? 'Membership rate limit exceeded' : 'Room send rate limit exceeded',
          },
        );
        if (!semanticQuota.ok) {
          return createMatrixError(
            429,
            'M_LIMIT_EXCEEDED',
            eventType === 'm.room.member' ? 'Membership rate limit exceeded' : 'Room send rate limit exceeded',
            {
              retry_after_ms: semanticQuota.retry_after_ms,
            },
          );
        }
      }
      if (!isCreateEvent && runtimeState?.room_id == null) {
        throw createRoomInternalError('room_not_found', `Room ${roomId} does not exist`);
      }
      if (runtimeState?.room_id && runtimeState.room_id !== roomId) {
        throw createRoomInternalError('room_forbidden', `Room runtime state is already bound to ${runtimeState.room_id}`);
      }
      const stateMap = this.getCurrentStateMap();
      const currentMembershipState = eventType === 'm.room.member' && stateKey != null
        ? getTypedStateEvent(stateMap, 'm.room.member', stateKey)
        : null;

      const clientContext = isObjectRecord(candidateEvent?.unsigned?.client_context)
        ? cloneJson(candidateEvent.unsigned.client_context)
        : null;
      const clientDedupeKey = clientContext
        ? {
          user_id: normalizeString(clientContext.user_id, 'candidate_event.unsigned.client_context.user_id'),
          device_id: normalizeString(clientContext.device_id, 'candidate_event.unsigned.client_context.device_id'),
          room_id: roomId,
          route_template: normalizeString(clientContext.route_template, 'candidate_event.unsigned.client_context.route_template'),
          txn_id_or_request_hash: normalizeString(
            eventType === 'm.room.member'
              ? `${clientContext.txn_id_or_request_hash ?? requestFingerprint}|${currentMembershipState?.event_id ?? 'none'}`
              : (clientContext.txn_id_or_request_hash ?? requestFingerprint),
            'candidate_event.unsigned.client_context.txn_id_or_request_hash',
          ),
        }
        : null;
      const existingDedupe = clientDedupeKey
        ? this.persistence.clientTxnDedupe.get({
          txn_dedupe_key: `${clientDedupeKey.user_id}|${clientDedupeKey.device_id}|${clientDedupeKey.room_id}|${clientDedupeKey.route_template}|${clientDedupeKey.txn_id_or_request_hash}`,
        })
        : null;
      if (existingDedupe) {
        if (existingDedupe.request_fingerprint !== requestFingerprint) {
          throw createRoomInternalError('idempotency_conflict', 'This room write idempotency key was already used with a different request body');
        }
        if (existingDedupe.terminal_state === 'failed' && existingDedupe.error_json) {
          return {
            ok: false,
            error: existingDedupe.error_json,
          };
        }
        const existingMetadata = existingDedupe.result_event_id
          ? this.persistence.eventMetadata.get({ event_id: existingDedupe.result_event_id })
          : null;
        return createSuccessResult({
          decision: 'accepted',
          event_id: existingDedupe.result_event_id ?? null,
          room_pos: existingMetadata?.room_pos ?? null,
          snapshot_id: this.persistence.getRuntimeState()?.current_snapshot_id ?? null,
        });
      }

      this.authorizeCandidateEvent(roomVersion, stateMap, candidateEvent);

      if (eventType === 'm.room.member' && currentMembershipState) {
        const currentMembershipEvent = this.loadRoomEventById(currentMembershipState.event_id).event;
        if (currentMembershipEvent?.sender === sender
          && canonicalJsonHash(currentMembershipEvent?.content ?? {}) === canonicalJsonHash(candidateEvent.content ?? {})) {
          const currentMetadata = this.persistence.eventMetadata.get({ event_id: currentMembershipState.event_id });
          return createSuccessResult({
            decision: 'accepted',
            event_id: currentMembershipState.event_id,
            room_pos: currentMetadata?.room_pos ?? null,
            snapshot_id: this.persistence.getRuntimeState()?.current_snapshot_id ?? null,
          });
        }
      }
      const prevEventIds = this.persistence.forwardExtremities.list()
        .sort((left, right) => left.room_pos - right.room_pos || left.event_id.localeCompare(right.event_id))
        .map((row) => row.event_id);
      const previousDepth = prevEventIds.reduce((maximumDepth, prevEventId) => {
        const metadata = this.persistence.eventMetadata.get({ event_id: prevEventId });
        return Math.max(maximumDepth, metadata?.depth ?? 0);
      }, 0);
      const authEventIds = this.buildAuthEventIds(roomVersion, stateMap, candidateEvent);
      const originServerTs = Number.isInteger(candidateEvent.origin_server_ts)
        ? candidateEvent.origin_server_ts
        : Date.now();
      const baseEvent = {
        type: eventType,
        sender,
        content: cloneJson(candidateEvent.content),
        origin_server_ts: originServerTs,
        prev_events: prevEventIds,
        auth_events: authEventIds,
        ...(stateKey == null ? {} : { state_key: stateKey }),
        ...(candidateEvent.redacts == null ? {} : { redacts: normalizeString(candidateEvent.redacts, 'candidate_event.redacts') }),
        ...((!isCreateEvent || roomVersion !== '12') ? { room_id: roomId } : {}),
      };
      const eventId = createIdentity?.create_event_id ?? deriveDeterministicEventId({
        kind: 'room_event',
        room_id: roomId,
        room_version: roomVersion,
        request_fingerprint: requestFingerprint,
        event: baseEvent,
      });
      const committedEvent = {
        ...baseEvent,
        event_id: eventId,
        depth: previousDepth + 1,
        hashes: {
          sha256: canonicalJsonHash(baseEvent),
        },
        ...(isObjectRecord(candidateEvent.unsigned?.public) ? { unsigned: cloneJson(candidateEvent.unsigned.public) } : {}),
      };

      const now = request?.now ?? new Date().toISOString();
      let roomPos = null;
      let snapshotId = this.persistence.getRuntimeState()?.current_snapshot_id ?? null;
      let fanoutDeltas = [];
      let redactedTarget = null;
      const sql = this.requireSqlStorage();
      withSqliteTransaction(sql, () => {
        roomPos = this.reserveRoomPosWithinTransaction(sql, {
          roomId,
          roomVersion,
          updatedAt: now,
        });
        for (const prevEventId of prevEventIds) {
          this.persistence.forwardExtremities.delete({ event_id: prevEventId });
        }
        this.persistence.forwardExtremities.put({
          event_id: eventId,
          room_pos: roomPos,
          updated_at: now,
          record_json: {},
        });
        for (const prevEventId of prevEventIds) {
          this.persistence.prevEdges.put({
            event_id: eventId,
            prev_event_id: prevEventId,
            record_json: {},
          });
        }
        for (const authEventId of authEventIds) {
          this.persistence.authEdges.put({
            event_id: eventId,
            auth_event_id: authEventId,
            record_json: {},
          });
        }

        if (stateKey != null || !this.persistence.getRuntimeState()?.current_snapshot_id) {
          snapshotId = `snapshot-${roomPos}`;
          const previousSnapshotId = this.persistence.getRuntimeState()?.current_snapshot_id ?? null;
          if (previousSnapshotId) {
            for (const entry of this.persistence.stateEntries.list().filter((row) => row.snapshot_id === previousSnapshotId)) {
              this.persistence.stateEntries.put({
                snapshot_id: snapshotId,
                event_type: entry.event_type,
                state_key: entry.state_key,
                event_id: entry.event_id,
                sender_user_id: entry.sender_user_id,
                membership: entry.membership,
                event_room_pos: entry.event_room_pos,
                content_json: cloneJson(entry.content),
                record_json: cloneJson(entry.record ?? {}),
              });
            }
          }
          if (stateKey != null) {
            this.persistence.stateEntries.put({
              snapshot_id: snapshotId,
              event_type: eventType,
              state_key: stateKey,
              event_id: eventId,
              sender_user_id: sender,
              membership: eventType === 'm.room.member' ? candidateEvent.content.membership : null,
              event_room_pos: roomPos,
              content_json: cloneJson(candidateEvent.content),
              record_json: {},
            });
          }
          const snapshotRows = this.persistence.stateEntries.list()
            .filter((row) => row.snapshot_id === snapshotId)
            .map((row) => ({
              event_type: row.event_type,
              state_key: row.state_key,
              event_id: row.event_id,
            }))
            .sort((left, right) => left.event_type.localeCompare(right.event_type) || left.state_key.localeCompare(right.state_key));
          const snapshotHash = canonicalJsonHash(snapshotRows);
          this.persistence.stateSnapshots.put({
            snapshot_id: snapshotId,
            snapshot_hash: snapshotHash,
            extremity_set_hash: canonicalJsonHash([eventId]),
            created_at: now,
            record_json: {
              room_pos: roomPos,
            },
          });
          this.persistence.updateCurrentSnapshot({
            snapshot_id: snapshotId,
            snapshot_hash: snapshotHash,
            updated_at: now,
          });
        }

        if (eventType === 'm.room.member') {
          const membership = normalizeString(candidateEvent.content.membership, 'candidate_event.content.membership');
          this.persistence.membershipProjection.put({
            user_id: stateKey,
            membership,
            event_id: eventId,
            room_pos: roomPos,
            displayname: candidateEvent.content.displayname ?? null,
            avatar_url: candidateEvent.content.avatar_url ?? null,
            profile_version: Number.isInteger(candidateEvent.unsigned?.public?.profile_version)
              ? candidateEvent.unsigned.public.profile_version
              : null,
            membership_visibility_class: mapMembershipVisibilityClass(membership),
            updated_at: now,
            record_json: {},
          });
        }

        if (eventType === 'm.room.redaction') {
          const target = this.loadRoomEventById(candidateEvent.redacts);
          redactedTarget = redactEventForRoomVersion(roomVersion, target.event, {
            event_id: eventId,
            sender,
            type: 'm.room.redaction',
            ...(roomVersion === '12' ? {} : { room_id: roomId }),
            redacts: candidateEvent.redacts,
            origin_server_ts: originServerTs,
            content: {},
          });
          this.persistence.hotEventJson.put({
            event_id: candidateEvent.redacts,
            content_hash: canonicalJsonHash(redactedTarget),
            stored_at: now,
            canonical_json: JSON.stringify(redactedTarget),
            record_json: {
              ...(target.metadata.record ?? {}),
              redacted_by_event_id: eventId,
            },
          });
          if (target.metadata.state_key_or_null != null && snapshotId) {
            this.persistence.stateEntries.put({
              snapshot_id: snapshotId,
              event_type: target.metadata.event_type,
              state_key: target.metadata.state_key_or_null,
              event_id: candidateEvent.redacts,
              sender_user_id: target.metadata.sender_user_id,
              membership: target.metadata.event_type === 'm.room.member'
                ? (typeof redactedTarget.content?.membership === 'string' ? redactedTarget.content.membership : null)
                : null,
              event_room_pos: target.metadata.room_pos,
              content_json: cloneJson(redactedTarget.content ?? {}),
              record_json: {},
            });
          }
        }

        fanoutDeltas = this.buildCommittedFanoutDeltas({
          committedEvent,
          roomPos,
          snapshotId,
        });
        const relationInfo = getRelationInfo(candidateEvent);
        this.persistence.eventMetadata.put({
          event_id: eventId,
          room_pos: roomPos,
          origin_server_ts: originServerTs,
          depth: committedEvent.depth,
          archive_object_key_or_segment_id: null,
          archive_offset_or_index: null,
          event_type: eventType,
          state_key_or_null: stateKey,
          sender_user_id: sender,
          contains_url_flag: /(?:https?:\/\/|mxc:\/\/)/.test(JSON.stringify(candidateEvent.content)),
          soft_failed_flag: false,
          waiting_missing_flag: false,
          redacts_event_id_or_null: committedEvent.redacts ?? null,
          membership_target_user_id_or_null: eventType === 'm.room.member' ? stateKey : null,
          history_visibility_class: 'shared',
          membership_visibility_class: eventType === 'm.room.member'
            ? mapMembershipVisibilityClass(candidateEvent.content.membership)
            : (sender ? 'joined' : null),
          relates_to_event_id_or_null: relationInfo.relates_to_event_id_or_null,
          relation_type_or_null: relationInfo.relation_type_or_null,
          aggregation_event_type_or_null: relationInfo.aggregation_event_type_or_null,
          thread_root_event_id_or_null: relationInfo.thread_root_event_id_or_null,
          record_json: {
            room_version: roomVersion,
            request_kind: requestKind,
            snapshot_id: snapshotId,
            ...(profileRefresh == null ? {} : {
              propagation_kind: 'profile_refresh',
              profile_version: profileRefresh.profileVersion,
            }),
            local_fanout_deltas: cloneJson(fanoutDeltas),
          },
        });
        this.persistence.hotEventJson.put({
          event_id: eventId,
          content_hash: canonicalJsonHash(committedEvent),
          stored_at: now,
          canonical_json: JSON.stringify(committedEvent),
          record_json: {
            room_version: roomVersion,
          },
        });

        for (const delta of fanoutDeltas) {
          this.persistence.fanoutOutbox.put({
            room_pos: roomPos,
            user_id: delta.user_id,
            event_id: eventId,
            status: 'pending',
            last_attempt_at: null,
            attempt_count: 0,
            acked_stream_pos: null,
            acked_at: null,
            delta_json: cloneJson(delta),
            last_error_json: null,
            created_at: now,
            record_json: profileRefresh == null ? {} : {
              propagation_kind: 'profile_refresh',
              profile_version: profileRefresh.profileVersion,
              profile_owner_user_id: stateKey,
            },
          });
        }

        if (clientDedupeKey) {
          this.persistence.clientTxnDedupe.put({
            txn_dedupe_key: `${clientDedupeKey.user_id}|${clientDedupeKey.device_id}|${clientDedupeKey.room_id}|${clientDedupeKey.route_template}|${clientDedupeKey.txn_id_or_request_hash}`,
            user_id: clientDedupeKey.user_id,
            device_id: clientDedupeKey.device_id,
            room_id: clientDedupeKey.room_id,
            route_template: clientDedupeKey.route_template,
            txn_id_or_request_hash: clientDedupeKey.txn_id_or_request_hash,
            request_fingerprint: requestFingerprint,
            terminal_state: 'succeeded',
            result_event_id: eventId,
            error_json: null,
            created_at: now,
            updated_at: now,
            record_json: {},
          });
        }
      });

      if (fanoutDeltas.length > 0) {
        await this.deliverPendingFanout({
          limit: fanoutDeltas.length,
          now,
        });
      }
      await this.enqueueDerivedUpdates({
        event_id: eventId,
        room_id: roomId,
        room_pos: roomPos,
        visibility_watermark: roomPos,
        redaction_watermark: roomPos,
        updated_at: now,
      });
      return createSuccessResult({
        decision: 'accepted',
        event_id: eventId,
        room_pos: roomPos,
        snapshot_id: snapshotId,
      });
    } catch (error) {
      if (request?.candidate_event?.unsigned?.client_context && request?.request_fingerprint) {
        try {
          const candidateEvent = request.candidate_event;
          const clientContext = candidateEvent.unsigned.client_context;
          const roomId = request.room_id ?? request.candidate_event.room_id ?? this.persistence.getRuntimeState()?.room_id
            ?? deriveCreateRoomIdentity({
              creator_user_id: request.candidate_event.sender,
              room_version: request?.room_version ?? request.candidate_event.content?.room_version ?? DEFAULT_ROOM_VERSION,
              request_fingerprint: request.request_fingerprint,
              server_name: this.env.MATRIX_SERVER_NAME,
            }).room_id;
          const failedStateMap = this.getCurrentStateMap();
          const currentMembershipState = candidateEvent?.type === 'm.room.member' && typeof candidateEvent?.state_key === 'string'
            ? getTypedStateEvent(failedStateMap, 'm.room.member', candidateEvent.state_key)
            : null;
          const txnIdOrRequestHash = candidateEvent?.type === 'm.room.member'
            ? `${clientContext.txn_id_or_request_hash ?? request.request_fingerprint}|${currentMembershipState?.event_id ?? 'none'}`
            : (clientContext.txn_id_or_request_hash ?? request.request_fingerprint);
          this.persistence.clientTxnDedupe.put({
            txn_dedupe_key: `${clientContext.user_id}|${clientContext.device_id}|${roomId}|${clientContext.route_template}|${txnIdOrRequestHash}`,
            user_id: clientContext.user_id,
            device_id: clientContext.device_id,
            room_id: roomId,
            route_template: clientContext.route_template,
            txn_id_or_request_hash: txnIdOrRequestHash,
            request_fingerprint: request.request_fingerprint,
            terminal_state: 'failed',
            result_event_id: null,
            error_json: error,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            record_json: {},
          });
        } catch {
          // Ignore dedupe persistence failures for rejected requests.
        }
      }
      return {
        ok: false,
        error: error?.matrix_error ? error.matrix_error : error,
      };
    } finally {
      this.observeAuthorityMetric('roomdo.admission.latency_ms', Date.now() - startedAt, {
        operation: 'admitEvent',
      });
    }
  }

  reserveRoomPosWithinTransaction(sql, {
    roomId,
    roomVersion = null,
    updatedAt,
  }) {
    const runtimeState = this.persistence.getRuntimeState();
    const normalizedRoomId = normalizeString(roomId ?? runtimeState?.room_id, 'roomId');
    if (runtimeState?.room_id && runtimeState.room_id !== normalizedRoomId) {
      throw new Error(`Room runtime state is already bound to ${runtimeState.room_id}`);
    }
    const nextRoomPos = Number.isInteger(runtimeState?.next_room_pos) && runtimeState.next_room_pos >= 1
      ? runtimeState.next_room_pos
      : 1;
    sql.exec(
      `
        UPDATE room_runtime_state
        SET room_id = ?,
            room_version = COALESCE(room_version, ?),
            next_room_pos = ?,
            updated_at = ?
        WHERE singleton = 1
      `,
      normalizedRoomId,
      roomVersion ?? runtimeState?.room_version ?? null,
      nextRoomPos + 1,
      normalizeString(updatedAt, 'updatedAt'),
    );
    return nextRoomPos;
  }

  isLocalUserId(userId) {
    return typeof userId === 'string' && userId.endsWith(`:${this.env.MATRIX_SERVER_NAME}`);
  }

  buildCommittedFanoutDeltas({
    committedEvent,
    roomPos,
    snapshotId,
  }) {
    const roomId = this.persistence.getRuntimeState()?.room_id ?? committedEvent.room_id ?? null;
    const stateKey = stateKeyForEvent(committedEvent);
    const summary = buildRoomSyncSummary(this.persistence);
    const currentSnapshotEventIds = snapshotId
      ? this.persistence.stateEntries.list()
        .filter((row) => row.snapshot_id === snapshotId)
        .map((row) => row.event_id)
      : [];
    const deltas = [];
    for (const membership of this.persistence.membershipProjection.list()) {
      if (!this.isLocalUserId(membership.user_id)) {
        continue;
      }
      let membershipBucket;
      try {
        membershipBucket = normalizeRoomMembershipBucket(membership.membership, { allowNull: false });
      } catch {
        continue;
      }
      if (membershipBucket === 'forgotten') {
        continue;
      }
      if (membershipBucket !== 'join' && roomPos > membership.room_pos) {
        continue;
      }
      const delta = {
        room_id: roomId,
        room_pos: roomPos,
        user_id: membership.user_id,
        membership_bucket: membershipBucket,
        event_id: committedEvent.event_id,
        timeline_event_ids: [],
        state_event_ids: [],
        limited: false,
        prev_batch: roomPos > 1 ? encodeRoomCursor(roomPos - 1) : null,
        notification_count: 0,
        highlight_count: 0,
        summary,
      };
      if (membershipBucket === 'join' || membershipBucket === 'leave') {
        delta.timeline_event_ids.push(committedEvent.event_id);
      }
      if (stateKey != null) {
        delta.state_event_ids.push(committedEvent.event_id);
      }
      if (committedEvent.type === 'm.room.member'
        && membership.user_id === stateKey
        && ['invite', 'knock'].includes(membershipBucket)) {
        delta.timeline_event_ids = [];
        delta.state_event_ids = [...new Set(currentSnapshotEventIds)];
      }
      deltas.push(delta);
    }
    return deltas;
  }

  loadRoomEventById(eventId) {
    const metadata = this.persistence.eventMetadata.get({ event_id: eventId });
    if (!metadata) {
      throw createRoomInternalError('event_not_found', `Event ${eventId} does not exist`);
    }
    const hotEvent = this.persistence.hotEventJson.get({ event_id: eventId });
    if (!hotEvent) {
      throw createInternalErrorEnvelope({
        code: 'archive_missing',
        message: `Room event ${eventId} JSON is missing`,
        retryable: false,
      });
    }
    let parsedEvent;
    try {
      parsedEvent = parseCanonicalRoomEvent(hotEvent);
    } catch {
      throw createInternalErrorEnvelope({
        code: 'archive_missing',
        message: `Room event ${eventId} JSON is not decodable`,
        retryable: false,
      });
    }
    return {
      metadata,
      event: parsedEvent,
    };
  }

  buildStateSnapshotEventsForUser(userId, {
    lazyLoadMembers = false,
    timelineEvents = [],
    snapshotId = null,
    maxRoomPos = null,
  } = {}) {
    const runtimeState = this.persistence.getRuntimeState();
    const resolvedSnapshotId = snapshotId
      ?? (maxRoomPos == null ? runtimeState?.current_snapshot_id ?? null : this.resolveSnapshotIdForRoomPos(maxRoomPos));
    if (!resolvedSnapshotId) {
      return [];
    }
    const allStateEntries = this.persistence.stateEntries.list()
      .filter((row) => row.snapshot_id === resolvedSnapshotId);
    if (!lazyLoadMembers) {
      return allStateEntries.map((row) => this.loadRoomEventById(row.event_id).event);
    }
    const requiredMembershipKeys = new Set([userId]);
    for (const event of timelineEvents) {
      if (typeof event?.sender === 'string') {
        requiredMembershipKeys.add(event.sender);
      }
      if (typeof event?.state_key === 'string') {
        requiredMembershipKeys.add(event.state_key);
      }
    }
    return allStateEntries
      .filter((row) => row.event_type !== 'm.room.member' || requiredMembershipKeys.has(row.state_key))
      .map((row) => this.loadRoomEventById(row.event_id).event);
  }

  resolveSnapshotIdForRoomPos(roomPos) {
    const normalizedRoomPos = normalizeInteger(roomPos, 'roomPos', { min: 1 });
    const candidate = this.persistence.stateSnapshots.list()
      .map((snapshot) => ({
        snapshot_id: snapshot.snapshot_id,
        room_pos: parseSnapshotRoomPos(snapshot),
      }))
      .filter((snapshot) => Number.isInteger(snapshot.room_pos) && snapshot.room_pos <= normalizedRoomPos)
      .sort((left, right) => right.room_pos - left.room_pos || right.snapshot_id.localeCompare(left.snapshot_id))
      .at(0);
    return candidate?.snapshot_id ?? null;
  }

  async deliverPendingFanout() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const limit = normalizeInteger(request?.limit ?? 100, 'request.limit', { min: 1 });
    const now = request?.now ?? new Date().toISOString();
    const targetUserId = request?.target_user_id == null
      ? null
      : normalizeString(request.target_user_id, 'request.target_user_id');
    const pendingItems = this.persistence
      .listPendingFanoutOutbox(targetUserId == null ? limit : 10_000)
      .filter((item) => targetUserId == null || item.user_id === targetUserId)
      .slice(0, limit);
    const results = [];
    for (const item of pendingItems) {
      if (isStaleProfileRefreshOutboxItem(this.persistence, item)) {
        this.persistence.acknowledgeFanoutOutbox({
          room_pos: item.room_pos,
          user_id: item.user_id,
          acked_stream_pos: null,
          acked_at: now,
        });
        results.push({
          room_pos: item.room_pos,
          user_id: item.user_id,
          status: 'skipped_stale',
        });
        continue;
      }
      const delta = {
        ...structuredClone(item.delta ?? {}),
        room_id: item.delta?.room_id ?? this.persistence.getRuntimeState()?.room_id,
        room_pos: item.delta?.room_pos ?? item.room_pos,
        user_id: item.delta?.user_id ?? item.user_id,
        origin_server_ts: Number.isInteger(item.delta?.origin_server_ts)
          ? item.delta.origin_server_ts
          : (item.event_id != null
            ? this.persistence.eventMetadata.get({ event_id: item.event_id })?.origin_server_ts ?? null
            : null),
      };
      try {
        const userDo = getUserDoStub(this.env, item.user_id);
        const appendResult = await userDo.appendRoomFanout(delta);
        if (!appendResult?.ok) {
          throw appendResult?.error ?? new Error('Unknown room fanout append failure');
        }
        this.persistence.acknowledgeFanoutOutbox({
          room_pos: item.room_pos,
          user_id: item.user_id,
          acked_stream_pos: appendResult.ack.durable_stream_pos,
          acked_at: appendResult.ack.accepted_at,
        });
        results.push({
          room_pos: item.room_pos,
          user_id: item.user_id,
          status: 'acked',
          acked_stream_pos: appendResult.ack.durable_stream_pos,
        });
      } catch (error) {
        const current = this.persistence.fanoutOutbox.get({ room_pos: item.room_pos, user_id: item.user_id });
        this.persistence.fanoutOutbox.put({
          room_pos: item.room_pos,
          user_id: item.user_id,
          event_id: current?.event_id ?? item.event_id ?? null,
          status: 'retrying',
          last_attempt_at: now,
          attempt_count: (current?.attempt_count ?? item.attempt_count ?? 0) + 1,
          acked_stream_pos: current?.acked_stream_pos ?? null,
          acked_at: current?.acked_at ?? null,
          delta_json: current?.delta ?? item.delta ?? {},
          last_error_json: {
            message: error?.message ?? 'Room fanout delivery failed',
            code: error?.code ?? null,
          },
          created_at: current?.created_at ?? item.created_at,
          record_json: current?.record ?? item.record ?? {},
        });
        results.push({
          room_pos: item.room_pos,
          user_id: item.user_id,
          status: 'retrying',
        });
      }
    }
    return createSuccessResult({
      results,
    });
  }

  async reconcileFanout() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    const limit = normalizeInteger(request?.limit ?? 100, 'request.limit', { min: 1 });
    const targetUserId = request?.target_user_id == null
      ? null
      : normalizeString(request.target_user_id, 'request.target_user_id');
    const dryRun = request?.dry_run === true;
    const results = [];
    const pendingBatchLimit = dryRun ? 1_000_000 : (targetUserId == null ? limit : 10_000);
    const pendingOutboxItems = this.persistence
      .listPendingFanoutOutbox(pendingBatchLimit)
      .filter((item) => targetUserId == null || item.user_id === targetUserId)
      .slice(0, limit);
    for (const item of pendingOutboxItems) {
      const userDo = getUserDoStub(this.env, item.user_id);
      const inspected = await userDo.inspectRoomFanout({
        room_id: item.delta?.room_id ?? this.persistence.getRuntimeState()?.room_id,
        room_pos: item.room_pos,
        user_id: item.user_id,
      });
      if (inspected?.ok && inspected.entry) {
        if (!dryRun) {
          this.persistence.acknowledgeFanoutOutbox({
            room_pos: item.room_pos,
            user_id: item.user_id,
            acked_stream_pos: inspected.entry.stream_pos,
            acked_at: now,
          });
        }
        results.push({
          room_pos: item.room_pos,
          user_id: item.user_id,
          status: dryRun ? 'would_ack_existing' : 'acked_existing',
        });
      }
    }

    for (const metadata of this.persistence.eventMetadata.list()) {
      const fanoutDeltas = Array.isArray(metadata.record?.local_fanout_deltas)
        ? metadata.record.local_fanout_deltas
        : [];
      for (const delta of fanoutDeltas) {
        if (!this.isLocalUserId(delta?.user_id)) {
          continue;
        }
        if (targetUserId != null && delta.user_id !== targetUserId) {
          continue;
        }
        const existingOutbox = this.persistence.fanoutOutbox.get({
          room_pos: metadata.room_pos,
          user_id: delta.user_id,
        });
        const userDo = getUserDoStub(this.env, delta.user_id);
        const inspected = await userDo.inspectRoomFanout({
          room_id: delta.room_id,
          room_pos: metadata.room_pos,
          user_id: delta.user_id,
        });
        if (existingOutbox && inspected?.ok && inspected.entry) {
          if (!dryRun) {
            this.persistence.acknowledgeFanoutOutbox({
              room_pos: metadata.room_pos,
              user_id: delta.user_id,
              acked_stream_pos: inspected.entry.stream_pos,
              acked_at: now,
            });
          }
          continue;
        }
        if (!existingOutbox && (!inspected?.ok || !inspected.entry)) {
          if (!dryRun) {
            this.persistence.fanoutOutbox.put({
              room_pos: metadata.room_pos,
              user_id: delta.user_id,
              event_id: metadata.event_id,
              status: 'repaired',
              last_attempt_at: null,
              attempt_count: 0,
              acked_stream_pos: null,
              acked_at: null,
              delta_json: cloneJson(delta),
              last_error_json: null,
              created_at: now,
              record_json: {
                repair_generated: true,
              },
            });
          }
          results.push({
            room_pos: metadata.room_pos,
            user_id: delta.user_id,
            status: dryRun ? 'would_recreate_outbox' : 'recreated_outbox',
          });
        }
      }
    }

    if (dryRun) {
      return createSuccessResult({
        results,
        has_more: false,
      });
    }

    const delivery = await this.deliverPendingFanout({
      limit,
      now,
      target_user_id: targetUserId,
    });
    const hasMore = this.persistence
      .listPendingFanoutOutbox(targetUserId == null ? 10_000 : 1_000_000)
      .some((item) => targetUserId == null || item.user_id === targetUserId);
    return createSuccessResult({
      results: [
        ...results,
        ...(delivery.results ?? []),
      ],
      has_more: hasMore,
    });
  }

  async emitEphemeralToJoinedMembers(ephemeralEvent, {
    now = new Date().toISOString(),
    dedupeSeed = null,
  } = {}) {
    const roomId = this.persistence.getRuntimeState()?.room_id;
    const joinedMemberships = this.persistence.membershipProjection.list()
      .filter((row) => row.membership === 'join' && this.isLocalUserId(row.user_id));
    const results = [];
    for (const membership of joinedMemberships) {
      try {
        const userDo = getUserDoStub(this.env, membership.user_id);
        const appendResult = await userDo.appendRoomEphemeral({
          room_id: roomId,
          user_id: membership.user_id,
          event: ephemeralEvent,
          now,
          dedupe_key: canonicalJsonHash({
            room_id: roomId,
            user_id: membership.user_id,
            event: ephemeralEvent,
            dedupe_seed: dedupeSeed,
          }),
        });
        results.push({
          user_id: membership.user_id,
          ok: appendResult?.ok === true,
        });
      } catch (error) {
        results.push({
          user_id: membership.user_id,
          ok: false,
          error: error?.message ?? 'ephemeral delivery failed',
        });
      }
    }
    return results;
  }

  getTypingAlarmStorage() {
    const storage = this.ctx?.storage;
    if (!storage || typeof storage.setAlarm !== 'function' || typeof storage.deleteAlarm !== 'function') {
      return null;
    }
    return storage;
  }

  getNextTypingExpiryMillis(now = new Date().toISOString()) {
    const nowMillis = Date.parse(now);
    const nextExpiry = this.persistence.typing.list()
      .filter((row) => Date.parse(row.expires_at) > nowMillis)
      .reduce((earliest, row) => {
        const expiry = Date.parse(row.expires_at);
        return Number.isFinite(expiry) && expiry < earliest ? expiry : earliest;
      }, Number.POSITIVE_INFINITY);
    return Number.isFinite(nextExpiry) ? nextExpiry : null;
  }

  getRegistryRetryMarker() {
    const stateMap = this.getCurrentStateMap();
    const createState = getTypedStateEvent(stateMap, 'm.room.create', '');
    if (!createState) {
      return null;
    }
    const metadata = this.persistence.eventMetadata.get({ event_id: createState.event_id });
    return readRegistryRetryMarker(metadata?.record);
  }

  persistRegistryRetryMarker(marker) {
    const stateMap = this.getCurrentStateMap();
    const createState = getTypedStateEvent(stateMap, 'm.room.create', '');
    if (!createState) {
      return null;
    }
    const metadata = this.persistence.eventMetadata.get({ event_id: createState.event_id });
    if (!metadata) {
      return null;
    }
    return this.persistence.eventMetadata.put({
      ...metadata,
      record_json: marker == null
        ? clearRegistryRetryMarker(metadata.record)
        : withRegistryRetryMarker(metadata.record, marker),
    });
  }

  async syncTypingAlarm(now = new Date().toISOString()) {
    const storage = this.getTypingAlarmStorage();
    if (!storage) {
      return null;
    }
    const nextExpiry = this.getNextTypingExpiryMillis(now);
    const nextRegistryRetry = getRegistryRetryAtMillis(this.getRegistryRetryMarker());
    const nextAlarmAt = [nextExpiry, nextRegistryRetry]
      .filter((value) => Number.isFinite(value))
      .reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextAlarmAt)) {
      await storage.deleteAlarm();
      return null;
    }
    await storage.setAlarm(nextAlarmAt);
    return nextAlarmAt;
  }

  async ensureShardRegistry() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const roomId = normalizeString(request?.room_id ?? this.persistence.getRuntimeState()?.room_id, 'request.room_id');
    const now = normalizeString(request?.now ?? new Date().toISOString(), 'request.now');
    try {
      await upsertShardRegistryBarrier(this.env, {
        shardType: 'RoomDO',
        shardKey: roomId,
        schemaVersion: ROOM_DO_SCHEMA_VERSION,
        nowIso: now,
      });
      if (this.getRegistryRetryMarker()) {
        this.persistRegistryRetryMarker(null);
      }
      await this.syncTypingAlarm(now);
      return createSuccessResult({
        registered: true,
        shard_type: 'RoomDO',
        shard_key: roomId,
      });
    } catch (error) {
      const mappedError = createShardRegistryBarrierError({
        shardType: 'RoomDO',
        shardKey: roomId,
        error,
      });
      this.persistRegistryRetryMarker(buildRegistryRetryMarker({
        existingMarker: this.getRegistryRetryMarker(),
        shardType: 'RoomDO',
        shardKey: roomId,
        schemaVersion: ROOM_DO_SCHEMA_VERSION,
        nowIso: now,
        error: mappedError,
      }));
      await this.syncTypingAlarm(now);
      return {
        ok: false,
        error: mappedError,
      };
    }
  }

  async retryPendingShardRegistry({ now = new Date().toISOString() } = {}) {
    const runtimeState = this.persistence.getRuntimeState();
    const marker = this.getRegistryRetryMarker();
    if (!runtimeState?.room_id || !marker) {
      return {
        attempted: false,
      };
    }
    const retryAtMs = getRegistryRetryAtMillis(marker);
    if (retryAtMs != null && retryAtMs > Date.parse(now)) {
      return {
        attempted: false,
        next_retry_at: marker.next_retry_at,
      };
    }
    try {
      await upsertShardRegistryBarrier(this.env, {
        shardType: 'RoomDO',
        shardKey: runtimeState.room_id,
        schemaVersion: ROOM_DO_SCHEMA_VERSION,
        nowIso: now,
      });
      this.persistRegistryRetryMarker(null);
      return {
        attempted: true,
        repaired: true,
      };
    } catch (error) {
      const mappedError = createShardRegistryBarrierError({
        shardType: 'RoomDO',
        shardKey: runtimeState.room_id,
        error,
      });
      const nextMarker = buildRegistryRetryMarker({
        existingMarker: marker,
        shardType: 'RoomDO',
        shardKey: runtimeState.room_id,
        schemaVersion: ROOM_DO_SCHEMA_VERSION,
        nowIso: now,
        error: mappedError,
      });
      this.persistRegistryRetryMarker(nextMarker);
      return {
        attempted: true,
        repaired: false,
        next_retry_at: nextMarker.next_retry_at,
      };
    }
  }

  async setTyping() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    try {
      const [request = {}] = arguments;
      const userId = normalizeString(request?.user_id, 'request.user_id');
      const membership = this.persistence.membershipProjection.get({ user_id: userId });
      if (!membership || membership.membership !== 'join') {
        return {
          ok: false,
          error: createRoomInternalError('room_forbidden', 'Typing is only allowed for joined users'),
        };
      }
      const now = request?.now ?? new Date().toISOString();
      if (request?.typing === true) {
        const timeoutMs = normalizeInteger(request?.timeout_ms ?? 30_000, 'request.timeout_ms', { min: 1 });
        this.persistence.typing.put({
          user_id: userId,
          typing: true,
          expires_at: new Date(Date.parse(now) + timeoutMs).toISOString(),
          updated_at: now,
          record_json: {},
        });
      } else {
        this.persistence.typing.delete({ user_id: userId });
      }
      await this.syncTypingAlarm(now);
      const currentTyping = this.persistence.typing.list()
        .filter((row) => Date.parse(row.expires_at) > Date.parse(now));
      await this.emitEphemeralToJoinedMembers(
        buildTypingEphemeralEvent(this.persistence.getRuntimeState()?.room_id, currentTyping),
        {
          now,
          dedupeSeed: `typing|${userId}|${now}`,
        },
      );
      return createSuccessResult({
        response: {},
      });
    } finally {
      this.observeAuthorityMetric('roomdo.operation.latency_ms', Date.now() - startedAt, {
        operation: 'setTyping',
      });
    }
  }

  async applyReceipt() {
    const startedAt = Date.now();
    await this.ensureCurrentness();
    await this.ensureSchema();
    try {
      const [request = {}] = arguments;
      const userId = normalizeString(request?.user_id, 'request.user_id');
      const membership = this.persistence.membershipProjection.get({ user_id: userId });
      if (!membership || membership.membership !== 'join') {
        return {
          ok: false,
          error: createRoomInternalError('room_forbidden', 'Receipts are only allowed for joined users'),
        };
      }
      const eventId = normalizeString(request?.event_id, 'request.event_id');
      const metadata = this.persistence.eventMetadata.get({ event_id: eventId });
      if (!metadata) {
        return {
          ok: false,
          error: createRoomInternalError('event_not_found', `Event ${eventId} does not exist`),
        };
      }
      const now = request?.now ?? new Date().toISOString();
      const receiptType = normalizeString(request?.receipt_type, 'request.receipt_type');
      const threadId = typeof request?.thread_id === 'string' ? request.thread_id : '';
      this.persistence.receipts.put({
        receipt_type: receiptType,
        user_id: userId,
        thread_id: threadId,
        event_id: eventId,
        room_pos: metadata.room_pos,
        receipt_ts: Number.isInteger(request?.receipt_ts) ? request.receipt_ts : Date.now(),
        updated_at: now,
        record_json: {},
      });
      const receiptRow = this.persistence.receipts.get({
        receipt_type: receiptType,
        user_id: userId,
        thread_id: threadId,
      });
      await this.emitEphemeralToJoinedMembers(
        buildReceiptEphemeralEvent(this.persistence.getRuntimeState()?.room_id, receiptRow),
        {
          now,
          dedupeSeed: `receipt|${receiptType}|${eventId}|${userId}|${threadId}|${now}`,
        },
      );
      return createSuccessResult({
        response: {},
      });
    } finally {
      this.observeAuthorityMetric('roomdo.operation.latency_ms', Date.now() - startedAt, {
        operation: 'applyReceipt',
      });
    }
  }

  async expireTypingAlarm() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    const expiredUsers = [];
    for (const row of this.persistence.typing.list()) {
      if (Date.parse(row.expires_at) <= Date.parse(now)) {
        this.persistence.typing.delete({ user_id: row.user_id });
        expiredUsers.push(row.user_id);
      }
    }
    if (expiredUsers.length > 0) {
      await this.emitEphemeralToJoinedMembers(
        buildTypingEphemeralEvent(this.persistence.getRuntimeState()?.room_id, this.persistence.typing.list()),
        {
          now,
          dedupeSeed: `typing-expire|${expiredUsers.join(',')}|${now}`,
        },
      );
    }
    await this.syncTypingAlarm(now);
    return createSuccessResult({
      expired_user_ids: expiredUsers,
    });
  }

  async markForgotten() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return createSuccessResult({
      updated: false,
      visibility_only: true,
    });
  }

  async enqueueProfileRefresh() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const runtimeState = this.persistence.getRuntimeState();
    const roomId = normalizeString(request?.room_id ?? runtimeState?.room_id, 'request.room_id');
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const profileVersion = normalizeInteger(request?.profile_version, 'request.profile_version', { min: 1 });
    const now = request?.now ?? new Date().toISOString();
    const membership = this.persistence.membershipProjection.get({ user_id: userId });
    if (!membership || membership.membership !== 'join') {
      return createSuccessResult({
        delivered: false,
        reason: 'not_joined',
      });
    }
    if (Number.isInteger(membership.profile_version) && membership.profile_version > profileVersion) {
      return createSuccessResult({
        delivered: false,
        reason: 'stale_profile_version',
      });
    }
    const result = await this.admitEvent({
      request_kind: 'client',
      room_id: roomId,
      room_version: request?.room_version ?? runtimeState?.room_version ?? DEFAULT_ROOM_VERSION,
      request_fingerprint: canonicalJsonHash({
        kind: 'profile_refresh',
        room_id: roomId,
        user_id: userId,
        profile_version: profileVersion,
        displayname: request?.displayname ?? null,
        avatar_url: request?.avatar_url ?? null,
      }),
      now,
      candidate_event: {
        type: 'm.room.member',
        sender: userId,
        state_key: userId,
        content: {
          membership: 'join',
          ...(request?.displayname == null ? {} : { displayname: request.displayname }),
          ...(request?.avatar_url == null ? {} : { avatar_url: request.avatar_url }),
        },
        unsigned: {
          public: {
            profile_version: profileVersion,
            propagation_kind: 'profile_refresh',
          },
        },
      },
    });
    if (!result?.ok) {
      return result;
    }
    return createSuccessResult({
      delivered: true,
      event_id: result.event_id ?? buildProfileRefreshEventId(roomId, userId, profileVersion),
      room_pos: result.room_pos ?? null,
    });
  }

  assertRoomReadableBy(userId) {
    const membership = this.persistence.membershipProjection.get({ user_id: userId });
    if (!membership) {
      throw createRoomInternalError('room_forbidden', 'The user cannot read this room');
    }
    if (membership.membership === 'forgotten') {
      throw createRoomInternalError('room_forbidden', 'Forgotten rooms are no longer readable');
    }
    if (!isReadableRoomMembership(membership.membership)) {
      throw createRoomInternalError('room_forbidden', 'The user cannot read this room');
    }
    return membership;
  }

  listVisibleTimelineMetadata({ maxRoomPos = null } = {}) {
    return this.persistence.eventMetadata.list()
      .filter((row) => row.soft_failed_flag !== true && row.waiting_missing_flag !== true)
      .filter((row) => maxRoomPos == null || row.room_pos <= maxRoomPos)
      .sort((left, right) => left.room_pos - right.room_pos || left.event_id.localeCompare(right.event_id));
  }

  loadVisibleRoomEventById(eventId, { maxRoomPos = null } = {}) {
    const loaded = this.loadRoomEventById(eventId);
    if (maxRoomPos != null && loaded.metadata.room_pos > maxRoomPos) {
      throw createRoomInternalError('event_not_found', `Event ${eventId} does not exist`);
    }
    if (loaded.metadata.soft_failed_flag === true || loaded.metadata.waiting_missing_flag === true) {
      throw createRoomInternalError('event_not_found', `Event ${eventId} does not exist`);
    }
    return loaded;
  }

  readTimelineChunk({ from = null, dir = 'b', limit = 10, maxRoomPos = null }) {
    const visible = this.listVisibleTimelineMetadata({ maxRoomPos });
    const normalizedLimit = normalizeInteger(limit, 'limit', { min: 1 });
    if (dir === 'f') {
      const startPos = from == null ? 0 : decodeRoomCursor(from);
      const rows = visible
        .filter((row) => row.room_pos > startPos)
        .slice(0, normalizedLimit);
      return {
        chunk: rows.map((row) => this.loadVisibleRoomEventById(row.event_id, { maxRoomPos }).event),
        start: encodeRoomCursor(startPos),
        end: rows.length > 0 ? encodeRoomCursor(rows.at(-1).room_pos) : encodeRoomCursor(startPos),
      };
    }
    const startPos = from == null
      ? ((visible.at(-1)?.room_pos ?? 0) + 1)
      : decodeRoomCursor(from);
    const rows = visible
      .filter((row) => row.room_pos < startPos)
      .toReversed()
      .slice(0, normalizedLimit);
    return {
      chunk: rows.map((row) => this.loadVisibleRoomEventById(row.event_id, { maxRoomPos }).event),
      start: encodeRoomCursor(startPos),
      end: rows.length > 0 ? encodeRoomCursor(rows.at(-1).room_pos) : encodeRoomCursor(startPos),
    };
  }

  readContextWindow(eventId, requesterUserId, limit = 10, {
    maxRoomPos = null,
  } = {}) {
    const target = this.loadVisibleRoomEventById(eventId, { maxRoomPos });
    const targetMetadata = target.metadata;
    const snapshotId = typeof targetMetadata.record?.snapshot_id === 'string' && targetMetadata.record.snapshot_id.length > 0
      ? targetMetadata.record.snapshot_id
      : this.resolveSnapshotIdForRoomPos(targetMetadata.room_pos);
    const visible = this.listVisibleTimelineMetadata({ maxRoomPos });
    const normalizedLimit = normalizeInteger(limit, 'limit', { min: 1 });
    const beforeRows = visible
      .filter((row) => row.room_pos < targetMetadata.room_pos)
      .slice(-normalizedLimit);
    const afterRows = visible
      .filter((row) => row.room_pos > targetMetadata.room_pos)
      .slice(0, normalizedLimit);
    return {
      event: target.event,
      events_before: beforeRows.map((row) => this.loadVisibleRoomEventById(row.event_id, { maxRoomPos }).event),
      events_after: afterRows.map((row) => this.loadVisibleRoomEventById(row.event_id, { maxRoomPos }).event),
      state: this.buildStateSnapshotEventsForUser(requesterUserId, {
        snapshotId,
      }),
      start: beforeRows.length > 0 ? encodeRoomCursor(beforeRows[0].room_pos) : encodeRoomCursor(targetMetadata.room_pos),
      end: afterRows.length > 0 ? encodeRoomCursor(afterRows.at(-1).room_pos) : encodeRoomCursor(targetMetadata.room_pos),
    };
  }

  async projectForSync() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const runtimeState = this.persistence.getRuntimeState();
    const roomId = normalizeString(request?.room_id ?? runtimeState?.room_id, 'request.room_id');
    const userId = normalizeString(request?.user_id, 'request.user_id');
    const filterFlags = request?.filter_flags && typeof request.filter_flags === 'object' && !Array.isArray(request.filter_flags)
      ? request.filter_flags
      : getSyncFilterFlags(request?.filter_json ?? {});
    const membership = this.persistence.membershipProjection.get({ user_id: userId });
    const membershipBucket = normalizeRoomMembershipBucket(membership?.membership ?? null, { allowNull: true });
    if (!membershipBucket || membershipBucket === 'forgotten') {
      return createSuccessResult({ projection: null });
    }
    if (membershipBucket === 'leave' && filterFlags.include_leave !== true) {
      return createSuccessResult({ projection: null });
    }
    const visibilityRoomPos = membershipBucket === 'join'
      ? null
      : (Number.isInteger(membership?.room_pos) && membership.room_pos >= 1 ? membership.room_pos : null);
    const snapshotId = visibilityRoomPos == null ? null : this.resolveSnapshotIdForRoomPos(visibilityRoomPos);

    const timelineEventIds = uniqueStringArray(request?.timeline_event_ids);
    const stateEventIds = uniqueStringArray(request?.state_event_ids);
    const loadProjectedEvents = (eventIds) => {
      const events = [];
      for (const eventId of eventIds) {
        try {
          events.push(this.loadVisibleRoomEventById(eventId, { maxRoomPos: visibilityRoomPos }).event);
        } catch (error) {
          if (error?.code === 'event_not_found') {
            continue;
          }
          return {
            ok: false,
            error,
          };
        }
      }
      return {
        ok: true,
        events,
      };
    };
    const timelineEventsResult = loadProjectedEvents(timelineEventIds);
    if (!timelineEventsResult.ok) {
      return timelineEventsResult;
    }
    const deltaStateEventsResult = loadProjectedEvents(stateEventIds);
    if (!deltaStateEventsResult.ok) {
      return deltaStateEventsResult;
    }
    const timelineEvents = timelineEventsResult.events;
    const deltaStateEvents = deltaStateEventsResult.events;

    let currentStateEvents = [];
    try {
      if (request?.full_state === true || request?.use_state_after === true) {
        currentStateEvents = this.buildStateSnapshotEventsForUser(userId, {
          lazyLoadMembers: filterFlags.lazy_load_members === true,
          timelineEvents,
          snapshotId,
        });
      }
    } catch (error) {
      return {
        ok: false,
        error,
      };
    }

    const summary = request?.summary && typeof request.summary === 'object' && !Array.isArray(request.summary)
      ? structuredClone(request.summary)
      : buildRoomSyncSummaryFromSnapshot(this, snapshotId);
    const projection = {
      room_id: roomId,
      membership_bucket: membershipBucket,
      limited: request?.limited === true,
      prev_batch: typeof request?.prev_batch === 'string' && request.prev_batch.length > 0 ? request.prev_batch : null,
      timeline_events: timelineEvents,
      state_events: request?.full_state === true ? currentStateEvents : deltaStateEvents,
      state_after_events: request?.use_state_after === true ? currentStateEvents : null,
      ephemeral_events: Array.isArray(request?.ephemeral_events) ? structuredClone(request.ephemeral_events) : [],
      account_data_events: Array.isArray(request?.account_data_events) ? structuredClone(request.account_data_events) : [],
      unread_notifications: (
        request?.notification_count != null || request?.highlight_count != null
      )
        ? {
          highlight_count: request?.highlight_count ?? 0,
          notification_count: request?.notification_count ?? 0,
        }
        : null,
      unread_thread_notifications: filterFlags.unread_thread_notifications === true
        && request?.unread_thread_notifications
        && typeof request.unread_thread_notifications === 'object'
        ? structuredClone(request.unread_thread_notifications)
        : null,
      summary,
      room_pos: membershipBucket === 'join'
        ? (request?.room_pos ?? membership?.room_pos ?? 0)
        : (visibilityRoomPos ?? 0),
    };
    return createSuccessResult({
      projection,
    });
  }

  async queryRoom() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    try {
      const [request = {}] = arguments;
      const kind = normalizeRoomReadKind(request?.kind);
      const roomId = normalizeString(request?.room_id ?? this.persistence.getRuntimeState()?.room_id, 'request.room_id');
      const requesterUserId = normalizeString(request?.requester_user_id, 'request.requester_user_id');
      const membership = this.assertRoomReadableBy(requesterUserId);
      const maxVisibleRoomPos = membership.membership === 'join'
        ? null
        : normalizeInteger(membership.room_pos, 'membership.room_pos', { min: 1 });
      const boundarySnapshotId = maxVisibleRoomPos == null ? null : this.resolveSnapshotIdForRoomPos(maxVisibleRoomPos);
      if (this.persistence.getRuntimeState()?.room_id && this.persistence.getRuntimeState().room_id !== roomId) {
        throw createRoomInternalError('room_not_found', `Room ${roomId} does not exist`);
      }

      if (kind === 'timeline') {
        const result = this.readTimelineChunk({
          from: request?.cursor?.from ?? null,
          dir: request?.cursor?.dir === 'f' ? 'f' : 'b',
          limit: request?.limit ?? 10,
          maxRoomPos: maxVisibleRoomPos,
        });
        return createSuccessResult({
          kind,
          room_id: roomId,
          ...result,
        });
      }

      if (kind === 'context') {
        const result = this.readContextWindow(
          normalizeString(request?.event_id, 'request.event_id'),
          requesterUserId,
          request?.limit ?? 10,
          {
            maxRoomPos: maxVisibleRoomPos,
          },
        );
        return createSuccessResult({
          kind,
          room_id: roomId,
          ...result,
        });
      }

      if (kind === 'event') {
        return createSuccessResult({
          kind,
          room_id: roomId,
          event: this.loadVisibleRoomEventById(
            normalizeString(request?.event_id, 'request.event_id'),
            { maxRoomPos: maxVisibleRoomPos },
          ).event,
        });
      }

      if (kind === 'state') {
        const stateMap = boundarySnapshotId == null
          ? this.getCurrentStateMap()
          : getRoomStateMapForSnapshot(this.persistence, boundarySnapshotId);
        const eventType = typeof request?.cursor?.event_type === 'string' ? request.cursor.event_type : null;
        const stateKey = typeof request?.cursor?.state_key === 'string' ? request.cursor.state_key : '';
        if (eventType) {
          const stateEntry = getTypedStateEvent(stateMap, eventType, stateKey);
          if (!stateEntry) {
            throw createRoomInternalError('event_not_found', `State event ${eventType}/${stateKey} does not exist`);
          }
          return createSuccessResult({
            kind,
            room_id: roomId,
            event: this.loadVisibleRoomEventById(stateEntry.event_id, { maxRoomPos: maxVisibleRoomPos }).event,
          });
        }
        return createSuccessResult({
          kind,
          room_id: roomId,
          state: this.buildStateSnapshotEventsForUser(requesterUserId, {
            snapshotId: boundarySnapshotId,
          }),
        });
      }

      if (kind === 'members') {
        const stateEvents = this.buildStateSnapshotEventsForUser(requesterUserId, {
          snapshotId: boundarySnapshotId,
        });
        return createSuccessResult({
          kind,
          room_id: roomId,
          chunk: stateEvents.filter((event) => event.type === 'm.room.member'),
        });
      }

      if (kind === 'joined_members') {
        const joined = {};
        for (const event of this.buildStateSnapshotEventsForUser(requesterUserId, {
          snapshotId: boundarySnapshotId,
        }).filter((candidate) => candidate.type === 'm.room.member' && candidate.content?.membership === 'join')) {
          joined[event.state_key] = {
            avatar_url: event.content?.avatar_url ?? undefined,
            display_name: event.content?.displayname ?? undefined,
          };
        }
        return createSuccessResult({
          kind,
          room_id: roomId,
          joined,
        });
      }

      if (kind === 'relations') {
        const eventId = normalizeString(request?.event_id, 'request.event_id');
        const relType = typeof request?.cursor?.rel_type === 'string' ? request.cursor.rel_type : null;
        const eventType = typeof request?.cursor?.event_type === 'string' ? request.cursor.event_type : null;
        const rows = this.listVisibleTimelineMetadata({ maxRoomPos: maxVisibleRoomPos })
          .filter((row) => row.relates_to_event_id_or_null === eventId)
          .filter((row) => relType == null || row.relation_type_or_null === relType)
          .filter((row) => eventType == null || row.event_type === eventType)
          .sort((left, right) => right.room_pos - left.room_pos)
          .slice(0, normalizeInteger(request?.limit ?? 10, 'limit', { min: 1 }));
        return createSuccessResult({
          kind,
          room_id: roomId,
          chunk: rows.map((row) => this.loadVisibleRoomEventById(row.event_id, { maxRoomPos: maxVisibleRoomPos }).event),
          start: rows.length > 0 ? encodeRoomCursor(rows[0].room_pos) : null,
          end: rows.length > 0 ? encodeRoomCursor(rows.at(-1).room_pos) : null,
        });
      }

      if (kind === 'threads') {
        const rootIds = [...new Set(
          this.listVisibleTimelineMetadata({ maxRoomPos: maxVisibleRoomPos })
            .map((row) => row.thread_root_event_id_or_null)
            .filter((value) => typeof value === 'string' && value.length > 0),
        )];
        const rows = rootIds
          .map((eventId) => this.persistence.eventMetadata.get({ event_id: eventId }))
          .filter((row) => row && (maxVisibleRoomPos == null || row.room_pos <= maxVisibleRoomPos))
          .filter(Boolean)
          .sort((left, right) => right.room_pos - left.room_pos)
          .slice(0, normalizeInteger(request?.limit ?? 10, 'limit', { min: 1 }));
        return createSuccessResult({
          kind,
          room_id: roomId,
          chunk: rows.map((row) => this.loadVisibleRoomEventById(row.event_id, { maxRoomPos: maxVisibleRoomPos }).event),
          start: rows.length > 0 ? encodeRoomCursor(rows[0].room_pos) : null,
          end: rows.length > 0 ? encodeRoomCursor(rows.at(-1).room_pos) : null,
        });
      }

      if (kind === 'timestamp_lookup') {
        const timestamp = normalizeInteger(request?.timestamp, 'request.timestamp', { min: 0 });
        const direction = request?.cursor?.dir === 'f' ? 'f' : 'b';
        const visible = this.listVisibleTimelineMetadata({ maxRoomPos: maxVisibleRoomPos });
        const match = direction === 'f'
          ? visible.find((row) => row.origin_server_ts >= timestamp)
          : [...visible].reverse().find((row) => row.origin_server_ts <= timestamp);
        if (!match) {
          throw createRoomInternalError('event_not_found', 'No visible event matches the timestamp lookup');
        }
        return createSuccessResult({
          kind,
          room_id: roomId,
          event: this.loadVisibleRoomEventById(match.event_id, { maxRoomPos: maxVisibleRoomPos }).event,
        });
      }

      throw createRoomInternalError('invalid_event', `Unsupported room query kind: ${kind}`);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return {
          ok: false,
          error: createRoomInternalError('invalid_cursor', error.message),
        };
      }
      return {
        ok: false,
        error,
      };
    }
  }

  async enqueueDerivedUpdates({
    event_id,
    room_id,
    room_pos,
    visibility_watermark,
    redaction_watermark,
    updated_at = new Date().toISOString(),
  }) {
    if (!this.env?.JOBS_WORKER) {
      return;
    }
    try {
      await enqueueDerivedWork(this.env, {
        schema_version: RUNTIME_JOB_SCHEMA_VERSION,
        batch_id: makeId('derived'),
        requested_by: 'RoomDO.admitEvent',
        work_items: [
          {
            work_type: 'search_index',
            idempotency_key: normalizeString(event_id, 'event_id'),
            scope: {
              scope_kind: 'room_id',
              scope_id: normalizeString(room_id, 'room_id'),
            },
            source_refs: {
              room_id,
              event_id,
              room_pos: normalizeInteger(room_pos, 'room_pos', { min: 1 }),
              visibility_watermark: normalizeInteger(visibility_watermark, 'visibility_watermark', { min: 1 }),
              redaction_watermark: normalizeInteger(redaction_watermark, 'redaction_watermark', { min: 1 }),
            },
            enqueued_at: updated_at,
          },
          {
            work_type: 'public_room_directory',
            idempotency_key: `public_room_directory:${room_id}`,
            scope: {
              scope_kind: 'room_id',
              scope_id: room_id,
            },
            source_refs: {
              room_id,
            },
            enqueued_at: updated_at,
          },
        ],
      });
    } catch {
      // Derived work is best-effort. Rebuild remains the repair path.
    }
  }

  async getDerivedEventProjection() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const eventId = normalizeString(request?.event_id, 'request.event_id');
    return createSuccessResult({
      search_index: buildSearchIndexProjection(this, eventId, request?.updated_at ?? new Date().toISOString()),
    });
  }

  async getPublicRoomDirectoryEntry() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return createSuccessResult({
      entry: buildRoomDirectoryProjection(this),
    });
  }

  async resolveRoomAlias() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const alias = normalizeString(request?.alias, 'request.alias');
    const entry = buildRoomDirectoryProjection(this);
    if (entry?.canonical_alias === alias) {
      return createSuccessResult({
        room_id: entry.room_id,
      });
    }
    return createSuccessResult({
      room_id: null,
    });
  }

  async loadRoomEventForRebuild(eventId) {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const metadata = this.persistence.eventMetadata.get({ event_id: normalizeString(eventId, 'eventId') });
    if (!metadata) {
      throw createRoomInternalError('event_not_found', `Event ${eventId} does not exist`);
    }
    const hotEvent = this.persistence.hotEventJson.get({ event_id: eventId });
    if (hotEvent) {
      return {
        metadata,
        event: parseCanonicalRoomEvent(hotEvent),
      };
    }
    const archiveKey = metadata.archive_object_key_or_segment_id ?? null;
    if (typeof archiveKey !== 'string' || archiveKey.length === 0) {
      throw createInternalErrorEnvelope({
        code: 'archive_missing',
        message: `Room event ${eventId} JSON is missing`,
        retryable: false,
      });
    }
    const archiveBucket = this.env.MATRIX_ARCHIVE_BUCKET;
    const archived = archiveBucket && typeof archiveBucket.get === 'function'
      ? await archiveBucket.get(archiveKey)
      : null;
    if (!archived) {
      throw createInternalErrorEnvelope({
        code: 'archive_missing',
        message: `Room event ${eventId} archive object ${archiveKey} is missing`,
        retryable: false,
      });
    }
    let event;
    if (typeof archived.json === 'function') {
      event = await archived.json();
    } else if (typeof archived.text === 'function') {
      event = JSON.parse(await archived.text());
    } else {
      event = JSON.parse(Buffer.from(archived.body).toString('utf8'));
    }
    return {
      metadata,
      event,
    };
  }

  async exportDerivedShard() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const updatedAt = request?.updated_at ?? new Date().toISOString();
    const includeSearchIndexRows = request?.include_search_index_rows !== false;
    const includePublicRoomDirectoryEntry = request?.include_public_room_directory_entry !== false;
    const requestedMaxRoomPos = request?.max_room_pos == null
      ? null
      : normalizeInteger(request.max_room_pos, 'request.max_room_pos', { min: 0 });
    const requestedSearchRowOffset = request?.search_row_offset == null
      ? 0
      : normalizeInteger(request.search_row_offset, 'request.search_row_offset', { min: 0 });
    const requestedSearchLimit = request?.search_limit == null
      ? null
      : normalizeInteger(request.search_limit, 'request.search_limit', { min: 1 });
    const visibleTimeline = this.listVisibleTimelineMetadata({ maxRoomPos: requestedMaxRoomPos });
    const effectiveMaxRoomPos = requestedMaxRoomPos ?? (visibleTimeline.at(-1)?.room_pos ?? 0);
    const selectedMetadata = includeSearchIndexRows
      ? (
        requestedSearchLimit == null
          ? visibleTimeline.slice(requestedSearchRowOffset)
          : visibleTimeline.slice(requestedSearchRowOffset, requestedSearchRowOffset + requestedSearchLimit)
      )
      : [];
    const searchIndexRows = [];
    for (const metadata of selectedMetadata) {
      const loaded = await this.loadRoomEventForRebuild(metadata.event_id);
      searchIndexRows.push({
        event_id: metadata.event_id,
        room_id: this.persistence.getRuntimeState()?.room_id ?? loaded.event.room_id ?? null,
        event_type: metadata.event_type,
        origin_server_ts: metadata.origin_server_ts,
        sender_user_id: metadata.sender_user_id,
        search_vector_text: buildSearchVectorText(loaded.event),
        visibility_scope: metadata.membership_visibility_class ?? metadata.history_visibility_class ?? 'shared',
        updated_at: updatedAt,
        record_json: {
          room_pos: metadata.room_pos,
          room_version: metadata.record?.room_version ?? null,
          redacts_event_id_or_null: metadata.redacts_event_id_or_null ?? null,
          archive_object_key_or_segment_id: metadata.archive_object_key_or_segment_id ?? null,
        },
      });
    }
    const nextSearchRowOffset = includeSearchIndexRows
      && requestedSearchLimit != null
      && requestedSearchRowOffset + searchIndexRows.length < visibleTimeline.length
      ? requestedSearchRowOffset + searchIndexRows.length
      : null;
    return createSuccessResult({
      room_id: this.persistence.getRuntimeState()?.room_id ?? null,
      max_room_pos: effectiveMaxRoomPos,
      search_row_offset: requestedSearchRowOffset,
      next_search_row_offset: nextSearchRowOffset,
      total_search_index_rows: includeSearchIndexRows ? visibleTimeline.length : 0,
      has_more_search_index_rows: nextSearchRowOffset != null,
      search_index_rows: searchIndexRows,
      public_room_directory_entry: includePublicRoomDirectoryEntry
        ? buildRoomDirectoryProjection(this, { updatedAt })
        : null,
    });
  }

  async alarm(alarmInfo = {}) {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const scheduledTime = Number.isFinite(alarmInfo?.scheduledTime)
      ? alarmInfo.scheduledTime
      : Date.now();
    const now = new Date(scheduledTime).toISOString();
    await this.retryPendingShardRegistry({ now });
    await this.expireTypingAlarm({ now });
  }
}

export class RemoteServerDO extends BaseDurableObject {
  static authorityKind = 'remote-server';
  static schemaVersion = REMOTE_SERVER_DO_SCHEMA_VERSION;

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'RemoteServerDO',
      authorityKind: RemoteServerDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'remoteserverdo',
    });
  }

  get persistence() {
    if (!this._persistence) {
      this._persistence = createRemoteServerDurableObjectPersistence(this.requireSqlStorage());
    }
    return this._persistence;
  }

  async ensureSchema() {
    await this.persistence.ensureSchema();
    return this.persistence.getRuntimeState();
  }

  async enqueueOutbound() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('enqueueOutbound', {
      schema_version: RemoteServerDO.schemaVersion,
    });
  }

  async recordInboundTxn() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('recordInboundTxn', {
      schema_version: RemoteServerDO.schemaVersion,
    });
  }
}
