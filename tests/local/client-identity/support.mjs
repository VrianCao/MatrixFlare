import gatewayWorkerModule from '../../../apps/gateway-worker/src/index.mjs';
import jobsWorkerModule from '../../../apps/jobs-worker/src/index.mjs';
import { RoomDO, UserDO } from '../../../packages/runtime-core/src/index.mjs';
import { buildLocalUserId } from '../../../packages/runtime-core/src/user-identity.mjs';
import {
  FakeQueueBinding,
  FakeR2Bucket,
  createFakeD1Database,
  FakeKvNamespace,
  createFakeSqlStorage,
} from '../runtime-foundations/support.mjs';

class FakeDurableObjectNamespace {
  constructor(DoClass, env) {
    this.DoClass = DoClass;
    this.env = env;
    this.instances = new Map();
  }

  idFromName(name) {
    return String(name);
  }

  get(id) {
    const normalizedId = String(id);
    if (!this.instances.has(normalizedId)) {
      const storage = createFakeSqlStorage();
      const instance = new this.DoClass({ storage }, this.env);
      this.instances.set(normalizedId, {
        instance,
        storage,
      });
    }
    return this.instances.get(normalizedId).instance;
  }

  close() {
    for (const entry of this.instances.values()) {
      entry.storage.close?.();
    }
    this.instances.clear();
  }
}

function createDefaultEnv(overrides = {}) {
  return {
    ENVIRONMENT_NAME: 'local',
    MATRIX_SERVER_NAME: 'matrix.example.test',
    RELEASE_PROFILE: 'L1',
    WORKER_VERSION_ID: 'phase04-test',
    DEPLOYMENT_ID: 'phase04-test-deployment',
    LOG_LEVEL: 'debug',
    CPU_LIMIT_CLASS: 'default',
    MATRIX_PUBLIC_BASE_URL: 'https://matrix.example.test',
    MANAGEMENT_API_BASE_URL: 'https://ops.example.test',
    GATEWAY_WORKER_SCRIPT_NAME: 'matrix-gateway-worker-local',
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '104857600',
    MATRIX_MEDIA_LEGACY_UNAUTH_FREEZE_AT: '',
    HOMESERVER_SIGNING_KEY_RING: 'hs-test-key-ring',
    SESSION_ROOT_KEY_RING: JSON.stringify({
      active: 'v2',
      keys: {
        v2: { secret_text: 'phase04-session-root-v2' },
        v1: { secret_text: 'phase04-session-root-v1' },
      },
    }),
    UIA_ROOT_KEY_RING: JSON.stringify({
      active: 'v1',
      keys: {
        v1: { secret_text: 'phase04-uia-root-v1' },
      },
    }),
    APPSERVICE_TOKEN_SET: 'appservice-token-set',
    FF_FEDERATION: 'false',
    FF_MEDIA_REMOTE_FETCH: 'false',
    FF_APPSERVICE_API: 'false',
    FF_OTEL_EXPORT: 'false',
    FF_OTEL_PERSIST: 'true',
    FF_SSO_LOGIN: 'false',
    FF_LOGIN_TOKEN: 'false',
    FF_THREEPID_CHANGES: 'false',
    FF_URL_PREVIEW: 'false',
    FF_PUSH_GATEWAY: 'false',
    FF_REQUEST_TOKEN_BOOTSTRAP: 'false',
    FF_TURN_CREDENTIALS: 'false',
    MATRIX_EDGE_CACHE: new FakeKvNamespace(),
    ...overrides,
  };
}

