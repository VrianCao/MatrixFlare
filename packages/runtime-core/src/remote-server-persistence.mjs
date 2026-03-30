import {
  canonicalizeJsonValue,
} from './canonical-json.mjs';
import {
  createSqliteTableAccess,
  ensureSingletonState,
  mapSqliteRow,
  normalizeInteger,
  normalizeString,
  requireSqlStorage,
  sqlFirst,
  sqlRun,
  tableExists,
  withSqliteTransaction,
} from './persistence-common.mjs';

export const REMOTE_SERVER_DO_SCHEMA_VERSION = 1;
const REMOTE_INBOUND_TXN_MARKER_STATES = Object.freeze(['in_progress', 'finalized', 'conflict']);

const REMOTE_SERVER_RUNTIME_STATE_TABLE = 'remote_server_runtime_state';
const REMOTE_SERVER_REQUIRED_TABLES = Object.freeze([
  REMOTE_SERVER_RUNTIME_STATE_TABLE,
  'remote_outbound_transactions',
  'remote_retry_schedule',
  'remote_inbound_txn_markers',
  'remote_gap_repair_backlog',
  'remote_cache_entries',
  'remote_inbound_txn_results',
]);

export const REMOTE_SERVER_DO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS remote_server_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  server_name TEXT,
  next_txn_sequence INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_outbound_transactions (
  txn_id TEXT PRIMARY KEY,
  txn_sequence INTEGER NOT NULL UNIQUE,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  acknowledged_at TEXT,
  payload_json TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_outbound_transactions_sequence
  ON remote_outbound_transactions (txn_sequence, acknowledged_at);

CREATE TABLE IF NOT EXISTS remote_retry_schedule (
  txn_id TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_at TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_retry_schedule_next_retry
  ON remote_retry_schedule (next_retry_at, txn_id);

CREATE TABLE IF NOT EXISTS remote_inbound_txn_markers (
  origin TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  dedupe_request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'finalized', 'conflict')),
  first_seen_at TEXT NOT NULL,
  finalized_at TEXT,
  conflict_reason TEXT,
  record_json TEXT,
  PRIMARY KEY (origin, txn_id)
);
CREATE INDEX IF NOT EXISTS idx_remote_inbound_txn_markers_state
  ON remote_inbound_txn_markers (state, first_seen_at);

CREATE TABLE IF NOT EXISTS remote_gap_repair_backlog (
  repair_job_id TEXT PRIMARY KEY,
  room_id TEXT,
  missing_kind TEXT NOT NULL,
  trigger_event_id TEXT,
  state TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT
);

