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
    'gateway-candidate-v2',
    'gateway-baseline-v1',
    'gateway-baseline-v1',
    'gateway-candidate-v2',
  ];
  const createdRoomVersionSequence = [
    'gateway-candidate-v2',
    'gateway-baseline-v1',
    'gateway-baseline-v1',
    'gateway-candidate-v2',
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
        baseline_gateway_version_id: 'gateway-baseline-v1',
        candidate_gateway_version_id: 'gateway-candidate-v2',
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
          userVersionById.set(user.userId, 'gateway-candidate-v2');
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
            worker_version_id: versionMap.get(String(id)) ?? 'gateway-candidate-v2',
            deployment_id: 'dep-gateway-candidate-v2',
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
        baseline_gateway_version_id: 'gateway-baseline-v1',
        candidate_gateway_version_id: 'gateway-candidate-v2',
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
