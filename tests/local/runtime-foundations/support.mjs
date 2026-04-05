import { DatabaseSync } from 'node:sqlite';

import { readCloudflareKnownLengthStreamMetadata } from '../../../packages/runtime-core/src/media-domain.mjs';

const R2_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;

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
  const executePreparedStatement = (sql, bindings) => {
    const statement = database.prepare(sql);
    const statementType = detectStatementType(sql);
    if (['SELECT', 'PRAGMA', 'WITH'].includes(statementType)) {
      return {
        success: true,
        results: statement.all(...bindings),
      };
    }
    statement.run(...bindings);
    return {
      success: true,
      results: [],
    };
  };
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
            __sql: sql,
            __bindings: bindings,
            __batchExecute: () => executePreparedStatement(sql, bindings),
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
    batch(statements) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          if (!statement || typeof statement.__batchExecute !== 'function') {
            throw new TypeError('batch() requires prepared statements returned by bind()');
          }
          results.push(statement.__batchExecute());
        }
        database.exec('COMMIT');
        return Promise.resolve(results);
      } catch (error) {
        database.exec('ROLLBACK');
        return Promise.reject(error);
      }
    },
    close() {
      database.close();
    },
  };
}

export class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
    this.multipartUploads = new Map();
    this.nextMultipartUploadId = 1;
  }

  async put(key, value, options = {}) {
    const streamMetadata = typeof value?.getReader === 'function'
      ? readCloudflareKnownLengthStreamMetadata(value)
      : null;
    if (typeof value?.getReader === 'function' && !Number.isInteger(streamMetadata?.byte_length)) {
      throw new Error('Provided readable stream must declare an exact known byte length');
    }
    const body = await readInputToBuffer(value);
    if (Number.isInteger(streamMetadata?.byte_length) && body.byteLength !== streamMetadata.byte_length) {
      throw new Error(`Provided readable stream declared ${streamMetadata.byte_length} bytes but produced ${body.byteLength}`);
    }
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
    const streamBody = createReadableStreamFromBuffer(entry.body);
    return {
      body: streamBody,
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

  async createMultipartUpload(key, options = {}) {
    const uploadId = `multipart-${this.nextMultipartUploadId++}`;
    this.multipartUploads.set(uploadId, {
      key,
      options,
      parts: new Map(),
    });
    return new FakeR2MultipartUpload(this, uploadId);
  }
}

class FakeR2MultipartUpload {
  constructor(bucket, uploadId) {
    this.bucket = bucket;
    this.uploadId = uploadId;
  }

  async uploadPart(partNumber, value) {
    const state = this.#state();
    const body = await readInputToBuffer(value);
    const normalizedPartNumber = Number(partNumber);
    const etag = `"${this.uploadId}:${normalizedPartNumber}"`;
    state.parts.set(normalizedPartNumber, {
      partNumber: normalizedPartNumber,
      etag,
      body,
    });
    return {
      partNumber: normalizedPartNumber,
      etag,
    };
  }

  async complete(uploadedParts) {
    const state = this.#state();
    const normalizedParts = Array.isArray(uploadedParts)
      ? uploadedParts
      : [...state.parts.values()]
        .sort((left, right) => left.partNumber - right.partNumber)
        .map(({ partNumber, etag }) => ({ partNumber, etag }));
    const resolvedParts = normalizedParts.map((part, index) => {
      const normalizedPartNumber = Number(part?.partNumber);
      if (!Number.isInteger(normalizedPartNumber) || normalizedPartNumber < 1) {
        throw new Error(`Multipart upload part number ${String(part?.partNumber)} is invalid`);
      }
      const previousPartNumber = index === 0 ? null : Number(normalizedParts[index - 1]?.partNumber);
      if (previousPartNumber != null && normalizedPartNumber <= previousPartNumber) {
        throw new Error('Multipart upload parts must be strictly increasing and unique');
      }
      const storedPart = state.parts.get(normalizedPartNumber);
      if (!storedPart || storedPart.etag !== part?.etag) {
        throw new Error(`Missing multipart upload part ${normalizedPartNumber}`);
      }
      if (index < normalizedParts.length - 1 && storedPart.body.byteLength < R2_MULTIPART_MIN_PART_BYTES) {
        throw new Error(`Multipart upload part ${normalizedPartNumber} must be at least ${R2_MULTIPART_MIN_PART_BYTES} bytes`);
      }
      return storedPart;
    });
    this.bucket.objects.set(state.key, {
      body: Buffer.concat(resolvedParts.map((part) => part.body)),
      options: state.options,
    });
    this.bucket.multipartUploads.delete(this.uploadId);
    return {
      key: state.key,
      etag: `"${state.key}"`,
    };
  }

  async abort() {
    this.bucket.multipartUploads.delete(this.uploadId);
  }

  #state() {
    const state = this.bucket.multipartUploads.get(this.uploadId);
    if (!state) {
      throw new Error(`Unknown multipart upload ${this.uploadId}`);
    }
    return state;
  }
}

function createReadableStreamFromBuffer(buffer) {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(Buffer.from(buffer));
    },
  });
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
