import {
  mapSqliteRow,
  normalizeInteger,
  normalizeString,
} from './persistence-common.mjs';

export const DERIVED_DATA_SCHEMA_VERSION = 1;

const DERIVED_SCHEMA_STATE_TABLE = 'derived_schema_state';
const REQUIRED_DERIVED_TABLES = Object.freeze([
  DERIVED_SCHEMA_STATE_TABLE,
  'search_index_rows',
  'user_directory_entries',
  'public_room_directory_entries',
  'media_catalog_entries',
]);

export const DERIVED_DATA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS derived_schema_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_index_rows (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  origin_server_ts INTEGER NOT NULL,
  sender_user_id TEXT,
  search_vector_text TEXT NOT NULL,
  visibility_scope TEXT,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_index_rows_room_id
  ON search_index_rows (room_id, origin_server_ts, event_id);

CREATE TABLE IF NOT EXISTS user_directory_entries (
  user_id TEXT PRIMARY KEY,
  displayname TEXT,
  avatar_url TEXT,
  profile_version INTEGER,
  directory_visibility TEXT NOT NULL,
  discovery_flags_json TEXT,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_directory_entries_visibility
  ON user_directory_entries (directory_visibility, displayname, user_id);

CREATE TABLE IF NOT EXISTS public_room_directory_entries (
  room_id TEXT PRIMARY KEY,
  canonical_alias TEXT,
  name TEXT,
  topic TEXT,
  avatar_url TEXT,
  join_rules TEXT,
  history_visibility TEXT,
  world_readable INTEGER NOT NULL DEFAULT 0,
  guest_can_join INTEGER NOT NULL DEFAULT 0,
  joined_members INTEGER NOT NULL DEFAULT 0,
  source_room_serial INTEGER,
  visibility_watermark INTEGER,
  is_public INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_public_room_directory_entries_visibility
  ON public_room_directory_entries (is_public, joined_members DESC, room_id);
CREATE INDEX IF NOT EXISTS idx_public_room_directory_entries_watermark
  ON public_room_directory_entries (visibility_watermark, room_id);

CREATE TABLE IF NOT EXISTS media_catalog_entries (
  mxc_uri TEXT PRIMARY KEY,
  origin_kind TEXT NOT NULL,
  origin_server_name TEXT,
  media_id TEXT NOT NULL,
  content_type TEXT,
  byte_size INTEGER,
  content_hash TEXT,
  legacy_unauth_access_flag INTEGER NOT NULL DEFAULT 0,
  source_object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_catalog_entries_origin
  ON media_catalog_entries (origin_kind, origin_server_name, media_id);
`;

function requireD1Database(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('db must expose D1-compatible prepare() and exec() methods');
  }
  return db;
}

async function statementRun(statement, ...bindings) {
  return statement.bind(...bindings).run();
}

async function statementFirst(statement, ...bindings) {
  return statement.bind(...bindings).first();
}

async function statementAll(statement, ...bindings) {
  const result = await statement.bind(...bindings).all();
  return result?.results ?? [];
}

function createD1TableAccess(db, {
  tableName,
  columns,
  keyColumns,
  jsonColumns = [],
  jsonFallbacks = {},
  booleanColumns = [],
  orderBy = null,
} = {}) {
  const updateColumns = columns.filter((column) => !keyColumns.includes(column));
  const insertSql = `
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(${keyColumns.join(', ')}) DO ${updateColumns.length === 0
      ? 'NOTHING'
      : `UPDATE SET ${updateColumns.map((column) => `${column} = excluded.${column}`).join(', ')}`}
  `;
  const selectSql = `
    SELECT *
    FROM ${tableName}
    WHERE ${keyColumns.map((column) => `${column} = ?`).join(' AND ')}
  `;
  const orderBySql = orderBy ? ` ORDER BY ${orderBy}` : '';
  const listSql = `SELECT * FROM ${tableName}${orderBySql}`;
  const deleteSql = `
    DELETE FROM ${tableName}
    WHERE ${keyColumns.map((column) => `${column} = ?`).join(' AND ')}
  `;

  return Object.freeze({
    async put(record) {
      const bindings = columns.map((column) => {
        const value = record[column];
        if (jsonColumns.includes(column)) {
          return value == null ? null : JSON.stringify(value);
        }
        if (booleanColumns.includes(column)) {
          return value == null ? null : (value ? 1 : 0);
        }
        return value ?? null;
      });
      await statementRun(db.prepare(insertSql), ...bindings);
      const keyRecord = keyColumns.reduce((accumulator, keyColumn) => {
        accumulator[keyColumn] = record[keyColumn];
        return accumulator;
      }, {});
      return this.get(keyRecord);
    },
    async get(key) {
      const bindings = keyColumns.map((column) => key[column]);
      const row = await statementFirst(db.prepare(selectSql), ...bindings);
      return mapSqliteRow(row, {
        jsonColumns,
        jsonFallbacks,
        booleanColumns,
      });
    },
    async list() {
      const rows = await statementAll(db.prepare(listSql));
      return rows.map((row) => mapSqliteRow(row, {
        jsonColumns,
        jsonFallbacks,
        booleanColumns,
      }));
    },
    async delete(key) {
      const bindings = keyColumns.map((column) => key[column]);
      await statementRun(db.prepare(deleteSql), ...bindings);
    },
  });
}

async function tableExists(db, tableName) {
  const row = await statementFirst(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `),
    normalizeString(tableName, 'tableName'),
  );
  return Boolean(row);
}

export function createD1DerivedDataPersistence(database) {
  const db = requireD1Database(database);
  const searchIndex = createD1TableAccess(db, {
    tableName: 'search_index_rows',
    keyColumns: ['event_id'],
    columns: [
      'event_id',
      'room_id',
      'event_type',
      'origin_server_ts',
      'sender_user_id',
      'search_vector_text',
      'visibility_scope',
      'updated_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    orderBy: 'origin_server_ts ASC, event_id ASC',
  });
  const userDirectory = createD1TableAccess(db, {
    tableName: 'user_directory_entries',
    keyColumns: ['user_id'],
    columns: ['user_id', 'displayname', 'avatar_url', 'profile_version', 'directory_visibility', 'discovery_flags_json', 'updated_at', 'record_json'],
    jsonColumns: ['discovery_flags_json', 'record_json'],
    jsonFallbacks: { discovery_flags_json: {}, record_json: {} },
    orderBy: 'displayname ASC, user_id ASC',
  });
  const publicRoomDirectory = createD1TableAccess(db, {
    tableName: 'public_room_directory_entries',
    keyColumns: ['room_id'],
    columns: [
      'room_id',
      'canonical_alias',
      'name',
      'topic',
      'avatar_url',
      'join_rules',
      'history_visibility',
      'world_readable',
      'guest_can_join',
      'joined_members',
      'source_room_serial',
      'visibility_watermark',
      'is_public',
      'updated_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    booleanColumns: ['world_readable', 'guest_can_join', 'is_public'],
    orderBy: 'joined_members DESC, room_id ASC',
  });
  const mediaCatalog = createD1TableAccess(db, {
    tableName: 'media_catalog_entries',
    keyColumns: ['mxc_uri'],
    columns: [
      'mxc_uri',
      'origin_kind',
      'origin_server_name',
      'media_id',
      'content_type',
      'byte_size',
      'content_hash',
      'legacy_unauth_access_flag',
      'source_object_key',
      'created_at',
      'updated_at',
      'record_json',
    ],
    jsonColumns: ['record_json'],
    jsonFallbacks: { record_json: {} },
    booleanColumns: ['legacy_unauth_access_flag'],
    orderBy: 'created_at ASC, mxc_uri ASC',
  });

  return Object.freeze({
    schemaVersion: DERIVED_DATA_SCHEMA_VERSION,
    async ensureSchema(now = new Date().toISOString()) {
      await db.exec(DERIVED_DATA_SCHEMA_SQL);
      await statementRun(
        db.prepare(`
          INSERT INTO ${DERIVED_SCHEMA_STATE_TABLE} (singleton, schema_version, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            schema_version = CASE
              WHEN ${DERIVED_SCHEMA_STATE_TABLE}.schema_version > excluded.schema_version THEN ${DERIVED_SCHEMA_STATE_TABLE}.schema_version
              ELSE excluded.schema_version
            END,
            updated_at = excluded.updated_at
        `),
        1,
        DERIVED_DATA_SCHEMA_VERSION,
        normalizeString(now, 'now'),
      );
    },
    async isSchemaReady() {
      for (const tableName of REQUIRED_DERIVED_TABLES) {
        if (!await tableExists(db, tableName)) {
          return false;
        }
      }
      const row = await statementFirst(
        db.prepare(`SELECT schema_version FROM ${DERIVED_SCHEMA_STATE_TABLE} WHERE singleton = 1`),
      );
      return Boolean(row) && row.schema_version >= DERIVED_DATA_SCHEMA_VERSION;
    },
    async getSchemaState() {
      return await statementFirst(db.prepare(`SELECT * FROM ${DERIVED_SCHEMA_STATE_TABLE} WHERE singleton = 1`));
    },
    searchIndex,
    userDirectory,
    publicRoomDirectory,
    mediaCatalog,
  });
}