export function createGatewayPhase04Rig(overrides = {}) {
  const env = createDefaultEnv(overrides);
  env.MATRIX_CONTROL_D1 = createFakeD1Database();
  env.MATRIX_MEDIA_BUCKET = new FakeR2Bucket();
  env.MATRIX_ARCHIVE_BUCKET = new FakeR2Bucket();
  env.SEARCH_INDEX_QUEUE = new FakeQueueBinding('matrix-search-index-job');
  env.MEDIA_THUMBNAIL_QUEUE = new FakeQueueBinding('matrix-media-thumbnail-job');
  env.APPSERVICE_TXN_QUEUE = new FakeQueueBinding('matrix-appservice-txn-job');
  env.REBUILD_SHARD_QUEUE = new FakeQueueBinding('matrix-rebuild-shard-job');
  env.EXPORT_SHARD_QUEUE = new FakeQueueBinding('matrix-export-shard-job');
  env.RESTORE_SHARD_QUEUE = new FakeQueueBinding('matrix-restore-shard-job');
  env.REPAIR_SHARD_QUEUE = new FakeQueueBinding('matrix-repair-shard-job');
  const userNamespace = new FakeDurableObjectNamespace(UserDO, env);
  const roomNamespace = new FakeDurableObjectNamespace(RoomDO, env);
  env.USER_DO = userNamespace;
  env.ROOM_DO = roomNamespace;
  env.JOBS_WORKER = {
    fetch(request) {
      return jobsWorkerModule.fetch(request, env);
    },
  };

  async function gatewayFetch(pathname, {
    method = 'GET',
    headers = {},
    json = null,
    body = null,
  } = {}) {
    const requestHeaders = new Headers(headers);
    if (json != null && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json; charset=utf-8');
    }
    if (body != null && json != null) {
      throw new TypeError('body and json are mutually exclusive');
    }
    const resolvedBody = json == null ? body : JSON.stringify(json);
    const requestInit = {
      method,
      headers: requestHeaders,
      body: resolvedBody,
    };
    if (resolvedBody && typeof resolvedBody.getReader === 'function') {
      requestInit.duplex = 'half';
    }
    const request = new Request(`https://matrix.example.test${pathname}`, requestInit);
    return gatewayWorkerModule.fetch(request, env);
  }

  function authHeaders(accessToken) {
    return {
      authorization: `Bearer ${accessToken}`,
    };
  }

  function getUserDo(localpartOrUserId) {
    const userId = String(localpartOrUserId).startsWith('@')
      ? String(localpartOrUserId)
      : buildLocalUserId(localpartOrUserId, env.MATRIX_SERVER_NAME);
    return userNamespace.get(userNamespace.idFromName(userId));
  }

  function getRoomDo(roomId) {
    return roomNamespace.get(roomNamespace.idFromName(roomId));
  }

  async function drainJobsQueues({ maxPasses = 16 } = {}) {
    const bindings = [
      env.SEARCH_INDEX_QUEUE,
      env.MEDIA_THUMBNAIL_QUEUE,
      env.APPSERVICE_TXN_QUEUE,
      env.REBUILD_SHARD_QUEUE,
      env.EXPORT_SHARD_QUEUE,
      env.RESTORE_SHARD_QUEUE,
      env.REPAIR_SHARD_QUEUE,
    ];
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let processed = false;
      for (const binding of bindings) {
        if (binding.messages.length === 0) {
          continue;
        }
        processed = true;
        await jobsWorkerModule.queue(binding.drainBatch(), env);
      }
      if (!processed) {
        return;
      }
    }
    throw new Error(`drainJobsQueues did not converge within ${maxPasses} passes`);
  }

  return {
    env,
    gatewayFetch,
    authHeaders,
    getUserDo,
    getRoomDo,
    queues: {
      search: env.SEARCH_INDEX_QUEUE,
      media: env.MEDIA_THUMBNAIL_QUEUE,
      appservice: env.APPSERVICE_TXN_QUEUE,
      rebuild: env.REBUILD_SHARD_QUEUE,
      export: env.EXPORT_SHARD_QUEUE,
      restore: env.RESTORE_SHARD_QUEUE,
      repair: env.REPAIR_SHARD_QUEUE,
    },
    buckets: {
      media: env.MATRIX_MEDIA_BUCKET,
      archive: env.MATRIX_ARCHIVE_BUCKET,
    },
    d1: env.MATRIX_CONTROL_D1,
    drainJobsQueues,
    close() {
      env.MATRIX_CONTROL_D1.close?.();
      userNamespace.close();
      roomNamespace.close();
    },
  };
}

