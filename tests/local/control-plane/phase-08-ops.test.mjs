import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  normalizeOpsHealthResponse,
  normalizeRolloutSkewProbeResponse,
} from '../../../packages/control-plane/src/index.mjs';
import {
  createControlPlaneRig,
  defaultPolicy,
} from './support.mjs';

function buildPreReleaseCloudflareResources() {
  return {
    workers: [
      'matrix-gateway-worker-pre-release',
      'matrix-jobs-worker-pre-release',
      'matrix-ops-worker-pre-release',
    ],
    durable_objects: ['RemoteServerDO', 'RoomDO', 'UserDO'],
    d1_databases: ['matrix-control-and-derived-pre-release'],
    r2_buckets: [
      'matrix-archive-pre-release',
      'matrix-evidence-pre-release',
      'matrix-media-pre-release',
    ],
    kv_namespaces: ['matrix-edge-cache-pre-release'],
    ratelimit_namespaces: [
      '84283001',
      '84283002',
      '84283003',
      '84283004',
      '84283005',
      '84283006',
      '84283007',
    ],
    queues: [
      'matrix-appservice-txn-job-pre-release',
      'matrix-export-shard-job-pre-release',
      'matrix-media-thumbnail-job-pre-release',
      'matrix-rebuild-shard-job-pre-release',
      'matrix-repair-shard-job-pre-release',
      'matrix-restore-shard-job-pre-release',
      'matrix-search-index-job-pre-release',
    ],
  };
}

function buildCostObservationResourceIds() {
  return JSON.stringify({
    worker_scripts: {
      'gateway-worker': 'matrix-gateway-worker-pre-release',
      'jobs-worker': 'matrix-jobs-worker-pre-release',
      'ops-worker': 'matrix-ops-worker-pre-release',
    },
    d1_database_id: 'd1-pre-release-1',
    kv_namespace_id: 'kv-pre-release-1',
    r2_bucket_names: {
      MATRIX_MEDIA_BUCKET: 'matrix-media-pre-release',
      MATRIX_ARCHIVE_BUCKET: 'matrix-archive-pre-release',
    },
    queue_ids: {
      'matrix-search-index-job-pre-release': 'queue-search-1',
      'matrix-media-thumbnail-job-pre-release': 'queue-media-1',
      'matrix-appservice-txn-job-pre-release': 'queue-appservice-1',
      'matrix-rebuild-shard-job-pre-release': 'queue-rebuild-1',
      'matrix-export-shard-job-pre-release': 'queue-export-1',
      'matrix-restore-shard-job-pre-release': 'queue-restore-1',
      'matrix-repair-shard-job-pre-release': 'queue-repair-1',
    },
    cloudflare_resources: buildPreReleaseCloudflareResources(),
  });
}

const BASELINE_GATEWAY_VERSION_ID = 'gateway-baseline-v1';
const BASELINE_GATEWAY_VERSION_TAG = 'mx-gw-d-baseline';
const CANDIDATE_GATEWAY_VERSION_ID = 'gateway-candidate-v2';
const CANDIDATE_GATEWAY_VERSION_TAG = 'mx-gw-d-candidate';

function resolveRolloutGatewayVersionTag(versionId) {
  if (versionId === BASELINE_GATEWAY_VERSION_ID) {
    return BASELINE_GATEWAY_VERSION_TAG;
  }
  if (versionId === CANDIDATE_GATEWAY_VERSION_ID) {
    return CANDIDATE_GATEWAY_VERSION_TAG;
  }
  return `mx-${String(versionId).replace(/[^a-z0-9]+/giu, '-').replace(/^-+|-+$/g, '').slice(0, 20)}`;
}

test('Phase 08 ops health response exposes deployment compatibility and secret-version fields', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      STARTUP_TIME_MS: '17',
      ACTIVE_DEPLOYMENT_COMPOSITION: JSON.stringify([
        {
          worker_name: 'ops-worker',
          worker_version_id: 'ops-v2',
          deployment_id: 'deploy-phase08',
        },
        {
          worker_name: 'jobs-worker',
          worker_version_id: 'jobs-v2',
          deployment_id: 'deploy-phase08',
        },
      ]),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/healthz', {
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );
  assert.equal(response.status, 200);

  const payload = normalizeOpsHealthResponse(await response.json());
  assert.equal(payload.service, 'ops-worker');
  assert.equal(payload.cpu_limit_class, 'default');
  assert.equal(payload.startup_time_ms, 17);
  assert.equal(payload.deployment_composition.length, 2);
  assert.equal(payload.deployment_composition[0].worker_name, 'ops-worker');
  assert.ok(payload.compatibility_flags.includes('global_fetch_strictly_public'));
  assert.deepEqual(payload.feature_gates, {
    appservice_api: false,
    otel_export: false,
    otel_persist: true,
  });
  assert.deepEqual(payload.secret_versions.export_bundle_key_ring, {
    signing: 'sig-v1',
    encryption: 'enc-v1',
  });
  assert.ok(payload.dependencies.some((entry) => entry.name === 'control-plane-schema' && entry.status === 'ok'));
});

test('Phase 08 ops health response fails closed when compatibility flags are missing from the payload', () => {
  assert.throws(
    () => normalizeOpsHealthResponse({
      service: 'ops-worker',
      status: 'ok',
      observed_at: new Date().toISOString(),
      worker_version_id: 'ops-v2',
      deployment_id: 'deploy-phase08',
      compatibility_date: '2026-03-26',
      release_profile: 'L1',
      cpu_limit_class: 'default',
      startup_time_ms: 17,
      deployment_composition: [],
      feature_gates: {},
      secret_versions: {},
      dependencies: [],
    }),
    /compatibility_flags/,
  );
});

