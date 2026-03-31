import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import jobsWorkerModule from '../../../apps/jobs-worker/src/index.mjs';
import opsWorkerModule from '../../../apps/ops-worker/src/index.mjs';
import {
  createD1ControlPlanePersistence,
  createJwtForTest,
} from '../../../packages/control-plane/src/index.mjs';

function toPemPair(keyPair) {
  return {
    privateKeyPem: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: keyPair.publicKey.export({ format: 'pem', type: 'spki' }),
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

export class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options = {}) {
    const body = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
    this.objects.set(key, {
      body,
      options,
    });
  }

  getJson(key) {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    return JSON.parse(entry.body);
  }

  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    return {
      text: async () => entry.body,
      json: async () => JSON.parse(entry.body),
      httpMetadata: entry.options.httpMetadata ?? null,
    };
  }
}

export function createExportKeyRingSecret() {
  const signingKeys = toPemPair(generateKeyPairSync('ed25519'));
  return JSON.stringify({
    signing: {
      active: 'sig-v1',
      keys: {
        'sig-v1': {
          private_key_pem: signingKeys.privateKeyPem,
          public_key_pem: signingKeys.publicKeyPem,
        },
      },
    },
    encryption: {
      active: 'enc-v1',
      keys: {
        'enc-v1': {
          key_base64: randomBytes(32).toString('base64'),
        },
      },
    },
  });
}

export function defaultPolicy({
  principalId,
  principalType = 'human',
  subjectValue,
  allowedScopes = ['ops.read', 'ops.export.write', 'ops.restore.write', 'ops.rebuild.write', 'ops.repair.write', 'ops.appservice.write'],
  constraints = {
    global: true,
    appservice_id: ['as-main'],
    room_id: ['!room:test'],
    user_id: ['@alice:test'],
    server_name: ['remote.example'],
  },
  teamDomain,
  audience,
  requireTicket = false,
}) {
  return {
    principal_id: principalId,
    principal_type: principalType,
    access_issuer: `https://${teamDomain}`,
    access_audience: audience,
    access_subject_binding: principalType === 'service'
      ? { mode: 'claim_priority', claims: ['common_name', 'sub'] }
      : { mode: 'sub' },
    access_subject_value: subjectValue,
    allowed_scopes: allowedScopes,
    target_scope_constraints: constraints,
    expires_at: null,
    disabled_at: null,
    require_reason: false,
    require_ticket: requireTicket,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function createControlPlaneRig({
  teamDomain = `team-${Date.now()}.cloudflareaccess.com`,
  audience = 'aud-ops',
  policies = [],
  jwkSequence = null,
  envOverrides = {},
} = {}) {
  const accessKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const accessPrivatePem = accessKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const accessPublicJwk = accessKeyPair.publicKey.export({ format: 'jwk' });
  accessPublicJwk.kid = 'kid-current';
  accessPublicJwk.alg = 'RS256';
  accessPublicJwk.use = 'sig';

  const staleKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const stalePublicJwk = staleKeyPair.publicKey.export({ format: 'jwk' });
  stalePublicJwk.kid = 'kid-stale';
  stalePublicJwk.alg = 'RS256';
  stalePublicJwk.use = 'sig';

  const d1 = createFakeD1Database();
  const persistence = createD1ControlPlanePersistence(d1);
  await persistence.ensureSchema();

  for (const policy of policies) {
    await persistence.upsertOperatorPolicy(policy);
  }

  const archiveBucket = new FakeR2Bucket();
  const rebuildQueue = new FakeQueueBinding('matrix-rebuild-shard-job');
  const exportQueue = new FakeQueueBinding('matrix-export-shard-job');
  const restoreQueue = new FakeQueueBinding('matrix-restore-shard-job');
  const repairQueue = new FakeQueueBinding('matrix-repair-shard-job');

  const certSequence = jwkSequence ?? [
    { keys: [accessPublicJwk] },
  ];
  let fetchCallCount = 0;
  const accessFetch = async () => {
    const payload = certSequence[Math.min(fetchCallCount, certSequence.length - 1)] ?? { keys: [accessPublicJwk] };
    fetchCallCount += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    });
  };

  const commonEnv = {
    ENVIRONMENT_NAME: 'local',
    MATRIX_SERVER_NAME: 'matrix.example.test',
    RELEASE_PROFILE: 'L1',
    WORKER_VERSION_ID: 'build-test',
    DEPLOYMENT_ID: 'deployment-test',
    LOG_LEVEL: 'debug',
    CPU_LIMIT_CLASS: 'default',
    MANAGEMENT_API_BASE_URL: 'https://ops.example.test',
    MATRIX_PUBLIC_BASE_URL: 'https://matrix.example.test',
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUDIENCE: audience,
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
    MATRIX_CONTROL_D1: d1,
    MATRIX_ARCHIVE_BUCKET: archiveBucket,
    REBUILD_SHARD_QUEUE: rebuildQueue,
    EXPORT_SHARD_QUEUE: exportQueue,
    RESTORE_SHARD_QUEUE: restoreQueue,
    REPAIR_SHARD_QUEUE: repairQueue,
    EXPORT_BUNDLE_KEY_RING: createExportKeyRingSecret(),
    HOMESERVER_SIGNING_KEY_RING: 'hs-key-ring',
    SESSION_ROOT_KEY_RING: 'session-root-key-ring',
    UIA_ROOT_KEY_RING: 'uia-root-key-ring',
    APPSERVICE_TOKEN_SET: 'appservice-token-set',
    __ACCESS_FETCH__: accessFetch,
    ...envOverrides,
  };

  const jobsEnv = {
    ...commonEnv,
  };
  const opsEnv = {
    ...commonEnv,
    JOBS_WORKER: {
      fetch: (request) => jobsWorkerModule.fetch(request, jobsEnv),
    },
  };

  function createAccessJwt({
    subject = '@operator:example.test',
    commonName = null,
    audienceOverride = audience,
    issuerOverride = `https://${teamDomain}`,
    kid = 'kid-current',
    expiresInSeconds = 300,
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: issuerOverride,
      aud: audienceOverride,
      exp: now + expiresInSeconds,
      nbf: now - 10,
      sub: subject,
    };
    if (commonName) {
      payload.common_name = commonName;
    }
    return createJwtForTest({
      header: {
        alg: 'RS256',
        typ: 'JWT',
        kid,
      },
      payload,
      privateKeyPem: accessPrivatePem,
    });
  }

  function makeOpsRequest(pathname, {
    method = 'GET',
    body = null,
    headers = {},
    assertion = createAccessJwt(),
  } = {}) {
    const requestHeaders = new Headers(headers);
    if (assertion) {
      requestHeaders.set('Cf-Access-Jwt-Assertion', assertion);
    }
    if (body != null) {
      requestHeaders.set('content-type', 'application/json; charset=utf-8');
    }
    return new Request(`https://ops.example.test${pathname}`, {
      method,
      headers: requestHeaders,
      body: body == null ? null : JSON.stringify(body),
    });
  }

  return {
    d1,
    persistence,
    opsWorker: opsWorkerModule.fetch,
    jobsWorker: jobsWorkerModule,
    opsEnv,
    jobsEnv,
    archiveBucket,
    queues: {
      rebuild: rebuildQueue,
      export: exportQueue,
      restore: restoreQueue,
      repair: repairQueue,
    },
    createAccessJwt,
    makeOpsRequest,
    getFetchCallCount() {
      return fetchCallCount;
    },
    close() {
      d1.close();
    },
  };
}