export function createGatewayVersionSkewRig({
  workerEnvOverrides = {},
  authorityEnvOverrides = {},
  jobsEnvOverrides = {},
} = {}) {
  const sharedD1 = createFakeD1Database();
  const sharedMediaBucket = new FakeR2Bucket();
  const sharedArchiveBucket = new FakeR2Bucket();
  const sharedEdgeCache = new FakeKvNamespace();
  const sharedQueues = {
    search: new FakeQueueBinding('matrix-search-index-job'),
    media: new FakeQueueBinding('matrix-media-thumbnail-job'),
    appservice: new FakeQueueBinding('matrix-appservice-txn-job'),
    rebuild: new FakeQueueBinding('matrix-rebuild-shard-job'),
    export: new FakeQueueBinding('matrix-export-shard-job'),
    restore: new FakeQueueBinding('matrix-restore-shard-job'),
    repair: new FakeQueueBinding('matrix-repair-shard-job'),
  };
  const sharedTelemetry = {
    metrics: new Map(),
    deployment_records: new Map(),
    cost_totals: new Map(),
    events: [],
  };
  const sharedBindings = {
    MATRIX_CONTROL_D1: sharedD1,
    MATRIX_MEDIA_BUCKET: sharedMediaBucket,
    MATRIX_ARCHIVE_BUCKET: sharedArchiveBucket,
    MATRIX_EDGE_CACHE: sharedEdgeCache,
    SEARCH_INDEX_QUEUE: sharedQueues.search,
    MEDIA_THUMBNAIL_QUEUE: sharedQueues.media,
    APPSERVICE_TXN_QUEUE: sharedQueues.appservice,
    REBUILD_SHARD_QUEUE: sharedQueues.rebuild,
    EXPORT_SHARD_QUEUE: sharedQueues.export,
    RESTORE_SHARD_QUEUE: sharedQueues.restore,
    REPAIR_SHARD_QUEUE: sharedQueues.repair,
    __MATRIX_RUNTIME_TELEMETRY__: sharedTelemetry,
  };
  const workerEnv = createDefaultEnv({
    ...sharedBindings,
    ...workerEnvOverrides,
  });
  const authorityEnv = createDefaultEnv({
    ...sharedBindings,
    ...authorityEnvOverrides,
  });
  const jobsEnv = createDefaultEnv({
    ...sharedBindings,
    ...jobsEnvOverrides,
  });
  const userNamespace = new FakeDurableObjectNamespace(UserDO, authorityEnv);
  const roomNamespace = new FakeDurableObjectNamespace(RoomDO, authorityEnv);
  workerEnv.USER_DO = userNamespace;
  workerEnv.ROOM_DO = roomNamespace;
  jobsEnv.USER_DO = userNamespace;
  jobsEnv.ROOM_DO = roomNamespace;
  workerEnv.JOBS_WORKER = {
    fetch(request) {
      return jobsWorkerModule.fetch(request, jobsEnv);
    },
  };

  async function gatewayFetch(pathname, {
    method = 'GET',
    headers = {},
    json = null,
    body = null,
  } = {}) {
    const requestHeaders = new Headers(headers);
    if (json != null && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json; charset=utf-8');
    }
    if (body != null && json != null) {
      throw new TypeError('body and json are mutually exclusive');
    }
    const request = new Request(`https://matrix.example.test${pathname}`, {
      method,
      headers: requestHeaders,
      body: json == null ? body : JSON.stringify(json),
    });
    return gatewayWorkerModule.fetch(request, workerEnv);
  }

  return {
    env: workerEnv,
    authorityEnv,
    jobsEnv,
    gatewayFetch,
    authHeaders(accessToken) {
      return {
        authorization: `Bearer ${accessToken}`,
      };
    },
    getUserDo(localpartOrUserId) {
      const userId = String(localpartOrUserId).startsWith('@')
        ? String(localpartOrUserId)
        : buildLocalUserId(localpartOrUserId, workerEnv.MATRIX_SERVER_NAME);
      return userNamespace.get(userNamespace.idFromName(userId));
    },
    getRoomDo(roomId) {
      return roomNamespace.get(roomNamespace.idFromName(roomId));
    },
    close() {
      sharedD1.close?.();
      userNamespace.close();
      roomNamespace.close();
    },
  };
}
