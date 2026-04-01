import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  classifyGatewayRequest,
  enforceGatewayAbuseGuard,
  ensureDeploymentRecord,
  INTERNAL_RUNTIME_DERIVED_WORK_PATH,
  instrumentEnvironmentBindings,
  loadWorkerRuntimeConfig,
  snapshotTelemetry,
} from '../../../packages/runtime-core/src/index.mjs';
import {
  createGatewayPhase04Rig,
  createGatewayVersionSkewRig,
} from '../client-identity/support.mjs';

function assertMetric(snapshot, metricName, predicate = () => true) {
  const entry = snapshot.metrics.find((metric) => metric.name === metricName && predicate(metric.dimensions));
  assert.ok(entry, `Expected metric ${metricName} to be present`);
  return entry;
}

async function registerUser(rig, {
  username,
  password = 'phase08-password',
  deviceId = `${username}-device`,
} = {}) {
  const challenge = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(challenge.status, 401);
  const challengeBody = await challenge.json();
  const response = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
      auth: {
        type: 'm.login.dummy',
        session: challengeBody.session,
      },
    },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function loginWithPassword(rig, {
  user,
  password = 'phase08-password',
  deviceId = `${user}-login-device`,
} = {}) {
  return rig.gatewayFetch('/_matrix/client/v3/login', {
    method: 'POST',
    json: {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user,
      },
      password,
      device_id: deviceId,
    },
  });
}

async function postJson(rig, accessToken, pathname, json = {}) {
  return rig.gatewayFetch(pathname, {
    method: 'POST',
    headers: rig.authHeaders(accessToken),
    json,
  });
}

async function putJson(rig, accessToken, pathname, json = {}) {
  return rig.gatewayFetch(pathname, {
    method: 'PUT',
    headers: rig.authHeaders(accessToken),
    json,
  });
}

test('Phase 08 gateway abuse guard classifies L1 surfaces and enforces IP limits', async () => {
  const env = {
    ABUSE_GUARD_POLICY_JSON: JSON.stringify({
      gateway_public_entry: { limit: 1, window_ms: 60_000 },
      gateway_login: { limit: 1, window_ms: 60_000 },
      gateway_search: { limit: 1, window_ms: 60_000 },
      gateway_media: { limit: 1, window_ms: 60_000 },
      gateway_room_write: { limit: 1, window_ms: 60_000 },
    }),
  };
  const cases = [
    ['GET', '/_matrix/client/versions', 'public-entry', 'gateway_public_entry'],
    ['GET', '/_matrix/client/v3/login', 'public-entry', 'gateway_public_entry'],
    ['POST', '/_matrix/client/v3/login', 'login', 'gateway_login'],
    ['POST', '/_matrix/client/v3/search', 'search', 'gateway_search'],
    ['GET', '/_matrix/client/v3/publicRooms', 'search', 'gateway_search'],
    ['GET', '/_matrix/client/v3/rooms/!room:matrix.example.test/hierarchy', 'search', 'gateway_search'],
    ['POST', '/_matrix/media/v3/upload', 'media', 'gateway_media'],
    ['POST', '/_matrix/client/v3/join/%21room%3Amatrix.example.test', 'room-write', 'gateway_room_write'],
    ['POST', '/_matrix/client/v3/knock/%21room%3Amatrix.example.test', 'room-write', 'gateway_room_write'],
    ['POST', '/_matrix/client/v3/rooms/!room:matrix.example.test/forget', 'room-write', 'gateway_room_write'],
    ['PUT', '/_matrix/client/v3/rooms/!room:matrix.example.test/send/m.room.message/txn-1', 'room-write', 'gateway_room_write'],
  ];

  for (const [method, pathname, routeFamily, policyId] of cases) {
    env.__MATRIX_GATEWAY_ABUSE_GUARD__ = new Map();
    const classification = classifyGatewayRequest(method, pathname);
    assert.equal(classification.route_family, routeFamily);
    assert.equal(classification.gateway_policy_id, policyId);

    const request = new Request(`https://matrix.example.test${pathname}`, {
      method,
      headers: {
        'cf-connecting-ip': '198.51.100.10',
      },
    });
    assert.equal(enforceGatewayAbuseGuard(request, env, classification), null);
    const limited = enforceGatewayAbuseGuard(request, env, classification);
    assert.ok(limited instanceof Response);
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.errcode, 'M_LIMIT_EXCEEDED');
    assert.ok(body.error.includes(routeFamily));
  }
});

