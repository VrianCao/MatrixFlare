import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import {
  REMOTE_SERVER_DO_SCHEMA_VERSION,
  createRemoteServerDurableObjectPersistence,
} from './remote-server-persistence.mjs';
import {
  ROOM_DO_SCHEMA_VERSION,
  createRoomDurableObjectPersistence,
} from './room-persistence.mjs';
import { createAsyncTaskContext, createRequestContext } from './structured-logging.mjs';
import { loadWorkerRuntimeConfig } from './runtime-manifest.mjs';
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
    return this.createNotImplementedEnvelope('resolveSession', {
      schema_version: UserDO.schemaVersion,
    });
  }

  async collectSince() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('collectSince', {
      schema_version: UserDO.schemaVersion,
    });
  }

  async enqueueToDevice() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('enqueueToDevice', {
      schema_version: UserDO.schemaVersion,
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

  async projectForSync() {
    await this.ensureCurrentness();
    await this.ensureSchema();
    return this.createNotImplementedEnvelope('projectForSync', {
      schema_version: RoomDO.schemaVersion,
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
