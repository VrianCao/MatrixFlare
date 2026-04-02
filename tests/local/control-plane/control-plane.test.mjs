import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  buildArchiveObjectKey,
  buildExportShardJob,
  buildInternalJobSpec,
  canonicalHash,
  createSignedManifest,
  dispatchJobStart,
  encryptBytes,
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

async function seedFullExportBundle(rig, {
  idempotencyKey = `idem-export-seed-${Date.now()}`,
  ticketId = 'OPS-SEED',
} = {}) {
  const exportResponse = await rig.opsWorker(
    rig.makeOpsRequest('/_ops/v1/exports', {
      method: 'POST',
      body: {
        export_mode: 'full_bundle',
        scope: {
          scope_kind: 'global',
          scope_id: null,
        },
        reason: 'seed bundle',
        ticket_id: ticketId,
        reuse_checkpoint_policy: 'force_fresh',
        max_checkpoint_age_seconds: 60,
        include_optional_objects: false,
        output_encryption_key_version: 'enc-v1',
      },
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    }),
    rig.opsEnv,
  );
  assert.equal(exportResponse.status, 202);
  await exportResponse.json();
  await rig.jobsWorker.queue(rig.queues.export.drainBatch(), rig.jobsEnv);

  const keys = [...rig.archiveBucket.objects.keys()];
  const bundleManifestKey = keys.find((key) => key.includes('/bundle-manifest/'));
  assert.ok(bundleManifestKey);
  const bundleManifest = rig.archiveBucket.getJson(bundleManifestKey);

  const checkpointRef = bundleManifest.checkpoint_refs?.[0] ?? null;
  assert.ok(checkpointRef?.manifest_r2_object_key);
  const checkpointManifest = rig.archiveBucket.getJson(checkpointRef.manifest_r2_object_key);
  const checkpointObjectKey = checkpointManifest?.objects?.[0]?.r2_object_key ?? null;
  assert.ok(checkpointObjectKey);

  return {
    bundleManifestKey,
    bundleManifest,
    checkpointRef,
    checkpointManifest,
    checkpointObjectKey,
  };
}

