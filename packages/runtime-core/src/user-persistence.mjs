import {
  createSqliteTableAccess,
  ensureSingletonState,
  mapSqliteRow,
  normalizeInteger,
  normalizeString,
  requireSqlStorage,
  sqlAll,
  sqlFirst,
  sqlRun,
  tableExists,
  withSqliteTransaction,
} from './persistence-common.mjs';

export const USER_DO_SCHEMA_VERSION = 1;

const USER_RUNTIME_STATE_TABLE = 'user_runtime_state';
const USER_REQUIRED_TABLES = Object.freeze([
  USER_RUNTIME_STATE_TABLE,
  'user_sessions',
  'user_devices',
  'user_device_keys',
  'user_one_time_keys',
  'user_fallback_keys',
  'user_global_account_data',
  'user_room_account_data',
  'user_to_device_queue',
  'user_presence_state',
  'user_stream',
  'user_room_key_backup_manifests',
  'user_profile_document',
  'user_push_rules',
  'user_stored_filters',
  'user_pending_upload_grants',
  'user_to_device_txn_dedupe',
  'user_principal',
]);

export const USER_DO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  user_id TEXT,
  next_user_stream_pos INTEGER NOT NULL DEFAULT 1,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  session_id TEXT PRIMARY KEY,
  access_token_hash TEXT,
  refresh_token_hash TEXT,
  device_id TEXT,
  auth_version INTEGER NOT NULL DEFAULT 1,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  is_guest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  refresh_expires_at TEXT,
  revoked_at TEXT,
  record_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_access_hash
  ON user_sessions (access_token_hash)
  WHERE access_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_refresh_hash
  ON user_sessions (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_sessions_device_id
  ON user_sessions (device_id, revoked_at, created_at);

CREATE TABLE IF NOT EXISTS user_devices (
  device_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_seen_ip TEXT,
  deleted_at TEXT,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS user_device_keys (
  device_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_type TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  record_json TEXT,
  PRIMARY KEY (device_id, key_id)
);
CREATE INDEX IF NOT EXISTS idx_user_device_keys_device_id
  ON user_device_keys (device_id, updated_at);

CREATE TABLE IF NOT EXISTS user_one_time_keys (
  device_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  claimed_at TEXT,
  claim_context_json TEXT,
  record_json TEXT,
  PRIMARY KEY (device_id, algorithm, key_id)
);
CREATE INDEX IF NOT EXISTS idx_user_one_time_keys_claimable
  ON user_one_time_keys (device_id, algorithm, claimed_at, published_at);

CREATE TABLE IF NOT EXISTS user_fallback_keys (
  device_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  used_at TEXT,
  record_json TEXT,
  PRIMARY KEY (device_id, algorithm, key_id)
);
CREATE INDEX IF NOT EXISTS idx_user_fallback_keys_device_id
  ON user_fallback_keys (device_id, algorithm, used_at, published_at);

CREATE TABLE IF NOT EXISTS user_global_account_data (
  type TEXT PRIMARY KEY,
  content_hash TEXT,
  updated_at TEXT NOT NULL,
  content_json TEXT
);

CREATE TABLE IF NOT EXISTS user_room_account_data (
  room_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content_hash TEXT,
  updated_at TEXT NOT NULL,
  content_json TEXT,
  PRIMARY KEY (room_id, type)
);
CREATE INDEX IF NOT EXISTS idx_user_room_account_data_room_id
  ON user_room_account_data (room_id, updated_at);

CREATE TABLE IF NOT EXISTS user_to_device_queue (
  target_device_id TEXT NOT NULL,
  stream_pos INTEGER NOT NULL,
  sender_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  expires_at TEXT,
  acknowledged_at TEXT,
  payload_json TEXT,
  record_json TEXT,
  PRIMARY KEY (target_device_id, stream_pos)
);
CREATE INDEX IF NOT EXISTS idx_user_to_device_queue_delivery
  ON user_to_device_queue (target_device_id, acknowledged_at, stream_pos);

CREATE TABLE IF NOT EXISTS user_presence_state (
  user_id TEXT PRIMARY KEY,
  presence TEXT NOT NULL,
  status_msg TEXT,
  currently_active INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT,
  presence_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS user_stream (
  stream_pos INTEGER PRIMARY KEY,
  stream_kind TEXT NOT NULL,
  room_id TEXT,
  event_id TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_stream_created_at
  ON user_stream (created_at, stream_pos);
CREATE INDEX IF NOT EXISTS idx_user_stream_room_id
  ON user_stream (room_id, stream_pos);
CREATE INDEX IF NOT EXISTS idx_user_stream_event_id
  ON user_stream (event_id, stream_pos);

CREATE TABLE IF NOT EXISTS user_room_key_backup_manifests (
  backup_version TEXT PRIMARY KEY,
  algorithm TEXT,
  etag TEXT,
  backup_state TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  auth_data_json TEXT,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS user_profile_document (
  key_name TEXT PRIMARY KEY,
  profile_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  value_json TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_profile_document_profile_version
  ON user_profile_document (profile_version, key_name);

CREATE TABLE IF NOT EXISTS user_push_rules (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority_class TEXT,
  priority_index INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  actions_json TEXT,
  conditions_json TEXT,
  record_json TEXT,
  PRIMARY KEY (scope, kind, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_user_push_rules_priority
  ON user_push_rules (scope, kind, priority_index, rule_id);

CREATE TABLE IF NOT EXISTS user_stored_filters (
  filter_id TEXT PRIMARY KEY,
  filter_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  filter_json TEXT,
  record_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_stored_filters_filter_hash
  ON user_stored_filters (filter_hash);

CREATE TABLE IF NOT EXISTS user_pending_upload_grants (
  pending_upload_id TEXT PRIMARY KEY,
  media_id TEXT,
  content_type TEXT,
  max_bytes INTEGER,
  state TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalized_at TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_pending_upload_grants_state
  ON user_pending_upload_grants (state, expires_at);

CREATE TABLE IF NOT EXISTS user_to_device_txn_dedupe (
  txn_dedupe_key TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  terminal_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result_json TEXT,
  record_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_to_device_txn_dedupe_public_key
  ON user_to_device_txn_dedupe (sender_user_id, event_type, txn_id);

CREATE TABLE IF NOT EXISTS user_principal (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  user_id TEXT NOT NULL,
  localpart TEXT NOT NULL,
  user_type TEXT,
  password_hash_or_null TEXT,
  password_login_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deactivated_at_or_null TEXT,
  erase_requested_flag INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 1,
  registration_source TEXT,
  record_json TEXT
);
`;

const USER_TABLES = Object.freeze({
  sessions: Object.freeze({
    tableName: 'user_sessions',
    keyColumns: ['session_id'],
    columns: [
      'session_id',
      'access_token_hash',
      'refresh_token_hash',
      'device_id',
      'auth_version',
      'session_epoch',
      'is_guest',
      'created_at',
      'updated_at',
      'expires_at',
      'refresh_expires_at',
      'revoked_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    booleanColumns: ['is_guest'],
    orderBy: 'created_at ASC, session_id ASC',
  }),
  devices: Object.freeze({
    tableName: 'user_devices',
    keyColumns: ['device_id'],
    columns: [
      'device_id',
      'display_name',
      'created_at',
      'updated_at',
      'last_seen_at',
      'last_seen_ip',
      'deleted_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'created_at ASC, device_id ASC',
  }),
  deviceKeys: Object.freeze({
    tableName: 'user_device_keys',
    keyColumns: ['device_id', 'key_id'],
    columns: ['device_id', 'key_id', 'key_type', 'version', 'updated_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'device_id ASC, key_id ASC',
  }),
  oneTimeKeys: Object.freeze({
    tableName: 'user_one_time_keys',
    keyColumns: ['device_id', 'algorithm', 'key_id'],
    columns: ['device_id', 'algorithm', 'key_id', 'published_at', 'claimed_at', 'claim_context_json', 'record_json'],
    jsonColumns: ['claim_context_json', 'record_json'],
    jsonFallbacks: { claim_context_json: null, record_json: {} },
    orderBy: 'device_id ASC, algorithm ASC, key_id ASC',
  }),
  fallbackKeys: Object.freeze({
    tableName: 'user_fallback_keys',
    keyColumns: ['device_id', 'algorithm', 'key_id'],
    columns: ['device_id', 'algorithm', 'key_id', 'published_at', 'used_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'device_id ASC, algorithm ASC, key_id ASC',
  }),
  globalAccountData: Object.freeze({
    tableName: 'user_global_account_data',
    keyColumns: ['type'],
    columns: ['type', 'content_hash', 'updated_at', 'content_json'],
    jsonColumns: ['content_json'],
    jsonFallbacks: { content_json: {} },
    orderBy: 'type ASC',
  }),
  roomAccountData: Object.freeze({
    tableName: 'user_room_account_data',
    keyColumns: ['room_id', 'type'],
    columns: ['room_id', 'type', 'content_hash', 'updated_at', 'content_json'],
    jsonColumns: ['content_json'],
    jsonFallbacks: { content_json: {} },
    orderBy: 'room_id ASC, type ASC',
  }),
  toDeviceQueue: Object.freeze({
    tableName: 'user_to_device_queue',
    keyColumns: ['target_device_id', 'stream_pos'],
    columns: [
      'target_device_id',
      'stream_pos',
      'sender_user_id',
      'event_type',
      'enqueued_at',
      'expires_at',
      'acknowledged_at',
      'payload_json',
      'record_json',
    ],
    jsonColumns: ['payload_json', 'record_json'],
    jsonFallbacks: { payload_json: {}, record_json: {} },
    orderBy: 'target_device_id ASC, stream_pos ASC',
  }),
  presence: Object.freeze({
    tableName: 'user_presence_state',
    keyColumns: ['user_id'],
    columns: [
      'user_id',
      'presence',
      'status_msg',
      'currently_active',
      'last_active_at',
      'presence_version',
      'updated_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    booleanColumns: ['currently_active'],
    orderBy: 'user_id ASC',
  }),
  userStream: Object.freeze({
    tableName: 'user_stream',
    keyColumns: ['stream_pos'],
    columns: ['stream_pos', 'stream_kind', 'room_id', 'event_id', 'dedupe_key', 'created_at', 'payload_json', 'record_json'],
    jsonColumns: ['payload_json', 'record_json'],
    jsonFallbacks: { payload_json: {}, record_json: {} },
    orderBy: 'stream_pos ASC',
  }),
  roomKeyBackupManifests: Object.freeze({
    tableName: 'user_room_key_backup_manifests',
    keyColumns: ['backup_version'],
    columns: [
      'backup_version',
      'algorithm',
      'etag',
      'backup_state',
      'chunk_count',
      'byte_count',
      'created_at',
      'updated_at',
      'auth_data_json',
      'record_json',
    ],
    jsonColumns: ['auth_data_json', 'record_json'],
    jsonFallbacks: { auth_data_json: {}, record_json: {} },
    orderBy: 'created_at ASC, backup_version ASC',
  }),
  profileDocument: Object.freeze({
    tableName: 'user_profile_document',
    keyColumns: ['key_name'],
    columns: ['key_name', 'profile_version', 'updated_at', 'value_json', 'record_json'],
    jsonColumns: ['value_json', 'record_json'],
    jsonFallbacks: { value_json: null, record_json: {} },
    orderBy: 'key_name ASC',
  }),
  pushRules: Object.freeze({
    tableName: 'user_push_rules',
    keyColumns: ['scope', 'kind', 'rule_id'],
    columns: [
      'scope',
      'kind',
      'rule_id',
      'enabled',
      'priority_class',
      'priority_index',
      'updated_at',
      'actions_json',
      'conditions_json',
      'record_json',
    ],
    jsonColumns: ['actions_json', 'conditions_json', 'record_json'],
    jsonFallbacks: { actions_json: [], conditions_json: [], record_json: {} },
    booleanColumns: ['enabled'],
    orderBy: 'scope ASC, kind ASC, priority_index ASC, rule_id ASC',
  }),
  storedFilters: Object.freeze({
    tableName: 'user_stored_filters',
    keyColumns: ['filter_id'],
    columns: ['filter_id', 'filter_hash', 'schema_version', 'created_at', 'filter_json', 'record_json'],
    jsonColumns: ['filter_json', 'record_json'],
    jsonFallbacks: { filter_json: {}, record_json: {} },
    orderBy: 'created_at ASC, filter_id ASC',
  }),
  pendingUploadGrants: Object.freeze({
    tableName: 'user_pending_upload_grants',
    keyColumns: ['pending_upload_id'],
    columns: [
      'pending_upload_id',
      'media_id',
      'content_type',
      'max_bytes',
      'state',
      'granted_at',
      'expires_at',
      'finalized_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'granted_at ASC, pending_upload_id ASC',
  }),
  toDeviceTxnDedupe: Object.freeze({
    tableName: 'user_to_device_txn_dedupe',
    keyColumns: ['txn_dedupe_key'],
    columns: [
      'txn_dedupe_key',
      'sender_user_id',
      'event_type',
      'txn_id',
      'request_fingerprint',
      'terminal_state',
      'created_at',
      'updated_at',
      'result_json',
      'record_json',
    ],
    jsonColumns: ['result_json', 'record_json'],
    jsonFallbacks: { result_json: null, record_json: {} },
    requiredColumns: [
      'txn_dedupe_key',
      'sender_user_id',
      'event_type',
      'txn_id',
      'request_fingerprint',
      'terminal_state',
      'created_at',
      'updated_at',
    ],
    orderBy: 'created_at ASC, txn_dedupe_key ASC',
  }),
});

function mapRuntimeState(row) {
  return row ? {
    singleton: row.singleton,
    schema_version: row.schema_version,
    user_id: row.user_id,
    next_user_stream_pos: row.next_user_stream_pos,
    session_epoch: row.session_epoch,
    updated_at: row.updated_at,
  } : null;
}

function getOrCreateRuntimeState(sql, updatedAt) {
  return mapRuntimeState(ensureSingletonState(sql, {
    tableName: USER_RUNTIME_STATE_TABLE,
    schemaVersion: USER_DO_SCHEMA_VERSION,
    updatedAt,
    defaults: {
      user_id: null,
      next_user_stream_pos: 1,
      session_epoch: 0,
    },
  }));
}

function allocateUserStreamPosWithinTransaction(sql, { updatedAt, userId = null } = {}) {
  const state = getOrCreateRuntimeState(sql, updatedAt);
  if (state.user_id && userId && state.user_id !== userId) {
    throw new Error(`User runtime state is already bound to ${state.user_id}`);
  }
  const allocated = state.next_user_stream_pos;
  sqlRun(
    sql,
    `
      UPDATE ${USER_RUNTIME_STATE_TABLE}
      SET user_id = ?,
          next_user_stream_pos = ?,
          updated_at = ?
      WHERE singleton = 1
    `,
    state.user_id ?? userId ?? null,
    allocated + 1,
    updatedAt,
  );
  return allocated;
}

function createUserPrincipalAccess(sql) {
  return Object.freeze({
    put(record) {
      const existing = mapSqliteRow(
        sqlFirst(sql, 'SELECT * FROM user_principal WHERE singleton = 1'),
        {
          jsonColumns: ['record_json'],
          jsonFallbacks: { record_json: {} },
          booleanColumns: ['password_login_enabled', 'erase_requested_flag'],
        },
      );
      const authVersion = normalizeInteger(record.auth_version ?? 1, 'record.auth_version', { min: 1 });
      if (existing && authVersion < existing.auth_version) {
        throw new RangeError('record.auth_version must not decrease');
      }
      const createdAt = existing?.created_at
        ?? normalizeString(record.created_at ?? record.updated_at ?? new Date().toISOString(), 'record.created_at');
      sqlRun(
        sql,
        `
          INSERT INTO user_principal (
            singleton, user_id, localpart, user_type, password_hash_or_null, password_login_enabled,
            created_at, deactivated_at_or_null, erase_requested_flag, auth_version, registration_source, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            user_id = excluded.user_id,
            localpart = excluded.localpart,
            user_type = excluded.user_type,
            password_hash_or_null = excluded.password_hash_or_null,
            password_login_enabled = excluded.password_login_enabled,
            created_at = user_principal.created_at,
            deactivated_at_or_null = excluded.deactivated_at_or_null,
            erase_requested_flag = excluded.erase_requested_flag,
            auth_version = excluded.auth_version,
            registration_source = excluded.registration_source,
            record_json = excluded.record_json
        `,
        1,
        normalizeString(record.user_id, 'record.user_id'),
        normalizeString(record.localpart, 'record.localpart'),
        record.user_type ?? null,
        record.password_hash_or_null ?? null,
        record.password_login_enabled == null ? 1 : (record.password_login_enabled ? 1 : 0),
        createdAt,
        record.deactivated_at_or_null ?? null,
        record.erase_requested_flag ? 1 : 0,
        authVersion,
        record.registration_source ?? null,
        JSON.stringify(record.record ?? {}),
      );
      return this.get();
    },
    get() {
      return mapSqliteRow(
        sqlFirst(sql, 'SELECT * FROM user_principal WHERE singleton = 1'),
        {
          jsonColumns: ['record_json'],
          jsonFallbacks: { record_json: {} },
          booleanColumns: ['password_login_enabled', 'erase_requested_flag'],
        },
      );
    },
  });
}

function createProfileDocumentAccess(sql) {
  const base = createSqliteTableAccess(sql, USER_TABLES.profileDocument);
  return Object.freeze({
    put(record) {
      const normalizedKeyName = normalizeString(record.key_name, 'record.key_name');
      const normalizedProfileVersion = normalizeInteger(record.profile_version, 'record.profile_version', { min: 1 });
      const existing = base.get({ key_name: normalizedKeyName });
      if (existing && normalizedProfileVersion < existing.profile_version) {
        throw new RangeError('record.profile_version must not decrease');
      }
      return base.put({
        ...record,
        key_name: normalizedKeyName,
        profile_version: normalizedProfileVersion,
      });
    },
    get(key) {
      return base.get(key);
    },
    list() {
      return base.list();
    },
    delete(key) {
      return base.delete(key);
    },
  });
}

export function createUserDurableObjectPersistence(sqlStorage) {
  const sql = requireSqlStorage(sqlStorage);
  const sessions = createSqliteTableAccess(sql, USER_TABLES.sessions);
  const devices = createSqliteTableAccess(sql, USER_TABLES.devices);
  const deviceKeys = createSqliteTableAccess(sql, USER_TABLES.deviceKeys);
  const oneTimeKeys = createSqliteTableAccess(sql, USER_TABLES.oneTimeKeys);
  const fallbackKeys = createSqliteTableAccess(sql, USER_TABLES.fallbackKeys);
  const globalAccountData = createSqliteTableAccess(sql, USER_TABLES.globalAccountData);
  const roomAccountData = createSqliteTableAccess(sql, USER_TABLES.roomAccountData);
  const toDeviceQueue = createSqliteTableAccess(sql, USER_TABLES.toDeviceQueue);
  const presence = createSqliteTableAccess(sql, USER_TABLES.presence);
  const userStream = createSqliteTableAccess(sql, USER_TABLES.userStream);
  const roomKeyBackupManifests = createSqliteTableAccess(sql, USER_TABLES.roomKeyBackupManifests);
  const profileDocument = createProfileDocumentAccess(sql);
  const pushRules = createSqliteTableAccess(sql, USER_TABLES.pushRules);
  const storedFilters = createSqliteTableAccess(sql, USER_TABLES.storedFilters);
  const pendingUploadGrants = createSqliteTableAccess(sql, USER_TABLES.pendingUploadGrants);
  const toDeviceTxnDedupe = createSqliteTableAccess(sql, USER_TABLES.toDeviceTxnDedupe);
  const userPrincipal = createUserPrincipalAccess(sql);

  function appendUserStreamRecord(record) {
    const createdAt = normalizeString(record.created_at ?? new Date().toISOString(), 'record.created_at');
    const streamPos = record.stream_pos == null
      ? allocateUserStreamPosWithinTransaction(sql, {
        updatedAt: createdAt,
        userId: record.user_id ?? null,
      })
      : normalizeInteger(record.stream_pos, 'record.stream_pos', { min: 1 });
    if (record.stream_pos != null && userStream.get(streamPos)) {
      throw new Error(`User stream position ${streamPos} already exists`);
    }
    userStream.put({
      stream_pos: streamPos,
      stream_kind: normalizeString(record.stream_kind, 'record.stream_kind'),
      room_id: record.room_id ?? null,
      event_id: record.event_id ?? null,
      dedupe_key: record.dedupe_key ?? null,
      created_at: createdAt,
      payload_json: record.payload ?? {},
      record_json: record.record ?? {},
    });
    return userStream.get(streamPos);
  }

  function enqueueToDeviceRecord(record) {
    const enqueuedAt = normalizeString(record.enqueued_at ?? new Date().toISOString(), 'record.enqueued_at');
    const streamPos = record.stream_pos ?? allocateUserStreamPosWithinTransaction(sql, {
      updatedAt: enqueuedAt,
      userId: record.user_id ?? null,
    });
    toDeviceQueue.put({
      target_device_id: normalizeString(record.target_device_id, 'record.target_device_id'),
      stream_pos: streamPos,
      sender_user_id: normalizeString(record.sender_user_id, 'record.sender_user_id'),
      event_type: normalizeString(record.event_type, 'record.event_type'),
      enqueued_at: enqueuedAt,
      expires_at: record.expires_at ?? null,
      acknowledged_at: record.acknowledged_at ?? null,
      payload_json: record.payload ?? {},
      record_json: record.record ?? {},
    });
    return toDeviceQueue.get({
      target_device_id: record.target_device_id,
      stream_pos: streamPos,
    });
  }

  return Object.freeze({
    schemaVersion: USER_DO_SCHEMA_VERSION,
    async ensureSchema(now = new Date().toISOString()) {
      sqlRun(sql, USER_DO_SCHEMA_SQL);
      getOrCreateRuntimeState(sql, now);
    },
    async isSchemaReady() {
      const allTablesPresent = USER_REQUIRED_TABLES.every((tableName) => tableExists(sql, tableName));
      if (!allTablesPresent) {
        return false;
      }
      const state = sqlFirst(sql, `SELECT schema_version FROM ${USER_RUNTIME_STATE_TABLE} WHERE singleton = 1`);
      return Boolean(state) && state.schema_version >= USER_DO_SCHEMA_VERSION;
    },
    getRuntimeState() {
      return mapRuntimeState(sqlFirst(sql, `SELECT * FROM ${USER_RUNTIME_STATE_TABLE} WHERE singleton = 1`));
    },
    setRuntimeIdentity({ user_id, updated_at = new Date().toISOString() }) {
      return withSqliteTransaction(sql, () => {
        const state = getOrCreateRuntimeState(sql, updated_at);
        const normalizedUserId = normalizeString(user_id, 'user_id');
        if (state.user_id && state.user_id !== normalizedUserId) {
          throw new Error(`User runtime state is already bound to ${state.user_id}`);
        }
        sqlRun(
          sql,
          `
            UPDATE ${USER_RUNTIME_STATE_TABLE}
            SET user_id = ?, updated_at = ?
            WHERE singleton = 1
          `,
          normalizedUserId,
          updated_at,
        );
        return this.getRuntimeState();
      });
    },
    allocateUserStreamPos({ updated_at = new Date().toISOString(), user_id = null } = {}) {
      return withSqliteTransaction(sql, () => allocateUserStreamPosWithinTransaction(sql, {
        updatedAt: updated_at,
        userId: user_id,
      }));
    },
    bumpSessionEpoch({ updated_at = new Date().toISOString(), user_id = null } = {}) {
      return withSqliteTransaction(sql, () => {
        const state = getOrCreateRuntimeState(sql, updated_at);
        if (state.user_id && user_id && state.user_id !== user_id) {
          throw new Error(`User runtime state is already bound to ${state.user_id}`);
        }
        const nextEpoch = state.session_epoch + 1;
        sqlRun(
          sql,
          `
            UPDATE ${USER_RUNTIME_STATE_TABLE}
            SET user_id = ?,
                session_epoch = ?,
                updated_at = ?
            WHERE singleton = 1
          `,
          state.user_id ?? user_id ?? null,
          nextEpoch,
          updated_at,
        );
        return nextEpoch;
      });
    },
    appendUserStream(record) {
      return withSqliteTransaction(sql, () => appendUserStreamRecord(record));
    },
    appendUserStreamWithinTransaction(record) {
      return appendUserStreamRecord(record);
    },
    listUserStreamSince(streamPos = 0, limit = 100) {
      return sqlAll(
        sql,
        `
          SELECT *
          FROM user_stream
          WHERE stream_pos > ?
          ORDER BY stream_pos ASC
          LIMIT ?
        `,
        normalizeInteger(streamPos, 'streamPos', { min: 0 }),
        normalizeInteger(limit, 'limit', { min: 1 }),
      ).map((row) => mapSqliteRow(row, {
        jsonColumns: ['payload_json', 'record_json'],
        jsonFallbacks: { payload_json: {}, record_json: {} },
      }));
    },
    enqueueToDevice(record) {
      return withSqliteTransaction(sql, () => enqueueToDeviceRecord(record));
    },
    enqueueToDeviceWithinTransaction(record) {
      return enqueueToDeviceRecord(record);
    },
    listToDeviceForDevice(targetDeviceId, { after_stream_pos = 0, limit = 100 } = {}) {
      return sqlAll(
        sql,
        `
          SELECT *
          FROM user_to_device_queue
          WHERE target_device_id = ?
            AND stream_pos > ?
            AND acknowledged_at IS NULL
          ORDER BY stream_pos ASC
          LIMIT ?
        `,
        normalizeString(targetDeviceId, 'targetDeviceId'),
        normalizeInteger(after_stream_pos, 'after_stream_pos', { min: 0 }),
        normalizeInteger(limit, 'limit', { min: 1 }),
      ).map((row) => mapSqliteRow(row, {
        jsonColumns: ['payload_json', 'record_json'],
        jsonFallbacks: { payload_json: {}, record_json: {} },
      }));
    },
    acknowledgeToDevice(targetDeviceId, streamPos, acknowledgedAt = new Date().toISOString()) {
      sqlRun(
        sql,
        `
          UPDATE user_to_device_queue
          SET acknowledged_at = ?
          WHERE target_device_id = ?
            AND stream_pos = ?
        `,
        normalizeString(acknowledgedAt, 'acknowledgedAt'),
        normalizeString(targetDeviceId, 'targetDeviceId'),
        normalizeInteger(streamPos, 'streamPos', { min: 1 }),
      );
      return toDeviceQueue.get({
        target_device_id: targetDeviceId,
        stream_pos: streamPos,
      });
    },
    claimOneTimeKey({ device_id, algorithm, key_id, claimed_at = new Date().toISOString(), claim_context = null } = {}) {
      return withSqliteTransaction(sql, () => claimOneTimeKeyRecord({
        device_id,
        algorithm,
        key_id,
        claimed_at,
        claim_context,
      }));
    },
    claimOneTimeKeyWithinTransaction({ device_id, algorithm, key_id, claimed_at = new Date().toISOString(), claim_context = null } = {}) {
      return claimOneTimeKeyRecord({
        device_id,
        algorithm,
        key_id,
        claimed_at,
        claim_context,
      });
    },
    userPrincipal,
    sessions,
    devices,
    deviceKeys,
    oneTimeKeys,
    fallbackKeys,
    globalAccountData,
    roomAccountData,
    toDeviceQueue,
    presence,
    userStream,
    roomKeyBackupManifests,
    profileDocument,
    pushRules,
    storedFilters,
    pendingUploadGrants,
    toDeviceTxnDedupe,
  });

  function claimOneTimeKeyRecord({ device_id, algorithm, key_id, claimed_at, claim_context }) {
    const existing = oneTimeKeys.get({ device_id, algorithm, key_id });
    if (!existing || existing.claimed_at) {
      return null;
    }
    oneTimeKeys.put({
      device_id,
      algorithm,
      key_id,
      published_at: existing.published_at,
      claimed_at: normalizeString(claimed_at, 'claimed_at'),
      claim_context_json: claim_context,
      record_json: existing.record ?? {},
    });
    return oneTimeKeys.get({ device_id, algorithm, key_id });
  }
}