test('Phase 08 cost observation fails closed after validating standard usage_model because the official proof surfaces remain unresolved', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const settingsRequests = [];
  const observabilityFetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/')) {
      settingsRequests.push(url);
      return new Response(JSON.stringify({
        success: true,
        result: {
          usage_model: 'standard',
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
      });
    }
    throw new Error(`Unexpected observability request: ${url}`);
  };

  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      CLOUDFLARE_OBSERVABILITY_API_TOKEN: 'cf-observability-token',
      CLOUDFLARE_RESOURCE_IDS_JSON: buildCostObservationResourceIds(),
      __CLOUDFLARE_OBSERVABILITY_FETCH__: observabilityFetch,
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/cost/observation', {
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.code, 'internal');
  assert.equal(payload.retryable, false);
  assert.match(payload.message, /TEST-COST-001 pre-release proof remains fail-closed/);
  assert.deepEqual(payload.details?.blocker_ids, ['OQ-0006']);
  assert.ok(payload.details?.blocker_reasons?.some((entry) => entry.includes('GraphQL')));
  assert.ok(payload.details?.blocker_reasons?.some((entry) => entry.includes('wall-clock duration')));
  assert.ok(payload.details?.official_source_uris?.some((entry) => entry.includes('/analytics/graphql-api/')));
  assert.equal(settingsRequests.length, 3);
});

test('Phase 08 cost observation rejects non-pre-release environments', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'staging',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      CLOUDFLARE_OBSERVABILITY_API_TOKEN: 'cf-observability-token',
      CLOUDFLARE_RESOURCE_IDS_JSON: buildCostObservationResourceIds(),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/cost/observation', {
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.code, 'internal');
  assert.equal(payload.retryable, false);
  assert.match(payload.message, /only supported in pre-release/);
});

test('Phase 08 cost observation fails closed on unsupported methods', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/cost/observation', {
      method: 'POST',
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.code, 'internal');
  assert.equal(payload.retryable, false);
  assert.match(payload.message, /Unsupported cost observation method/);
});

test('Phase 08 cost observation fails closed when required Cloudflare cost configuration is missing', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      CLOUDFLARE_RESOURCE_IDS_JSON: buildCostObservationResourceIds(),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/cost/observation', {
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.code, 'internal');
  assert.equal(payload.retryable, true);
  assert.match(payload.message, /CLOUDFLARE_OBSERVABILITY_API_TOKEN/);
});

test('Phase 08 cost observation fails closed when any worker script usage_model is not standard', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const observabilityFetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/')) {
      const usageModel = url.endsWith('/matrix-ops-worker-pre-release/settings') ? 'bundled' : 'standard';
      return new Response(JSON.stringify({
        success: true,
        result: {
          usage_model: usageModel,
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
      });
    }
    throw new Error(`Unexpected observability request: ${url}`);
  };

  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      CLOUDFLARE_OBSERVABILITY_API_TOKEN: 'cf-observability-token',
      CLOUDFLARE_RESOURCE_IDS_JSON: buildCostObservationResourceIds(),
      __CLOUDFLARE_OBSERVABILITY_FETCH__: observabilityFetch,
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/cost/observation', {
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.code, 'internal');
  assert.equal(payload.retryable, false);
  assert.match(payload.message, /usage_model must be standard/);
});