CREATE TABLE IF NOT EXISTS remote_cache_entries (
  cache_key TEXT PRIMARY KEY,
  cache_kind TEXT NOT NULL,
  key_id TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT,
  etag TEXT,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_cache_entries_kind
  ON remote_cache_entries (cache_kind, key_id, expires_at);

CREATE TABLE IF NOT EXISTS remote_inbound_txn_results (
  origin TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  dedupe_request_hash TEXT NOT NULL,
  canonical_response_text TEXT NOT NULL,
  canonical_response_bytes_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pdu_results_json TEXT,
  record_json TEXT,
  PRIMARY KEY (origin, txn_id)
);
`;

const REMOTE_SERVER_TABLES = Object.freeze({
  outboundTransactions: Object.freeze({
    tableName: 'remote_outbound_transactions',
    keyColumns: ['txn_id'],
    columns: ['txn_id', 'txn_sequence', 'payload_hash', 'created_at', 'dispatched_at', 'acknowledged_at', 'payload_json', 'record_json'],
    jsonColumns: ['payload_json', 'record_json'],
    jsonFallbacks: { payload_json: {}, record_json: {} },
    orderBy: 'txn_sequence ASC, txn_id ASC',
  }),
  retrySchedule: Object.freeze({
    tableName: 'remote_retry_schedule',
    keyColumns: ['txn_id'],
    columns: ['txn_id', 'attempt_count', 'next_retry_at', 'last_error_code', 'last_error_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'next_retry_at ASC, txn_id ASC',
  }),
  inboundMarkers: Object.freeze({
    tableName: 'remote_inbound_txn_markers',
    keyColumns: ['origin', 'txn_id'],
    columns: ['origin', 'txn_id', 'dedupe_request_hash', 'state', 'first_seen_at', 'finalized_at', 'conflict_reason', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'first_seen_at ASC, origin ASC, txn_id ASC',
  }),
  gapRepairBacklog: Object.freeze({
    tableName: 'remote_gap_repair_backlog',
    keyColumns: ['repair_job_id'],
    columns: ['repair_job_id', 'room_id', 'missing_kind', 'trigger_event_id', 'state', 'scheduled_at', 'updated_at', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'scheduled_at ASC, repair_job_id ASC',
  }),
  cacheEntries: Object.freeze({
    tableName: 'remote_cache_entries',
    keyColumns: ['cache_key'],
    columns: ['cache_key', 'cache_kind', 'key_id', 'fetched_at', 'expires_at', 'etag', 'record_json'],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'cache_kind ASC, key_id ASC, cache_key ASC',
  }),
  inboundResults: Object.freeze({
    tableName: 'remote_inbound_txn_results',
    keyColumns: ['origin', 'txn_id'],
    columns: [
      'origin',
      'txn_id',
      'dedupe_request_hash',
      'canonical_response_text',
      'canonical_response_bytes_base64',
      'created_at',
      'pdu_results_json',
      'record_json',
    ],
    jsonColumns: ['pdu_results_json', 'record_json'],
    jsonFallbacks: { pdu_results_json: {}, record_json: {} },
    orderBy: 'created_at ASC, origin ASC, txn_id ASC',
  }),
});

function mapRuntimeState(row) {
  return row ? {
    singleton: row.singleton,
    schema_version: row.schema_version,
    server_name: row.server_name,
    next_txn_sequence: row.next_txn_sequence,
    updated_at: row.updated_at,
  } : null;
}

function getOrCreateRuntimeState(sql, updatedAt) {
  return mapRuntimeState(ensureSingletonState(sql, {
    tableName: REMOTE_SERVER_RUNTIME_STATE_TABLE,
    schemaVersion: REMOTE_SERVER_DO_SCHEMA_VERSION,
    updatedAt,
    defaults: {
      server_name: null,
      next_txn_sequence: 1,
    },
  }));
}

function allocateOutboundTxnSequenceWithinTransaction(sql, { updatedAt, serverName = null } = {}) {
  const state = getOrCreateRuntimeState(sql, updatedAt);
  if (state.server_name && serverName && state.server_name !== serverName) {
    throw new Error(`RemoteServer runtime state is already bound to ${state.server_name}`);
  }
  const allocated = state.next_txn_sequence;
  sqlRun(
    sql,
    `
      UPDATE ${REMOTE_SERVER_RUNTIME_STATE_TABLE}
      SET server_name = ?,
          next_txn_sequence = ?,
          updated_at = ?
      WHERE singleton = 1
    `,
    state.server_name ?? serverName ?? null,
    allocated + 1,
    updatedAt,
  );
  return allocated;
}

function buildCacheKey(cacheKind, keyId = null) {
  const normalizedCacheKind = normalizeString(cacheKind, 'cacheKind');
  const normalizedKeyId = keyId == null ? null : normalizeString(keyId, 'keyId');
  if (normalizedCacheKind === 'server-key' && normalizedKeyId == null) {
    throw new TypeError('keyId must be present when cacheKind is server-key');
  }
  return `${normalizedCacheKind}:${normalizedKeyId ?? 'singleton'}`;
}

function normalizeInboundTxnMarkerState(value, label = 'state') {
  const normalizedState = normalizeString(value, label);
  if (!REMOTE_INBOUND_TXN_MARKER_STATES.includes(normalizedState)) {
    throw new RangeError(`${label} must be one of ${REMOTE_INBOUND_TXN_MARKER_STATES.join(', ')}`);
  }
  return normalizedState;
}

export function createRemoteServerDurableObjectPersistence(sqlStorage) {
  const sql = requireSqlStorage(sqlStorage);
  const outboundTransactions = createSqliteTableAccess(sql, REMOTE_SERVER_TABLES.outboundTransactions);
  const retrySchedule = createSqliteTableAccess(sql, REMOTE_SERVER_TABLES.retrySchedule);
  const inboundMarkers = createSqliteTableAccess(sql, REMOTE_SERVER_TABLES.inboundMarkers);
  const gapRepairBacklog = createSqliteTableAccess(sql, REMOTE_SERVER_TABLES.gapRepairBacklog);
  const cacheEntries = createSqliteTableAccess(sql, REMOTE_SERVER_TABLES.cacheEntries);
  const inboundResults = createSqliteTableAccess(sql, REMOTE_SERVER_TABLES.inboundResults);

  return Object.freeze({
    schemaVersion: REMOTE_SERVER_DO_SCHEMA_VERSION,
    async ensureSchema(now = new Date().toISOString()) {
      sqlRun(sql, REMOTE_SERVER_DO_SCHEMA_SQL);
      getOrCreateRuntimeState(sql, now);
    },
    async isSchemaReady() {
      const allTablesPresent = REMOTE_SERVER_REQUIRED_TABLES.every((tableName) => tableExists(sql, tableName));
      if (!allTablesPresent) {
        return false;
      }
      const state = sqlFirst(sql, `SELECT schema_version FROM ${REMOTE_SERVER_RUNTIME_STATE_TABLE} WHERE singleton = 1`);
      return Boolean(state) && state.schema_version >= REMOTE_SERVER_DO_SCHEMA_VERSION;
    },
    getRuntimeState() {
      return mapRuntimeState(sqlFirst(sql, `SELECT * FROM ${REMOTE_SERVER_RUNTIME_STATE_TABLE} WHERE singleton = 1`));
    },
    setRuntimeIdentity({ server_name, updated_at = new Date().toISOString() }) {
      return withSqliteTransaction(sql, () => {
        const state = getOrCreateRuntimeState(sql, updated_at);
        const normalizedServerName = normalizeString(server_name, 'server_name');
        if (state.server_name && state.server_name !== normalizedServerName) {
          throw new Error(`RemoteServer runtime state is already bound to ${state.server_name}`);
        }
        sqlRun(
          sql,
          `
            UPDATE ${REMOTE_SERVER_RUNTIME_STATE_TABLE}
            SET server_name = ?, updated_at = ?
            WHERE singleton = 1
          `,
          normalizedServerName,
          updated_at,
        );
        return this.getRuntimeState();
      });
    },
    allocateOutboundTxnSequence({ updated_at = new Date().toISOString(), server_name = null } = {}) {
      return withSqliteTransaction(sql, () => allocateOutboundTxnSequenceWithinTransaction(sql, {
        updatedAt: updated_at,
        serverName: server_name,
      }));
    },
    enqueueOutboundTransaction(record) {
      return withSqliteTransaction(sql, () => {
        const createdAt = normalizeString(record.created_at ?? new Date().toISOString(), 'record.created_at');
        const normalizedTxnId = normalizeString(record.txn_id, 'record.txn_id');
        const normalizedPayload = record.payload ?? {};
        const normalizedPayloadHash = record.payload_hash ?? null;
        const existing = outboundTransactions.get(normalizedTxnId);
        if (existing) {
          const samePayload = canonicalizeJsonValue(existing.payload ?? {}) === canonicalizeJsonValue(normalizedPayload);
          const samePayloadHash = (existing.payload_hash ?? null) === normalizedPayloadHash;
          if (!samePayload || !samePayloadHash) {
            throw new Error(`Outbound txn ${normalizedTxnId} payload is immutable once queued`);
          }
          return existing;
        }
        const txnSequence = record.txn_sequence ?? allocateOutboundTxnSequenceWithinTransaction(sql, {
          updatedAt: createdAt,
          serverName: record.server_name ?? null,
        });
        outboundTransactions.put({
          txn_id: normalizedTxnId,
          txn_sequence: txnSequence,
          payload_hash: normalizedPayloadHash,
          created_at: createdAt,
          dispatched_at: record.dispatched_at ?? null,
          acknowledged_at: record.acknowledged_at ?? null,
          payload_json: normalizedPayload,
          record_json: record.record ?? {},
        });
        return outboundTransactions.get(normalizedTxnId);
      });
    },
    putInboundTxnMarker(record) {
      return inboundMarkers.put({
        origin: normalizeString(record.origin, 'record.origin'),
        txn_id: normalizeString(record.txn_id, 'record.txn_id'),
        dedupe_request_hash: normalizeString(record.dedupe_request_hash, 'record.dedupe_request_hash'),
        state: normalizeInboundTxnMarkerState(record.state ?? 'in_progress'),
        first_seen_at: normalizeString(record.first_seen_at ?? new Date().toISOString(), 'record.first_seen_at'),
        finalized_at: record.finalized_at ?? null,
        conflict_reason: record.conflict_reason ?? null,
        record_json: record.record ?? {},
      });
    },
    markInboundTxnConflict({ origin, txn_id, dedupe_request_hash, conflict_reason, finalized_at = new Date().toISOString(), record = null }) {
      return withSqliteTransaction(sql, () => {
        const existingMarker = inboundMarkers.get({ origin, txn_id });
        if (!existingMarker) {
          throw new Error(`Inbound txn marker ${origin}/${txn_id} must exist before conflict is recorded`);
        }
        if (existingMarker.state === 'finalized') {
          throw new Error(`Inbound txn ${origin}/${txn_id} is already finalized and cannot be rewritten as conflict`);
        }
        const conflictingHash = normalizeString(dedupe_request_hash, 'dedupe_request_hash');
        if (existingMarker.dedupe_request_hash === conflictingHash) {
          throw new Error(`Inbound txn ${origin}/${txn_id} conflict hash must differ from the original dedupe_request_hash`);
        }
        return inboundMarkers.put({
          origin,
          txn_id,
          dedupe_request_hash: existingMarker.dedupe_request_hash,
          state: 'conflict',
          first_seen_at: existingMarker.first_seen_at,
          finalized_at: normalizeString(finalized_at, 'finalized_at'),
          conflict_reason: normalizeString(conflict_reason, 'conflict_reason'),
          record_json: record ?? existingMarker.record ?? {},
        });
      });
    },
    finalizeInboundTxn({
      origin,
      txn_id,
      dedupe_request_hash,
      canonical_response_text,
      canonical_response_bytes_base64,
      pdu_results = {},
      created_at = new Date().toISOString(),
      record = {},
    }) {
      return withSqliteTransaction(sql, () => {
        const existingMarker = inboundMarkers.get({ origin, txn_id });
        if (!existingMarker) {
          throw new Error(`Inbound txn marker ${origin}/${txn_id} must exist before finalization`);
        }
        if (existingMarker.dedupe_request_hash !== dedupe_request_hash) {
          throw new Error(`Inbound txn ${origin}/${txn_id} dedupe_request_hash mismatch`);
        }
        if (existingMarker.state === 'finalized') {
          const existingResult = inboundResults.get({ origin, txn_id });
          if (!existingResult) {
            throw new Error(`Inbound txn ${origin}/${txn_id} is marked finalized without a cached result`);
          }
          return {
            marker: existingMarker,
            result: existingResult,
          };
        }
        inboundResults.put({
          origin,
          txn_id,
          dedupe_request_hash,
          canonical_response_text: normalizeString(canonical_response_text, 'canonical_response_text'),
          canonical_response_bytes_base64: normalizeString(canonical_response_bytes_base64, 'canonical_response_bytes_base64'),
          created_at: normalizeString(created_at, 'created_at'),
          pdu_results_json: pdu_results,
          record_json: record,
        });
        inboundMarkers.put({
          origin,
          txn_id,
          dedupe_request_hash,
          state: 'finalized',
          first_seen_at: existingMarker.first_seen_at,
          finalized_at: created_at,
          conflict_reason: null,
          record_json: existingMarker.record ?? {},
        });
        return {
          marker: inboundMarkers.get({ origin, txn_id }),
          result: inboundResults.get({ origin, txn_id }),
        };
      });
    },
    putCacheEntry({ cache_kind, key_id = null, fetched_at = new Date().toISOString(), expires_at = null, etag = null, record = {} }) {
      const cacheKey = buildCacheKey(cache_kind, key_id);
      return cacheEntries.put({
        cache_key: cacheKey,
        cache_kind,
        key_id,
        fetched_at: normalizeString(fetched_at, 'fetched_at'),
        expires_at,
        etag,
        record_json: record,
      });
    },
    getCacheEntry({ cache_kind, key_id = null }) {
      return cacheEntries.get(buildCacheKey(cache_kind, key_id));
    },
    outboundTransactions,
    retrySchedule,
    inboundMarkers,
    gapRepairBacklog,
    cacheEntries,
    inboundResults,
  });
}
