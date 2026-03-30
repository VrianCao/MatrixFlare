import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExportShardJob,
  buildInternalJobSpec,
  createSignedManifest,
  parseExportKeyRing,
  verifySignedManifest,
} from '../../../packages/control-plane/src/index.mjs';
import {
  createControlPlaneRig,
  createExportKeyRingSecret,
  defaultPolicy,
} from './support.mjs';

function createStoredJobRecord({
  spec,
  internalState = 'pending',
  checkpointState = null,
  progressTotalUnits = 0,
  registrySnapshotId = null,
  exportEpoch = null,
}) {
  const acceptedAt = new Date().toISOString();
  return {
    job_id: spec.job_id,
    job_type: spec.job_type,
    internal_state: internalState,
    scope: spec.scope,
    operator_principal_id: spec.operator_principal_id,
    auth_mechanism: spec.auth_mechanism,
    idempotency_key: spec.idempotency_key,
    request_fingerprint: spec.request_fingerprint,
    accepted_at: acceptedAt,
    created_at: acceptedAt,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    cancel_reason: null,
    spec,
    checkpoint_state: checkpointState,
    progress_completed_units: 0,
    progress_total_units: progressTotalUnits,
    progress_unit_name: 'shard',
    last_error: null,
    registry_snapshot_id: registrySnapshotId,
    export_epoch: exportEpoch,
    result_summary: null,
  };
}

test('createSignedManifest stays self-verifiable when crypto metadata is implicit', () => {
  const keyRing = parseExportKeyRing(createExportKeyRingSecret());
  const manifest = createSignedManifest({
    unsignedManifest: {
      manifest_version: 1,
      created_at: new Date().toISOString(),
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
    },
    keyRing,
  });

  assert.equal(manifest.signature_algorithm, 'Ed25519');
  assert.equal(manifest.signing_key_version, keyRing.signing.active);
  assert.equal(manifest.encryption_algorithm, 'AES-256-GCM');
  assert.equal(manifest.encryption_key_version, keyRing.encryption.active);
  assert.equal(verifySignedManifest(manifest, keyRing.signing.public_key_pem), true);
});

test('ops-worker healthz requires a valid Access JWT and supports JWK refresh on kid miss', async () => {
  const teamDomain = `refresh-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'svc-ci',
        principalType: 'service',
        subjectValue: 'svc-ci',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
    jwkSequence: [
      { keys: [{ kty: 'RSA', kid: 'kid-stale', alg: 'RS256', use: 'sig', n: 'AQAB', e: 'AQAB' }] },
      undefined,
    ],
  });

  try {
    const withoutAssertion = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/healthz', { assertion: null }),
      rig.opsEnv,
    );
    assert.equal(withoutAssertion.status, 401);

    const refreshedResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/healthz', {
        assertion: rig.createAccessJwt({
          subject: 'service-subject',
          commonName: 'svc-ci',
        }),
      }),
      rig.opsEnv,
    );
    assert.equal(refreshedResponse.status, 200);
    const refreshedPayload = await refreshedResponse.json();
    assert.equal(refreshedPayload.service, 'ops-worker');
    assert.equal(rig.getFetchCallCount(), 2);
  } finally {
    rig.close();
  }
});

test('ops-worker rejects invalid Access JWT claims with 401 and does not create control-plane shard rows on unauthorized health checks', async () => {
  const teamDomain = `health-auth-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    assert.equal((await rig.persistence.listShardRegistry({})).length, 0);

    const invalidIssuerResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/healthz', {
        assertion: rig.createAccessJwt({
          issuerOverride: 'https://wrong.example.test',
        }),
      }),
      rig.opsEnv,
    );
    assert.equal(invalidIssuerResponse.status, 401);
    const invalidIssuerBody = await invalidIssuerResponse.json();
    assert.equal(invalidIssuerBody.code, 'unauthorized');
    assert.equal(invalidIssuerBody.retryable, false);
    assert.equal((await rig.persistence.listShardRegistry({})).length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker requires Access JWT before request parsing or resource lookup on protected control-plane routes', async () => {
  const teamDomain = `ops-auth-order-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const malformedCursor = Buffer.from(JSON.stringify({}), 'utf8').toString('base64url');
    const requests = [
      new Request('https://ops.example.test/_ops/v1/exports', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'Idempotency-Key': 'idem-unauthorized-export',
        },
        body: 'not-json',
      }),
      new Request(`https://ops.example.test/_ops/v1/jobs?cursor=${malformedCursor}`),
      rig.makeOpsRequest('/_ops/v1/jobs/job_missing', {
        assertion: null,
      }),
      new Request('https://ops.example.test/_ops/v1/jobs/job_missing/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'Idempotency-Key': 'idem-unauthorized-cancel',
        },
        body: 'not-json',
      }),
      new Request('https://ops.example.test/_ops/v1/appservices', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'Idempotency-Key': 'idem-unauthorized-appservice',
        },
        body: 'not-json',
      }),
    ];

    for (const request of requests) {
      const response = await rig.opsWorker(request, rig.opsEnv);
      assert.equal(response.status, 401);
      const payload = await response.json();
      assert.equal(payload.code, 'unauthorized');
    }
  } finally {
    rig.close();
  }
});