test('Phase 08 rollout skew probe returns attested new-worker/old-authority and old-worker/new-authority observations', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const expectedScriptName = 'matrix-gateway-worker-pre-release';
  const sharedSecret = 'phase08-rollout-secret';
  const serverName = 'matrix.example.test';
  const userVersionById = new Map();
  const roomVersionById = new Map();
  const usersByUsername = new Map();
  const usersByToken = new Map();
  const roomsByAlias = new Map();
  const roomsById = new Map();
  const createdUserVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];
  const createdRoomVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];

  const readRequestJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const parseRequestedVersion = (request) => {
    const overrideHeader = String(request.headers['cloudflare-workers-version-overrides'] ?? '');
    const escapedScriptName = expectedScriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedScriptName}="([^"]+)"$`, 'u').exec(overrideHeader);
    assert.ok(match, `expected Cloudflare version override header for ${expectedScriptName}, received ${overrideHeader}`);
    assert.equal(request.headers['x-matrix-rollout-probe-secret'], sharedSecret);
    return match[1];
  };

  const writeJson = (response, status, payload, observedVersionId) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-matrix-rollout-probe-gateway-version-id': observedVersionId,
      'x-matrix-rollout-probe-gateway-version-tag': resolveRolloutGatewayVersionTag(observedVersionId),
    });
    response.end(JSON.stringify(payload));
  };

  const fakeGateway = createServer(async (request, response) => {
    try {
      const observedVersionId = parseRequestedVersion(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      const authorization = String(request.headers.authorization ?? '');
      const accessToken = authorization.replace(/^Bearer\s+/iu, '');
      const authenticatedUser = usersByToken.get(accessToken) ?? null;

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const body = await readRequestJson(request);
        if (body.auth == null) {
          writeJson(response, 401, {
            session: `uia-${body.username}`,
            flows: [{ stages: ['m.login.dummy'] }],
          }, observedVersionId);
          return;
        }
        let user = usersByUsername.get(body.username) ?? null;
        if (user == null) {
          const assignedVersionId = createdUserVersionSequence.shift() ?? observedVersionId;
          user = {
            username: body.username,
            userId: `@${body.username}:${serverName}`,
            accessToken: `atk-${body.username}`,
            versionId: assignedVersionId,
          };
          usersByUsername.set(body.username, user);
          userVersionById.set(user.userId, assignedVersionId);
        }
        usersByToken.set(user.accessToken, user);
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
        const body = await readRequestJson(request);
        const username = body.identifier?.user;
        const user = usersByUsername.get(username) ?? null;
        assert.ok(user, `expected probe user ${username} to exist`);
        usersByToken.set(user.accessToken, user);
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
        assert.ok(authenticatedUser, 'createRoom requires authenticated probe user');
        const body = await readRequestJson(request);
        const roomAlias = `#${body.room_alias_name}:${serverName}`;
        let room = roomsByAlias.get(roomAlias) ?? null;
        if (room == null) {
          const assignedVersionId = createdRoomVersionSequence.shift() ?? observedVersionId;
          room = {
            roomId: `!${body.room_alias_name}:${serverName}`,
            versionId: assignedVersionId,
          };
          roomsByAlias.set(roomAlias, room);
          roomsById.set(room.roomId, room);
          roomVersionById.set(room.roomId, assignedVersionId);
        }
        writeJson(response, 200, {
          room_id: room.roomId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/_matrix/client/v3/join/')) {
        assert.ok(authenticatedUser, 'join requires authenticated probe user');
        const roomAlias = decodeURIComponent(url.pathname.slice('/_matrix/client/v3/join/'.length));
        const room = roomsByAlias.get(roomAlias) ?? null;
        assert.ok(room, `expected probe room ${roomAlias} to exist`);
        writeJson(response, 200, {
          room_id: room.roomId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
        assert.ok(authenticatedUser, 'whoami requires authenticated probe user');
        writeJson(response, 200, {
          user_id: authenticatedUser.userId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'GET' && /\/_matrix\/client\/v3\/rooms\/.+\/state$/u.test(url.pathname)) {
        assert.ok(authenticatedUser, 'room state requires authenticated probe user');
        const encodedRoomId = url.pathname
          .replace('/_matrix/client/v3/rooms/', '')
          .replace(/\/state$/u, '');
        const roomId = decodeURIComponent(encodedRoomId);
        assert.ok(roomsById.has(roomId), `expected probe room ${roomId} to exist`);
        writeJson(response, 200, [], observedVersionId);
        return;
      }

      writeJson(response, 404, {
        errcode: 'M_UNRECOGNIZED',
        error: 'Not found',
      }, observedVersionId);
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        error: error.message,
      }));
    }
  });

  await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      fakeGateway.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  class FakeRuntimeIdentityNamespace {
    constructor(authorityKind, versionMap) {
      this.authorityKind = authorityKind;
      this.versionMap = versionMap;
    }

    idFromName(name) {
      return String(name);
    }

    get(id) {
      const authorityKind = this.authorityKind;
      const versionMap = this.versionMap;
      return {
        async inspectRuntimeIdentity() {
          const workerVersionId = versionMap.get(String(id)) ?? null;
          return {
            ok: true,
            authority_kind: authorityKind,
            worker_version_id: workerVersionId,
            deployment_id: workerVersionId == null ? null : `dep-${workerVersionId}`,
            environment_name: 'pre-release',
          };
        },
      };
    }
  }

  const address = fakeGateway.address();
  assert.ok(address && typeof address === 'object');
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      MATRIX_SERVER_NAME: serverName,
      MATRIX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      GATEWAY_WORKER_SCRIPT_NAME: expectedScriptName,
      ROLLOUT_PROBE_SHARED_SECRET: sharedSecret,
      USER_DO: new FakeRuntimeIdentityNamespace('UserDO', userVersionById),
      ROOM_DO: new FakeRuntimeIdentityNamespace('RoomDO', roomVersionById),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-probe-1',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-1',
        authority_kind: 'matrix-core',
        seed_prefix: 'probe-gha-pre-release-rollout-20260403t034058z-23932691478-1',
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 200);
  const payload = normalizeRolloutSkewProbeResponse(await response.json());
  assert.equal(payload.environment_name, 'pre-release');
  assert.equal(payload.dual_version_deployment_id, 'dual-deployment-1');
  assert.equal(payload.baseline_gateway_version_tag, BASELINE_GATEWAY_VERSION_TAG);
  assert.equal(payload.candidate_gateway_version_tag, CANDIDATE_GATEWAY_VERSION_TAG);
  assert.equal(payload.assertions.new_worker_old_authority, true);
  assert.equal(payload.assertions.old_worker_new_authority, true);
  assert.equal(payload.observations.length, 4);
  assert.ok(payload.observations.some((entry) => entry.probe_name === 'new-worker-old-authority' && entry.authority_kind === 'UserDO'));
  assert.ok(payload.observations.some((entry) => entry.probe_name === 'new-worker-old-authority' && entry.authority_kind === 'RoomDO'));
  assert.ok(payload.observations.some((entry) => entry.probe_name === 'old-worker-new-authority' && entry.authority_kind === 'UserDO'));
  assert.ok(payload.observations.some((entry) => entry.probe_name === 'old-worker-new-authority' && entry.authority_kind === 'RoomDO'));
  assert.deepEqual(createdUserVersionSequence, [], 'probe should sample enough distinct users to find both baseline and candidate authority versions');
  assert.deepEqual(createdRoomVersionSequence, [], 'probe should sample enough distinct rooms to find both baseline and candidate authority versions');
});

