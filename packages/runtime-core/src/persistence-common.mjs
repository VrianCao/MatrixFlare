function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

export function normalizeString(value, label, { allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeInteger(value, label, { min = 0, allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${label} must be an integer`);
  }
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} must be an integer >= ${min}`);
  }
  return value;
}

export function normalizeBoolean(value, label, { allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${label} must be a boolean`);
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

export function serializeJsonCell(value) {
  return value == null ? null : JSON.stringify(value);
}

export function parseJsonCell(value, fallback = null) {
  if (value == null || value === '') {
    return fallback;
  }
  return JSON.parse(value);
}

export function toSqliteBoolean(value) {
  return value ? 1 : 0;
}

export function fromSqliteBoolean(value) {
  return value === true || value === 1;
}

export function requireSqlStorage(sql, label = 'sql') {
  if (!sql || typeof sql.exec !== 'function') {
    throw new TypeError(`${label} must expose a Durable Object SQLite compatible exec() method`);
  }
  return sql;
}

export function sqlRun(sql, query, ...bindings) {
  requireSqlStorage(sql).exec(query, ...bindings);
}

export function sqlAll(sql, query, ...bindings) {
  const result = requireSqlStorage(sql).exec(query, ...bindings);
  if (!result) {
    return [];
  }
  return Array.isArray(result) ? result : Array.from(result);
}

export function sqlFirst(sql, query, ...bindings) {
  return sqlAll(sql, query, ...bindings)[0] ?? null;
}

export function withSqliteTransaction(sql, callback) {
  sqlRun(sql, 'BEGIN IMMEDIATE');
  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      throw new TypeError('withSqliteTransaction callback must be synchronous');
    }
    sqlRun(sql, 'COMMIT');
    return result;
  } catch (error) {
    try {
      sqlRun(sql, 'ROLLBACK');
    } catch {
      // Ignore rollback failures so the original error is preserved.
    }
    throw error;
  }
}

export function tableExists(sql, tableName) {
  return Boolean(
    sqlFirst(
      sql,
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
      `,
      normalizeString(tableName, 'tableName'),
    ),
  );
}

export function mapSqliteRow(row, {
  jsonColumns = [],
  jsonFallbacks = {},
  booleanColumns = [],
} = {}) {
  if (!row) {
    return null;
  }
  const mapped = { ...row };
  for (const booleanColumn of booleanColumns) {
    mapped[booleanColumn] = fromSqliteBoolean(mapped[booleanColumn]);
  }
  for (const jsonColumn of jsonColumns) {
    const propertyName = jsonColumn.endsWith('_json')
      ? jsonColumn.slice(0, -'_json'.length)
      : jsonColumn;
    mapped[propertyName] = parseJsonCell(mapped[jsonColumn], jsonFallbacks[jsonColumn] ?? null);
    delete mapped[jsonColumn];
  }
  return mapped;
}

function normalizeKeyInput(keyColumns, key) {
  if (keyColumns.length === 1 && !isPlainObject(key)) {
    return {
      [keyColumns[0]]: key,
    };
  }
  return assertPlainObject(key, 'key');
}

function getKeyBindings(keyColumns, key) {
  const normalized = normalizeKeyInput(keyColumns, key);
  return keyColumns.map((keyColumn) => {
    const value = normalized[keyColumn];
    if (value == null) {
      throw new TypeError(`key.${keyColumn} must be present`);
    }
    return value;
  });
}

function getRecordBindings(columns, record, {
  jsonColumns = [],
  booleanColumns = [],
  requiredColumns = [],
} = {}) {
  const normalized = assertPlainObject(record, 'record');
  for (const requiredColumn of requiredColumns) {
    const value = normalized[requiredColumn];
    if (value == null) {
      throw new TypeError(`record.${requiredColumn} must be present`);
    }
  }
  return columns.map((column) => {
    const value = normalized[column];
    if (jsonColumns.includes(column)) {
      return serializeJsonCell(value ?? null);
    }
    if (booleanColumns.includes(column)) {
      return value == null ? null : toSqliteBoolean(Boolean(value));
    }
    return value ?? null;
  });
}

