import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import { createAsyncTaskContext, createRequestContext } from './structured-logging.mjs';
import { loadWorkerRuntimeConfig } from './runtime-manifest.mjs';

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
}

export class UserDO extends BaseDurableObject {
  static authorityKind = 'user';

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'UserDO',
      authorityKind: UserDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'userdo',
    });
  }

  async resolveSession() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('resolveSession');
  }

  async collectSince() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('collectSince');
  }

  async enqueueToDevice() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('enqueueToDevice');
  }
}

export class RoomDO extends BaseDurableObject {
  static authorityKind = 'room';

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'RoomDO',
      authorityKind: RoomDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'roomdo',
    });
  }

  async admitEvent() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('admitEvent');
  }

  async projectForSync() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('projectForSync');
  }

  async queryRoom() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('queryRoom');
  }
}

export class RemoteServerDO extends BaseDurableObject {
  static authorityKind = 'remote-server';

  constructor(ctx, env) {
    super(ctx, env, {
      className: 'RemoteServerDO',
      authorityKind: RemoteServerDO.authorityKind,
      owningWorkerName: 'gateway-worker',
      routeFamilyPrefix: 'remoteserverdo',
    });
  }

  async enqueueOutbound() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('enqueueOutbound');
  }

  async recordInboundTxn() {
    await this.ensureCurrentness();
    return this.createNotImplementedEnvelope('recordInboundTxn');
  }
}