test('Phase 08 rollout skew probe tolerates missing seed-route identity when final observation routes prove the targeted worker version via official version tag fallback', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const expectedScriptName = 'matrix-gateway-worker-pre-release';
  const sharedSecret = 'phase08-rollout-secret';
  const serverName = 'matrix.example.test';
  const userVersionById = new Map();
  const roomVersionById = new Map();
  const usersByUsername = new Map();
  const usersByToken = new Map();
  const roomsByAlias = new Map();
  const roomsById = new Map();
  const createdUserVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];
  const createdRoomVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];

  const readRequestJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const parseRequestedVersion = (request) => {
    const overrideHeader = String(request.headers['cloudflare-workers-version-overrides'] ?? '');
    const escapedScriptName = expectedScriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedScriptName}="([^"]+)"$`, 'u').exec(overrideHeader);
    assert.ok(match, `expected Cloudflare version override header for ${expectedScriptName}, received ${overrideHeader}`);
    assert.equal(request.headers['x-matrix-rollout-probe-secret'], sharedSecret);
    return match[1];
  };

  const writeJson = (response, status, payload, observedVersionId, {
    includeGatewayVersionHeader = true,
    includeGatewayVersionTagHeader = true,
  } = {}) => {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
    };
    if (includeGatewayVersionHeader) {
      headers['x-matrix-rollout-probe-gateway-version-id'] = observedVersionId;
    }
    if (includeGatewayVersionTagHeader) {
      headers['x-matrix-rollout-probe-gateway-version-tag'] = resolveRolloutGatewayVersionTag(observedVersionId);
    }
    response.writeHead(status, headers);
    response.end(JSON.stringify(payload));
  };

  const fakeGateway = createServer(async (request, response) => {
    try {
      const observedVersionId = parseRequestedVersion(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      const authorization = String(request.headers.authorization ?? '');
      const accessToken = authorization.replace(/^Bearer\s+/iu, '');
      const authenticatedUser = usersByToken.get(accessToken) ?? null;

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const body = await readRequestJson(request);
        if (body.auth == null) {
          writeJson(response, 401, {
            session: `uia-${body.username}`,
            flows: [{ stages: ['m.login.dummy'] }],
          }, observedVersionId, {
            includeGatewayVersionHeader: false,
            includeGatewayVersionTagHeader: false,
          });
          return;
        }
        let user = usersByUsername.get(body.username) ?? null;
        if (user == null) {
          const assignedVersionId = createdUserVersionSequence.shift() ?? observedVersionId;
          user = {
            username: body.username,
            userId: `@${body.username}:${serverName}`,
            accessToken: `atk-${body.username}`,
            versionId: assignedVersionId,
          };
          usersByUsername.set(body.username, user);
          userVersionById.set(user.userId, assignedVersionId);
        }
        usersByToken.set(user.accessToken, user);
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId, {
          includeGatewayVersionHeader: false,
          includeGatewayVersionTagHeader: false,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
        const body = await readRequestJson(request);
        const username = body.identifier?.user;
        const user = usersByUsername.get(username) ?? null;
        assert.ok(user, `expected probe user ${username} to exist`);
        usersByToken.set(user.accessToken, user);
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId, {
          includeGatewayVersionHeader: false,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
        assert.ok(authenticatedUser, 'createRoom requires authenticated probe user');
        const body = await readRequestJson(request);
        const roomAlias = `#${body.room_alias_name}:${serverName}`;
        let room = roomsByAlias.get(roomAlias) ?? null;
        if (room == null) {
          const assignedVersionId = createdRoomVersionSequence.shift() ?? observedVersionId;
          room = {
            roomId: `!${body.room_alias_name}:${serverName}`,
            versionId: assignedVersionId,
          };
          roomsByAlias.set(roomAlias, room);
          roomsById.set(room.roomId, room);
          roomVersionById.set(room.roomId, assignedVersionId);
        }
        writeJson(response, 200, {
          room_id: room.roomId,
        }, observedVersionId, {
          includeGatewayVersionHeader: false,
          includeGatewayVersionTagHeader: false,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/_matrix/client/v3/join/')) {
        assert.ok(authenticatedUser, 'join requires authenticated probe user');
        const roomAlias = decodeURIComponent(url.pathname.slice('/_matrix/client/v3/join/'.length));
        const room = roomsByAlias.get(roomAlias) ?? null;
        assert.ok(room, `expected probe room ${roomAlias} to exist`);
        writeJson(response, 200, {
          room_id: room.roomId,
        }, observedVersionId, {
          includeGatewayVersionHeader: false,
          includeGatewayVersionTagHeader: false,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
        assert.ok(authenticatedUser, 'whoami requires authenticated probe user');
        writeJson(response, 200, {
          user_id: authenticatedUser.userId,
        }, observedVersionId, {
          includeGatewayVersionHeader: false,
        });
        return;
      }

      if (request.method === 'GET' && /\/_matrix\/client\/v3\/rooms\/.+\/state$/u.test(url.pathname)) {
        assert.ok(authenticatedUser, 'room state requires authenticated probe user');
        const encodedRoomId = url.pathname
          .replace('/_matrix/client/v3/rooms/', '')
          .replace(/\/state$/u, '');
        const roomId = decodeURIComponent(encodedRoomId);
        assert.ok(roomsById.has(roomId), `expected probe room ${roomId} to exist`);
        writeJson(response, 200, [], observedVersionId, {
          includeGatewayVersionHeader: false,
        });
        return;
      }

      writeJson(response, 404, {
        errcode: 'M_UNRECOGNIZED',
        error: 'Not found',
      }, observedVersionId);
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        error: error.message,
      }));
    }
  });

  await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      fakeGateway.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  class FakeRuntimeIdentityNamespace {
    constructor(authorityKind, versionMap) {
      this.authorityKind = authorityKind;
      this.versionMap = versionMap;
    }

    idFromName(name) {
      return String(name);
    }

    get(id) {
      const authorityKind = this.authorityKind;
      const versionMap = this.versionMap;
      return {
        async inspectRuntimeIdentity() {
          const workerVersionId = versionMap.get(String(id)) ?? null;
          return {
            ok: true,
            authority_kind: authorityKind,
            worker_version_id: workerVersionId,
            deployment_id: workerVersionId == null ? null : `dep-${workerVersionId}`,
            environment_name: 'pre-release',
          };
        },
      };
    }
  }

  const address = fakeGateway.address();
  assert.ok(address && typeof address === 'object');
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      MATRIX_SERVER_NAME: serverName,
      MATRIX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      GATEWAY_WORKER_SCRIPT_NAME: expectedScriptName,
      ROLLOUT_PROBE_SHARED_SECRET: sharedSecret,
      USER_DO: new FakeRuntimeIdentityNamespace('UserDO', userVersionById),
      ROOM_DO: new FakeRuntimeIdentityNamespace('RoomDO', roomVersionById),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-probe-missing-seed-header',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-1',
        authority_kind: 'matrix-core',
        seed_prefix: 'probe-gha-pre-release-rollout-missing-seed-header',
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 200);
  const payload = normalizeRolloutSkewProbeResponse(await response.json());
  assert.equal(payload.assertions.new_worker_old_authority, true);
  assert.equal(payload.assertions.old_worker_new_authority, true);
  assert.equal(payload.observations.length, 4);
  assert.ok(
    payload.observations.every((entry) => entry.observed_gateway_version_id == null && typeof entry.observed_gateway_version_tag === 'string'),
    'final observation routes should be able to prove the targeted worker version through official version tags when official ids are absent',
  );
  assert.deepEqual(createdUserVersionSequence, []);
  assert.deepEqual(createdRoomVersionSequence, []);
});