function createRotatedExportKeyRingSecret(baseSecret) {
  const rotated = JSON.parse(baseSecret);
  const signingKeyPair = generateKeyPairSync('ed25519');
  rotated.signing.keys['sig-v2'] = {
    private_key_pem: signingKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    public_key_pem: signingKeyPair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  rotated.signing.active = 'sig-v2';
  rotated.encryption.keys['enc-v2'] = {
    key_base64: randomBytes(32).toString('base64'),
  };
  rotated.encryption.active = 'enc-v2';
  return JSON.stringify(rotated);
}

const LEGACY_CONTROL_PLANE_SCHEMA_SQL = `
  CREATE TABLE operator_authz_policies (
    principal_id TEXT PRIMARY KEY,
    principal_type TEXT NOT NULL,
    access_issuer TEXT NOT NULL,
    access_audience TEXT NOT NULL,
    access_subject_binding TEXT NOT NULL,
    access_subject_value TEXT NOT NULL,
    allowed_scopes TEXT NOT NULL,
    expires_at TEXT,
    disabled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    operator_principal_id TEXT NOT NULL,
    auth_mechanism TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    request_id TEXT,
    idempotency_key TEXT,
    request_fingerprint TEXT,
    result_code TEXT NOT NULL,
    affected_objects TEXT NOT NULL
  );
  CREATE TABLE request_dedupe_projection (
    operator_principal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    scope_token TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    job_id TEXT,
    result_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operator_principal_id, idempotency_key, scope_token)
  );
  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    internal_state TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    operator_principal_id TEXT NOT NULL,
    auth_mechanism TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    canceled_at TEXT,
    cancel_reason TEXT,
    spec_json TEXT NOT NULL
  );
  CREATE TABLE replay_manifests (
    job_id TEXT PRIMARY KEY,
    manifest_kind TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE repair_decisions (
    decision_id TEXT PRIMARY KEY,
    repair_kind TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    ticket_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE shard_registry (
    shard_type TEXT NOT NULL,
    shard_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    PRIMARY KEY (shard_type, shard_key)
  );
  CREATE TABLE registry_snapshots (
    registry_snapshot_id TEXT PRIMARY KEY,
    export_epoch TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT,
    scope_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL
  );
  CREATE TABLE appservice_configs (
    appservice_id TEXT PRIMARY KEY,
    descriptor_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const CONTROL_PLANE_LEGACY_CONVERGENCE_TABLES = Object.freeze([
  'operator_authz_policies',
  'audit_events',
  'request_dedupe_projection',
  'jobs',
  'replay_manifests',
  'repair_decisions',
  'shard_registry',
  'registry_snapshots',
  'appservice_configs',
]);

async function listD1TableColumns(db, tableName) {
  const result = await db.prepare(`PRAGMA table_info('${tableName}')`).bind().all();
  return result.results.map((row) => row.name);
}

const ROOM_REQUIRED_OBJECT_SPECS_WITHOUT_ARCHIVE_REFERENCE = Object.freeze([
  { kind: 'room-events-metadata-segment', apply_phase: 'truth-core', data_ids: ['DATA-ROOM-001'] },
  { kind: 'room-hot-event-json-segment', apply_phase: 'truth-core', data_ids: ['DATA-ROOM-002'] },
  { kind: 'room-prev-edges-segment', apply_phase: 'truth-core', data_ids: ['DATA-ROOM-003'] },
  { kind: 'room-auth-edges-segment', apply_phase: 'truth-core', data_ids: ['DATA-ROOM-004'] },
  { kind: 'room-state-snapshot-segment', apply_phase: 'truth-aux', data_ids: ['DATA-ROOM-005'] },
  { kind: 'room-membership-current', apply_phase: 'truth-aux', data_ids: ['DATA-ROOM-006'] },
  { kind: 'room-forward-extremities-current', apply_phase: 'truth-aux', data_ids: ['DATA-ROOM-007'] },
  { kind: 'room-fanout-outbox-segment', apply_phase: 'dedupe-and-outbox', data_ids: ['DATA-ROOM-011'] },
  { kind: 'room-client-txn-dedupe-segment', apply_phase: 'dedupe-and-outbox', data_ids: ['DATA-ROOM-012'] },
]);
const USER_REQUIRED_OBJECT_SPECS = Object.freeze([
  { kind: 'user-identity-and-session-segment', apply_phase: 'truth-core', data_ids: ['DATA-USER-001'] },
  { kind: 'user-profile-and-account-segment', apply_phase: 'truth-aux', data_ids: ['DATA-USER-006'] },
  { kind: 'user-stream-and-todevice-segment', apply_phase: 'dedupe-and-outbox', data_ids: ['DATA-USER-008'] },
]);
const CONTROL_PLANE_REQUIRED_OBJECT_SPECS = Object.freeze([
  { kind: 'ops-core-segment', apply_phase: 'control-plane', data_ids: ['DATA-OPS-001'] },
]);

async function putJsonArchiveObject(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
    },
  });
}

async function seedSyntheticRoomRestoreBundleMissingArchiveReference(rig, {
  sourceWatermark = {
    max_committed_room_pos: 7,
    current_snapshot_id: 'snapshot_room_1',
    forward_extremities_hash: 'forward_extremities_hash_1',
  },
} = {}) {
  const keyRing = parseExportKeyRing(rig.opsEnv.EXPORT_BUNDLE_KEY_RING);
  const exportEpoch = `export_epoch_room_missing_archive_${Date.now()}`;
  const scope = {
    scope_kind: 'global',
    scope_id: null,
  };
  const shardType = 'RoomDO';
  const shardKey = '!room:test';
  const checkpointId = `checkpoint_room_missing_archive_${Date.now()}`;
  const bundleId = `bundle_room_missing_archive_${Date.now()}`;
  const registrySnapshotId = `registry_snapshot_room_missing_archive_${Date.now()}`;
  const createdAt = new Date().toISOString();
  const registryRows = [{
    shard_type: shardType,
    shard_key: shardKey,
    created_at: createdAt,
    last_seen_at: createdAt,
    schema_version: 1,
    disabled_at: null,
  }];

  const unsignedRegistrySnapshot = {
    manifest_version: 1,
    registry_snapshot_id: registrySnapshotId,
    export_epoch: exportEpoch,
    scope,
    created_at: createdAt,
    row_count: registryRows.length,
    hash_algorithm: 'sha256',
    signature_algorithm: 'Ed25519',
    encryption_algorithm: 'AES-256-GCM',
    signing_key_version: keyRing.signing.active,
    encryption_key_version: keyRing.encryption.active,
    completeness_state: 'complete',
    rows: registryRows,
  };
  const registrySnapshot = createSignedManifest({
    unsignedManifest: unsignedRegistrySnapshot,
    keyRing,
  });
  const registrySnapshotKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'registry-snapshot',
    scope,
    objectId: registrySnapshotId,
  });
  await putJsonArchiveObject(rig.archiveBucket, registrySnapshotKey, registrySnapshot);

  const objectEntries = [];
  for (const [index, objectSpec] of ROOM_REQUIRED_OBJECT_SPECS_WITHOUT_ARCHIVE_REFERENCE.entries()) {
    const objectId = `${checkpointId}--${index}`;
    const objectKey = buildArchiveObjectKey({
      exportEpochOrImportBatch: exportEpoch,
      artifactKind: 'checkpoint-object',
      scope,
      objectId,
    });
    const objectEnvelope = {
      envelope_version: 1,
      checkpoint_id: checkpointId,
      object_id: objectId,
      shard_type: shardType,
      shard_key: shardKey,
      codec: 'jcs-json',
      ...encryptBytes(Buffer.from('{}', 'utf8'), keyRing, {
        aad: `${checkpointId}:${objectId}`,
      }),
    };
    await putJsonArchiveObject(rig.archiveBucket, objectKey, objectEnvelope);
    objectEntries.push({
      object_id: objectId,
      object_kind: objectSpec.kind,
      shard_type: shardType,
      shard_key: shardKey,
      data_ids: objectSpec.data_ids,
      required_for_restore: true,
      apply_phase: objectSpec.apply_phase,
      range_start: index,
      range_end: index,
      content_hash: canonicalHash(objectEnvelope),
      codec: 'jcs-json',
      encryption_key_version: keyRing.encryption.active,
      byte_size: Buffer.byteLength(JSON.stringify(objectEnvelope), 'utf8'),
      record_count: 1,
      r2_object_key: objectKey,
    });
  }

  const checkpointManifest = createSignedManifest({
    unsignedManifest: {
      manifest_version: 1,
      checkpoint_id: checkpointId,
      job_id: `export_job_${Date.now()}`,
      export_epoch: exportEpoch,
      registry_snapshot_id: registrySnapshotId,
      registry_snapshot_hash: registrySnapshot.manifest_hash,
      scope,
      shard_type: shardType,
      shard_key: shardKey,
      started_at: createdAt,
      completed_at: createdAt,
      source_watermark: sourceWatermark,
      hash_algorithm: 'sha256',
      signature_algorithm: 'Ed25519',
      encryption_algorithm: 'AES-256-GCM',
      signing_key_version: keyRing.signing.active,
      encryption_key_version: keyRing.encryption.active,
      objects: objectEntries,
      completeness_state: 'complete',
    },
    keyRing,
  });
  const checkpointManifestKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'checkpoint-manifest',
    scope,
    objectId: checkpointId,
  });
  await putJsonArchiveObject(rig.archiveBucket, checkpointManifestKey, checkpointManifest);

  const bundleManifest = createSignedManifest({
    unsignedManifest: {
      manifest_version: 1,
      job_id: bundleId,
      job_type: 'export',
      bundle_id: bundleId,
      scope,
      created_at: createdAt,
      export_epoch: exportEpoch,
      registry_snapshot_id: registrySnapshotId,
      registry_snapshot_hash: registrySnapshot.manifest_hash,
      registry_snapshot_r2_object_key: registrySnapshotKey,
      spec: {
        export_mode: 'full_bundle',
      },
      hash_algorithm: 'sha256',
      signature_algorithm: 'Ed25519',
      encryption_algorithm: 'AES-256-GCM',
      signing_key_version: keyRing.signing.active,
      encryption_key_version: keyRing.encryption.active,
      objects: [
        {
          object_id: registrySnapshotId,
          object_kind: 'registry-snapshot',
          shard_type: 'control-plane',
          shard_key: 'ops-core',
          data_ids: ['DATA-OPS-011'],
          required_for_restore: true,
          apply_phase: 'control-plane',
          range_start: createdAt,
          range_end: createdAt,
          content_hash: canonicalHash(registrySnapshot),
          codec: 'jcs-json',
          encryption_key_version: keyRing.encryption.active,
          byte_size: Buffer.byteLength(JSON.stringify(registrySnapshot), 'utf8'),
          record_count: 1,
          r2_object_key: registrySnapshotKey,
          completeness_state: 'complete',
        },
      ],
      checkpoint_refs: [{
        checkpoint_id: checkpointId,
        shard_type: shardType,
        shard_key: shardKey,
        manifest_hash: checkpointManifest.manifest_hash,
        manifest_r2_object_key: checkpointManifestKey,
        source_watermark: sourceWatermark,
        completeness_state: 'complete',
        apply_phase: 'truth-core',
        object_count: objectEntries.length,
      }],
      completeness_state: 'complete',
    },
    keyRing,
  });
  const bundleManifestKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'bundle-manifest',
    scope,
    objectId: bundleId,
  });
  await putJsonArchiveObject(rig.archiveBucket, bundleManifestKey, bundleManifest);

  return {
    bundleManifest,
    bundleManifestKey,
  };
}

async function seedSyntheticRestoreBundle(rig, {
  shardType,
  shardKey,
  sourceWatermark,
  objectSpecs,
  scope = {
    scope_kind: 'global',
    scope_id: null,
  },
}) {
  const keyRing = parseExportKeyRing(rig.opsEnv.EXPORT_BUNDLE_KEY_RING);
  const exportEpoch = `export_epoch_synthetic_${Date.now()}`;
  const bundleId = `bundle_synthetic_${Date.now()}`;
  const checkpointId = `checkpoint_synthetic_${Date.now()}`;
  const registrySnapshotId = `registry_snapshot_synthetic_${Date.now()}`;
  const createdAt = new Date().toISOString();
  const registryRows = [{
    shard_type: shardType,
    shard_key: shardKey,
    created_at: createdAt,
    last_seen_at: createdAt,
    schema_version: 1,
    disabled_at: null,
  }];

  const registrySnapshot = createSignedManifest({
    unsignedManifest: {
      manifest_version: 1,
      registry_snapshot_id: registrySnapshotId,
      export_epoch: exportEpoch,
      scope,
      created_at: createdAt,
      row_count: registryRows.length,
      hash_algorithm: 'sha256',
      signature_algorithm: 'Ed25519',
      encryption_algorithm: 'AES-256-GCM',
      signing_key_version: keyRing.signing.active,
      encryption_key_version: keyRing.encryption.active,
      completeness_state: 'complete',
      rows: registryRows,
    },
    keyRing,
  });
  const registrySnapshotKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'registry-snapshot',
    scope,
    objectId: registrySnapshotId,
  });
  await putJsonArchiveObject(rig.archiveBucket, registrySnapshotKey, registrySnapshot);

  const objectEntries = [];
  for (const [index, objectSpec] of objectSpecs.entries()) {
    const objectId = `${checkpointId}--${index}`;
    const objectKey = buildArchiveObjectKey({
      exportEpochOrImportBatch: exportEpoch,
      artifactKind: 'checkpoint-object',
      scope,
      objectId,
    });
    const defaultEnvelope = {
      envelope_version: 1,
      checkpoint_id: checkpointId,
      object_id: objectId,
      shard_type: shardType,
      shard_key: shardKey,
      codec: objectSpec.codec ?? 'jcs-json',
      ...encryptBytes(
        Buffer.isBuffer(objectSpec.payload)
          ? objectSpec.payload
          : Buffer.from(objectSpec.payload ?? '{}', 'utf8'),
        keyRing,
        {
          aad: `${checkpointId}:${objectId}`,
        },
      ),
    };
    const objectEnvelope = {
      ...defaultEnvelope,
      ...(objectSpec.envelopeOverrides ?? {}),
    };
    await putJsonArchiveObject(rig.archiveBucket, objectKey, objectEnvelope);
    objectEntries.push({
      object_id: objectId,
      object_kind: objectSpec.kind,
      shard_type: shardType,
      shard_key: shardKey,
      data_ids: objectSpec.data_ids,
      required_for_restore: objectSpec.required_for_restore ?? true,
      apply_phase: objectSpec.apply_phase,
      range_start: objectSpec.range_start ?? index,
      range_end: objectSpec.range_end ?? index,
      content_hash: canonicalHash(objectEnvelope),
      codec: objectSpec.codec ?? 'jcs-json',
      encryption_key_version: objectEnvelope.encryption_key_version,
      byte_size: Buffer.byteLength(JSON.stringify(objectEnvelope), 'utf8'),
      record_count: objectSpec.record_count ?? (objectSpec.codec === 'jsonl-gzip' ? 1 : 1),
      r2_object_key: objectKey,
      ...(objectSpec.entryOverrides ?? {}),
    });
  }

  const checkpointManifest = createSignedManifest({
    unsignedManifest: {
      manifest_version: 1,
      checkpoint_id: checkpointId,
      job_id: `export_job_${Date.now()}`,
      export_epoch: exportEpoch,
      registry_snapshot_id: registrySnapshotId,
      registry_snapshot_hash: registrySnapshot.manifest_hash,
      scope,
      shard_type: shardType,
      shard_key: shardKey,
      started_at: createdAt,
      completed_at: createdAt,
      source_watermark: sourceWatermark,
      hash_algorithm: 'sha256',
      signature_algorithm: 'Ed25519',
      encryption_algorithm: 'AES-256-GCM',
      signing_key_version: keyRing.signing.active,
      encryption_key_version: keyRing.encryption.active,
      objects: objectEntries,
      completeness_state: 'complete',
    },
    keyRing,
  });
  const checkpointManifestKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'checkpoint-manifest',
    scope,
    objectId: checkpointId,
  });
  await putJsonArchiveObject(rig.archiveBucket, checkpointManifestKey, checkpointManifest);

  const bundleManifest = createSignedManifest({
    unsignedManifest: {
      manifest_version: 1,
      job_id: bundleId,
      job_type: 'export',
      bundle_id: bundleId,
      scope,
      created_at: createdAt,
      export_epoch: exportEpoch,
      registry_snapshot_id: registrySnapshotId,
      registry_snapshot_hash: registrySnapshot.manifest_hash,
      registry_snapshot_r2_object_key: registrySnapshotKey,
      spec: {
        export_mode: 'full_bundle',
      },
      hash_algorithm: 'sha256',
      signature_algorithm: 'Ed25519',
      encryption_algorithm: 'AES-256-GCM',
      signing_key_version: keyRing.signing.active,
      encryption_key_version: keyRing.encryption.active,
      objects: [
        {
          object_id: registrySnapshotId,
          object_kind: 'registry-snapshot',
          shard_type: 'control-plane',
          shard_key: 'ops-core',
          data_ids: ['DATA-OPS-011'],
          required_for_restore: true,
          apply_phase: 'control-plane',
          range_start: createdAt,
          range_end: createdAt,
          content_hash: canonicalHash(registrySnapshot),
          codec: 'jcs-json',
          encryption_key_version: keyRing.encryption.active,
          byte_size: Buffer.byteLength(JSON.stringify(registrySnapshot), 'utf8'),
          record_count: 1,
          r2_object_key: registrySnapshotKey,
          completeness_state: 'complete',
        },
      ],
      checkpoint_refs: [{
        checkpoint_id: checkpointId,
        shard_type: shardType,
        shard_key: shardKey,
        manifest_hash: checkpointManifest.manifest_hash,
        manifest_r2_object_key: checkpointManifestKey,
        source_watermark: sourceWatermark,
        completeness_state: 'complete',
        apply_phase: objectEntries[0]?.apply_phase ?? 'truth-core',
        object_count: objectEntries.length,
      }],
      completeness_state: 'complete',
    },
    keyRing,
  });
  const bundleManifestKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'bundle-manifest',
    scope,
    objectId: bundleId,
  });
  await putJsonArchiveObject(rig.archiveBucket, bundleManifestKey, bundleManifest);

  return {
    bundleManifest,
    bundleManifestKey,
    checkpointManifest,
    checkpointManifestKey,
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

test('ops-worker healthz requires a valid Access JWT, supports JWK refresh on kid miss, and accepts service-auth JWTs with empty sub', async () => {
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
          subject: '',
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

test('ops-worker rejects raw service-token ingress headers when Access did not mint a JWT assertion', async () => {
  const teamDomain = `ops-service-headers-${Date.now()}.cloudflareaccess.com`;
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
  });

  try {
    const response = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/healthz', {
        assertion: null,
        headers: {
          'CF-Access-Client-Id': 'fake-client-id.access',
          'CF-Access-Client-Secret': 'fake-client-secret',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.code, 'unauthorized');
    assert.equal(payload.retryable, false);
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
    const checkpointObjectKey = [...rig.archiveBucket.objects.keys()].find((key) => key.includes('/checkpoint-object/'));
    assert.ok(registrySnapshotKey);
    assert.ok(bundleManifestKey);
    assert.ok(checkpointManifestKey);
    assert.ok(checkpointObjectKey);

    const bundleManifest = rig.archiveBucket.getJson(bundleManifestKey);
    const checkpointManifest = rig.archiveBucket.getJson(checkpointManifestKey);
    const registrySnapshot = rig.archiveBucket.getJson(registrySnapshotKey);
    const replayManifest = await rig.persistence.getReplayManifest(firstPayload.job_id);
    const exportKeyRing = JSON.parse(rig.opsEnv.EXPORT_BUNDLE_KEY_RING);
    assert.equal(bundleManifest.signature_algorithm, 'Ed25519');
    assert.equal(typeof bundleManifest.registry_snapshot_hash, 'string');
    assert.equal(bundleManifest.registry_snapshot_r2_object_key, registrySnapshotKey);
    assert.equal(bundleManifest.completeness_state, 'complete');
    assert.equal(replayManifest?.manifest_kind, 'bundle-manifest');
    assert.equal(replayManifest?.manifest_hash, bundleManifest.manifest_hash);
    assert.equal(checkpointManifest.signature_algorithm, 'Ed25519');
    assert.equal(checkpointManifest.completeness_state, 'complete');
    assert.ok(bundleManifest.objects.some((entry) => (
      entry.object_kind === 'registry-snapshot'
      && entry.r2_object_key === registrySnapshotKey
      && entry.content_hash === canonicalHash(registrySnapshot)
    )));
    assert.ok(bundleManifest.objects.some((entry) => (
      entry.object_kind === 'checkpoint-manifest'
      && entry.r2_object_key === checkpointManifestKey
      && entry.content_hash === canonicalHash(checkpointManifest)
    )));
    assert.equal(bundleManifest.checkpoint_refs[0].checkpoint_id, checkpointManifest.checkpoint_id);
    assert.equal(
      verifySignedManifest(bundleManifest, exportKeyRing.signing.keys['sig-v1'].public_key_pem),
      true,
    );
    assert.equal(
      verifySignedManifest(checkpointManifest, exportKeyRing.signing.keys['sig-v1'].public_key_pem),
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

test('jobs-worker marks non-retryable queue failures as failed instead of leaving the job in-flight', async () => {
  const teamDomain = `queue-fatal-${Date.now()}.cloudflareaccess.com`;
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
    const response = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'fatal queue error should fail the job',
          ticket_id: 'OPS-300A',
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': 'idem-export-fatal-queue-failure',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(response.status, 202);
    const payload = await response.json();
    const batch = rig.queues.export.drainBatch();
    rig.jobsEnv.MATRIX_ARCHIVE_BUCKET = null;

    await rig.jobsWorker.queue(batch, rig.jobsEnv);

    assert.equal(batch.messages[0].acked, true);
    assert.equal(batch.messages[0].retried, false);

    const failedJob = await rig.persistence.getJob(payload.job_id);
    assert.equal(failedJob.internal_state, 'failed');
    assert.equal(failedJob.last_error.code, 'precondition_failed');
    assert.match(failedJob.last_error.message, /Missing MATRIX_ARCHIVE_BUCKET binding/);
    assert.equal(failedJob.result_summary.failure, failedJob.last_error.message);
  } finally {
    rig.close();
  }
});

test('ops-worker recovers staged queue fan-out on idempotent retry after transient queue publish failure', async () => {
  const teamDomain = `ops-export-retry-${Date.now()}.cloudflareaccess.com`;
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
    const originalSend = rig.queues.export.send.bind(rig.queues.export);
    let sendAttempts = 0;
    rig.queues.export.send = async (body) => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error('synthetic queue publish failure');
      }
      return originalSend(body);
    };

    const exportBody = {
      export_mode: 'full_bundle',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'recover transient queue publish failure',
      ticket_id: 'OPS-301',
      reuse_checkpoint_policy: 'force_fresh',
      max_checkpoint_age_seconds: 60,
      include_optional_objects: false,
      output_encryption_key_version: 'enc-v1',
    };
    const requestOptions = {
      method: 'POST',
      body: exportBody,
      headers: {
        'Idempotency-Key': 'idem-export-retryable-start',
      },
    };

    const firstResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', requestOptions),
      rig.opsEnv,
    );
    assert.equal(firstResponse.status, 503);
    const firstPayload = await firstResponse.json();
    assert.equal(firstPayload.code, 'internal');
    assert.equal(firstPayload.retryable, true);
    assert.equal(rig.queues.export.messages.length, 0);

    const stagedJob = (await rig.persistence.listJobs({ limit: 10 }))[0];
    assert.equal(stagedJob.internal_state, 'failed');
    assert.equal(stagedJob.checkpoint_state?.queue_delivery_state, 'staged');

    const secondResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', requestOptions),
      rig.opsEnv,
    );
    assert.equal(secondResponse.status, 202);
    const secondPayload = await secondResponse.json();
    assert.equal(secondPayload.job_id, stagedJob.job_id);
    assert.equal(rig.queues.export.messages.length, 1);

    const recoveredJob = await rig.persistence.getJob(stagedJob.job_id);
    assert.equal(recoveredJob.internal_state, 'checkpointed');
    assert.equal(recoveredJob.checkpoint_state?.queue_delivery_state, 'published');

    await rig.jobsWorker.queue(rig.queues.export.drainBatch(), rig.jobsEnv);
    const completedJob = await rig.persistence.getJob(stagedJob.job_id);
    assert.equal(completedJob.internal_state, 'finalized');
  } finally {
    rig.close();
  }
});

test('ops-worker persists the enriched export job spec after freezing the registry snapshot', async () => {
  const teamDomain = `ops-export-spec-${Date.now()}.cloudflareaccess.com`;
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
    const exportResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'persist export spec',
          ticket_id: 'OPS-301A',
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': 'idem-export-persisted-spec',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(exportResponse.status, 202);
    const payload = await exportResponse.json();

    const storedJob = await rig.persistence.getJob(payload.job_id);
    assert.equal(typeof storedJob.registry_snapshot_id, 'string');
    assert.equal(typeof storedJob.export_epoch, 'string');
    assert.equal(storedJob.spec.registry_snapshot_id, storedJob.registry_snapshot_id);
    assert.equal(storedJob.spec.export_epoch, storedJob.export_epoch);
    assert.equal(storedJob.spec.reuse_checkpoint_policy, 'force_fresh');
  } finally {
    rig.close();
  }
});

test('jobs-worker assigns per-message async context when a queue batch spans multiple jobs', async () => {
  const teamDomain = `jobs-queue-context-${Date.now()}.cloudflareaccess.com`;
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
    const makeExportRequest = (idempotencyKey, ticketId, reason) => rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason,
          ticket_id: ticketId,
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
      }),
      rig.opsEnv,
    );

    const firstResponse = await makeExportRequest('idem-export-batch-context-1', 'OPS-301B', 'batch context one');
    const secondResponse = await makeExportRequest('idem-export-batch-context-2', 'OPS-301C', 'batch context two');
    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 202);

    const firstPayload = await firstResponse.json();
    const secondPayload = await secondResponse.json();
    assert.equal(rig.queues.export.messages.length, 2);

    await rig.jobsWorker.queue(rig.queues.export.drainBatch(), rig.jobsEnv);

    const firstAuditEvents = await rig.persistence.listAuditEvents({ job_id: firstPayload.job_id });
    const secondAuditEvents = await rig.persistence.listAuditEvents({ job_id: secondPayload.job_id });

    assert.ok(firstAuditEvents.some((event) => (
      event.event_type === 'export.materializing'
      && event.causation_id === firstPayload.job_id
    )));
    assert.ok(firstAuditEvents.some((event) => (
      event.event_type === 'export.finalized'
      && event.causation_id === firstPayload.job_id
    )));
    assert.ok(secondAuditEvents.some((event) => (
      event.event_type === 'export.materializing'
      && event.causation_id === secondPayload.job_id
    )));
    assert.ok(secondAuditEvents.some((event) => (
      event.event_type === 'export.finalized'
      && event.causation_id === secondPayload.job_id
    )));
  } finally {
    rig.close();
  }
});

test('jobs-worker preserves started_at when queue processing reaches a terminal export state', async () => {
  const teamDomain = `jobs-started-at-${Date.now()}.cloudflareaccess.com`;
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
    const exportResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'started_at should survive queue completion',
          ticket_id: 'OPS-301D',
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': 'idem-export-started-at',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(exportResponse.status, 202);
    const payload = await exportResponse.json();

    await rig.jobsWorker.queue(rig.queues.export.drainBatch(), rig.jobsEnv);

    const storedJob = await rig.persistence.getJob(payload.job_id);
    assert.equal(typeof storedJob.started_at, 'string');
    assert.equal(typeof storedJob.completed_at, 'string');
    assert.equal(storedJob.started_at <= storedJob.completed_at, true);
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
    const exportResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'seed restore bundle',
          ticket_id: 'OPS-199',
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': 'idem-export-restore-seed',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(exportResponse.status, 202);
    await exportResponse.json();
    await rig.jobsWorker.queue(rig.queues.export.drainBatch(), rig.jobsEnv);
    const bundleManifestKey = [...rig.archiveBucket.objects.keys()].find((key) => key.includes('/bundle-manifest/'));
    assert.ok(bundleManifestKey);
    const bundleManifest = rig.archiveBucket.getJson(bundleManifestKey);
    const now = new Date().toISOString();
    await rig.persistence.upsertShardRegistry({
      shard_type: 'RoomDO',
      shard_key: '!room:test',
      created_at: now,
      last_seen_at: now,
      schema_version: 1,
      disabled_at: null,
    });

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
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
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
    assert.equal(rig.queues.restore.messages[0].checkpoint_id, bundleManifest.checkpoint_refs[0].checkpoint_id);

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

test('jobs-worker repair queue dispatches room_user_fanout jobs to scoped RoomDO reconciliation', async () => {
  const teamDomain = `ops-room-fanout-${Date.now()}.cloudflareaccess.com`;
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
    const roomCalls = [];
    rig.jobsEnv.ROOM_DO = {
      idFromName(name) {
        return String(name);
      },
      get(id) {
        return {
          async reconcileFanout(request) {
            roomCalls.push({
              room_id: String(id),
              request,
            });
            return {
              ok: true,
              results: [{
                room_id: String(id),
                status: request?.dry_run === true ? 'would_recreate_outbox' : 'acked',
              }],
            };
          },
        };
      },
    };
    rig.jobsEnv.USER_DO = {
      idFromName(name) {
        return String(name);
      },
      get(id) {
        return {
          async listRoomSyncMemberships() {
            assert.equal(String(id), '@alice:test');
            return {
              ok: true,
              entries: [
                { room_id: '!fanout-a:test', membership_bucket: 'join', room_pos: 1 },
                { room_id: '!fanout-b:test', membership_bucket: 'leave', room_pos: 2 },
              ],
            };
          },
        };
      },
    };

    const repairResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/repairs', {
        method: 'POST',
        body: {
          repair_kind: 'room_user_fanout',
          scope: {
            scope_kind: 'user_id',
            scope_id: '@alice:test',
          },
          reason: 'repair fanout truth',
          ticket_id: 'OPS-202A',
          dry_run: true,
          source_bundle_uri: null,
        },
        headers: {
          'Idempotency-Key': 'idem-room-user-fanout-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(repairResponse.status, 202);
    const repairPayload = await repairResponse.json();

    await rig.jobsWorker.queue(rig.queues.repair.drainBatch(), rig.jobsEnv);

    assert.deepEqual(
      roomCalls.map((entry) => entry.room_id),
      ['!fanout-a:test', '!fanout-b:test'],
    );
    assert.ok(roomCalls.every((entry) => entry.request.target_user_id === '@alice:test'));
    assert.ok(roomCalls.every((entry) => entry.request.dry_run === true));

    const storedJob = await rig.persistence.getJob(repairPayload.job_id);
    assert.equal(storedJob.internal_state, 'completed');
    assert.equal(storedJob.result_summary.repair_summary.scope_count, 2);
    assert.equal(storedJob.result_summary.repair_summary.dry_run, true);
  } finally {
    rig.close();
  }
});

test('jobs-worker drains room-scoped fanout repair until RoomDO reports no remaining work', async () => {
  const teamDomain = `ops-room-fanout-room-scope-${Date.now()}.cloudflareaccess.com`;
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
    const roomCalls = [];
    rig.jobsEnv.ROOM_DO = {
      idFromName(name) {
        return String(name);
      },
      get(id) {
        return {
          async reconcileFanout(request) {
            roomCalls.push({
              room_id: String(id),
              request,
            });
            return {
              ok: true,
              has_more: roomCalls.length === 1,
              results: [{
                room_id: String(id),
                status: roomCalls.length === 1 ? 'recreated_outbox' : 'acked',
              }],
            };
          },
        };
      },
    };

    const repairResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/repairs', {
        method: 'POST',
        body: {
          repair_kind: 'room_user_fanout',
          scope: {
            scope_kind: 'room_id',
            scope_id: '!room:test',
          },
          reason: 'repair room fanout truth',
          ticket_id: 'OPS-202B',
          dry_run: false,
          source_bundle_uri: null,
        },
        headers: {
          'Idempotency-Key': 'idem-room-fanout-room-scope-1',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(repairResponse.status, 202);
    const repairPayload = await repairResponse.json();

    await rig.jobsWorker.queue(rig.queues.repair.drainBatch(), rig.jobsEnv);

    assert.equal(roomCalls.length, 2);
    assert.ok(roomCalls.every((entry) => entry.room_id === '!room:test'));
    assert.ok(roomCalls.every((entry) => entry.request.target_user_id == null));
    assert.ok(roomCalls.every((entry) => entry.request.dry_run === false));

    const storedJob = await rig.persistence.getJob(repairPayload.job_id);
    assert.equal(storedJob.internal_state, 'completed');
    assert.equal(storedJob.result_summary.repair_summary.scope_count, 1);
    assert.equal(storedJob.result_summary.repair_summary.results.length, 2);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects bundle hash mismatches before queue fanout', async () => {
  const teamDomain = `ops-restore-preflight-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifestKey } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-preflight-seed',
      ticketId: 'OPS-204',
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace with bad hash',
          ticket_id: 'OPS-205',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: 'bundle-hash-mismatch',
          target_environment_id: 'target-env-1',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-bad-hash',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight enforces signing key version allowlists before queue fanout', async () => {
  const teamDomain = `ops-restore-allowlist-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifestKey, bundleManifest } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-allowlist-seed',
      ticketId: 'OPS-208',
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace with signing key allowlist mismatch',
          ticket_id: 'OPS-209',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-allowlist',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v0'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-allowlist-mismatch',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight enforces encryption key version allowlists before queue fanout', async () => {
  const teamDomain = `ops-restore-encryption-allowlist-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifestKey, bundleManifest } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-encryption-allowlist-seed',
      ticketId: 'OPS-210',
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace with encryption key allowlist mismatch',
          ticket_id: 'OPS-211',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-encryption-allowlist',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v0'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-encryption-allowlist-mismatch',
        },
      }),
      rig.opsEnv,
    );
    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects tampered registry snapshots before queue fanout', async () => {
  const teamDomain = `ops-restore-registry-tamper-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifestKey, bundleManifest } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-registry-tamper-seed',
      ticketId: 'OPS-210',
    });
    const snapshotKey = bundleManifest.registry_snapshot_r2_object_key;
    assert.ok(snapshotKey);

    const snapshot = rig.archiveBucket.getJson(snapshotKey);
    assert.ok(snapshot);
    await rig.archiveBucket.put(snapshotKey, JSON.stringify({
      ...snapshot,
      row_count: Number(snapshot.row_count ?? 0) + 1,
    }));

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace with tampered registry snapshot',
          ticket_id: 'OPS-211',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-registry-tamper',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-registry-tamper',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects bundle manifests that omit the frozen registry snapshot', async () => {
  const teamDomain = `ops-restore-missing-registry-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifestKey, bundleManifest } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-missing-registry-seed',
      ticketId: 'OPS-211A',
    });
    const unsignedBundleManifest = {
      ...bundleManifest,
      registry_snapshot_id: null,
      registry_snapshot_hash: null,
      registry_snapshot_r2_object_key: null,
    };
    delete unsignedBundleManifest.manifest_hash;
    delete unsignedBundleManifest.signature;
    const keyRing = parseExportKeyRing(rig.opsEnv.EXPORT_BUNDLE_KEY_RING);
    const tamperedBundleManifest = createSignedManifest({
      unsignedManifest: unsignedBundleManifest,
      keyRing,
    });
    await rig.archiveBucket.put(bundleManifestKey, JSON.stringify(tamperedBundleManifest));

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace without frozen registry snapshot',
          ticket_id: 'OPS-211B',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: tamperedBundleManifest.manifest_hash,
          target_environment_id: 'target-env-missing-registry',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-missing-registry',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.match(restorePayload.message, /registry snapshot id and hash/);
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects tampered checkpoint manifests before queue fanout', async () => {
  const teamDomain = `ops-restore-checkpoint-manifest-tamper-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifestKey, bundleManifest, checkpointRef } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-checkpoint-manifest-tamper-seed',
      ticketId: 'OPS-212',
    });
    const checkpointManifestKey = checkpointRef.manifest_r2_object_key;
    const checkpointManifest = rig.archiveBucket.getJson(checkpointManifestKey);
    assert.ok(checkpointManifest);
    await rig.archiveBucket.put(checkpointManifestKey, JSON.stringify({
      ...checkpointManifest,
      completeness_state: 'incomplete',
    }));

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace with tampered checkpoint manifest',
          ticket_id: 'OPS-213',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-checkpoint-manifest-tamper',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-checkpoint-manifest-tamper',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker export creation fails closed when the archive bucket binding is missing during snapshot freeze', async () => {
  const teamDomain = `ops-export-missing-bucket-${Date.now()}.cloudflareaccess.com`;
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
    rig.opsEnv.MATRIX_ARCHIVE_BUCKET = null;
    const exportResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'snapshot freeze should fail without archive bucket',
          ticket_id: 'OPS-215A',
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': 'idem-export-missing-archive-bucket',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(exportResponse.status, 409);
    const exportPayload = await exportResponse.json();
    assert.equal(exportPayload.code, 'precondition_failed');
    assert.match(exportPayload.message, /Missing MATRIX_ARCHIVE_BUCKET binding/);
    assert.equal(rig.queues.export.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects checkpoint object hash mismatches before queue fanout', async () => {
  const teamDomain = `ops-restore-checkpoint-object-tamper-${Date.now()}.cloudflareaccess.com`;
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
    const {
      bundleManifestKey,
      bundleManifest,
      checkpointObjectKey,
    } = await seedFullExportBundle(rig, {
      idempotencyKey: 'idem-export-checkpoint-object-tamper-seed',
      ticketId: 'OPS-214',
    });

    const objectEnvelope = rig.archiveBucket.getJson(checkpointObjectKey);
    assert.ok(objectEnvelope);
    await rig.archiveBucket.put(checkpointObjectKey, JSON.stringify({
      ...objectEnvelope,
      ciphertext_base64url: `${objectEnvelope.ciphertext_base64url}tampered`,
    }));

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'restore namespace with tampered checkpoint object',
          ticket_id: 'OPS-215',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-checkpoint-object-tamper',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-checkpoint-object-tamper',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight resolves registry snapshots from the bundle archive instead of local D1 state', async () => {
  const sourceTeamDomain = `ops-restore-source-${Date.now()}.cloudflareaccess.com`;
  const targetTeamDomain = `ops-restore-target-${Date.now()}.cloudflareaccess.com`;
  const sourceRig = await createControlPlaneRig({
    teamDomain: sourceTeamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain: sourceTeamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const exportResponse = await sourceRig.opsWorker(
      sourceRig.makeOpsRequest('/_ops/v1/exports', {
        method: 'POST',
        body: {
          export_mode: 'full_bundle',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'seed cross environment restore',
          ticket_id: 'OPS-206',
          reuse_checkpoint_policy: 'force_fresh',
          max_checkpoint_age_seconds: 60,
          include_optional_objects: false,
          output_encryption_key_version: 'enc-v1',
        },
        headers: {
          'Idempotency-Key': 'idem-export-cross-env-seed',
        },
      }),
      sourceRig.opsEnv,
    );
    assert.equal(exportResponse.status, 202);
    await sourceRig.jobsWorker.queue(sourceRig.queues.export.drainBatch(), sourceRig.jobsEnv);

    const bundleManifestKey = [...sourceRig.archiveBucket.objects.keys()].find((key) => key.includes('/bundle-manifest/'));
    assert.ok(bundleManifestKey);
    const bundleManifest = sourceRig.archiveBucket.getJson(bundleManifestKey);
    assert.ok(bundleManifest.registry_snapshot_r2_object_key);

    const targetRig = await createControlPlaneRig({
      teamDomain: targetTeamDomain,
      policies: [
        defaultPolicy({
          principalId: 'human-1',
          subjectValue: '@operator:example.test',
          teamDomain: targetTeamDomain,
          audience: 'aud-ops',
        }),
      ],
    });

    try {
      targetRig.opsEnv.MATRIX_ARCHIVE_BUCKET = sourceRig.archiveBucket;
      targetRig.jobsEnv.MATRIX_ARCHIVE_BUCKET = sourceRig.archiveBucket;
      targetRig.opsEnv.EXPORT_BUNDLE_KEY_RING = sourceRig.opsEnv.EXPORT_BUNDLE_KEY_RING;
      targetRig.jobsEnv.EXPORT_BUNDLE_KEY_RING = sourceRig.jobsEnv.EXPORT_BUNDLE_KEY_RING;

      assert.equal(
        await targetRig.persistence.getRegistrySnapshot(bundleManifest.registry_snapshot_id),
        null,
      );

      const restoreResponse = await targetRig.opsWorker(
        targetRig.makeOpsRequest('/_ops/v1/restores', {
          method: 'POST',
          body: {
            restore_mode: 'full_namespace',
            scope: {
              scope_kind: 'global',
              scope_id: null,
            },
            reason: 'cross environment restore',
            ticket_id: 'OPS-207',
            source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
            source_bundle_hash: bundleManifest.manifest_hash,
            target_environment_id: 'target-env-2',
            allow_incomplete: false,
            allowed_signing_key_versions: ['sig-v1'],
            allowed_encryption_key_versions: ['enc-v1'],
          },
          headers: {
            'Idempotency-Key': 'idem-restore-cross-env',
          },
        }),
        targetRig.opsEnv,
      );

      assert.equal(restoreResponse.status, 202);
      assert.equal(targetRig.queues.restore.messages.length, 1);
      assert.equal(
        targetRig.queues.restore.messages[0].checkpoint_id,
        bundleManifest.checkpoint_refs[0].checkpoint_id,
      );
    } finally {
      targetRig.close();
    }
  } finally {
    sourceRig.close();
  }
});

test('ops-worker restore preflight accepts allowed non-active signing and encryption key versions after rotation', async () => {
  const sourceTeamDomain = `ops-restore-rotated-source-${Date.now()}.cloudflareaccess.com`;
  const targetTeamDomain = `ops-restore-rotated-target-${Date.now()}.cloudflareaccess.com`;
  const sourceRig = await createControlPlaneRig({
    teamDomain: sourceTeamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain: sourceTeamDomain,
        audience: 'aud-ops',
      }),
    ],
  });

  try {
    const { bundleManifestKey, bundleManifest } = await seedFullExportBundle(sourceRig, {
      idempotencyKey: 'idem-export-rotated-key-seed',
      ticketId: 'OPS-216',
    });

    const targetRig = await createControlPlaneRig({
      teamDomain: targetTeamDomain,
      policies: [
        defaultPolicy({
          principalId: 'human-1',
          subjectValue: '@operator:example.test',
          teamDomain: targetTeamDomain,
          audience: 'aud-ops',
        }),
      ],
    });

    try {
      const rotatedSecret = createRotatedExportKeyRingSecret(sourceRig.opsEnv.EXPORT_BUNDLE_KEY_RING);
      targetRig.opsEnv.MATRIX_ARCHIVE_BUCKET = sourceRig.archiveBucket;
      targetRig.jobsEnv.MATRIX_ARCHIVE_BUCKET = sourceRig.archiveBucket;
      targetRig.opsEnv.EXPORT_BUNDLE_KEY_RING = rotatedSecret;
      targetRig.jobsEnv.EXPORT_BUNDLE_KEY_RING = rotatedSecret;

      const restoreResponse = await targetRig.opsWorker(
        targetRig.makeOpsRequest('/_ops/v1/restores', {
          method: 'POST',
          body: {
            restore_mode: 'full_namespace',
            scope: {
              scope_kind: 'global',
              scope_id: null,
            },
            reason: 'cross environment restore with rotated key ring',
            ticket_id: 'OPS-217',
            source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
            source_bundle_hash: bundleManifest.manifest_hash,
            target_environment_id: 'target-env-rotated-keys',
            allow_incomplete: false,
            allowed_signing_key_versions: ['sig-v1'],
            allowed_encryption_key_versions: ['enc-v1'],
          },
          headers: {
            'Idempotency-Key': 'idem-restore-rotated-keys',
          },
        }),
        targetRig.opsEnv,
      );

      assert.equal(restoreResponse.status, 202);
      const restorePayload = await restoreResponse.json();
      assert.equal(restorePayload.job_type, 'restore');
      assert.equal(targetRig.queues.restore.messages.length, 1);
      assert.equal(
        targetRig.queues.restore.messages[0].checkpoint_id,
        bundleManifest.checkpoint_refs[0].checkpoint_id,
      );
    } finally {
      targetRig.close();
    }
  } finally {
    sourceRig.close();
  }
});

test('ops-worker restore preflight accepts spec-minimal UserDO checkpoints', async () => {
  const teamDomain = `ops-restore-user-minimal-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRestoreBundle(rig, {
      shardType: 'UserDO',
      shardKey: '@alice:example.test',
      sourceWatermark: {
        max_user_stream_pos: 7,
        device_state_version: 3,
        to_device_queue_highwater: 9,
      },
      objectSpecs: USER_REQUIRED_OBJECT_SPECS,
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'accept spec-minimal user checkpoint',
          ticket_id: 'OPS-218',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-user-minimal',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-user-minimal',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 202);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.job_type, 'restore');
    assert.equal(rig.queues.restore.messages.length, 1);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects undecodable checkpoint objects as precondition_failed', async () => {
  const teamDomain = `ops-restore-undecodable-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRestoreBundle(rig, {
      shardType: 'control-plane',
      shardKey: 'ops-core',
      sourceWatermark: {
        max_audit_event_seq: 11,
      },
      objectSpecs: [{
        ...CONTROL_PLANE_REQUIRED_OBJECT_SPECS[0],
        envelopeOverrides: {
          tag_base64url: 'AA',
        },
      }],
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'reject undecodable checkpoint object',
          ticket_id: 'OPS-219',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-undecodable',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-undecodable-object',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects checkpoint objects with unsupported apply_phase', async () => {
  const teamDomain = `ops-restore-apply-phase-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRestoreBundle(rig, {
      shardType: 'control-plane',
      shardKey: 'ops-core',
      sourceWatermark: {
        max_audit_event_seq: 12,
      },
      objectSpecs: [{
        ...CONTROL_PLANE_REQUIRED_OBJECT_SPECS[0],
        apply_phase: 'mystery-phase',
      }],
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'reject invalid apply phase',
          ticket_id: 'OPS-220',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-apply-phase',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-invalid-apply-phase',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects checkpoint objects with unsupported codec', async () => {
  const teamDomain = `ops-restore-codec-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRestoreBundle(rig, {
      shardType: 'control-plane',
      shardKey: 'ops-core',
      sourceWatermark: {
        max_audit_event_seq: 13,
      },
      objectSpecs: [{
        ...CONTROL_PLANE_REQUIRED_OBJECT_SPECS[0],
        codec: 'tarball',
      }],
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'reject invalid codec',
          ticket_id: 'OPS-221',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-codec',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-invalid-codec',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects jcs-json checkpoint objects with invalid record_count', async () => {
  const teamDomain = `ops-restore-record-count-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRestoreBundle(rig, {
      shardType: 'control-plane',
      shardKey: 'ops-core',
      sourceWatermark: {
        max_audit_event_seq: 14,
      },
      objectSpecs: [{
        ...CONTROL_PLANE_REQUIRED_OBJECT_SPECS[0],
        entryOverrides: {
          record_count: 2,
        },
      }],
    });

    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'reject invalid record count',
          ticket_id: 'OPS-222',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-record-count',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-invalid-record-count',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects RoomDO checkpoints missing room-archive-reference-set', async () => {
  const teamDomain = `ops-restore-room-archive-ref-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRoomRestoreBundleMissingArchiveReference(rig);
    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'reject incomplete room checkpoint',
          ticket_id: 'OPS-208',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-room-1',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-room-missing-archive-ref',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.match(restorePayload.message, /room-archive-reference-set/);
    assert.equal(rig.queues.restore.messages.length, 0);
  } finally {
    rig.close();
  }
});

test('ops-worker restore preflight rejects RoomDO checkpoints with invalid source_watermark shape', async () => {
  const teamDomain = `ops-restore-room-watermark-${Date.now()}.cloudflareaccess.com`;
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
    const { bundleManifest, bundleManifestKey } = await seedSyntheticRoomRestoreBundleMissingArchiveReference(rig, {
      sourceWatermark: 7,
    });
    const restoreResponse = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/restores', {
        method: 'POST',
        body: {
          restore_mode: 'full_namespace',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'reject invalid room watermark',
          ticket_id: 'OPS-209',
          source_bundle_uri: `r2://matrix-archive/${bundleManifestKey}`,
          source_bundle_hash: bundleManifest.manifest_hash,
          target_environment_id: 'target-env-room-2',
          allow_incomplete: false,
          allowed_signing_key_versions: ['sig-v1'],
          allowed_encryption_key_versions: ['enc-v1'],
        },
        headers: {
          'Idempotency-Key': 'idem-restore-room-invalid-watermark',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(restoreResponse.status, 409);
    const restorePayload = await restoreResponse.json();
    assert.equal(restorePayload.code, 'precondition_failed');
    assert.match(restorePayload.message, /source_watermark/);
    assert.equal(rig.queues.restore.messages.length, 0);
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

test('jobs-worker internal export start rejects registry snapshots with shard rows that Phase 02 cannot materialize', async () => {
  const rig = await createControlPlaneRig();

  try {
    const exportEpoch = `export_epoch_unsupported_shard_${Date.now()}`;
    const registrySnapshotId = `registry_snapshot_unsupported_shard_${Date.now()}`;
    const createdAt = new Date().toISOString();
    const snapshotRows = [
      {
        shard_type: 'RoomDO',
        shard_key: '!room:test',
        created_at: createdAt,
        last_seen_at: createdAt,
        schema_version: 1,
        disabled_at: null,
      },
    ];
    await rig.persistence.insertRegistrySnapshot({
      registry_snapshot_id: registrySnapshotId,
      export_epoch: exportEpoch,
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      created_at: createdAt,
      row_count: snapshotRows.length,
      snapshot: {
        rows: snapshotRows,
      },
      snapshot_hash: 'hash-unsupported-shard',
      signature: 'sig-unsupported-shard',
      signing_key_version: 'sig-v1',
      r2_object_key: null,
    });

    const spec = buildInternalJobSpec({
      jobId: `export-unsupported-shard-${Date.now()}`,
      jobType: 'export',
      operatorPrincipalId: 'human-1',
      authMechanism: 'Cf-Access-Jwt-Assertion',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'test unsupported shard export start',
      ticketId: 'OPS-UNSUPPORTED-SHARD',
      idempotencyKey: 'idem-unsupported-shard',
      requestFingerprint: 'fingerprint-unsupported-shard',
      extra: {
        registry_snapshot_id: registrySnapshotId,
        export_epoch: exportEpoch,
        reuse_checkpoint_policy: 'force_fresh',
      },
    });
    await rig.persistence.createJob(createStoredJobRecord({
      spec,
      registrySnapshotId,
      exportEpoch,
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
    assert.match(payload.message, /only control-plane\/ops-core is implemented/);
    assert.equal(rig.queues.export.messages.length, 0);
    assert.deepEqual(await rig.persistence.listJobCheckpoints(spec.job_id), []);
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

test('jobs-worker fails staged unsupported export shard queue messages before writing control-plane artifacts', async () => {
  const rig = await createControlPlaneRig();

  try {
    const exportEpoch = `export_epoch_unsupported_queue_${Date.now()}`;
    const spec = buildInternalJobSpec({
      jobId: `export-unsupported-queue-${Date.now()}`,
      jobType: 'export',
      operatorPrincipalId: 'human-1',
      authMechanism: 'Cf-Access-Jwt-Assertion',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'test unsupported shard queue delivery',
      ticketId: 'OPS-UNSUPPORTED-QUEUE',
      idempotencyKey: 'idem-unsupported-queue',
      requestFingerprint: 'fingerprint-unsupported-queue',
      extra: {
        registry_snapshot_id: 'registry_snapshot_unsupported_queue',
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
      registrySnapshotId: 'registry_snapshot_unsupported_queue',
      exportEpoch,
    }));
    await rig.persistence.upsertJobCheckpoint({
      job_id: spec.job_id,
      shard_type: 'RoomDO',
      shard_key: '!room:test',
      checkpoint: {
        status: 'queued',
        queue_name: 'matrix-export-shard-job',
        attempt: 0,
      },
      updated_at: new Date().toISOString(),
    });

    const message = {
      body: buildExportShardJob({
        jobId: spec.job_id,
        exportEpoch,
        shardType: 'RoomDO',
        shardKey: '!room:test',
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

    assert.equal(message.acked, true);
    assert.equal(message.retried, false);

    const failedJob = await rig.persistence.getJob(spec.job_id);
    assert.equal(failedJob.internal_state, 'failed');
    assert.equal(failedJob.last_error.code, 'precondition_failed');
    assert.match(failedJob.last_error.message, /only control-plane\/ops-core is implemented/);

    const checkpoint = await rig.persistence.getJobCheckpoint({
      job_id: spec.job_id,
      shard_type: 'RoomDO',
      shard_key: '!room:test',
    });
    assert.equal(checkpoint.checkpoint.status, 'queued');
    assert.equal(rig.archiveBucket.objects.size, 0);
  } finally {
    rig.close();
  }
});

test('jobs-worker runtime consumer queues acknowledge malformed search jobs instead of falling through to placeholder handling', async () => {
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

    assert.equal(message.acked, true);
    assert.equal(message.retried, false);
  } finally {
    rig.close();
  }
});

test('jobs-worker runtime consumer queues recognize environment-suffixed search queue names', async () => {
  const rig = await createControlPlaneRig({
    envOverrides: {
      RESOURCE_BINDING_NAMES_JSON: JSON.stringify({
        queues: {
          SEARCH_INDEX_QUEUE: 'matrix-search-index-job-staging',
        },
      }),
    },
  });

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
      queue: 'matrix-search-index-job-staging',
      messages: [message],
    }, rig.jobsEnv);

    assert.equal(message.acked, true);
    assert.equal(message.retried, false);
  } finally {
    rig.close();
  }
});

test('jobs-worker runtime consumer queues still recognize canonical search queue names when bindings are suffixed', async () => {
  const rig = await createControlPlaneRig({
    envOverrides: {
      RESOURCE_BINDING_NAMES_JSON: JSON.stringify({
        queues: {
          SEARCH_INDEX_QUEUE: 'matrix-search-index-job-staging',
        },
      }),
    },
  });

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

    assert.equal(message.acked, true);
    assert.equal(message.retried, false);
  } finally {
    rig.close();
  }
});

test('jobs-worker runtime consumer queues recognize canonical and suffixed media queue names when bindings are suffixed', async () => {
  const rig = await createControlPlaneRig({
    envOverrides: {
      RESOURCE_BINDING_NAMES_JSON: JSON.stringify({
        queues: {
          MEDIA_THUMBNAIL_QUEUE: 'matrix-media-thumbnail-job-staging',
        },
      }),
    },
  });

  try {
    for (const queueName of ['matrix-media-thumbnail-job-staging', 'matrix-media-thumbnail-job']) {
      const message = {
        body: 'not-an-object',
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
        queue: queueName,
        messages: [message],
      }, rig.jobsEnv);

      assert.equal(message.acked, true, `${queueName} should be acknowledged by the runtime handler`);
      assert.equal(message.retried, false, `${queueName} should not retry malformed runtime payloads`);
    }
  } finally {
    rig.close();
  }
});

test('jobs-worker control-plane consumer queues recognize environment-suffixed export queue names', async () => {
  const rig = await createControlPlaneRig({
    envOverrides: {
      RESOURCE_BINDING_NAMES_JSON: JSON.stringify({
        queues: {
          EXPORT_SHARD_QUEUE: 'matrix-export-shard-job-staging',
        },
      }),
    },
  });

  try {
    const exportEpoch = `export_epoch_suffixed_queue_${Date.now()}`;
    const spec = buildInternalJobSpec({
      jobId: `export-suffixed-queue-${Date.now()}`,
      jobType: 'export',
      operatorPrincipalId: 'human-1',
      authMechanism: 'Cf-Access-Jwt-Assertion',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'test suffixed export queue delivery',
      ticketId: 'OPS-SUFFIXED-QUEUE',
      idempotencyKey: 'idem-suffixed-queue',
      requestFingerprint: 'fingerprint-suffixed-queue',
      extra: {
        registry_snapshot_id: 'registry_snapshot_suffixed_queue',
        export_epoch: exportEpoch,
        reuse_checkpoint_policy: 'force_fresh',
      },
    });
    await rig.persistence.createJob(createStoredJobRecord({
      spec,
      internalState: 'checkpointed',
      checkpointState: {
        queue_ready: 1,
        queue_name: 'matrix-export-shard-job-staging',
      },
      progressTotalUnits: 1,
      registrySnapshotId: 'registry_snapshot_suffixed_queue',
      exportEpoch,
    }));
    await rig.persistence.upsertJobCheckpoint({
      job_id: spec.job_id,
      shard_type: 'RoomDO',
      shard_key: '!room:test',
      checkpoint: {
        status: 'queued',
        queue_name: 'matrix-export-shard-job-staging',
        attempt: 0,
      },
      updated_at: new Date().toISOString(),
    });

    const message = {
      body: buildExportShardJob({
        jobId: spec.job_id,
        exportEpoch,
        shardType: 'RoomDO',
        shardKey: '!room:test',
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
      queue: 'matrix-export-shard-job-staging',
      messages: [message],
    }, rig.jobsEnv);
    assert.equal(message.acked, true);
    assert.equal(message.retried, false);

    const failedJob = await rig.persistence.getJob(spec.job_id);
    assert.equal(failedJob.internal_state, 'failed');
    assert.equal(failedJob.last_error.code, 'precondition_failed');
    assert.match(failedJob.last_error.message, /only control-plane\/ops-core is implemented/);
  } finally {
    rig.close();
  }
});

test('jobs-worker control-plane consumer queues still recognize canonical export queue names when bindings are suffixed', async () => {
  const rig = await createControlPlaneRig({
    envOverrides: {
      RESOURCE_BINDING_NAMES_JSON: JSON.stringify({
        queues: {
          EXPORT_SHARD_QUEUE: 'matrix-export-shard-job-staging',
        },
      }),
    },
  });

  try {
    const exportEpoch = `export_epoch_canonical_queue_${Date.now()}`;
    const spec = buildInternalJobSpec({
      jobId: `export-canonical-queue-${Date.now()}`,
      jobType: 'export',
      operatorPrincipalId: 'human-1',
      authMechanism: 'Cf-Access-Jwt-Assertion',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: 'test canonical export queue delivery under suffixed binding override',
      ticketId: 'OPS-CANONICAL-QUEUE',
      idempotencyKey: 'idem-canonical-queue',
      requestFingerprint: 'fingerprint-canonical-queue',
      extra: {
        registry_snapshot_id: 'registry_snapshot_canonical_queue',
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
      registrySnapshotId: 'registry_snapshot_canonical_queue',
      exportEpoch,
    }));
    await rig.persistence.upsertJobCheckpoint({
      job_id: spec.job_id,
      shard_type: 'RoomDO',
      shard_key: '!room:test',
      checkpoint: {
        status: 'queued',
        queue_name: 'matrix-export-shard-job',
        attempt: 0,
      },
      updated_at: new Date().toISOString(),
    });

    const message = {
      body: buildExportShardJob({
        jobId: spec.job_id,
        exportEpoch,
        shardType: 'RoomDO',
        shardKey: '!room:test',
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
    assert.equal(message.acked, true);
    assert.equal(message.retried, false);

    const failedJob = await rig.persistence.getJob(spec.job_id);
    assert.equal(failedJob.internal_state, 'failed');
    assert.equal(failedJob.last_error.code, 'precondition_failed');
    assert.match(failedJob.last_error.message, /only control-plane\/ops-core is implemented/);
  } finally {
    rig.close();
  }
});

test('jobs-worker control-plane consumer queues still recognize canonical and suffixed rebuild/restore/repair queue names when bindings are suffixed', async () => {
  const rig = await createControlPlaneRig({
    envOverrides: {
      RESOURCE_BINDING_NAMES_JSON: JSON.stringify({
        queues: {
          REBUILD_SHARD_QUEUE: 'matrix-rebuild-shard-job-staging',
          RESTORE_SHARD_QUEUE: 'matrix-restore-shard-job-staging',
          REPAIR_SHARD_QUEUE: 'matrix-repair-shard-job-staging',
        },
      }),
    },
  });

  try {
    const scenarios = [
      { queueName: 'matrix-rebuild-shard-job-staging', jobId: `rebuild-suffixed-${Date.now()}` },
      { queueName: 'matrix-rebuild-shard-job', jobId: `rebuild-canonical-${Date.now()}` },
      { queueName: 'matrix-restore-shard-job-staging', jobId: `restore-suffixed-${Date.now()}` },
      { queueName: 'matrix-restore-shard-job', jobId: `restore-canonical-${Date.now()}` },
      { queueName: 'matrix-repair-shard-job-staging', jobId: `repair-suffixed-${Date.now()}` },
      { queueName: 'matrix-repair-shard-job', jobId: `repair-canonical-${Date.now()}` },
    ];

    for (const scenario of scenarios) {
      const message = {
        body: {
          job_id: scenario.jobId,
          schema_version: 999,
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
        queue: scenario.queueName,
        messages: [message],
      }, rig.jobsEnv);

      assert.equal(message.acked, true, `${scenario.queueName} should be acknowledged by the control-plane handler`);
      assert.equal(message.retried, false, `${scenario.queueName} should fail closed on unsupported schema versions`);
    }
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
    const now = new Date().toISOString();
    await rig.persistence.upsertShardRegistry({
      shard_type: 'RoomDO',
      shard_key: '!room:test',
      created_at: now,
      last_seen_at: now,
      schema_version: 1,
      disabled_at: null,
    });

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

test('ops-worker preserves typed jobs-worker start conflicts as precondition_failed instead of internal', async () => {
  const teamDomain = `ops-start-map-${Date.now()}.cloudflareaccess.com`;
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
    rig.opsEnv.JOBS_WORKER = {
      async fetch() {
        return new Response(JSON.stringify({
          code: 'job_conflict',
          message: 'synthetic conflict',
          retryable: false,
          details: {
            source: 'test',
          },
        }), {
          status: 409,
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
        });
      },
    };

    const response = await rig.opsWorker(
      rig.makeOpsRequest('/_ops/v1/rebuilds', {
        method: 'POST',
        body: {
          rebuild_target: 'search_index',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: 'typed internal error mapping',
          ticket_id: 'OPS-304',
          force_full_scan: false,
        },
        headers: {
          'Idempotency-Key': 'idem-start-dispatch-mapping',
        },
      }),
      rig.opsEnv,
    );

    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.code, 'precondition_failed');
    assert.equal(payload.message, 'synthetic conflict');
    assert.equal(payload.retryable, false);
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

test('ops-worker rebuild start converges legacy control-plane D1 tables to the current schema before queueing jobs', async () => {
  const teamDomain = `ops-stale-schema-${Date.now()}.cloudflareaccess.com`;
  const staleRig = await createControlPlaneRig({
    teamDomain,
    policies: [
      defaultPolicy({
        principalId: 'human-1',
        subjectValue: '@operator:example.test',
        teamDomain,
        audience: 'aud-ops',
      }),
    ],
    initializeControlPlaneD1: async (d1) => {
      await d1.exec(LEGACY_CONTROL_PLANE_SCHEMA_SQL);
    },
  });
  const freshRig = await createControlPlaneRig();

  try {
    const response = await staleRig.opsWorker(
      staleRig.makeOpsRequest('/_ops/v1/rebuilds', {
        method: 'POST',
        body: {
          rebuild_target: 'user_directory',
          scope: {
            scope_kind: 'user_id',
            scope_id: '@alice:test',
          },
          reason: 'stale schema convergence',
          force_full_scan: false,
        },
        headers: {
          'Idempotency-Key': 'idem-stale-schema-rebuild',
        },
      }),
      staleRig.opsEnv,
    );

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.job_type, 'rebuild');
    assert.equal(payload.idempotency_key_echo, 'idem-stale-schema-rebuild');
    assert.equal(staleRig.queues.rebuild.messages.length, 1);

    for (const tableName of CONTROL_PLANE_LEGACY_CONVERGENCE_TABLES) {
      const convergedColumns = await listD1TableColumns(staleRig.d1, tableName);
      const currentColumns = await listD1TableColumns(freshRig.d1, tableName);
      assert.deepEqual(
        [...convergedColumns].sort(),
        [...currentColumns].sort(),
        `legacy table ${tableName} must converge to the current control-plane schema`,
      );
    }
  } finally {
    staleRig.close();
    freshRig.close();
  }
});

test('dispatchJobStart keeps non-JSON jobs-worker failures diagnosable without echoing raw HTML in the error message', async () => {
  await assert.rejects(
    dispatchJobStart({
      env: {
        JOBS_WORKER: {
          fetch: async () => new Response('<!DOCTYPE html><html><body>worker crashed</body></html>', {
            status: 500,
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          }),
        },
      },
      routeTemplate: '/_internal/jobs/start/rebuild',
      spec: {
        job_id: 'job-rebuild-test',
      },
    }),
    (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
      assert.match(error.message, /jobs-worker start failed with 500: non-JSON error body/);
      assert.equal(/<!DOCTYPE html>/.test(error.message), false);
      assert.match(error.details?.non_json_body_preview ?? '', /<!DOCTYPE html>/);
      return true;
    },
  );
});