export function createSqliteTableAccess(sql, {
  tableName,
  columns,
  keyColumns,
  jsonColumns = [],
  jsonFallbacks = {},
  booleanColumns = [],
  orderBy = null,
  requiredColumns = keyColumns,
} = {}) {
  const normalizedTableName = normalizeString(tableName, 'tableName');
  const normalizedColumns = [...columns];
  const normalizedKeyColumns = [...keyColumns];
  const updateColumns = normalizedColumns.filter((column) => !normalizedKeyColumns.includes(column));
  const insertSql = `
    INSERT INTO ${normalizedTableName} (${normalizedColumns.join(', ')})
    VALUES (${normalizedColumns.map(() => '?').join(', ')})
    ON CONFLICT(${normalizedKeyColumns.join(', ')}) DO ${updateColumns.length === 0
      ? 'NOTHING'
      : `UPDATE SET ${updateColumns.map((column) => `${column} = excluded.${column}`).join(', ')}`}
  `;
  const selectByKeySql = `
    SELECT *
    FROM ${normalizedTableName}
    WHERE ${normalizedKeyColumns.map((column) => `${column} = ?`).join(' AND ')}
  `;
  const deleteByKeySql = `
    DELETE FROM ${normalizedTableName}
    WHERE ${normalizedKeyColumns.map((column) => `${column} = ?`).join(' AND ')}
  `;
  const orderBySql = orderBy ? ` ORDER BY ${orderBy}` : '';
  const listSql = `
    SELECT *
    FROM ${normalizedTableName}${orderBySql}
  `;

  return Object.freeze({
    put(record) {
      const bindings = getRecordBindings(normalizedColumns, record, {
        jsonColumns,
        booleanColumns,
        requiredColumns,
      });
      sqlRun(sql, insertSql, ...bindings);
      const keyRecord = normalizedKeyColumns.reduce((accumulator, keyColumn) => {
        accumulator[keyColumn] = record[keyColumn];
        return accumulator;
      }, {});
      return this.get(keyRecord);
    },
    get(key) {
      const row = sqlFirst(sql, selectByKeySql, ...getKeyBindings(normalizedKeyColumns, key));
      return mapSqliteRow(row, {
        jsonColumns,
        jsonFallbacks,
        booleanColumns,
      });
    },
    list() {
      return sqlAll(sql, listSql).map((row) => mapSqliteRow(row, {
        jsonColumns,
        jsonFallbacks,
        booleanColumns,
      }));
    },
    delete(key) {
      sqlRun(sql, deleteByKeySql, ...getKeyBindings(normalizedKeyColumns, key));
    },
  });
}

export function ensureSingletonState(sql, {
  tableName,
  schemaVersion,
  updatedAt,
  defaults = {},
} = {}) {
  const normalizedTableName = normalizeString(tableName, 'tableName');
  const normalizedUpdatedAt = normalizeString(updatedAt, 'updatedAt');
  const defaultColumns = Object.keys(defaults);
  const insertColumns = ['singleton', 'schema_version', 'updated_at', ...defaultColumns];
  const updateSql = `
    INSERT INTO ${normalizedTableName} (${insertColumns.join(', ')})
    VALUES (${insertColumns.map(() => '?').join(', ')})
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = CASE
        WHEN ${normalizedTableName}.schema_version > excluded.schema_version THEN ${normalizedTableName}.schema_version
        ELSE excluded.schema_version
      END,
      updated_at = excluded.updated_at
  `;
  sqlRun(
    sql,
    updateSql,
    1,
    normalizeInteger(schemaVersion, 'schemaVersion', { min: 1 }),
    normalizedUpdatedAt,
    ...defaultColumns.map((column) => defaults[column]),
  );
  return sqlFirst(sql, `SELECT * FROM ${normalizedTableName} WHERE singleton = 1`);
}