test('Phase 08 rollout skew probe fails closed when a seed route echoes the wrong official gateway version tag', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const expectedScriptName = 'matrix-gateway-worker-pre-release';
  const sharedSecret = 'phase08-rollout-secret';

  const readRequestJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const parseRequestedVersion = (request) => {
    const overrideHeader = String(request.headers['cloudflare-workers-version-overrides'] ?? '');
    const escapedScriptName = expectedScriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedScriptName}="([^"]+)"$`, 'u').exec(overrideHeader);
    assert.ok(match, `expected Cloudflare version override header for ${expectedScriptName}, received ${overrideHeader}`);
    assert.equal(request.headers['x-matrix-rollout-probe-secret'], sharedSecret);
    return match[1];
  };

  const fakeGateway = createServer(async (request, response) => {
    try {
      const requestedVersionId = parseRequestedVersion(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const body = await readRequestJson(request);
        response.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'x-matrix-rollout-probe-gateway-version-tag': `${resolveRolloutGatewayVersionTag(requestedVersionId)}-unexpected`,
        });
        response.end(JSON.stringify({
          session: `uia-${body.username}`,
          flows: [{ stages: ['m.login.dummy'] }],
        }));
        return;
      }

      response.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        errcode: 'M_UNRECOGNIZED',
        error: 'Not found',
      }));
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        error: error.message,
      }));
    }
  });

  await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      fakeGateway.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  class FakeRuntimeIdentityNamespace {
    idFromName(name) {
      return String(name);
    }

    get() {
      return {
        async inspectRuntimeIdentity() {
          assert.fail('runtime identity inspection should not be reached when seed route header echo is mismatched');
        },
      };
    }
  }

  const address = fakeGateway.address();
  assert.ok(address && typeof address === 'object');
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      MATRIX_SERVER_NAME: 'matrix.example.test',
      MATRIX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      GATEWAY_WORKER_SCRIPT_NAME: expectedScriptName,
      ROLLOUT_PROBE_SHARED_SECRET: sharedSecret,
      USER_DO: new FakeRuntimeIdentityNamespace(),
      ROOM_DO: new FakeRuntimeIdentityNamespace(),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-probe-seed-header-mismatch',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-seed-mismatch',
        authority_kind: 'matrix-core',
        seed_prefix: 'probe-gha-pre-release-rollout-seed-header-mismatch',
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, 'precondition_failed');
  assert.match(
    payload.message,
    /^Gateway version override mismatch for \/_matrix\/client\/v3\/register: requested gateway-(baseline|candidate)-v[12] \(mx-gw-d-(baseline|candidate)\), observed tag mx-gw-d-(baseline|candidate)-unexpected$/u,
  );
  assert.equal(typeof payload.request_id, 'string');
  assert.ok(payload.request_id.length > 0);
  assert.equal(payload.retryable, false);
  assert.equal(payload.details, null);
});