test('ops-worker accepts export jobs, deduplicates identical requests, rejects conflicts, and jobs-worker completes queued export tasks', async () => {
  const teamDomain = `ops-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const exportBody = {
      export_mode: 'full_bundle',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'backup before deploy',
      ticket_id: 'OPS-100',
      reuse_checkpoint_policy: 'force_fresh',
      max_checkpoint_age_seconds: 60,
      include_optional_objects: false,
      output_encryption_key_version: 'enc-v1',
    };
    const firstResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: exportBody,
        headers: {
          'Idempotency-Key': 'idem-export-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(firstResponse.status, 202);
    const firstPayload = await firstResponse.json();
    assert.equal(firstPayload.job_type, 'export');
    assert.equal(firstPayload.state, 'queued');
    assert.equal(rig.queues.export.messages.length, 1);

    const dedupedResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: exportBody,
        headers: {
          'Idempotency-Key': 'idem-export-1',
        },
      }),
      rig.opsEnv,
    );
    const dedupedPayload = await dedupedResponse.json();
    assert.equal(dedupedPayload.job_id, firstPayload.job_id);

    const conflictResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          ...exportBody,
          reason: 'backup after deploy',
        },
        headers: {
          'Idempotency-Key': 'idem-export-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(conflictResponse.status, 409);
    const conflictPayload = await conflictResponse.json();
    assert.equal(conflictPayload.code, 'idempotency_conflict');

    const initialJobResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${firstPayload.job_id}`),
      rig.opsEnv,
    );
    const initialJobPayload = await initialJobResponse.json();
    assert.equal(initialJobPayload.job.state, 'queued');

    const storedJob = await rig.persistence.getJob(firstPayload.job_id);
    const repeatedStartResponse = await rig.jobsWorker.fetch(new Request('https://jobs.internal/_internal/jobs/start/export', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(storedJob.spec),
    }), rig.jobsEnv);
    assert.equal(repeatedStartResponse.status, 200);
    const repeatedStartPayload = await repeatedStartResponse.json();
    assert.equal(repeatedStartPayload.job_id, firstPayload.job_id);
    assert.equal(rig.queues.export.messages.length, 1);

    const queueBatch = rig.queues.export.drainBatch();
    const duplicateQueueBatch = {
      queue: queueBatch.queue,
      messages: [
        queueBatch.messages[0],
        {
          body: JSON.parse(JSON.stringify(queueBatch.messages[0].body)),
          acked: false,
          retried: false,
          ack() {
            this.acked = true;
          },
          retry() {
            this.retried = true;
          },
        },
      ],
    };
    await rig.jobsWorker.queue(duplicateQueueBatch, rig.jobsEnv);

    const completedJobResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${firstPayload.job_id}`),
      rig.opsEnv,
    );
    const completedJobPayload = await completedJobResponse.json();
    assert.equal(completedJobPayload.job.state, 'succeeded');
    assert.equal(completedJobPayload.job.progress.completed_units, 1);
    assert.equal(completedJobPayload.job.progress.total_units, 1);

    const registrySnapshotKey = [...rig.archiveBucket.objects.keys()].find((key) => key.includes('/registry-snapshot/'));
    const bundleManifestKey = [...rig.archiveBucket.objects.keys()].find((key) => key.includes('/bundle-manifest/'));
    const checkpointManifestKey = [...rig.archiveBucket.objects.keys()].find((key) => key.includes('/checkpoint-manifest/'));
    assert.ok(registrySnapshotKey);
    assert.ok(bundleManifestKey);
    assert.ok(checkpointManifestKey);

    const bundleManifest = rig.archiveBucket.getJson(bundleManifestKey);
    const checkpointManifest = rig.archiveBucket.getJson(checkpointManifestKey);
    const replayManifest = await rig.persistence.getReplayManifest(firstPayload.job_id);
    const exportKeyRing = JSON.parse(rig.opsEnv.EXPORT_BUNDLE_KEY_RING);
    assert.equal(bundleManifest.signature_algorithm, 'Ed25519');
    assert.equal(typeof bundleManifest.registry_snapshot_hash, 'string');
    assert.equal(replayManifest?.manifest_kind, 'bundle-manifest');
    assert.equal(replayManifest?.manifest_hash, bundleManifest.manifest_hash);
    assert.equal(checkpointManifest.completeness_state, 'incomplete');
    assert.equal(
      verifySignedManifest(bundleManifest, exportKeyRing.signing.keys['sig-v1'].public_key_pem),
      true,
    );

    const auditEvents = await rig.persistence.listAuditEvents({ job_id: firstPayload.job_id });
    assert.equal(auditEvents[0].event_type, 'export.accepted');
    assert.deepEqual(auditEvents[0].affected_objects, [{ kind: 'job', id: firstPayload.job_id }]);
    assert.ok(auditEvents.some((event) => event.event_type === 'export.checkpointed'));
    assert.ok(auditEvents.some((event) => event.event_type === 'export.finalized'));
  } finally {
    rig.close();
  }
});

test('jobs-worker poisons queue messages with unsupported schema_version and marks the job failed', async () => {
  const teamDomain = `queue-version-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const exportBody = {
      export_mode: 'full_bundle',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'pre-upgrade backup',
      ticket_id: 'OPS-300',
      reuse_checkpoint_policy: 'force_fresh',
      max_checkpoint_age_seconds: 60,
      include_optional_objects: false,
      output_encryption_key_version: 'enc-v1',
    };
    const response = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: exportBody,
        headers: {
          'Idempotency-Key': 'idem-export-unsupported-schema',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.job_type, 'export');
    assert.equal(rig.queues.export.messages.length, 1);

    const queueBatch = rig.queues.export.drainBatch();
    queueBatch.messages[0].body.schema_version = 999;
    await rig.jobsWorker.queue(queueBatch, rig.jobsEnv);
    assert.equal(queueBatch.messages[0].acked, true);
    assert.equal(queueBatch.messages[0].retried, false);

    const jobResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${payload.job_id}`),
      rig.opsEnv,
    );
    assert.equal(jobResponse.status, 200);
    const jobPayload = await jobResponse.json();
    assert.equal(jobPayload.job.state, 'failed');

    const auditEvents = await rig.persistence.listAuditEvents({ job_id: payload.job_id });
    assert.ok(auditEvents.some((event) => event.event_type === 'export.failed'));
  } finally {
    rig.close();
  }
});

test('ops-worker supports rebuild, restore, repair, and cancel control-plane routes', async () => {
  const teamDomain = `ops-jobs-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const rebuildResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/rebuilds', {
        method: 'POST',
        body: {
          rebuild_target: 'search_index',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'rebuild derived data',
          ticket_id: 'OPS-200',
          force_full_scan: false,
        },
        headers: {
          'Idempotency-Key': 'idem-rebuild-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(rebuildResponse.status, 202);
    const rebuildPayload = await rebuildResponse.json();
    assert.equal(rebuildPayload.job_type, 'rebuild');
    assert.equal(rig.queues.rebuild.messages.length, 1);

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace',
          ticket_id: 'OPS-201',
          source_bundle_uri: 'r2://bundle/export-1',
          source_bundle_hash: 'hash-1',
          target_environment_id: 'target-env-1',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(restoreResponse.status, 202);
    assert.equal(rig.queues.restore.messages.length, 1);

    const repairResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/repairs', {
        method: 'POST',
        body: {
          repair_kind: 'search_reindex',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'repair derived state',
          ticket_id: 'OPS-202',
          dry_run: true,
          source_bundle_uri: null,
        },
        headers: {
          'Idempotency-Key': 'idem-repair-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(repairResponse.status, 202);
    assert.equal(rig.queues.repair.messages.length, 1);

    const cancelResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${rebuildPayload.job_id}/cancel`, {
        method: 'POST',
        body: {
          reason: 'operator canceled rebuild',
          ticket_id: 'OPS-203',
          if_in_states: ['queued'],
        },
        headers: {
          'Idempotency-Key': 'idem-cancel-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(cancelResponse.status, 202);
    const cancelPayload = await cancelResponse.json();
    assert.equal(cancelPayload.new_state, 'canceled');

    const canceledJobResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${rebuildPayload.job_id}`),
      rig.opsEnv,
    );
    const canceledJobPayload = await canceledJobResponse.json();
    assert.equal(canceledJobPayload.job.state, 'canceled');

    const cancelAuditEvents = await rig.persistence.listAuditEvents({ job_id: rebuildPayload.job_id });
    const cancelSucceededEvent = cancelAuditEvents.find((event) => event.event_type === 'job.cancel.succeeded');
    assert.equal(cancelSucceededEvent?.result_code, 'canceled');

    const canceledQueueBatch = rig.queues.rebuild.drainBatch();
    await rig.jobsWorker.queue(canceledQueueBatch, rig.jobsEnv);
    const afterLateQueueResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${rebuildPayload.job_id}`),
      rig.opsEnv,
    );
    const afterLateQueuePayload = await afterLateQueueResponse.json();
    assert.equal(afterLateQueuePayload.job.state, 'canceled');
  } finally {
    rig.close();
  }
});

test('jobs-worker internal export start returns a typed conflict when the registry snapshot is missing', async () => {
  const rig = await createControlPlaneRig();

  try {
    const spec = buildInternalJobSpec({
      jobId: `export-missing-snapshot-${Date.now()}`,
      jobType: 'export',
      operatorPrincipalId: 'human-1',
      authMechanism: 'Cf-Access-Jwt-Assertion',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'test missing snapshot',
      ticketId: 'OPS-MISSING-SNAPSHOT',
      idempotencyKey: 'idem-missing-snapshot',
      requestFingerprint: 'fingerprint-missing-snapshot',
      extra: {
        registry_snapshot_id: 'registry_snapshot_missing',
        export_epoch: 'export_epoch_missing',
        reuse_checkpoint_policy: 'force_fresh',
      },
    });
    await rig.persistence.createJob(createStoredJobRecord({
      spec,
      registrySnapshotId: 'registry_snapshot_missing',
      exportEpoch: 'export_epoch_missing',
    }));

    const response = await rig.jobsWorker.fetch(new Request('https://jobs.internal/_internal/jobs/start/export', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(spec),
    }), rig.jobsEnv);

    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.code, 'job_conflict');
    assert.equal(payload.retryable, false);
    assert.match(payload.message, /Registry snapshot .* not found/);
  } finally {
    rig.close();
  }
});

test('jobs-worker queue retries when a shard checkpoint was not staged before delivery', async () => {
  const rig = await createControlPlaneRig();

  try {
    const exportEpoch = `export_epoch_queue_order_${Date.now()}`;
    const spec = buildInternalJobSpec({
      jobId: `export-queue-order-${Date.now()}`,
      jobType: 'export',
      operatorPrincipalId: 'human-1',
      authMechanism: 'Cf-Access-Jwt-Assertion',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'test queue order',
      ticketId: 'OPS-QUEUE-ORDER',
      idempotencyKey: 'idem-queue-order',
      requestFingerprint: 'fingerprint-queue-order',
      extra: {
        registry_snapshot_id: 'registry_snapshot_queue_order',
        export_epoch: exportEpoch,
        reuse_checkpoint_policy: 'force_fresh',
      },
    });
    await rig.persistence.createJob(createStoredJobRecord({
      spec,
      internalState: 'checkpointed',
      checkpointState: {
        queue_ready: 1,
        queue_name: 'matrix-export-shard-job',
      },
      progressTotalUnits: 1,
      registrySnapshotId: 'registry_snapshot_queue_order',
      exportEpoch,
    }));

    const message = {
      body: buildExportShardJob({
        jobId: spec.job_id,
        exportEpoch,
        shardType: 'control-plane',
        shardKey: 'ops-core',
        checkpointStrategy: 'force_fresh',
        attempt: 0,
      }),
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      },
    };
    await rig.jobsWorker.queue({
      queue: 'matrix-export-shard-job',
      messages: [message],
    }, rig.jobsEnv);

    assert.equal(message.acked, false);
    assert.equal(message.retried, true);
    const checkpoint = await rig.persistence.getJobCheckpoint({
      job_id: spec.job_id,
      shard_type: 'control-plane',
      shard_key: 'ops-core',
    });
    assert.equal(checkpoint, null);
  } finally {
    rig.close();
  }
});

test('jobs-worker routes non-control-plane consumer queues to placeholder handling', async () => {
  const rig = await createControlPlaneRig();

  try {
    const message = {
      body: {
        target: 'search-index',
      },
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      },
    };
    await rig.jobsWorker.queue({
      queue: 'matrix-search-index-job',
      messages: [message],
    }, rig.jobsEnv);

    assert.equal(message.acked, false);
    assert.equal(message.retried, false);
  } finally {
    rig.close();
  }
});

test('ops-worker cancel idempotency is linearized by job_id instead of shared scope token', async () => {
  const teamDomain = `ops-cancel-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const makeRebuild = (idempotencyKey, ticketId) =>
      rig.opsWorker(
        rig.makeOpsRequest('/_ops/v1/rebuilds', {
          method: 'POST',
          body: {
            rebuild_target: 'search_index',
            scope: {
              scope_kind: 'global',
              scope_id: null,
            },
            reason: 'rebuild derived data',
            ticket_id: ticketId,
            force_full_scan: false,
          },
          headers: {
            'Idempotency-Key': idempotencyKey,
          },
        }),
        rig.opsEnv,
      );

    const firstJob = await (await makeRebuild('idem-rebuild-a', 'OPS-300')).json();
    const secondJob = await (await makeRebuild('idem-rebuild-b', 'OPS-301')).json();

    const firstCancelResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${firstJob.job_id}/cancel`, {
        method: 'POST',
        body: {
          reason: 'cancel first job',
          ticket_id: 'OPS-302',
        },
        headers: {
          'Idempotency-Key': 'shared-cancel-key',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(firstCancelResponse.status, 202);

    const secondCancelResponse = await rig.opsWorker(
      rig.makeOpsRequest(`/_ops/v1/jobs/${secondJob.job_id}/cancel`, {
        method: 'POST',
        body: {
          reason: 'cancel second job',
          ticket_id: 'OPS-303',
        },
        headers: {
          'Idempotency-Key': 'shared-cancel-key',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(secondCancelResponse.status, 202);
    const secondCancelPayload = await secondCancelResponse.json();
    assert.equal(secondCancelPayload.job_id, secondJob.job_id);
  } finally {
    rig.close();
  }
});

test('ops-worker validates malformed jobs cursor as a typed validation error', async () => {
  const teamDomain = `ops-cursor-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const invalidCursors = [
      'definitely-not-json',
      Buffer.from(JSON.stringify({}), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify([]), 'utf8').toString('base64url'),
    ];
    for (const cursor of invalidCursors) {
      const response = await rig.opsWorker(
        rig.makeOpsRequest(`/_ops/v1/jobs?cursor=${cursor}`),
        rig.opsEnv,
      );
      assert.equal(response.status, 422);
      const payload = await response.json();
      assert.equal(payload.code, 'validation_failed');
    }
  } finally {
    rig.close();
  }
});

