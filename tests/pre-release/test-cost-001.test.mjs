import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  makeTxnId,
  putAuthenticated,
  registerUser,
  request,
  requestOpsAuthorized,
  requirePreReleaseCostObservationContext,
  requireRemoteHarnessContext,
  roomPath,
  writeSuiteSidecarJson,
} from './support.mjs';

const REQUIRED_COST_SURFACES = Object.freeze([
  'workers',
  'durable_objects',
  'd1',
  'r2',
  'kv',
  'queues',
]);

test('TEST-COST-001 pre-release records an official Cloudflare cost observation for a bounded workload', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'pre-release');
  if (harness == null) {
    return;
  }
  const costObservation = requirePreReleaseCostObservationContext();
  const token = makeTxnId('costpre');

  const alice = await registerUser(harness, {
    usernamePrefix: `cost-pre-alice-${token}`,
    deviceId: 'COSTPREALICE',
  });
  const room = await createRoom(harness, alice.access_token, {
    visibility: 'private',
    name: `Cost pre-release room ${token}`,
  });
  const messageResult = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(room.room_id, `/send/m.room.message/${encodeURIComponent(makeTxnId('costmsg'))}`),
    {
      msgtype: 'm.text',
      body: `Phase 08 bounded cost workload ${token}`,
    },
  );
  assert.equal(messageResult.response.status, 200);

  const mediaUpload = await request(harness, '/_matrix/media/v3/upload?filename=phase08-cost.txt', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.access_token}`,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: `phase08-cost-payload-${token}`,
  });
  assert.equal(mediaUpload.response.status, 200);

  const healthz = await requestOpsAuthorized(harness, '/_ops/v1/healthz');
  assert.equal(healthz.response.status, 200);

  const result = await requestOpsAuthorized(harness, '/_ops/v1/cost/observation');
  assert.equal(
    result.response.status,
    200,
    `cost observation returned ${result.response.status}: ${JSON.stringify(result.payload)}`,
  );

  const payload = result.payload;
  assert.equal(typeof payload?.observation_id, 'string');
  assert.equal(payload?.source_environment, 'pre-release');
  assert.equal(payload?.capture_method, 'cloudflare-official-metrics');
  assert.equal(typeof payload?.captured_at, 'string');
  assert.equal(typeof payload?.capture_window?.start, 'string');
  assert.equal(typeof payload?.capture_window?.end, 'string');
  assert.ok(Date.parse(payload.capture_window.start) <= Date.parse(payload.capture_window.end));
  assert.ok(Array.isArray(payload?.source_query_uris));
  assert.ok(payload.source_query_uris.length > 0);
  assert.notEqual(payload?.topology_kind, 'local');
  for (const surfaceName of REQUIRED_COST_SURFACES) {
    assert.equal(typeof payload?.cost_surfaces?.[surfaceName], 'object', `missing cost surface ${surfaceName}`);
    assert.notEqual(payload.cost_surfaces[surfaceName], null, `missing cost surface ${surfaceName}`);
  }
  assert.equal(typeof payload?.model_comparison?.status, 'string');
  assert.equal(typeof payload?.model_comparison?.summary, 'string');
  assert.equal(typeof payload?.model_comparison?.actual_total_usd, 'number');
  assert.equal(typeof payload?.model_comparison?.modeled_total_usd, 'number');
  assert.equal(typeof payload?.model_comparison?.drift_ratio, 'number');

  await writeSuiteSidecarJson(costObservation.outputPath, payload);
});
