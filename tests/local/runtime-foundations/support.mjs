import { DatabaseSync } from 'node:sqlite';

import { CLOUDFLARE_KNOWN_LENGTH_STREAM } from '../../../packages/runtime-core/src/media-domain.mjs';

function detectStatementType(sql) {
  const trimmed = sql.trim().replace(/^\uFEFF/, '');
  const match = /^([A-Za-z]+)/.exec(trimmed);
  return match?.[1]?.toUpperCase() ?? '';
}

export function createFakeSqlStorage() {
  const database = new DatabaseSync(':memory:');
  let alarm = null;
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
    async setAlarm(scheduledTime) {
      if (scheduledTime == null) {
        alarm = null;
        return;
      }
      if (scheduledTime instanceof Date) {
        alarm = scheduledTime.getTime();
        return;
      }
      if (typeof scheduledTime === 'number' && Number.isFinite(scheduledTime)) {
        alarm = scheduledTime;
        return;
      }
      throw new TypeError('scheduledTime must be a Date or finite epoch milliseconds');
    },
    async getAlarm() {
      return alarm;
    },
    async deleteAlarm() {
      alarm = null;
    },
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
    if (typeof value?.getReader === 'function' && !value[CLOUDFLARE_KNOWN_LENGTH_STREAM]) {
      throw new Error('Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)');
    }
    const body = await readInputToBuffer(value);
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
      size: entry.body.byteLength,
      etag: `"${key}"`,
      key,
      customMetadata: entry.options.customMetadata ?? null,
      httpMetadata: entry.options.httpMetadata ?? null,
      arrayBuffer: async () => entry.body.buffer.slice(
        entry.body.byteOffset,
        entry.body.byteOffset + entry.body.byteLength,
      ),
      text: async () => (
        Buffer.from(entry.body).toString('utf8')
      ),
      json: async () => JSON.parse(
        Buffer.from(entry.body).toString('utf8'),
      ),
    };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async head(key) {
    const object = await this.get(key);
    if (!object) {
      return null;
    }
    return {
      key,
      size: object.size,
      etag: object.etag,
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
    };
  }

  async list({ prefix = '' } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => ({
        key,
        size: entry.body.byteLength,
        etag: `"${key}"`,
        customMetadata: entry.options.customMetadata ?? null,
        httpMetadata: entry.options.httpMetadata ?? null,
      }));
    return {
      objects,
      truncated: false,
      cursor: null,
      delimitedPrefixes: [],
    };
  }
}

async function readInputToBuffer(value) {
  if (value == null) {
    return Buffer.alloc(0);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (typeof value.arrayBuffer === 'function') {
    return Buffer.from(await value.arrayBuffer());
  }
  if (typeof value.getReader === 'function') {
    const reader = value.getReader();
    const chunks = [];
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(value), 'utf8');
}

export class FakeQueueBinding {
  constructor(queueName) {
    this.queueName = queueName;
    this.messages = [];
  }

  async send(body) {
    this.messages.push(body);
  }

  async sendBatch(bodies) {
    this.messages.push(...bodies);
  }

  drainBatch() {
    const drained = this.messages.splice(0);
    return {
      queue: this.queueName,
      messages: drained.map((body) => ({
        body,
        acked: false,
        retried: false,
        ack() {
          this.acked = true;
        },
        retry() {
          this.retried = true;
        },
      })),
    };
  }
}

export class FakeKvNamespace {
  constructor({ pageSize = 1000 } = {}) {
    this.entries = new Map();
    this.pageSize = pageSize;
  }

  async put(key, value, options = {}) {
    if (options.expirationTtl != null) {
      if (!Number.isInteger(options.expirationTtl) || options.expirationTtl < 60) {
        throw new Error(`400 Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least 60.`);
      }
    }
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
