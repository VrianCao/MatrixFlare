import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import {
  REMOTE_SERVER_DO_SCHEMA_VERSION,
  createRemoteServerDurableObjectPersistence,
} from './remote-server-persistence.mjs';
import {
  ROOM_DO_SCHEMA_VERSION,
  createRoomDurableObjectPersistence,
} from './room-persistence.mjs';
import { normalizeInteger, normalizeString, withSqliteTransaction } from './persistence-common.mjs';
import { createAsyncTaskContext, createRequestContext } from './structured-logging.mjs';
import { loadWorkerRuntimeConfig } from './runtime-manifest.mjs';
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
  const normalizedRoomId = normalizeString(room_id, 'room_id');
  const normalizedBucket = normalizeRoomMembershipBucket(membership_bucket, { allowNull: false });
  if (normalizedBucket === 'forgotten') {
    delete existing[normalizedRoomId];
  } else {
    existing[normalizedRoomId] = {
      room_id: normalizedRoomId,
      membership_bucket: normalizedBucket,
      room_pos: normalizeInteger(room_pos, 'room_pos', { min: 0 }),
      updated_at: normalizeString(updated_at, 'updated_at'),
    };
  }
  return {
    ...(principal?.record ?? {}),
    room_sync_memberships: existing,
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

function buildProfileRefreshEventId(roomId, userId, profileVersion) {
  return `$profile_refresh_${Buffer.from(`${roomId}|${userId}|${profileVersion}`, 'utf8').toString('base64url')}`;
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
  return {
    status: 500,
    body: {
      errcode: 'M_UNKNOWN',
      error: error?.message ?? 'Internal error',
    },
  };
}

export class BaseDurableObject {
  constructor(ctx, env, options) {
    this.ctx = ctx;
    this.env = env;
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
    const sql = this.ctx?.storage?.sql;
    if (!sql || typeof sql.exec !== 'function') {
      throw new TypeError(`${this.options.className} requires SQLite-backed Durable Object storage`);
    }
    return sql;
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
      try {
        const decoded = JSON.parse(error.message);
        if (decoded?.errcode) {
          return createMatrixError(decoded.status, decoded.errcode, decoded.error);
        }
      } catch {
        return createMatrixError(400, 'M_INVALID_PARAM', error.message);
      }
      return createMatrixError(400, 'M_INVALID_PARAM', error.message);
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
      const streamEntry = this.persistence.appendUserStreamWithinTransaction({
        user_id: userId,
        stream_kind: 'push_rules',
        created_at: now,
        payload: { type: 'm.push_rules' },
      });
      wakePos = streamEntry.stream_pos;
    });
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
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const now = request?.now ?? new Date().toISOString();
    let localpart;
    try {
      localpart = normalizeLocalpart(request?.localpart);
    } catch {
      return createMatrixError(403, 'M_FORBIDDEN', 'Invalid username or password');
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
  }

  async refreshSession() {
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

  async admitEvent() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('admitEvent', {
      schema_version: RoomDO.schemaVersion,
    });
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

  loadRoomEventById(eventId) {
    const metadata = this.persistence.eventMetadata.get({ event_id: eventId });
    if (!metadata) {
      throw createInternalErrorEnvelope({
        code: 'archive_missing',
        message: `Room event ${eventId} metadata is missing`,
        retryable: false,
      });
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
  } = {}) {
    const runtimeState = this.persistence.getRuntimeState();
    if (!runtimeState?.current_snapshot_id) {
      return [];
    }
    const allStateEntries = this.persistence.stateEntries.list()
      .filter((row) => row.snapshot_id === runtimeState.current_snapshot_id);
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

  async deliverPendingFanout() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    const [request = {}] = arguments;
    const limit = normalizeInteger(request?.limit ?? 100, 'request.limit', { min: 1 });
    const now = request?.now ?? new Date().toISOString();
    const pendingItems = this.persistence.listPendingFanoutOutbox(limit);
    const results = [];
    for (const item of pendingItems) {
      const delta = {
        ...structuredClone(item.delta ?? {}),
        room_id: item.delta?.room_id ?? this.persistence.getRuntimeState()?.room_id,
        room_pos: item.delta?.room_pos ?? item.room_pos,
        user_id: item.delta?.user_id ?? item.user_id,
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

    const eventId = buildProfileRefreshEventId(roomId, userId, profileVersion);
    const existingEvent = this.persistence.eventMetadata.get({ event_id: eventId });
    let roomPos = existingEvent?.room_pos ?? null;
    const sql = this.requireSqlStorage();
    withSqliteTransaction(sql, () => {
      if (runtimeState?.room_id == null) {
        sql.exec(
          `
            UPDATE room_runtime_state
            SET room_id = ?,
                room_version = COALESCE(room_version, ?),
                updated_at = ?
            WHERE singleton = 1
          `,
          roomId,
          request?.room_version ?? '12',
          now,
        );
      }
      if (roomPos == null) {
        roomPos = this.reserveRoomPosWithinTransaction(sql, {
          roomId,
          roomVersion: request?.room_version ?? runtimeState?.room_version ?? '12',
          updatedAt: now,
        });
      }
      const memberEvent = buildRoomMemberRefreshEvent({
        roomId,
        userId,
        eventId,
        roomPos,
        displayname: request?.displayname ?? null,
        avatarUrl: request?.avatar_url ?? null,
        profileVersion,
        updatedAt: now,
      });
      this.persistence.eventMetadata.put({
        event_id: eventId,
        room_pos: roomPos,
        origin_server_ts: memberEvent.origin_server_ts,
        depth: roomPos,
        archive_object_key_or_segment_id: null,
        archive_offset_or_index: null,
        event_type: 'm.room.member',
        state_key_or_null: userId,
        sender_user_id: userId,
        contains_url_flag: false,
        soft_failed_flag: false,
        waiting_missing_flag: false,
        redacts_event_id_or_null: null,
        membership_target_user_id_or_null: userId,
        history_visibility_class: 'shared',
        membership_visibility_class: 'joined',
        relates_to_event_id_or_null: null,
        relation_type_or_null: null,
        aggregation_event_type_or_null: null,
        thread_root_event_id_or_null: null,
        record_json: {
          profile_version: profileVersion,
          propagation_kind: 'profile_refresh',
        },
      });
      this.persistence.hotEventJson.put({
        event_id: eventId,
        content_hash: null,
        stored_at: now,
        canonical_json: JSON.stringify(memberEvent),
        record_json: {
          profile_version: profileVersion,
        },
      });
      if (runtimeState?.current_snapshot_id) {
        this.persistence.stateEntries.put({
          snapshot_id: runtimeState.current_snapshot_id,
          event_type: 'm.room.member',
          state_key: userId,
          event_id: eventId,
          sender_user_id: userId,
          membership: 'join',
          event_room_pos: roomPos,
          content_json: structuredClone(memberEvent.content),
          record_json: {
            profile_version: profileVersion,
          },
        });
      }
      this.persistence.membershipProjection.put({
        user_id: userId,
        membership: 'join',
        event_id: eventId,
        room_pos: roomPos,
        displayname: request?.displayname ?? null,
        avatar_url: request?.avatar_url ?? null,
        profile_version: profileVersion,
        membership_visibility_class: membership.membership_visibility_class ?? 'joined',
        updated_at: now,
        record_json: {
          ...(membership.record ?? {}),
          propagation_kind: 'profile_refresh',
        },
      });
      this.persistence.fanoutOutbox.put({
        room_pos: roomPos,
        user_id: userId,
        event_id: eventId,
        status: 'pending',
        last_attempt_at: null,
        attempt_count: 0,
        acked_stream_pos: null,
        acked_at: null,
        delta_json: {
          room_id: roomId,
          room_pos: roomPos,
          user_id: userId,
          membership_bucket: 'join',
          event_id: eventId,
          state_event_ids: [eventId],
        },
        last_error_json: null,
        created_at: now,
        record_json: {
          profile_version: profileVersion,
          propagation_kind: 'profile_refresh',
        },
      });
    });
    await this.deliverPendingFanout({
      limit: 1,
      now,
    });
    return createSuccessResult({
      delivered: true,
      event_id: eventId,
      room_pos: roomPos,
    });
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
    const membershipBucket = normalizeRoomMembershipBucket(
      request?.membership_bucket ?? membership?.membership ?? null,
      { allowNull: true },
    );
    if (!membershipBucket || membershipBucket === 'forgotten') {
      return createSuccessResult({ projection: null });
    }
    if (membershipBucket === 'leave' && filterFlags.include_leave !== true) {
      return createSuccessResult({ projection: null });
    }

    const timelineEventIds = uniqueStringArray(request?.timeline_event_ids);
    const stateEventIds = uniqueStringArray(request?.state_event_ids);
    let timelineEvents;
    let deltaStateEvents;
    try {
      timelineEvents = timelineEventIds.map((eventId) => this.loadRoomEventById(eventId).event);
      deltaStateEvents = stateEventIds.map((eventId) => this.loadRoomEventById(eventId).event);
    } catch (error) {
      return {
        ok: false,
        error,
      };
    }

    let currentStateEvents = [];
    try {
      if (request?.full_state === true || request?.use_state_after === true) {
        currentStateEvents = this.buildStateSnapshotEventsForUser(userId, {
          lazyLoadMembers: filterFlags.lazy_load_members === true,
          timelineEvents,
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
      : buildRoomSyncSummary(this.persistence);
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
      unread_thread_notifications: request?.unread_thread_notifications && typeof request.unread_thread_notifications === 'object'
        ? structuredClone(request.unread_thread_notifications)
        : null,
      summary,
      room_pos: request?.room_pos ?? membership?.room_pos ?? 0,
    };
    return createSuccessResult({
      projection,
    });
  }

  async queryRoom() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('queryRoom', {
      schema_version: RoomDO.schemaVersion,
    });
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