test('Phase 08 gateway telemetry does not crash when process.cpuUsage is unavailable in Workers runtime', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const originalCpuUsage = process.cpuUsage;
  process.cpuUsage = () => {
    throw new Error('The process.cpuUsage method is not implemented');
  };
  t.after(() => {
    process.cpuUsage = originalCpuUsage;
  });

  const versionsResponse = await rig.gatewayFetch('/_matrix/client/versions');
  assert.equal(versionsResponse.status, 200);
  const versionsBody = await versionsResponse.json();
  assert.deepEqual(versionsBody, {
    versions: ['v1.17'],
    unstable_features: {},
  });

  const snapshot = snapshotTelemetry(rig.env);
  assertMetric(snapshot, 'worker.request.count', (dimensions) => dimensions.worker === 'gateway-worker');
  assertMetric(snapshot, 'worker.wall_ms', (dimensions) => dimensions.worker === 'gateway-worker');
  assert.equal(
    snapshot.metrics.some((metric) => metric.name === 'worker.cpu_ms' && metric.dimensions.worker === 'gateway-worker'),
    false,
  );
});

test('Phase 08 semantic quotas remain application-visible for register/login/media/membership/send', async (t) => {
  const basePolicy = {
    gateway_register: { limit: 100, window_ms: 60_000 },
    gateway_login: { limit: 100, window_ms: 60_000 },
    gateway_media: { limit: 100, window_ms: 60_000 },
    gateway_room_write: { limit: 100, window_ms: 60_000 },
    userdo_register: { limit: 1, window_ms: 60_000 },
    userdo_login: { limit: 1, window_ms: 60_000 },
    userdo_media: { limit: 1, window_ms: 60_000 },
  };
  const rig = createGatewayPhase04Rig({
    ABUSE_GUARD_POLICY_JSON: JSON.stringify({
      ...basePolicy,
      roomdo_membership: { limit: 100, window_ms: 60_000 },
      roomdo_send: { limit: 100, window_ms: 60_000 },
    }),
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase08-alice' });
  const registerChallenge = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username: 'phase08-alice',
      password: 'phase08-password',
      device_id: 'phase08-alice-duplicate',
    },
  });
  assert.equal(registerChallenge.status, 401);
  const registerChallengeBody = await registerChallenge.json();
  const registerLimited = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username: 'phase08-alice',
      password: 'phase08-password',
      device_id: 'phase08-alice-duplicate',
      auth: {
        type: 'm.login.dummy',
        session: registerChallengeBody.session,
      },
    },
  });
  assert.equal(registerLimited.status, 429);
  assert.equal((await registerLimited.json()).errcode, 'M_LIMIT_EXCEEDED');

  const loginOk = await loginWithPassword(rig, {
    user: 'phase08-alice',
  });
  assert.equal(loginOk.status, 200);
  const loginLimited = await loginWithPassword(rig, {
    user: 'phase08-alice',
  });
  assert.equal(loginLimited.status, 429);
  assert.equal((await loginLimited.json()).errcode, 'M_LIMIT_EXCEEDED');

  const bob = await registerUser(rig, { username: 'phase08-bob' });
  const createRoomResponse = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    name: 'Phase 08 Quota Room',
  });
  assert.equal(createRoomResponse.status, 200);
  const { room_id: roomId } = await createRoomResponse.json();
  rig.env.ABUSE_GUARD_POLICY_JSON = JSON.stringify({
    ...basePolicy,
    roomdo_membership: { limit: 1, window_ms: 60_000 },
    roomdo_send: { limit: 1, window_ms: 60_000 },
  });
  rig.getRoomDo(roomId).__MATRIX_SEMANTIC_QUOTAS__ = new Map();

  const inviteOk = await postJson(rig, alice.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
    user_id: bob.user_id,
  });
  assert.equal(inviteOk.status, 200);
  const inviteLimited = await postJson(rig, alice.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
    user_id: bob.user_id,
  });
  assert.equal(inviteLimited.status, 429);
  assert.equal((await inviteLimited.json()).errcode, 'M_LIMIT_EXCEEDED');

  const sendOk = await putJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/txn-phase08-1`,
    {
      msgtype: 'm.text',
      body: 'first',
    },
  );
  assert.equal(sendOk.status, 200);
  const sendLimited = await putJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/txn-phase08-2`,
    {
      msgtype: 'm.text',
      body: 'second',
    },
  );
  assert.equal(sendLimited.status, 429);
  assert.equal((await sendLimited.json()).errcode, 'M_LIMIT_EXCEEDED');

  const mediaOk = await postJson(rig, alice.access_token, '/_matrix/media/v3/create');
  assert.equal(mediaOk.status, 200);
  const mediaLimited = await postJson(rig, alice.access_token, '/_matrix/media/v3/create');
  assert.equal(mediaLimited.status, 429);
  assert.equal((await mediaLimited.json()).errcode, 'M_LIMIT_EXCEEDED');
});