test('Phase 08 rollout skew probe keeps probe-owned usernames and room aliases unique across reruns even when seed prefixes collide after truncation', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const expectedScriptName = 'matrix-gateway-worker-pre-release';
  const sharedSecret = 'phase08-rollout-secret';
  const serverName = 'matrix.example.test';
  const userVersionById = new Map();
  const roomVersionById = new Map();
  const usersByUsername = new Map();
  const usersByToken = new Map();
  const roomsByAlias = new Map();
  const roomsById = new Map();
  const observedUsernames = [];
  const observedRoomAliasLocalparts = [];
  let loginAttempts = 0;
  const createdUserVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];
  const createdRoomVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];

  const readRequestJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const parseRequestedVersion = (request) => {
    const overrideHeader = String(request.headers['cloudflare-workers-version-overrides'] ?? '');
    const escapedScriptName = expectedScriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedScriptName}="([^"]+)"$`, 'u').exec(overrideHeader);
    assert.ok(match, `expected Cloudflare version override header for ${expectedScriptName}, received ${overrideHeader}`);
    assert.equal(request.headers['x-matrix-rollout-probe-secret'], sharedSecret);
    return match[1];
  };

  const writeJson = (response, status, payload, observedVersionId) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-matrix-rollout-probe-gateway-version-id': observedVersionId,
      'x-matrix-rollout-probe-gateway-version-tag': resolveRolloutGatewayVersionTag(observedVersionId),
    });
    response.end(JSON.stringify(payload));
  };

  const fakeGateway = createServer(async (request, response) => {
    try {
      const observedVersionId = parseRequestedVersion(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      const authorization = String(request.headers.authorization ?? '');
      const accessToken = authorization.replace(/^Bearer\s+/iu, '');
      const authenticatedUser = usersByToken.get(accessToken) ?? null;

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const body = await readRequestJson(request);
        if (body.auth == null) {
          writeJson(response, 401, {
            session: `uia-${body.username}`,
            flows: [{ stages: ['m.login.dummy'] }],
          }, observedVersionId);
          return;
        }
        observedUsernames.push(body.username);
        if (usersByUsername.has(body.username)) {
          writeJson(response, 409, {
            errcode: 'M_USER_IN_USE',
            error: 'User already exists',
          }, observedVersionId);
          return;
        }
        const assignedVersionId = createdUserVersionSequence.shift() ?? observedVersionId;
        const user = {
          username: body.username,
          password: body.password,
          userId: `@${body.username}:${serverName}`,
          accessToken: `atk-${body.username}`,
          versionId: assignedVersionId,
        };
        usersByUsername.set(user.username, user);
        userVersionById.set(user.userId, assignedVersionId);
        usersByToken.set(user.accessToken, user);
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
        loginAttempts += 1;
        const body = await readRequestJson(request);
        const username = body.identifier?.user;
        const user = usersByUsername.get(username) ?? null;
        if (user == null || user.password !== body.password) {
          writeJson(response, 403, {
            errcode: 'M_FORBIDDEN',
            error: 'Invalid username or password',
          }, observedVersionId);
          return;
        }
        usersByToken.set(user.accessToken, user);
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
        assert.ok(authenticatedUser, 'createRoom requires authenticated probe user');
        const body = await readRequestJson(request);
        observedRoomAliasLocalparts.push(body.room_alias_name);
        const roomAlias = `#${body.room_alias_name}:${serverName}`;
        if (roomsByAlias.has(roomAlias)) {
          writeJson(response, 409, {
            errcode: 'M_ROOM_IN_USE',
            error: 'Room alias already exists',
          }, observedVersionId);
          return;
        }
        const assignedVersionId = createdRoomVersionSequence.shift() ?? observedVersionId;
        const room = {
          roomId: `!${body.room_alias_name}:${serverName}`,
          versionId: assignedVersionId,
        };
        roomsByAlias.set(roomAlias, room);
        roomsById.set(room.roomId, room);
        roomVersionById.set(room.roomId, assignedVersionId);
        writeJson(response, 200, {
          room_id: room.roomId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/_matrix/client/v3/join/')) {
        assert.ok(authenticatedUser, 'join requires authenticated probe user');
        const roomAlias = decodeURIComponent(url.pathname.slice('/_matrix/client/v3/join/'.length));
        const room = roomsByAlias.get(roomAlias) ?? null;
        assert.ok(room, `expected probe room ${roomAlias} to exist`);
        writeJson(response, 200, {
          room_id: room.roomId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
        assert.ok(authenticatedUser, 'whoami requires authenticated probe user');
        writeJson(response, 200, {
          user_id: authenticatedUser.userId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'GET' && /\/_matrix\/client\/v3\/rooms\/.+\/state$/u.test(url.pathname)) {
        assert.ok(authenticatedUser, 'room state requires authenticated probe user');
        const encodedRoomId = url.pathname
          .replace('/_matrix/client/v3/rooms/', '')
          .replace(/\/state$/u, '');
        const roomId = decodeURIComponent(encodedRoomId);
        assert.ok(roomsById.has(roomId), `expected probe room ${roomId} to exist`);
        writeJson(response, 200, [], observedVersionId);
        return;
      }

      writeJson(response, 404, {
        errcode: 'M_UNRECOGNIZED',
        error: 'Not found',
      }, observedVersionId);
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        error: error.message,
      }));
    }
  });

  await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      fakeGateway.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  class FakeRuntimeIdentityNamespace {
    constructor(authorityKind, versionMap) {
      this.authorityKind = authorityKind;
      this.versionMap = versionMap;
    }

    idFromName(name) {
      return String(name);
    }

    get(id) {
      const authorityKind = this.authorityKind;
      const versionMap = this.versionMap;
      return {
        async inspectRuntimeIdentity() {
          const workerVersionId = versionMap.get(String(id)) ?? null;
          return {
            ok: true,
            authority_kind: authorityKind,
            worker_version_id: workerVersionId,
            deployment_id: workerVersionId == null ? null : `dep-${workerVersionId}`,
            environment_name: 'pre-release',
          };
        },
      };
    }
  }

  const address = fakeGateway.address();
  assert.ok(address && typeof address === 'object');
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      MATRIX_SERVER_NAME: serverName,
      MATRIX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      GATEWAY_WORKER_SCRIPT_NAME: expectedScriptName,
      ROLLOUT_PROBE_SHARED_SECRET: sharedSecret,
      USER_DO: new FakeRuntimeIdentityNamespace('UserDO', userVersionById),
      ROOM_DO: new FakeRuntimeIdentityNamespace('RoomDO', roomVersionById),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const sharedSeedPrefix = `probe-gha-pre-release-rollout-${'shared-prefix-'.repeat(24)}`;
  assert.ok(sharedSeedPrefix.length > 256, 'test requires a seed_prefix long enough to truncate probe_run_id entropy in the previous implementation');
  const firstResponse = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-gha-pre-release-alpha-12345678',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-alpha',
        authority_kind: 'matrix-core',
        seed_prefix: sharedSeedPrefix,
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );
  assert.equal(firstResponse.status, 200);

  const secondResponse = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-gha-pre-release-beta-87654321',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-beta',
        authority_kind: 'matrix-core',
        seed_prefix: sharedSeedPrefix,
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );
  assert.equal(secondResponse.status, 200);

  assert.equal(loginAttempts, 0, 'probe should not fall back to login because rerun probe identities must stay unique');
  assert.equal(new Set(observedUsernames).size, observedUsernames.length, 'probe-owned usernames should remain unique across reruns');
  assert.equal(new Set(observedRoomAliasLocalparts).size, observedRoomAliasLocalparts.length, 'probe-owned room aliases should remain unique across reruns');
  assert.deepEqual(createdUserVersionSequence, []);
  assert.deepEqual(createdRoomVersionSequence, []);
});

