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

export const ROOM_DO_SCHEMA_VERSION = 1;

const ROOM_RUNTIME_STATE_TABLE = 'room_runtime_state';
const ROOM_REQUIRED_TABLES = Object.freeze([
  ROOM_RUNTIME_STATE_TABLE,
  'room_events_metadata',
  'room_hot_event_json',
  'room_prev_edges',
  'room_auth_edges',
  'room_state_snapshots',
  'room_state_entries',
  'room_membership_projection',
  'room_forward_extremities',
  'room_receipts_current',
  'room_typing_current',
  'room_fanout_outbox',
  'room_client_txn_dedupe',
]);

export const ROOM_DO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS room_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  room_id TEXT,
  room_version TEXT,
  next_room_pos INTEGER NOT NULL DEFAULT 1,
  current_snapshot_id TEXT,
  current_snapshot_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_events_metadata (
  event_id TEXT PRIMARY KEY,
  room_pos INTEGER NOT NULL UNIQUE,
  origin_server_ts INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  archive_object_key_or_segment_id TEXT,
  archive_offset_or_index INTEGER,
  event_type TEXT NOT NULL,
  state_key_or_null TEXT,
  sender_user_id TEXT NOT NULL,
  contains_url_flag INTEGER NOT NULL DEFAULT 0,
  soft_failed_flag INTEGER NOT NULL DEFAULT 0,
  waiting_missing_flag INTEGER NOT NULL DEFAULT 0,
  redacts_event_id_or_null TEXT,
  membership_target_user_id_or_null TEXT,
  history_visibility_class TEXT,
  membership_visibility_class TEXT,
  relates_to_event_id_or_null TEXT,
  relation_type_or_null TEXT,
  aggregation_event_type_or_null TEXT,
  thread_root_event_id_or_null TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_events_metadata_room_pos
  ON room_events_metadata (room_pos);
CREATE INDEX IF NOT EXISTS idx_room_events_metadata_timestamp_room_pos
  ON room_events_metadata (origin_server_ts, room_pos);
CREATE INDEX IF NOT EXISTS idx_room_events_metadata_relations
  ON room_events_metadata (
    relates_to_event_id_or_null,
    relation_type_or_null,
    aggregation_event_type_or_null,
    room_pos
  );
CREATE INDEX IF NOT EXISTS idx_room_events_metadata_threads
  ON room_events_metadata (thread_root_event_id_or_null, room_pos);
CREATE INDEX IF NOT EXISTS idx_room_events_metadata_membership_target
  ON room_events_metadata (membership_target_user_id_or_null, room_pos);

CREATE TABLE IF NOT EXISTS room_hot_event_json (
  event_id TEXT PRIMARY KEY,
  content_hash TEXT,
  stored_at TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS room_prev_edges (
  event_id TEXT NOT NULL,
  prev_event_id TEXT NOT NULL,
  record_json TEXT,
  PRIMARY KEY (event_id, prev_event_id)
);

CREATE TABLE IF NOT EXISTS room_auth_edges (
  event_id TEXT NOT NULL,
  auth_event_id TEXT NOT NULL,
  record_json TEXT,
  PRIMARY KEY (event_id, auth_event_id)
);

CREATE TABLE IF NOT EXISTS room_state_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  snapshot_hash TEXT,
  extremity_set_hash TEXT,
  created_at TEXT NOT NULL,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS room_state_entries (
  snapshot_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sender_user_id TEXT,
  membership TEXT,
  event_room_pos INTEGER,
  content_json TEXT,
  record_json TEXT,
  PRIMARY KEY (snapshot_id, event_type, state_key)
);
CREATE INDEX IF NOT EXISTS idx_room_state_entries_event_id
  ON room_state_entries (event_id);

CREATE TABLE IF NOT EXISTS room_membership_projection (
  user_id TEXT PRIMARY KEY,
  membership TEXT NOT NULL,
  event_id TEXT NOT NULL,
  room_pos INTEGER NOT NULL,
  displayname TEXT,
  avatar_url TEXT,
  profile_version INTEGER,
  membership_visibility_class TEXT,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_membership_projection_membership
  ON room_membership_projection (membership, room_pos, user_id);

CREATE TABLE IF NOT EXISTS room_forward_extremities (
  event_id TEXT PRIMARY KEY,
  room_pos INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS room_receipts_current (
  receipt_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL,
  room_pos INTEGER,
  receipt_ts INTEGER,
  updated_at TEXT NOT NULL,
  record_json TEXT,
  PRIMARY KEY (receipt_type, user_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_room_receipts_current_event
  ON room_receipts_current (event_id, updated_at);

CREATE TABLE IF NOT EXISTS room_typing_current (
  user_id TEXT PRIMARY KEY,
  typing INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_typing_current_expires_at
  ON room_typing_current (expires_at, user_id);

CREATE TABLE IF NOT EXISTS room_fanout_outbox (
  room_pos INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  event_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  acked_stream_pos INTEGER,
  acked_at TEXT,
  delta_json TEXT,
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  record_json TEXT,
  PRIMARY KEY (room_pos, user_id)
);
CREATE INDEX IF NOT EXISTS idx_room_fanout_outbox_status
  ON room_fanout_outbox (status, room_pos, user_id);

CREATE TABLE IF NOT EXISTS room_client_txn_dedupe (
  txn_dedupe_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  route_template TEXT NOT NULL,
  txn_id_or_request_hash TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  terminal_state TEXT NOT NULL,
  result_event_id TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_room_client_txn_dedupe_public_key
  ON room_client_txn_dedupe (user_id, device_id, room_id, route_template, txn_id_or_request_hash);
`;

const ROOM_TABLES = Object.freeze({
  eventMetadata: Object.freeze({
    tableName: 'room_events_metadata',
    keyColumns: ['event_id'],
    columns: [
      'event_id',
      'room_pos',
      'origin_server_ts',
      'depth',
      'archive_object_key_or_segment_id',
      'archive_offset_or_index',
      'event_type',
      'state_key_or_null',
      'sender_user_id',
      'contains_url_flag',
      'soft_failed_flag',
      'waiting_missing_flag',
      'redacts_event_id_or_null',
      'membership_target_user_id_or_null',
      'history_visibility_class',
      'membership_visibility_class',
      'relates_to_event_id_or_null',
      'relation_type_or_null',
      'aggregation_event_type_or_null',
      'thread_root_event_id_or_null',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    booleanColumns: ['contains_url_flag', 'soft_failed_flag', 'waiting_missing_flag'],
    orderBy: 'room_pos ASC',
  }),
  hotEventJson: Object.freeze({
    tableName: 'room_hot_event_json',
    keyColumns: ['event_id'],
    columns: ['event_id', 'content_hash', 'stored_at', 'canonical_json', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'stored_at ASC, event_id ASC',
  }),
  prevEdges: Object.freeze({
    tableName: 'room_prev_edges',
    keyColumns: ['event_id', 'prev_event_id'],
    columns: ['event_id', 'prev_event_id', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'event_id ASC, prev_event_id ASC',
  }),
  authEdges: Object.freeze({
    tableName: 'room_auth_edges',
    keyColumns: ['event_id', 'auth_event_id'],
    columns: ['event_id', 'auth_event_id', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'event_id ASC, auth_event_id ASC',
  }),
  stateSnapshots: Object.freeze({
    tableName: 'room_state_snapshots',
    keyColumns: ['snapshot_id'],
    columns: ['snapshot_id', 'snapshot_hash', 'extremity_set_hash', 'created_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'created_at ASC, snapshot_id ASC',
  }),
  stateEntries: Object.freeze({
    tableName: 'room_state_entries',
    keyColumns: ['snapshot_id', 'event_type', 'state_key'],
    columns: ['snapshot_id', 'event_type', 'state_key', 'event_id', 'sender_user_id', 'membership', 'event_room_pos', 'content_json', 'record_json'],
    jsonColumns: ['content_json', 'record_json'],
    jsonFallbacks: { content_json: {}, record_json: {} },
    orderBy: 'snapshot_id ASC, event_type ASC, state_key ASC',
  }),
  membershipProjection: Object.freeze({
    tableName: 'room_membership_projection',
    keyColumns: ['user_id'],
    columns: [
      'user_id',
      'membership',
      'event_id',
      'room_pos',
      'displayname',
      'avatar_url',
      'profile_version',
      'membership_visibility_class',
      'updated_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'room_pos ASC, user_id ASC',
  }),
  forwardExtremities: Object.freeze({
    tableName: 'room_forward_extremities',
    keyColumns: ['event_id'],
    columns: ['event_id', 'room_pos', 'updated_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'room_pos ASC, event_id ASC',
  }),
  fanoutOutbox: Object.freeze({
    tableName: 'room_fanout_outbox',
    keyColumns: ['room_pos', 'user_id'],
    columns: [
      'room_pos',
      'user_id',
      'event_id',
      'status',
      'last_attempt_at',
      'attempt_count',
      'acked_stream_pos',
      'acked_at',
      'delta_json',
      'last_error_json',
      'created_at',
      'record_json',
    ],
    jsonColumns: ['delta_json', 'last_error_json', 'record_json'],
    jsonFallbacks: { delta_json: {}, last_error_json: null, record_json: {} },
    orderBy: 'room_pos ASC, user_id ASC',
  }),
  clientTxnDedupe: Object.freeze({
    tableName: 'room_client_txn_dedupe',
    keyColumns: ['txn_dedupe_key'],
    columns: [
      'txn_dedupe_key',
      'user_id',
      'device_id',
      'room_id',
      'route_template',
      'txn_id_or_request_hash',
      'request_fingerprint',
      'terminal_state',
      'result_event_id',
      'error_json',
      'created_at',
      'updated_at',
      'record_json',
    ],
    jsonColumns: ['error_json', 'record_json'],
    jsonFallbacks: { error_json: null, record_json: {} },
    requiredColumns: [
      'txn_dedupe_key',
      'user_id',
      'device_id',
      'room_id',
      'route_template',
      'txn_id_or_request_hash',
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
    room_id: row.room_id,
    room_version: row.room_version,
    next_room_pos: row.next_room_pos,
    current_snapshot_id: row.current_snapshot_id,
    current_snapshot_hash: row.current_snapshot_hash,
    updated_at: row.updated_at,
  } : null;
}

function getOrCreateRuntimeState(sql, updatedAt) {
  return mapRuntimeState(ensureSingletonState(sql, {
    tableName: ROOM_RUNTIME_STATE_TABLE,
    schemaVersion: ROOM_DO_SCHEMA_VERSION,
    updatedAt,
    defaults: {
      room_id: null,
      room_version: null,
      next_room_pos: 1,
      current_snapshot_id: null,
      current_snapshot_hash: null,
    },
  }));
}

function allocateRoomPosWithinTransaction(sql, { updatedAt, roomId = null, roomVersion = null } = {}) {
  const state = getOrCreateRuntimeState(sql, updatedAt);
  if (state.room_id && roomId && state.room_id !== roomId) {
    throw new Error(`Room runtime state is already bound to ${state.room_id}`);
  }
  const allocated = state.next_room_pos;
  sqlRun(
    sql,
    `
      UPDATE ${ROOM_RUNTIME_STATE_TABLE}
      SET room_id = ?,
          room_version = COALESCE(room_version, ?),
          next_room_pos = ?,
          updated_at = ?
      WHERE singleton = 1
    `,
    state.room_id ?? roomId ?? null,
    roomVersion ?? null,
    allocated + 1,
    updatedAt,
  );
  return allocated;
}

function createReceiptAccess(sql) {
  const base = createSqliteTableAccess(sql, {
    tableName: 'room_receipts_current',
    keyColumns: ['receipt_type', 'user_id', 'thread_id'],
    columns: ['receipt_type', 'user_id', 'thread_id', 'event_id', 'room_pos', 'receipt_ts', 'updated_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    requiredColumns: ['receipt_type', 'user_id', 'event_id', 'updated_at'],
    orderBy: 'updated_at ASC, receipt_type ASC, user_id ASC, thread_id ASC',
  });
  return Object.freeze({
    put(record) {
      return base.put({
        ...record,
        thread_id: record.thread_id ?? '',
      });
    },
    get(key) {
      const row = base.get({
        ...key,
        thread_id: key.thread_id ?? '',
      });
      return row ? {
        ...row,
        thread_id: row.thread_id === '' ? null : row.thread_id,
      } : null;
    },
    list() {
      return base.list().map((row) => ({
        ...row,
        thread_id: row.thread_id === '' ? null : row.thread_id,
      }));
    },
    delete(key) {
      base.delete({
        ...key,
        thread_id: key.thread_id ?? '',
      });
    },
  });
}

function createTypingAccess(sql) {
  return createSqliteTableAccess(sql, {
    tableName: 'room_typing_current',
    keyColumns: ['user_id'],
    columns: ['user_id', 'typing', 'expires_at', 'updated_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    booleanColumns: ['typing'],
    orderBy: 'expires_at ASC, user_id ASC',
  });
}

export function createRoomDurableObjectPersistence(sqlStorage) {
  const sql = requireSqlStorage(sqlStorage);
  const eventMetadata = createSqliteTableAccess(sql, ROOM_TABLES.eventMetadata);
  const hotEventJson = createSqliteTableAccess(sql, ROOM_TABLES.hotEventJson);
  const prevEdges = createSqliteTableAccess(sql, ROOM_TABLES.prevEdges);
  const authEdges = createSqliteTableAccess(sql, ROOM_TABLES.authEdges);
  const stateSnapshots = createSqliteTableAccess(sql, ROOM_TABLES.stateSnapshots);
  const stateEntries = createSqliteTableAccess(sql, ROOM_TABLES.stateEntries);
  const membershipProjection = createSqliteTableAccess(sql, ROOM_TABLES.membershipProjection);
  const forwardExtremities = createSqliteTableAccess(sql, ROOM_TABLES.forwardExtremities);
  const receipts = createReceiptAccess(sql);
  const typing = createTypingAccess(sql);
  const fanoutOutbox = createSqliteTableAccess(sql, ROOM_TABLES.fanoutOutbox);
  const clientTxnDedupe = createSqliteTableAccess(sql, ROOM_TABLES.clientTxnDedupe);

  return Object.freeze({
    schemaVersion: ROOM_DO_SCHEMA_VERSION,
    async ensureSchema(now = new Date().toISOString()) {
      sqlRun(sql, ROOM_DO_SCHEMA_SQL);
      getOrCreateRuntimeState(sql, now);
    },
    async isSchemaReady() {
      const allTablesPresent = ROOM_REQUIRED_TABLES.every((tableName) => tableExists(sql, tableName));
      if (!allTablesPresent) {
        return false;
      }
      const state = sqlFirst(sql, `SELECT schema_version FROM ${ROOM_RUNTIME_STATE_TABLE} WHERE singleton = 1`);
      return Boolean(state) && state.schema_version >= ROOM_DO_SCHEMA_VERSION;
    },
    getRuntimeState() {
      return mapRuntimeState(sqlFirst(sql, `SELECT * FROM ${ROOM_RUNTIME_STATE_TABLE} WHERE singleton = 1`));
    },
    setRuntimeIdentity({ room_id, room_version = null, updated_at = new Date().toISOString() }) {
      return withSqliteTransaction(sql, () => {
        const state = getOrCreateRuntimeState(sql, updated_at);
        const normalizedRoomId = normalizeString(room_id, 'room_id');
        if (state.room_id && state.room_id !== normalizedRoomId) {
          throw new Error(`Room runtime state is already bound to ${state.room_id}`);
        }
        sqlRun(
          sql,
          `
            UPDATE ${ROOM_RUNTIME_STATE_TABLE}
            SET room_id = ?,
                room_version = COALESCE(room_version, ?),
                updated_at = ?
            WHERE singleton = 1
          `,
          normalizedRoomId,
          room_version ?? null,
          updated_at,
        );
        return this.getRuntimeState();
      });
    },
    updateCurrentSnapshot({ snapshot_id, snapshot_hash = null, updated_at = new Date().toISOString() }) {
      sqlRun(
        sql,
        `
          UPDATE ${ROOM_RUNTIME_STATE_TABLE}
          SET current_snapshot_id = ?,
              current_snapshot_hash = ?,
              updated_at = ?
          WHERE singleton = 1
        `,
        snapshot_id,
        snapshot_hash,
        normalizeString(updated_at, 'updated_at'),
      );
      return this.getRuntimeState();
    },
    allocateRoomPos({ updated_at = new Date().toISOString(), room_id = null, room_version = null } = {}) {
      return withSqliteTransaction(sql, () => allocateRoomPosWithinTransaction(sql, {
        updatedAt: updated_at,
        roomId: room_id,
        roomVersion: room_version,
      }));
    },
    appendEventMetadata(record) {
      return withSqliteTransaction(sql, () => {
        const roomPos = record.room_pos ?? allocateRoomPosWithinTransaction(sql, {
          updatedAt: record.record?.updated_at ?? record.stored_at ?? new Date().toISOString(),
          roomId: record.room_id ?? null,
          roomVersion: record.room_version ?? null,
        });
        eventMetadata.put({
          event_id: normalizeString(record.event_id, 'record.event_id'),
          room_pos: roomPos,
          origin_server_ts: normalizeInteger(record.origin_server_ts, 'record.origin_server_ts', { min: 0 }),
          depth: normalizeInteger(record.depth, 'record.depth', { min: 0 }),
          archive_object_key_or_segment_id: record.archive_object_key_or_segment_id ?? null,
          archive_offset_or_index: record.archive_offset_or_index ?? null,
          event_type: normalizeString(record.event_type, 'record.event_type'),
          state_key_or_null: record.state_key_or_null ?? null,
          sender_user_id: normalizeString(record.sender_user_id, 'record.sender_user_id'),
          contains_url_flag: Boolean(record.contains_url_flag),
          soft_failed_flag: Boolean(record.soft_failed_flag),
          waiting_missing_flag: Boolean(record.waiting_missing_flag),
          redacts_event_id_or_null: record.redacts_event_id_or_null ?? null,
          membership_target_user_id_or_null: record.membership_target_user_id_or_null ?? null,
          history_visibility_class: record.history_visibility_class ?? null,
          membership_visibility_class: record.membership_visibility_class ?? null,
          relates_to_event_id_or_null: record.relates_to_event_id_or_null ?? null,
          relation_type_or_null: record.relation_type_or_null ?? null,
          aggregation_event_type_or_null: record.aggregation_event_type_or_null ?? null,
          thread_root_event_id_or_null: record.thread_root_event_id_or_null ?? null,
          record_json: record.record ?? {},
        });
        return eventMetadata.get(record.event_id);
      });
    },
    getEventMetadataByRoomPos(roomPos) {
      return mapSqliteRow(
        sqlFirst(sql, 'SELECT * FROM room_events_metadata WHERE room_pos = ?', normalizeInteger(roomPos, 'roomPos', { min: 1 })),
        {
          jsonColumns: ['record_json'],
          jsonFallbacks: { record_json: {} },
          booleanColumns: ['contains_url_flag', 'soft_failed_flag', 'waiting_missing_flag'],
        },
      );
    },
    listPendingFanoutOutbox(limit = 100) {
      return sqlAll(
        sql,
        `
          SELECT *
          FROM room_fanout_outbox
          WHERE status != 'acked'
          ORDER BY room_pos ASC, user_id ASC
          LIMIT ?
        `,
        normalizeInteger(limit, 'limit', { min: 1 }),
      ).map((row) => mapSqliteRow(row, {
        jsonColumns: ['delta_json', 'last_error_json', 'record_json'],
        jsonFallbacks: { delta_json: {}, last_error_json: null, record_json: {} },
      }));
    },
    acknowledgeFanoutOutbox({ room_pos, user_id, acked_stream_pos, acked_at = new Date().toISOString() }) {
      sqlRun(
        sql,
        `
          UPDATE room_fanout_outbox
          SET status = 'acked',
              acked_stream_pos = ?,
              acked_at = ?
          WHERE room_pos = ?
            AND user_id = ?
        `,
        acked_stream_pos ?? null,
        normalizeString(acked_at, 'acked_at'),
        normalizeInteger(room_pos, 'room_pos', { min: 1 }),
        normalizeString(user_id, 'user_id'),
      );
      return fanoutOutbox.get({ room_pos, user_id });
    },
    eventMetadata,
    hotEventJson,
    prevEdges,
    authEdges,
    stateSnapshots,
    stateEntries,
    membershipProjection,
    forwardExtremities,
    receipts,
    typing,
    fanoutOutbox,
    clientTxnDedupe,
  });
}
