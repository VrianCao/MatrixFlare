import gatewayWorkerModule from '../../../apps/gateway-worker/src/index.mjs';
import { RoomDO, UserDO } from '../../../packages/runtime-core/src/index.mjs';
import { buildLocalUserId } from '../../../packages/runtime-core/src/user-identity.mjs';
import {
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
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '104857600',
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
  const userNamespace = new FakeDurableObjectNamespace(UserDO, env);
  const roomNamespace = new FakeDurableObjectNamespace(RoomDO, env);
  env.USER_DO = userNamespace;
  env.ROOM_DO = roomNamespace;

  async function gatewayFetch(pathname, {
    method = 'GET',
    headers = {},
    json = null,
  } = {}) {
    const requestHeaders = new Headers(headers);
    if (json != null && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json; charset=utf-8');
    }
    const request = new Request(`https://matrix.example.test${pathname}`, {
      method,
      headers: requestHeaders,
      body: json == null ? null : JSON.stringify(json),
    });
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

  return {
    env,
    gatewayFetch,
    authHeaders,
    getUserDo,
    getRoomDo,
    close() {
      userNamespace.close();
      roomNamespace.close();
    },
  };
}
