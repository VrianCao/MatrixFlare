import { DatabaseSync } from 'node:sqlite';

function detectStatementType(sql) {
  const trimmed = sql.trim().replace(/^\uFEFF/, '');
  const match = /^([A-Za-z]+)/.exec(trimmed);
  return match?.[1]?.toUpperCase() ?? '';
}

export function createFakeSqlStorage() {
  const database = new DatabaseSync(':memory:');
  return {
    sql: {
      exec(sql, ...bindings) {
        const statementType = detectStatementType(sql);
        if (bindings.length === 0 && sql.includes(';') && !['SELECT', 'PRAGMA', 'WITH'].includes(statementType)) {
          database.exec(sql);
          return [];
        }
        if (['SELECT', 'PRAGMA', 'WITH'].includes(statementType)) {
          const statement = database.prepare(sql);
          return statement.all(...bindings);
        }
        const statement = database.prepare(sql);
        statement.run(...bindings);
        return [];
      },
    },
    get: async () => null,
    close() {
      database.close();
    },
  };
}

export function createFakeD1Database() {
  const database = new DatabaseSync(':memory:');
  return {
    exec(sql) {
      database.exec(sql);
      return Promise.resolve();
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...bindings) {
          return {
            run: async () => {
              statement.run(...bindings);
              return { success: true };
            },
            first: async () => statement.get(...bindings) ?? null,
            all: async () => ({
              results: statement.all(...bindings),
            }),
          };
        },
      };
    },
    close() {
      database.close();
    },
  };
}

export class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options = {}) {
    const body = typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array
      ? value
      : String(value);
    this.objects.set(key, {
      body,
      options,
    });
  }

  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    return {
      body: entry.body,
      customMetadata: entry.options.customMetadata ?? null,
      httpMetadata: entry.options.httpMetadata ?? null,
      text: async () => (
        typeof entry.body === 'string'
          ? entry.body
          : Buffer.from(entry.body).toString('utf8')
      ),
      json: async () => JSON.parse(
        typeof entry.body === 'string'
          ? entry.body
          : Buffer.from(entry.body).toString('utf8'),
      ),
    };
  }
}

export class FakeKvNamespace {
  constructor({ pageSize = 1000 } = {}) {
    this.entries = new Map();
    this.pageSize = pageSize;
  }

  async put(key, value, options = {}) {
    this.entries.set(key, {
      value,
      metadata: options.metadata ?? null,
      expirationTtl: options.expirationTtl ?? null,
    });
  }

  async get(key) {
    return this.entries.get(key)?.value ?? null;
  }

  async getWithMetadata(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    return {
      value: entry.value,
      metadata: entry.metadata,
    };
  }

  async delete(key) {
    this.entries.delete(key);
  }

  async list({ prefix = '', cursor = null, limit = null } = {}) {
    const pageLimit = limit ?? this.pageSize;
    const allKeys = [...this.entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([name, entry]) => ({
        name,
        metadata: entry.metadata ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const startIndex = cursor == null
      ? 0
      : allKeys.findIndex((entry) => entry.name > cursor);
    const normalizedStartIndex = startIndex === -1 ? allKeys.length : startIndex;
    const keys = allKeys.slice(normalizedStartIndex, normalizedStartIndex + pageLimit);
    const listComplete = normalizedStartIndex + pageLimit >= allKeys.length;
    return {
      keys,
      list_complete: listComplete,
      cursor: listComplete || keys.length === 0 ? null : keys.at(-1).name,
    };
  }
}
