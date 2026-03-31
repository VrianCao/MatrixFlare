import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOpsHealthResponse } from '../../../packages/control-plane/src/index.mjs';
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