test('Phase 08 rollout skew probe retries the next seed attempt when a conflicting probe username falls back to a plain-text login failure', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const expectedScriptName = 'matrix-gateway-worker-pre-release';
  const sharedSecret = 'phase08-rollout-secret';
  const serverName = 'matrix.example.test';
  const userVersionById = new Map();
  const roomVersionById = new Map();
  const usersByUsername = new Map();
  const usersByToken = new Map();
  const roomsByAlias = new Map();
  const roomsById = new Map();
  const createdUserVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];
  const createdRoomVersionSequence = [
    CANDIDATE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    BASELINE_GATEWAY_VERSION_ID,
    CANDIDATE_GATEWAY_VERSION_ID,
  ];
  let loginAttempts = 0;
  const retryableConflictUsernames = new Set();

  const readRequestJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const parseRequestedVersion = (request) => {
    const overrideHeader = String(request.headers['cloudflare-workers-version-overrides'] ?? '');
    const escapedScriptName = expectedScriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedScriptName}="([^"]+)"$`, 'u').exec(overrideHeader);
    assert.ok(match, `expected Cloudflare version override header for ${expectedScriptName}, received ${overrideHeader}`);
    assert.equal(request.headers['x-matrix-rollout-probe-secret'], sharedSecret);
    return match[1];
  };

  const writeResponse = (response, status, payload, observedVersionId, {
    contentType = 'application/json; charset=utf-8',
  } = {}) => {
    response.writeHead(status, {
      'content-type': contentType,
      'x-matrix-rollout-probe-gateway-version-id': observedVersionId,
      'x-matrix-rollout-probe-gateway-version-tag': resolveRolloutGatewayVersionTag(observedVersionId),
    });
    response.end(contentType.includes('json') ? JSON.stringify(payload) : String(payload));
  };

  const fakeGateway = createServer(async (request, response) => {
    try {
      const observedVersionId = parseRequestedVersion(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      const authorization = String(request.headers.authorization ?? '');
      const accessToken = authorization.replace(/^Bearer\s+/iu, '');
      const authenticatedUser = usersByToken.get(accessToken) ?? null;

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const body = await readRequestJson(request);
        if (body.auth == null) {
          writeResponse(response, 401, {
            session: `uia-${body.username}`,
            flows: [{ stages: ['m.login.dummy'] }],
          }, observedVersionId);
          return;
        }
        if (body.username.startsWith('baseline-user-1-') && !retryableConflictUsernames.has(body.username)) {
          retryableConflictUsernames.add(body.username);
          writeResponse(response, 409, {
            errcode: 'M_USER_IN_USE',
            error: 'User already exists',
          }, observedVersionId);
          return;
        }
        let user = usersByUsername.get(body.username) ?? null;
        if (user == null) {
          const assignedVersionId = createdUserVersionSequence.shift() ?? observedVersionId;
          user = {
            username: body.username,
            password: body.password,
            userId: `@${body.username}:${serverName}`,
            accessToken: `atk-${body.username}`,
            versionId: assignedVersionId,
          };
          usersByUsername.set(user.username, user);
          userVersionById.set(user.userId, assignedVersionId);
        }
        usersByToken.set(user.accessToken, user);
        writeResponse(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
        loginAttempts += 1;
        const body = await readRequestJson(request);
        const username = body.identifier?.user;
        if (retryableConflictUsernames.has(username)) {
          writeResponse(response, 403, 'error code: 1042', observedVersionId, {
            contentType: 'text/plain; charset=utf-8',
          });
          return;
        }
        const user = usersByUsername.get(username) ?? null;
        assert.ok(user, `expected probe user ${username} to exist`);
        usersByToken.set(user.accessToken, user);
        writeResponse(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
        assert.ok(authenticatedUser, 'createRoom requires authenticated probe user');
        const body = await readRequestJson(request);
        const roomAlias = `#${body.room_alias_name}:${serverName}`;
        let room = roomsByAlias.get(roomAlias) ?? null;
        if (room == null) {
          const assignedVersionId = createdRoomVersionSequence.shift() ?? observedVersionId;
          room = {
            roomId: `!${body.room_alias_name}:${serverName}`,
            versionId: assignedVersionId,
          };
          roomsByAlias.set(roomAlias, room);
          roomsById.set(room.roomId, room);
          roomVersionById.set(room.roomId, assignedVersionId);
        }
        writeResponse(response, 200, {
          room_id: room.roomId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/_matrix/client/v3/join/')) {
        assert.ok(authenticatedUser, 'join requires authenticated probe user');
        const roomAlias = decodeURIComponent(url.pathname.slice('/_matrix/client/v3/join/'.length));
        const room = roomsByAlias.get(roomAlias) ?? null;
        assert.ok(room, `expected probe room ${roomAlias} to exist`);
        writeResponse(response, 200, {
          room_id: room.roomId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
        assert.ok(authenticatedUser, 'whoami requires authenticated probe user');
        writeResponse(response, 200, {
          user_id: authenticatedUser.userId,
        }, observedVersionId);
        return;
      }

      if (request.method === 'GET' && /\/_matrix\/client\/v3\/rooms\/.+\/state$/u.test(url.pathname)) {
        assert.ok(authenticatedUser, 'room state requires authenticated probe user');
        const encodedRoomId = url.pathname
          .replace('/_matrix/client/v3/rooms/', '')
          .replace(/\/state$/u, '');
        const roomId = decodeURIComponent(encodedRoomId);
        assert.ok(roomsById.has(roomId), `expected probe room ${roomId} to exist`);
        writeResponse(response, 200, [], observedVersionId);
        return;
      }

      writeResponse(response, 404, {
        errcode: 'M_UNRECOGNIZED',
        error: 'Not found',
      }, observedVersionId);
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        error: error.message,
      }));
    }
  });

  await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      fakeGateway.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  class FakeRuntimeIdentityNamespace {
    constructor(authorityKind, versionMap) {
      this.authorityKind = authorityKind;
      this.versionMap = versionMap;
    }

    idFromName(name) {
      return String(name);
    }

    get(id) {
      const authorityKind = this.authorityKind;
      const versionMap = this.versionMap;
      return {
        async inspectRuntimeIdentity() {
          const workerVersionId = versionMap.get(String(id)) ?? null;
          return {
            ok: true,
            authority_kind: authorityKind,
            worker_version_id: workerVersionId,
            deployment_id: workerVersionId == null ? null : `dep-${workerVersionId}`,
            environment_name: 'pre-release',
          };
        },
      };
    }
  }

  const address = fakeGateway.address();
  assert.ok(address && typeof address === 'object');
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      MATRIX_SERVER_NAME: serverName,
      MATRIX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      GATEWAY_WORKER_SCRIPT_NAME: expectedScriptName,
      ROLLOUT_PROBE_SHARED_SECRET: sharedSecret,
      USER_DO: new FakeRuntimeIdentityNamespace('UserDO', userVersionById),
      ROOM_DO: new FakeRuntimeIdentityNamespace('RoomDO', roomVersionById),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-probe-plain-text-login-failure',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-plain-text-login-failure',
        authority_kind: 'matrix-core',
        seed_prefix: 'probe-gha-pre-release-rollout-plain-text-login-failure',
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 200);
  const payload = normalizeRolloutSkewProbeResponse(await response.json());
  assert.equal(payload.assertions.new_worker_old_authority, true);
  assert.equal(payload.assertions.old_worker_new_authority, true);
  assert.equal(loginAttempts, 1, 'probe should only fall back to the conflicted login once before moving to the next seed attempt');
  assert.deepEqual(createdUserVersionSequence, []);
  assert.deepEqual(createdRoomVersionSequence, []);
});