test('Phase 08 telemetry records deployment, binding, derived-lag, and cost attribution signals', async (t) => {
  const rig = createGatewayPhase04Rig({
    WORKER_VERSION_ID: 'phase08-gateway',
    DEPLOYMENT_ID: 'phase08-deployment',
    STARTUP_TIME_MS: 12,
    ACTIVE_DEPLOYMENT_COMPOSITION: JSON.stringify([
      {
        worker_name: 'gateway-worker',
        worker_version_id: 'phase08-gateway',
        deployment_id: 'phase08-deployment',
      },
      {
        worker_name: 'jobs-worker',
        worker_version_id: 'phase08-jobs',
        deployment_id: 'phase08-deployment',
      },
    ]),
  });
  t.after(() => rig.close());

  instrumentEnvironmentBindings(rig.env);
  const config = loadWorkerRuntimeConfig('gateway-worker', rig.env);
  ensureDeploymentRecord(rig.env, {
    workerName: 'gateway-worker',
    config,
  });

  const versionsResponse = await rig.gatewayFetch('/_matrix/client/versions');
  assert.equal(versionsResponse.status, 200);

  await rig.env.MATRIX_CONTROL_D1.exec('CREATE TABLE phase08_metrics (id INTEGER PRIMARY KEY)');
  await rig.env.MATRIX_CONTROL_D1.prepare('INSERT INTO phase08_metrics (id) VALUES (?)').bind(1).run();
  await rig.env.MATRIX_EDGE_CACHE.put('phase08:key', 'value');
  await rig.env.MATRIX_EDGE_CACHE.get('phase08:key');
  await rig.env.MATRIX_MEDIA_BUCKET.put('phase08/object', 'hello', {
    customMetadata: {
      content_type: 'text/plain',
      byte_size: '5',
    },
  });
  await rig.env.MATRIX_MEDIA_BUCKET.get('phase08/object');
  await rig.env.SEARCH_INDEX_QUEUE.send({
    id: 'phase08-queued-message',
  });

  const alice = await registerUser(rig, { username: 'phase08-metrics-alice' });
  const derivedResponse = await rig.env.JOBS_WORKER.fetch(new Request(`https://jobs-worker${INTERNAL_RUNTIME_DERIVED_WORK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      schema_version: 1,
      batch_id: 'phase08-derived-batch',
      requested_by: 'phase08-test',
      work_items: [
        {
          work_type: 'user_directory',
          idempotency_key: 'phase08-user-directory',
          scope: {
            scope_kind: 'user_id',
            scope_id: alice.user_id,
          },
          source_refs: {
            user_id: alice.user_id,
          },
          enqueued_at: new Date(Date.now() - 2_000).toISOString(),
        },
      ],
    }),
  }));
  assert.equal(derivedResponse.status, 202);

  const snapshot = snapshotTelemetry(rig.env);
  assertMetric(snapshot, 'worker.request.count', (dimensions) => dimensions.worker === 'gateway-worker');
  assertMetric(snapshot, 'd1.query.count', (dimensions) => dimensions.database === 'matrix-control-and-derived');
  assertMetric(snapshot, 'kv.operation.count', (dimensions) => dimensions.namespace === 'matrix-edge-cache');
  assertMetric(snapshot, 'r2.class_a.count', (dimensions) => dimensions.bucket === 'matrix-media');
  assertMetric(snapshot, 'r2.class_b.count', (dimensions) => dimensions.bucket === 'matrix-media');
  assertMetric(snapshot, 'queue.enqueue.count', (dimensions) => dimensions.queue_name === 'matrix-search-index-job');
  assertMetric(snapshot, 'derived.work.lag_ms', (dimensions) => dimensions.work_type === 'user_directory');

  assert.ok(snapshot.cost_totals.some((entry) => entry.surface === 'd1.query'));
  assert.ok(snapshot.cost_totals.some((entry) => entry.surface === 'kv.put'));
  assert.ok(snapshot.cost_totals.some((entry) => entry.surface === 'kv.get'));
  assert.ok(snapshot.cost_totals.some((entry) => entry.surface === 'r2.class_a'));
  assert.ok(snapshot.cost_totals.some((entry) => entry.surface === 'r2.class_b'));
  assert.ok(snapshot.cost_totals.some((entry) => entry.surface === 'queue.write'));

  const gatewayRecord = snapshot.deployment_records.find((entry) => entry.worker_name === 'gateway-worker');
  assert.ok(gatewayRecord);
  assert.equal(gatewayRecord.startup_time_ms, 12);
  assert.equal(gatewayRecord.deployment_composition.length, 2);
  assert.equal(gatewayRecord.feature_gates.otel_persist, true);
});

test('Phase 08 request contracts stay functional under worker and authority version skew', async (t) => {
  async function exerciseSkew({ workerVersion, authorityVersion }) {
    const rig = createGatewayVersionSkewRig({
      workerEnvOverrides: {
        WORKER_VERSION_ID: workerVersion,
        DEPLOYMENT_ID: `${workerVersion}-deployment`,
      },
      authorityEnvOverrides: {
        WORKER_VERSION_ID: authorityVersion,
        DEPLOYMENT_ID: `${authorityVersion}-deployment`,
      },
    });
    t.after(() => rig.close());

    const alice = await registerUser(rig, {
      username: `phase08-${workerVersion}-alice`,
    });
    const createRoomResponse = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
      name: `Version skew ${workerVersion}/${authorityVersion}`,
    });
    assert.equal(createRoomResponse.status, 200);
    const { room_id: roomId } = await createRoomResponse.json();
    const sendResponse = await putJson(
      rig,
      alice.access_token,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/txn-${workerVersion}`,
      {
        msgtype: 'm.text',
        body: `${workerVersion}->${authorityVersion}`,
      },
    );
    assert.equal(sendResponse.status, 200);
    const userDo = rig.getUserDo(alice.user_id);
    const roomDo = rig.getRoomDo(roomId);
    assert.equal(userDo.config.text.WORKER_VERSION_ID, authorityVersion);
    assert.equal(roomDo.config.text.WORKER_VERSION_ID, authorityVersion);
  }

  await exerciseSkew({
    workerVersion: 'worker-new',
    authorityVersion: 'do-old',
  });
  await exerciseSkew({
    workerVersion: 'worker-old',
    authorityVersion: 'do-new',
  });
});
