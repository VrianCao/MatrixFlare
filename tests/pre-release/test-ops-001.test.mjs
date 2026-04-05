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
  expectedGatewayVersionTag,
  expectedAuthorityVersionId,
} = {}) {
  const matchesObservedGatewayIdentity = (entry) => {
    if (entry?.observed_gateway_version_id === expectedGatewayVersionId) {
      return entry?.observed_gateway_version_tag == null
        || entry?.observed_gateway_version_tag === expectedGatewayVersionTag;
    }
    return (
      entry?.observed_gateway_version_id == null
      && entry?.observed_gateway_version_tag === expectedGatewayVersionTag
    );
  };
  assert.ok(
    payload.observations.some((entry) => (
      entry?.probe_name === probeName
      && entry?.authority_kind === authorityKind
      && entry?.request_gateway_version_id === expectedGatewayVersionId
      && matchesObservedGatewayIdentity(entry)
      && entry?.observed_authority_version_id === expectedAuthorityVersionId
    )),
    `Missing ${probeName}/${authorityKind} observation for gateway=${expectedGatewayVersionId} (${expectedGatewayVersionTag}) authority=${expectedAuthorityVersionId}`,
  );
}

test('TEST-OPS-001 pre-release proves worker/authority rollout skew compatibility through Access-protected ops probe', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'pre-release');
  if (harness == null) {
    return;
  }
  const rollout = requireRolloutProbeContext();
  const healthz = await requestOpsAuthorized(harness, '/_ops/v1/healthz');
  assert.equal(
    healthz.response.status,
    200,
    `ops healthz returned ${healthz.response.status}: ${JSON.stringify(healthz.payload)}`,
  );
  assert.equal(healthz.payload?.service, 'ops-worker');
  assert.ok(
    Array.isArray(healthz.payload?.compatibility_flags)
    && healthz.payload.compatibility_flags.includes('global_fetch_strictly_public'),
    `ops healthz must expose global_fetch_strictly_public: ${JSON.stringify(healthz.payload)}`,
  );

  const result = await requestOpsAuthorized(harness, '/_ops/v1/rollout-skew/probe', {
    method: 'POST',
    json: {
      probe_run_id: rollout.probeRunId,
      baseline_gateway_version_id: rollout.baselineGatewayVersionId,
      baseline_gateway_version_tag: rollout.baselineGatewayVersionTag,
      candidate_gateway_version_id: rollout.candidateGatewayVersionId,
      candidate_gateway_version_tag: rollout.candidateGatewayVersionTag,
      dual_version_deployment_id: rollout.dualVersionDeploymentId,
      authority_kind: 'matrix-core',
      seed_prefix: rollout.seedPrefix,
    },
  });

  assert.equal(
    result.response.status,
    200,
    `rollout skew probe returned ${result.response.status}: ${JSON.stringify(result.payload)}`,
  );
  const payload = result.payload;
  assert.equal(payload?.environment_name, 'pre-release');
  assert.equal(payload?.probe_run_id, rollout.probeRunId);
  assert.equal(payload?.dual_version_deployment_id, rollout.dualVersionDeploymentId);
  assert.equal(payload?.baseline_gateway_version_id, rollout.baselineGatewayVersionId);
  assert.equal(payload?.baseline_gateway_version_tag, rollout.baselineGatewayVersionTag);
  assert.equal(payload?.candidate_gateway_version_id, rollout.candidateGatewayVersionId);
  assert.equal(payload?.candidate_gateway_version_tag, rollout.candidateGatewayVersionTag);
  assert.equal(payload?.override_strategy, 'cloudflare-version-overrides');
  assert.equal(payload?.assertions?.new_worker_old_authority, true);
  assert.equal(payload?.assertions?.old_worker_new_authority, true);
  assert.ok(Array.isArray(payload?.observations));
  assert.ok(payload.observations.length >= 4);

  assertObservationSet(payload, {
    probeName: 'new-worker-old-authority',
    authorityKind: 'UserDO',
    expectedGatewayVersionId: rollout.candidateGatewayVersionId,
    expectedGatewayVersionTag: rollout.candidateGatewayVersionTag,
    expectedAuthorityVersionId: rollout.baselineGatewayVersionId,
  });
  assertObservationSet(payload, {
    probeName: 'new-worker-old-authority',
    authorityKind: 'RoomDO',
    expectedGatewayVersionId: rollout.candidateGatewayVersionId,
    expectedGatewayVersionTag: rollout.candidateGatewayVersionTag,
    expectedAuthorityVersionId: rollout.baselineGatewayVersionId,
  });
  assertObservationSet(payload, {
    probeName: 'old-worker-new-authority',
    authorityKind: 'UserDO',
    expectedGatewayVersionId: rollout.baselineGatewayVersionId,
    expectedGatewayVersionTag: rollout.baselineGatewayVersionTag,
    expectedAuthorityVersionId: rollout.candidateGatewayVersionId,
  });
  assertObservationSet(payload, {
    probeName: 'old-worker-new-authority',
    authorityKind: 'RoomDO',
    expectedGatewayVersionId: rollout.baselineGatewayVersionId,
    expectedGatewayVersionTag: rollout.baselineGatewayVersionTag,
    expectedAuthorityVersionId: rollout.candidateGatewayVersionId,
  });

  await writeSuiteSidecarJson(rollout.outputPath, payload);
});