test('Phase 08 rollout skew probe fails retryably when bounded sampling cannot reach the requested authority version', async (t) => {
  const teamDomain = `phase08-${Date.now()}.cloudflareaccess.com`;
  const expectedScriptName = 'matrix-gateway-worker-pre-release';
  const sharedSecret = 'phase08-rollout-secret';
  const serverName = 'matrix.example.test';
  const userVersionById = new Map();
  const usersByUsername = new Map();
  const usersByToken = new Map();

  const readRequestJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const parseRequestedVersion = (request) => {
    const overrideHeader = String(request.headers['cloudflare-workers-version-overrides'] ?? '');
    const escapedScriptName = expectedScriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedScriptName}="([^"]+)"$`, 'u').exec(overrideHeader);
    assert.ok(match, `expected Cloudflare version override header for ${expectedScriptName}, received ${overrideHeader}`);
    assert.equal(request.headers['x-matrix-rollout-probe-secret'], sharedSecret);
    return match[1];
  };

  const writeJson = (response, status, payload, observedVersionId) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-matrix-rollout-probe-gateway-version-id': observedVersionId,
      'x-matrix-rollout-probe-gateway-version-tag': resolveRolloutGatewayVersionTag(observedVersionId),
    });
    response.end(JSON.stringify(payload));
  };

  const fakeGateway = createServer(async (request, response) => {
    try {
      const observedVersionId = parseRequestedVersion(request);
      const url = new URL(request.url, 'http://127.0.0.1');

      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const body = await readRequestJson(request);
        if (body.auth == null) {
          writeJson(response, 401, {
            session: `uia-${body.username}`,
            flows: [{ stages: ['m.login.dummy'] }],
          }, observedVersionId);
          return;
        }
        let user = usersByUsername.get(body.username) ?? null;
        if (user == null) {
          user = {
            username: body.username,
            userId: `@${body.username}:${serverName}`,
            accessToken: `atk-${body.username}`,
          };
          usersByUsername.set(body.username, user);
          usersByToken.set(user.accessToken, user);
          userVersionById.set(user.userId, CANDIDATE_GATEWAY_VERSION_ID);
        }
        writeJson(response, 200, {
          user_id: user.userId,
          access_token: user.accessToken,
        }, observedVersionId);
        return;
      }

      writeJson(response, 404, {
        errcode: 'M_UNRECOGNIZED',
        error: 'Not found',
      }, observedVersionId);
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({
        error: error.message,
      }));
    }
  });

  await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      fakeGateway.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  class FakeRuntimeIdentityNamespace {
    constructor(authorityKind, versionMap) {
      this.authorityKind = authorityKind;
      this.versionMap = versionMap;
    }

    idFromName(name) {
      return String(name);
    }

    get(id) {
      const authorityKind = this.authorityKind;
      const versionMap = this.versionMap;
      return {
        async inspectRuntimeIdentity() {
          return {
            ok: true,
            authority_kind: authorityKind,
            worker_version_id: versionMap.get(String(id)) ?? CANDIDATE_GATEWAY_VERSION_ID,
            deployment_id: `dep-${CANDIDATE_GATEWAY_VERSION_ID}`,
            environment_name: 'pre-release',
          };
        },
      };
    }
  }

  const address = fakeGateway.address();
  assert.ok(address && typeof address === 'object');
  const rig = await createControlPlaneRig({
    teamDomain,
    envOverrides: {
      ENVIRONMENT_NAME: 'pre-release',
      MATRIX_SERVER_NAME: serverName,
      MATRIX_PUBLIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      GATEWAY_WORKER_SCRIPT_NAME: expectedScriptName,
      ROLLOUT_PROBE_SHARED_SECRET: sharedSecret,
      USER_DO: new FakeRuntimeIdentityNamespace('UserDO', userVersionById),
      ROOM_DO: new FakeRuntimeIdentityNamespace('RoomDO', new Map()),
    },
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });
  t.after(() => rig.close());

  const response = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/rollout-skew/probe', {
      method: 'POST',
      body: {
        probe_run_id: 'rollout-probe-exhausted',
        baseline_gateway_version_id: BASELINE_GATEWAY_VERSION_ID,
        baseline_gateway_version_tag: BASELINE_GATEWAY_VERSION_TAG,
        candidate_gateway_version_id: CANDIDATE_GATEWAY_VERSION_ID,
        candidate_gateway_version_tag: CANDIDATE_GATEWAY_VERSION_TAG,
        dual_version_deployment_id: 'dual-deployment-1',
        authority_kind: 'matrix-core',
        seed_prefix: 'probe-gha-pre-release-rollout-exhausted',
      },
      assertion: rig.createAccessJwt({
        subject: 'service-subject',
        commonName: 'svc-ci',
      }),
    }),
    rig.opsEnv,
  );

  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, 'precondition_failed');
  assert.equal(payload.retryable, true);
  assert.match(payload.message, /Unable to seed baseline-user on gateway-baseline-v1/);
  assert.match(payload.message, /gateway-candidate-v2/);
});