test('ops-worker provides appservice CRUD through IF-OPS-008', async () => {
  const teamDomain = `ops-appservice-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const descriptor = {
      appservice_id: 'as-main',
      url: 'https://as.example.test',
      sender_localpart: 'bridgebot',
      hs_token_secret_ref: 'secret://hs-token',
      as_token_secret_ref: 'secret://as-token',
      namespaces: {
        users: [{ regex: '@_bridge_.*', exclusive: true }],
        aliases: [],
        rooms: [],
      },
      protocols: ['irc'],
      rate_limited: true,
      receive_ephemeral: true,
      healthcheck_enabled: true,
      disabled_at: null,
      delivery_state: {
        last_success_at: null,
        backlog_depth: 0,
        retry_state: 'idle',
        last_error: null,
      },
    };

    const createResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices', {
        method: 'POST',
        body: {
          appservice: descriptor,
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(createResponse.status, 200);
    const createPayload = await createResponse.json();
    assert.equal(createPayload.appservice.appservice_id, 'as-main');

    const getResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices/as-main'),
      rig.opsEnv,
    );
    assert.equal(getResponse.status, 200);
    const getPayload = await getResponse.json();
    assert.equal(getPayload.appservice.sender_localpart, 'bridgebot');

    const updateResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices/as-main', {
        method: 'PUT',
        body: {
          appservice: {
            ...descriptor,
            sender_localpart: 'bridgebot-updated',
          },
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-2',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(updateResponse.status, 200);
    const updatePayload = await updateResponse.json();
    assert.equal(updatePayload.appservice.sender_localpart, 'bridgebot-updated');

    const listResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices'),
      rig.opsEnv,
    );
    const listPayload = await listResponse.json();
    assert.equal(listPayload.appservices.length, 1);

    const deleteResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices/as-main', {
        method: 'DELETE',
        body: {
          appservice: null,
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-3',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(deleteResponse.status, 200);

    const missingResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices/as-main'),
      rig.opsEnv,
    );
    assert.equal(missingResponse.status, 404);
  } finally {
    rig.close();
  }
});

test('ops-worker appservice writes enforce ticket_id when operator policy requires it', async () => {
  const teamDomain = `ops-appservice-ticket-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
        requireTicket: true,
      }),
    ],
  });

  try {
    const descriptor = {
      appservice_id: 'as-main',
      url: 'https://as.example.test',
      sender_localpart: 'bridgebot',
      hs_token_secret_ref: 'secret://hs-token',
      as_token_secret_ref: 'secret://as-token',
      namespaces: {
        users: [{ regex: '@_bridge_.*', exclusive: true }],
        aliases: [],
        rooms: [],
      },
      protocols: ['irc'],
      rate_limited: true,
      receive_ephemeral: true,
      healthcheck_enabled: true,
      disabled_at: null,
      delivery_state: {
        last_success_at: null,
        backlog_depth: 0,
        retry_state: 'idle',
        last_error: null,
      },
    };

    const missingTicketResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices', {
        method: 'POST',
        body: {
          appservice: descriptor,
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-ticket-missing',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(missingTicketResponse.status, 422);

    const createResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices', {
        method: 'POST',
        body: {
          appservice: descriptor,
          ticket_id: 'OPS-400',
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-ticket-present',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(createResponse.status, 200);

    const updateResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices/as-main', {
        method: 'PUT',
        body: {
          appservice: {
            ...descriptor,
            sender_localpart: 'bridgebot-updated',
          },
          ticket_id: 'OPS-401',
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-ticket-update',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(updateResponse.status, 200);

    const deleteResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices/as-main', {
        method: 'DELETE',
        body: {
          appservice: null,
          ticket_id: 'OPS-402',
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-ticket-delete',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(deleteResponse.status, 200);

    const auditEvents = await rig.persistence.listAuditEvents({ event_type: 'appservice.succeeded' });
    assert.ok(auditEvents.length >= 3);
  } finally {
    rig.close();
  }
});

test('ops-worker rejects unsupported HTTP methods with typed not_found errors', async () => {
  const teamDomain = `ops-methods-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const healthPost = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/healthz', { method: 'POST' }),
      rig.opsEnv,
    );
    assert.equal(healthPost.status, 404);
    assert.equal((await healthPost.json()).code, 'not_found');

    const exportsGet = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports'),
      rig.opsEnv,
    );
    assert.equal(exportsGet.status, 404);
    assert.equal((await exportsGet.json()).code, 'not_found');

    const jobsPost = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/jobs', { method: 'POST' }),
      rig.opsEnv,
    );
    assert.equal(jobsPost.status, 404);
    assert.equal((await jobsPost.json()).code, 'not_found');
  } finally {
    rig.close();
  }
});

test('ops-worker appservice idempotency rejects fingerprint conflicts', async () => {
  const teamDomain = `ops-appservice-idem-${Date.now()}.cloudflareaccess.com`;
  const rig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const descriptor = {
      appservice_id: 'as-main',
      url: 'https://as.example.test',
      sender_localpart: 'bridgebot',
      hs_token_secret_ref: 'secret://hs-token',
      as_token_secret_ref: 'secret://as-token',
      namespaces: {
        users: [{ regex: '@_bridge_.*', exclusive: true }],
        aliases: [],
        rooms: [],
      },
      protocols: ['irc'],
      rate_limited: true,
      receive_ephemeral: true,
      healthcheck_enabled: true,
      disabled_at: null,
      delivery_state: {
        last_success_at: null,
        backlog_depth: 0,
        retry_state: 'idle',
        last_error: null,
      },
    };

    const firstResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices', {
        method: 'POST',
        body: {
          appservice: descriptor,
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-conflict',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(firstResponse.status, 200);

    const conflictResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/appservices', {
        method: 'POST',
        body: {
          appservice: {
            ...descriptor,
            sender_localpart: 'bridgebot-changed',
          },
        },
        headers: {
          'Idempotency-Key': 'idem-appservice-conflict',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, 'idempotency_conflict');
  } finally {
    rig.close();
  }
});
