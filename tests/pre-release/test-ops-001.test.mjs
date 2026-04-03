import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requireRemoteHarnessContext,
  requireRolloutProbeContext,
  requestOpsAuthorized,
  writeSuiteSidecarJson,
} from './support.mjs';

function assertObservationSet(payload, {
  probeName,
  authorityKind,
  expectedGatewayVersionId,
  expectedAuthorityVersionId,
} = {}) {
  assert.ok(
    payload.observations.some((entry) => (
      entry?.probe_name === probeName
      && entry?.authority_kind === authorityKind
      && entry?.observed_gateway_version_id === expectedGatewayVersionId
      && entry?.observed_authority_version_id === expectedAuthorityVersionId
    )),
    `Missing ${probeName}/${authorityKind} observation for gateway=${expectedGatewayVersionId} authority=${expectedAuthorityVersionId}`,
  );
}

test('TEST-OPS-001 pre-release proves worker/authority rollout skew compatibility through Access-protected ops probe', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'pre-release');
  if (harness == null) {
    return;
  }
  const rollout = requireRolloutProbeContext();

  const result = await requestOpsAuthorized(harness, '/_ops/v1/rollout-skew/probe', {
    method: 'POST',
    json: {
      probe_run_id: rollout.probeRunId,
      baseline_gateway_version_id: rollout.baselineGatewayVersionId,
      candidate_gateway_version_id: rollout.candidateGatewayVersionId,
      dual_version_deployment_id: rollout.dualVersionDeploymentId,
      authority_kind: 'matrix-core',
      seed_prefix: rollout.seedPrefix,
    },
  });

  assert.equal(result.response.status, 200);
  const payload = result.payload;
  assert.equal(payload?.environment_name, 'pre-release');
  assert.equal(payload?.probe_run_id, rollout.probeRunId);
  assert.equal(payload?.dual_version_deployment_id, rollout.dualVersionDeploymentId);
  assert.equal(payload?.baseline_gateway_version_id, rollout.baselineGatewayVersionId);
  assert.equal(payload?.candidate_gateway_version_id, rollout.candidateGatewayVersionId);
  assert.equal(payload?.override_strategy, 'cloudflare-version-overrides');
  assert.equal(payload?.assertions?.new_worker_old_authority, true);
  assert.equal(payload?.assertions?.old_worker_new_authority, true);
  assert.ok(Array.isArray(payload?.observations));
  assert.ok(payload.observations.length >= 4);

  assertObservationSet(payload, {
    probeName: 'new-worker-old-authority',
    authorityKind: 'UserDO',
    expectedGatewayVersionId: rollout.candidateGatewayVersionId,
    expectedAuthorityVersionId: rollout.baselineGatewayVersionId,
  });
  assertObservationSet(payload, {
    probeName: 'new-worker-old-authority',
    authorityKind: 'RoomDO',
    expectedGatewayVersionId: rollout.candidateGatewayVersionId,
    expectedAuthorityVersionId: rollout.baselineGatewayVersionId,
  });
  assertObservationSet(payload, {
    probeName: 'old-worker-new-authority',
    authorityKind: 'UserDO',
    expectedGatewayVersionId: rollout.baselineGatewayVersionId,
    expectedAuthorityVersionId: rollout.candidateGatewayVersionId,
  });
  assertObservationSet(payload, {
    probeName: 'old-worker-new-authority',
    authorityKind: 'RoomDO',
    expectedGatewayVersionId: rollout.baselineGatewayVersionId,
    expectedAuthorityVersionId: rollout.candidateGatewayVersionId,
  });

  await writeSuiteSidecarJson(rollout.outputPath, payload);
});
