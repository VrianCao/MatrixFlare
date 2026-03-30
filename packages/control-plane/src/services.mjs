import {
  parseInternalErrorEnvelope,
} from '../../contracts/src/index.mjs';
import {
  buildExportBundleObjectKey,
  buildNormalizedRequestObject,
  canonicalizeJsonText,
  canonicalizeJsonValue,
  createRequestFingerprint,
  createRequestContext,
  loadWorkerRuntimeConfig,
  makeId,
} from '../../runtime-core/src/index.mjs';
import {
  canonicalHash,
  computeStableSubject,
  createAccessJwkCache,
  createSignedManifest,
  decryptBytes,
  encryptBytes,
  parseExportKeyRing,
  verifySignedManifestWithKeyRing,
  verifyAccessJwt,
} from './crypto.mjs';
import { createD1ControlPlanePersistence } from './persistence.mjs';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  OPS_SCOPE_VOCABULARY,
  ROUTE_TEMPLATES,
  buildInternalJobSpec,
  buildJobHandleFromRecord,
  buildJobStatusResponseFromRecords,
  buildOpsErrorJson,
  mapInternalJobStateToPublicState,
  normalizeExportJobRequest,
  normalizeJobStatusQuery,
  normalizeRebuildJobRequest,
  normalizeRepairJobRequest,
  normalizeRestoreJobRequest,
  normalizeTargetScope,
  scopeToToken,
} from './schemas.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';

const ACCESS_JWK_CACHE = createAccessJwkCache();
const RESTORE_PHASE_ORDER = Object.freeze([
  'truth-core',
  'truth-aux',
  'ephemeral-current',
  'dedupe-and-outbox',
  'control-plane',
]);
const REQUIRED_RESTORE_OBJECT_KINDS = Object.freeze({
  RoomDO: Object.freeze([
    'room-events-metadata-segment',
    'room-hot-event-json-segment',
    'room-prev-edges-segment',
    'room-auth-edges-segment',
    'room-state-snapshot-segment',
    'room-membership-current',
    'room-forward-extremities-current',
    'room-fanout-outbox-segment',
    'room-client-txn-dedupe-segment',
    'room-archive-reference-set',
  ]),
  UserDO: Object.freeze([
    'user-identity-and-session-segment',
    'user-profile-and-account-segment',
    'user-stream-and-todevice-segment',
  ]),
  RemoteServerDO: Object.freeze([
    'remote-outbound-queue-segment',
    'remote-inbound-txn-segment',
  ]),
  'control-plane': Object.freeze([
    'ops-core-segment',
  ]),
});
const CONTROL_PLANE_CHECKPOINT_DATA_IDS = Object.freeze([
  'DATA-D1-005',
  'DATA-D1-006',
  'DATA-OPS-001',
  'DATA-OPS-002',
  'DATA-OPS-003',
  'DATA-OPS-004',
  'DATA-OPS-010',
  'DATA-OPS-011',
]);

function normalizeString(value, label, { allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw Object.assign(new Error(`${label} must be a non-negative integer`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

export function decodeCursor(cursor) {
  if (cursor == null) {
    return null;
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(normalizeString(cursor, 'cursor'), 'base64url').toString('utf8'));
  } catch (error) {
    throw new TypeError(`cursor must be a valid base64url-encoded JSON object: ${error.message}`);
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('cursor must decode to an object with created_at and job_id strings');
  }
  if (typeof decoded.created_at !== 'string' || decoded.created_at.trim().length === 0) {
    throw new TypeError('cursor.created_at must be a non-empty string');
  }
  if (typeof decoded.job_id !== 'string' || decoded.job_id.trim().length === 0) {
    throw new TypeError('cursor.job_id must be a non-empty string');
  }
  return {
    created_at: decoded.created_at.trim(),
    job_id: decoded.job_id.trim(),
  };
}

export function encodeCursor(value) {
  if (value == null) {
    return null;
  }
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export async function readJsonBody(request) {
  const contentType = request.headers.get('content-type') ?? 'application/json';
  if (!contentType.toLowerCase().includes('json')) {
    throw new TypeError('request body must use a JSON content type');
  }
  try {
    return await request.json();
  } catch (error) {
    throw new TypeError(`invalid JSON request body: ${error.message}`);
  }
}

export async function readOptionalJsonBody(request, { defaultValue = {} } = {}) {
  const contentType = request.headers.get('content-type');
  if (contentType != null && !contentType.toLowerCase().includes('json')) {
    throw new TypeError('request body must use a JSON content type');
  }
  const rawText = await request.text();
  if (rawText.trim().length === 0) {
    return defaultValue;
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new TypeError(`invalid JSON request body: ${error.message}`);
  }
}

export function getFetchImpl(env) {
  return env?.__ACCESS_FETCH__ ?? globalThis.fetch;
}

export function getControlPlanePersistence(env) {
  if (env?.__CONTROL_PLANE_PERSISTENCE) {
    return env.__CONTROL_PLANE_PERSISTENCE;
  }
  if (!env?.MATRIX_CONTROL_D1) {
    throw new TypeError('Missing MATRIX_CONTROL_D1 binding');
  }
  return createD1ControlPlanePersistence(env.MATRIX_CONTROL_D1);
}

export function getNow(env) {
  return typeof env?.__NOW__ === 'function' ? env.__NOW__ : () => new Date();
}

function normalizeTargetConstraints(rawValue) {
  const value = rawValue ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('target_scope_constraints must be an object');
  }
  const allowedScopeKinds = Array.isArray(value.allowed_scope_kinds)
    ? value.allowed_scope_kinds.map((entry) => normalizeString(entry, 'allowed_scope_kinds[]'))
    : [];
  const allowedValues = value.allowed_values && typeof value.allowed_values === 'object' && !Array.isArray(value.allowed_values)
    ? Object.fromEntries(Object.entries(value.allowed_values).map(([key, entries]) => {
      if (!Array.isArray(entries)) {
        throw new TypeError(`allowed_values.${key} must be an array`);
      }
      return [key, entries.map((entry) => normalizeString(entry, `allowed_values.${key}[]`))];
    }))
    : {};

  for (const [key, entries] of Object.entries(value)) {
    if (key === 'allowed_scope_kinds' || key === 'allowed_values') {
      continue;
    }
    if (key === 'global') {
      if (entries === true && !allowedScopeKinds.includes('global')) {
        allowedScopeKinds.push('global');
      }
      continue;
    }
    if (!Array.isArray(entries)) {
      throw new TypeError(`target_scope_constraints.${key} must be an array`);
    }
    allowedValues[key] = entries.map((entry) => normalizeString(entry, `target_scope_constraints.${key}[]`));
    if (!allowedScopeKinds.includes(key)) {
      allowedScopeKinds.push(key);
    }
  }

  return {
    allowed_scope_kinds: allowedScopeKinds,
    allowed_values: allowedValues,
  };
}

function authorizeScope(constraints, scope) {
  const normalizedScope = normalizeTargetScope(scope);
  const normalizedConstraints = normalizeTargetConstraints(constraints);
  if (!normalizedConstraints.allowed_scope_kinds.includes(normalizedScope.scope_kind)) {
    return false;
  }
  if (normalizedScope.scope_kind === 'global') {
    return true;
  }
  const allowedValues = normalizedConstraints.allowed_values[normalizedScope.scope_kind] ?? [];
  return allowedValues.includes(normalizedScope.scope_id);
}

function serializeEnvelope(kind, status, body) {
  return {
    kind,
    status,
    body,
  };
}

function createDedupeScopeToken({ scope, dedupeKey = null }) {
  if (dedupeKey != null) {
    return normalizeString(dedupeKey, 'dedupeKey');
  }
  return scopeToToken(scope);
}

function isUniqueConstraintError(error) {
  return typeof error?.message === 'string'
    && error.message.toLowerCase().includes('unique constraint');
}

function deserializeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('response envelope must be an object');
  }
  return {
    kind: normalizeString(envelope.kind, 'envelope.kind'),
    status: envelope.status,
    body: envelope.body,
  };
}

export function responseFromEnvelope(envelope) {
  const normalized = deserializeEnvelope(envelope);
  return jsonResponse(normalized.body, normalized.status);
}

export function opsErrorResponse({
  requestId,
  code,
  message,
  retryable = false,
  details = null,
}) {
  const body = buildOpsErrorJson({
    code,
    message,
    requestId,
    retryable,
    details,
  });
  const statusByCode = {
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    idempotency_conflict: 409,
    validation_failed: 422,
    precondition_failed: 409,
    rate_limited: 429,
    internal: retryable ? 503 : 500,
  };
  return jsonResponse(body, statusByCode[code]);
}

export function buildRequestFingerprint({
  request,
  routeTemplate,
  principalId,
  semanticQuery = null,
  body = null,
}) {
  return createRequestFingerprint({
    method: request.method,
    routeTemplate,
    principalId,
    semanticQuery,
    body,
    contentType: request.headers.get('content-type') ?? 'application/json',
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
  });
}

export function authorizeOperatorRequest({
  operator,
  requiredScope = null,
  targetScope = null,
}) {
  if (requiredScope && !OPS_SCOPE_VOCABULARY.includes(requiredScope)) {
    throw new RangeError(`Unsupported required scope ${requiredScope}`);
  }
  if (requiredScope && !operator.allowed_scopes.includes(requiredScope)) {
    throw Object.assign(new Error(`Operator principal lacks required scope ${requiredScope}`), { code: 'forbidden' });
  }
  if (targetScope && !authorizeScope(operator.target_scope_constraints, targetScope)) {
    throw Object.assign(new Error('Operator target scope is not authorized by policy'), { code: 'forbidden' });
  }
  return operator;
}

export async function authenticateOperatorIdentity({
  request,
  env,
  config,
  requiredScope = null,
}) {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) {
    throw Object.assign(new Error('Missing Cf-Access-Jwt-Assertion'), { code: 'unauthorized' });
  }
  const persistence = getControlPlanePersistence(env);
  const now = getNow(env)();
  const verification = await verifyAccessJwt({
    assertion,
    teamDomain: config.text.ACCESS_TEAM_DOMAIN,
    audience: config.text.ACCESS_AUDIENCE,
    fetchImpl: getFetchImpl(env),
    cache: ACCESS_JWK_CACHE,
    now: getNow(env),
  });
  const rows = await persistence.listActiveOperatorPolicies({
    issuer: verification.claims.iss,
    audience: config.text.ACCESS_AUDIENCE,
    now: now.toISOString(),
  });
  let matched = null;
  for (const row of rows) {
    try {
      const stableSubject = computeStableSubject({
        claims: verification.claims,
        principalType: row.principal_type,
        accessSubjectBinding: row.access_subject_binding,
      });
      if (stableSubject === row.access_subject_value) {
        matched = {
          principal_id: row.principal_id,
          principal_type: row.principal_type,
          allowed_scopes: row.allowed_scopes,
          target_scope_constraints: row.target_scope_constraints,
          require_reason: row.require_reason,
          require_ticket: row.require_ticket,
          auth_mechanism: 'cloudflare-access-jwt',
          stable_subject: stableSubject,
          jwt_claims: verification.claims,
        };
        break;
      }
    } catch {
      continue;
    }
  }
  if (matched == null) {
    throw Object.assign(new Error('No operator policy matched the authenticated principal'), { code: 'forbidden' });
  }
  return Object.freeze(authorizeOperatorRequest({
    operator: matched,
    requiredScope,
  }));
}

export async function authenticateOperator({
  request,
  env,
  config,
  requiredScope,
  targetScope,
}) {
  const operator = await authenticateOperatorIdentity({
    request,
    env,
    config,
    requiredScope,
  });
  return Object.freeze(authorizeOperatorRequest({
    operator,
    targetScope,
  }));
}

export async function appendAuditEvent({
  persistence,
  eventType,
  operator,
  scope,
  requestContext,
  idempotencyKey = null,
  requestFingerprint = null,
  jobId = null,
  resultCode,
  affectedObjects = [],
  details = null,
  eventId = makeId('audit'),
  occurredAt = new Date().toISOString(),
}) {
  await persistence.insertAuditEvent({
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    operator_principal_id: operator.principal_id,
    auth_mechanism: operator.auth_mechanism,
    scope,
    request_id: requestContext?.requestId ?? null,
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
    job_id: jobId,
    causation_id: requestContext?.causationId ?? jobId ?? null,
    result_code: normalizeString(resultCode, 'resultCode'),
    affected_objects: affectedObjects,
    details,
  });
}

export async function reserveIdempotentWrite({
  persistence,
  operator,
  scope,
  idempotencyKey,
  requestFingerprint,
  initialEnvelope,
  auditEventType,
  requestContext,
  jobRecord = null,
  dedupeKey = null,
  affectedObjects = null,
}) {
  const scopeToken = createDedupeScopeToken({ scope, dedupeKey });
  const normalizedAffectedObjects = affectedObjects ?? (jobRecord ? [{ kind: 'job', id: jobRecord.job_id }] : []);
  try {
    await persistence.transaction(async (tx) => {
      await appendAuditEvent({
        persistence: tx,
        eventType: auditEventType,
        operator,
        scope,
        requestContext,
        idempotencyKey,
        requestFingerprint,
        jobId: jobRecord?.job_id ?? null,
        resultCode: 'accepted',
        affectedObjects: normalizedAffectedObjects,
        details: {
          action: 'accepted',
        },
      });
      await tx.insertDedupeRecord({
        operator_principal_id: operator.principal_id,
        idempotency_key: idempotencyKey,
        scope_token: scopeToken,
        request_fingerprint: requestFingerprint,
        job_id: jobRecord?.job_id ?? null,
        result_code: 'accepted',
        response_payload: initialEnvelope,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (jobRecord) {
        await tx.createJob(jobRecord);
      }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await persistence.getDedupeRecord({
      operator_principal_id: operator.principal_id,
      idempotency_key: idempotencyKey,
      scope_token: scopeToken,
    });
    if (!existing) {
      throw error;
    }
    if (existing.request_fingerprint !== requestFingerprint) {
      return {
        outcome: 'conflict',
        envelope: serializeEnvelope('error', 409, buildOpsErrorJson({
          code: 'idempotency_conflict',
          message: 'Idempotency-Key already exists with a different request fingerprint',
          requestId: requestContext.requestId,
          retryable: false,
          details: {
            operator_principal_id: operator.principal_id,
            scope_token: scopeToken,
          },
        })),
      };
    }
    return {
      outcome: 'replay',
      envelope: existing.response_payload,
      job_id: existing.job_id,
    };
  }

  return {
    outcome: 'accepted',
    envelope: initialEnvelope,
    job_id: jobRecord?.job_id ?? null,
  };
}

export async function finalizeReservedWrite({
  persistence,
  operator,
  scope,
  idempotencyKey,
  envelope,
  resultCode,
  requestContext,
  requestFingerprint,
  jobId = null,
  eventType,
  details = null,
  dedupeKey = null,
  affectedObjects = null,
}) {
  const nowIso = new Date().toISOString();
  const scopeToken = createDedupeScopeToken({ scope, dedupeKey });
  await persistence.transaction(async (tx) => {
    await tx.updateDedupeRecord({
      operator_principal_id: operator.principal_id,
      idempotency_key: idempotencyKey,
      scope_token: scopeToken,
      result_code: resultCode,
      response_payload: envelope,
      updated_at: nowIso,
    });
    await appendAuditEvent({
      persistence: tx,
      eventType,
      operator,
      scope,
      requestContext,
      idempotencyKey,
      requestFingerprint,
      jobId,
      resultCode,
      affectedObjects: affectedObjects ?? (jobId ? [{ kind: 'job', id: jobId }] : []),
      details,
      occurredAt: nowIso,
    });
  });
}

export function createJobRecord({
  jobId,
  jobType,
  scope,
  operator,
  idempotencyKey,
  requestFingerprint,
  spec,
  acceptedAt,
  registrySnapshotId = null,
  exportEpoch = null,
  progressTotalUnits = 0,
}) {
  return {
    job_id: jobId,
    job_type: jobType,
    internal_state: 'pending',
    scope,
    operator_principal_id: operator.principal_id,
    auth_mechanism: operator.auth_mechanism,
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
    accepted_at: acceptedAt,
    created_at: acceptedAt,
    spec,
    checkpoint_state: null,
    progress_completed_units: 0,
    progress_total_units: progressTotalUnits,
    progress_unit_name: 'shard',
    last_error: null,
    registry_snapshot_id: registrySnapshotId,
    export_epoch: exportEpoch,
    result_summary: null,
  };
}

export function buildArchiveObjectKey({
  exportEpochOrImportBatch,
  artifactKind,
  scope,
  objectId,
}) {
  return buildExportBundleObjectKey({
    exportEpochOrImportBatch,
    artifactKind,
    scope,
    objectId,
  });
}

export function parseArchiveObjectKeyFromUri(uri) {
  const normalized = normalizeString(uri, 'source_bundle_uri');
  if (!normalized.startsWith('r2://')) {
    throw Object.assign(new Error('source_bundle_uri must use the r2:// scheme'), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  const withoutScheme = normalized.slice('r2://'.length);
  const firstSlashIndex = withoutScheme.indexOf('/');
  if (firstSlashIndex < 0 || firstSlashIndex === withoutScheme.length - 1) {
    throw Object.assign(new Error('source_bundle_uri must include a bucket segment and object key'), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  return withoutScheme.slice(firstSlashIndex + 1);
}

async function readArchiveObjectText(archiveBucket, objectKey) {
  if (!archiveBucket) {
    return null;
  }
  if (typeof archiveBucket.get === 'function') {
    const existing = await archiveBucket.get(objectKey);
    if (!existing) {
      return null;
    }
    if (typeof existing.text === 'function') {
      return existing.text();
    }
    if (typeof existing.body === 'string') {
      return existing.body;
    }
    if (existing.body instanceof Uint8Array || Buffer.isBuffer(existing.body)) {
      return Buffer.from(existing.body).toString('utf8');
    }
  }
  if (archiveBucket.objects instanceof Map) {
    const existing = archiveBucket.objects.get(objectKey);
    return existing?.body ?? null;
  }
  return null;
}

export async function readArchiveJsonObject(archiveBucket, objectKey) {
  const rawText = await readArchiveObjectText(archiveBucket, objectKey);
  if (rawText == null) {
    return null;
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw Object.assign(new Error(`Archive object ${objectKey} does not contain valid JSON: ${error.message}`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
}

export async function putArchiveJsonObject(archiveBucket, objectKey, value) {
  if (!archiveBucket || typeof archiveBucket.put !== 'function') {
    throw Object.assign(new Error('Missing MATRIX_ARCHIVE_BUCKET binding'), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  const serialized = canonicalizeJsonValue(value);
  const existing = await readArchiveObjectText(archiveBucket, objectKey);
  if (existing != null) {
    try {
      if (canonicalizeJsonText(existing) === serialized) {
        return;
      }
    } catch {
      // Non-JSON or invalid JSON stored under a manifest key is a hard integrity violation.
      // Fall through to conflict.
    }
    if (existing === serialized) {
      return;
    }
    throw new Error(`Archive object key conflict for ${objectKey}`);
  }
  await archiveBucket.put(objectKey, serialized, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
    },
  });
}

function jsonUtf8Size(value) {
  return Buffer.byteLength(canonicalizeJsonValue(value), 'utf8');
}

function buildJsonlGzipBytes(records) {
  const jsonl = records.map((record) => canonicalizeJsonValue(record)).join('\n');
  const payload = jsonl.length > 0 ? `${jsonl}\n` : '';
  return gzipSync(Buffer.from(payload, 'utf8'));
}

function computeRestorePhaseFromObjects(objects) {
  const usedPhases = new Set(
    (objects ?? [])
      .filter((entry) => entry?.required_for_restore)
      .map((entry) => entry.apply_phase),
  );
  for (const phase of RESTORE_PHASE_ORDER) {
    if (usedPhases.has(phase)) {
      return phase;
    }
  }
  return 'control-plane';
}

function scopeToShardIdentity(scope) {
  if (scope.scope_kind === 'room_id') {
    return { shard_type: 'RoomDO', shard_key: scope.scope_id };
  }
  if (scope.scope_kind === 'user_id') {
    return { shard_type: 'UserDO', shard_key: scope.scope_id };
  }
  if (scope.scope_kind === 'server_name') {
    return { shard_type: 'RemoteServerDO', shard_key: scope.scope_id };
  }
  if (scope.scope_kind === 'global') {
    return { shard_type: 'control-plane', shard_key: 'ops-core' };
  }
  throw Object.assign(new Error(`Unsupported restore scope_kind ${scope.scope_kind}`), {
    code: 'job_conflict',
    retryable: false,
  });
}

function assertValidSourceWatermark(sourceWatermark, shardType, checkpointId) {
  const labelPrefix = `Checkpoint ${checkpointId} source_watermark`;
  if (shardType === 'RoomDO') {
    if (!isRecord(sourceWatermark)) {
      throw Object.assign(new Error(`${labelPrefix} must be an object for RoomDO checkpoints`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    assertNonNegativeInteger(sourceWatermark.max_committed_room_pos, `${labelPrefix}.max_committed_room_pos`);
    normalizeString(sourceWatermark.current_snapshot_id, `${labelPrefix}.current_snapshot_id`);
    normalizeString(sourceWatermark.forward_extremities_hash, `${labelPrefix}.forward_extremities_hash`);
    return;
  }
  if (shardType === 'UserDO') {
    if (!isRecord(sourceWatermark)) {
      throw Object.assign(new Error(`${labelPrefix} must be an object for UserDO checkpoints`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    assertNonNegativeInteger(sourceWatermark.max_user_stream_pos, `${labelPrefix}.max_user_stream_pos`);
    assertNonNegativeInteger(sourceWatermark.device_state_version, `${labelPrefix}.device_state_version`);
    assertNonNegativeInteger(sourceWatermark.to_device_queue_highwater, `${labelPrefix}.to_device_queue_highwater`);
    return;
  }
  if (shardType === 'RemoteServerDO') {
    if (!isRecord(sourceWatermark)) {
      throw Object.assign(new Error(`${labelPrefix} must be an object for RemoteServerDO checkpoints`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    assertNonNegativeInteger(sourceWatermark.max_outbound_txn_seq, `${labelPrefix}.max_outbound_txn_seq`);
    assertNonNegativeInteger(sourceWatermark.retry_schedule_version, `${labelPrefix}.retry_schedule_version`);
    assertNonNegativeInteger(sourceWatermark.inbound_txn_cache_version, `${labelPrefix}.inbound_txn_cache_version`);
    return;
  }
  if (shardType === 'control-plane') {
    if (Number.isInteger(sourceWatermark) && sourceWatermark >= 0) {
      return;
    }
    if (!isRecord(sourceWatermark)) {
      throw Object.assign(new Error(`${labelPrefix} must be a non-negative integer or object for control-plane checkpoints`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (sourceWatermark.max_audit_event_seq != null) {
      assertNonNegativeInteger(sourceWatermark.max_audit_event_seq, `${labelPrefix}.max_audit_event_seq`);
      return;
    }
    if (sourceWatermark.audit_event_rowid != null) {
      assertNonNegativeInteger(sourceWatermark.audit_event_rowid, `${labelPrefix}.audit_event_rowid`);
      return;
    }
    throw Object.assign(new Error(`${labelPrefix} must carry max_audit_event_seq or audit_event_rowid for control-plane checkpoints`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  throw Object.assign(new Error(`Unsupported checkpoint shard_type ${shardType}`), {
    code: 'job_conflict',
    retryable: false,
  });
}

function assertAllowedKeyVersion(allowedVersions, actualVersion, label) {
  if (!Array.isArray(allowedVersions) || allowedVersions.length === 0) {
    return;
  }
  if (!allowedVersions.includes(actualVersion)) {
    throw Object.assign(new Error(`${label} ${actualVersion} is not in the allowed key version set`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
}

function buildRestorePreflightConflict(message, error = null) {
  return Object.assign(
    new Error(error ? `${message}: ${error.message}` : message),
    {
      code: 'job_conflict',
      retryable: false,
    },
  );
}

function assertRestoreObjectMetadata(objectEntry, checkpointManifest) {
  if (objectEntry.shard_type !== checkpointManifest.shard_type || objectEntry.shard_key !== checkpointManifest.shard_key) {
    throw buildRestorePreflightConflict(
      `Checkpoint object ${objectEntry.object_id} resolved to unexpected shard identity ${objectEntry.shard_type}/${objectEntry.shard_key}`,
    );
  }
  if (!RESTORE_PHASE_ORDER.includes(objectEntry.apply_phase)) {
    throw buildRestorePreflightConflict(
      `Checkpoint object ${objectEntry.object_id} apply_phase ${objectEntry.apply_phase ?? 'missing'} is not supported`,
    );
  }
  if (objectEntry.codec !== 'jcs-json' && objectEntry.codec !== 'jsonl-gzip') {
    throw buildRestorePreflightConflict(
      `Checkpoint object ${objectEntry.object_id} codec ${objectEntry.codec ?? 'missing'} is not supported`,
    );
  }
  if (objectEntry.codec === 'jcs-json' && objectEntry.record_count !== 1) {
    throw buildRestorePreflightConflict(
      `Checkpoint object ${objectEntry.object_id} record_count must be 1 for codec jcs-json`,
    );
  }
  if (
    objectEntry.codec === 'jsonl-gzip'
    && (!Number.isInteger(objectEntry.record_count) || objectEntry.record_count <= 0)
  ) {
    throw buildRestorePreflightConflict(
      `Checkpoint object ${objectEntry.object_id} record_count must be a positive integer for codec jsonl-gzip`,
    );
  }
}

function assertSignedManifestIntegrity(manifest, keyRing, label) {
  if (manifest?.signature_algorithm !== 'Ed25519') {
    throw Object.assign(new Error(`${label} must use Ed25519 signatures`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  if (!verifySignedManifestWithKeyRing(manifest, keyRing)) {
    throw Object.assign(new Error(`${label} signature verification failed`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
}

export async function ensureControlPlaneShardRegistered({ persistence, now = new Date().toISOString() }) {
  await persistence.upsertShardRegistry({
    shard_type: 'control-plane',
    shard_key: 'ops-core',
    created_at: now,
    last_seen_at: now,
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    disabled_at: null,
  });
}

export async function freezeShardRegistrySnapshot({
  persistence,
  archiveBucket,
  exportEpoch,
  scope,
  keyRing,
  now,
}) {
  const createdAt = now.toISOString();
  const registrySnapshotId = makeId('registry_snapshot');
  const rows = await persistence.listShardRegistry({ scope });
  const unsignedSnapshot = {
    manifest_version: CONTROL_PLANE_SCHEMA_VERSION,
    registry_snapshot_id: registrySnapshotId,
    export_epoch: exportEpoch,
    scope,
    created_at: createdAt,
    row_count: rows.length,
    hash_algorithm: 'sha256',
    signature_algorithm: 'Ed25519',
    encryption_algorithm: 'AES-256-GCM',
    signing_key_version: keyRing.signing.active,
    encryption_key_version: keyRing.encryption.active,
    completeness_state: 'complete',
    rows,
  };
  const signedSnapshot = createSignedManifest({
    unsignedManifest: unsignedSnapshot,
    keyRing,
  });
  const objectKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: exportEpoch,
    artifactKind: 'registry-snapshot',
    scope,
    objectId: registrySnapshotId,
  });
  await putArchiveJsonObject(archiveBucket, objectKey, signedSnapshot);
  await persistence.insertRegistrySnapshot({
    registry_snapshot_id: registrySnapshotId,
    export_epoch: exportEpoch,
    scope,
    created_at: createdAt,
    row_count: rows.length,
    snapshot: signedSnapshot,
    snapshot_hash: signedSnapshot.manifest_hash,
    signature: signedSnapshot.signature,
    signing_key_version: signedSnapshot.signing_key_version,
    r2_object_key: objectKey,
  });
  return {
    registry_snapshot_id: registrySnapshotId,
    snapshot: signedSnapshot,
    rows,
    r2_object_key: objectKey,
  };
}

function flattenControlPlaneSnapshotRecords(snapshot) {
  const orderedTables = [
    'operator_authz_policies',
    'audit_events',
    'request_dedupe_projection',
    'jobs',
    'job_checkpoints',
    'replay_manifests',
    'repair_decisions',
    'shard_registry',
    'registry_snapshots',
    'appservice_configs',
  ];
  const records = [];
  for (const table of orderedTables) {
    const rows = snapshot.tables?.[table] ?? [];
    for (const row of rows) {
      records.push({
        table,
        row,
      });
    }
  }
  return records;
}

export async function buildControlPlaneCheckpointArtifact({
  persistence,
  archiveBucket,
  keyRing,
  job,
  checkpointId,
  now,
}) {
  if (!archiveBucket) {
    throw Object.assign(new Error('Missing MATRIX_ARCHIVE_BUCKET binding'), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  const registrySnapshot = job.registry_snapshot_id == null
    ? null
    : await persistence.getRegistrySnapshot(job.registry_snapshot_id);
  const snapshot = await persistence.exportControlPlaneSnapshot();
  const records = flattenControlPlaneSnapshotRecords(snapshot);
  const compressedBytes = buildJsonlGzipBytes(records);
  const objectId = `${normalizeString(checkpointId, 'checkpointId')}--ops-core-segment`;
  const encryptedEnvelope = Object.freeze({
    envelope_version: 1,
    checkpoint_id: checkpointId,
    object_id: objectId,
    shard_type: 'control-plane',
    shard_key: 'ops-core',
    codec: 'jsonl-gzip',
    ...encryptBytes(compressedBytes, keyRing, {
      aad: `${checkpointId}:${objectId}`,
    }),
  });
  const checkpointObjectKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: job.export_epoch ?? checkpointId,
    artifactKind: 'checkpoint-object',
    scope: job.scope,
    objectId,
  });
  await putArchiveJsonObject(archiveBucket, checkpointObjectKey, encryptedEnvelope);

  const objectEntry = Object.freeze({
    object_id: objectId,
    object_kind: 'ops-core-segment',
    shard_type: 'control-plane',
    shard_key: 'ops-core',
    data_ids: [...CONTROL_PLANE_CHECKPOINT_DATA_IDS],
    required_for_restore: true,
    apply_phase: 'control-plane',
    range_start: snapshot.range_start,
    range_end: snapshot.range_end,
    content_hash: canonicalHash(encryptedEnvelope),
    codec: 'jsonl-gzip',
    encryption_key_version: keyRing.encryption.active,
    byte_size: jsonUtf8Size(encryptedEnvelope),
    record_count: records.length,
    r2_object_key: checkpointObjectKey,
  });

  const unsignedManifest = {
    manifest_version: CONTROL_PLANE_SCHEMA_VERSION,
    checkpoint_id: checkpointId,
    job_id: job.job_id,
    export_epoch: job.export_epoch ?? null,
    registry_snapshot_id: job.registry_snapshot_id ?? null,
    registry_snapshot_hash: registrySnapshot?.snapshot_hash ?? null,
    scope: job.scope,
    shard_type: 'control-plane',
    shard_key: 'ops-core',
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    source_watermark: snapshot.watermark,
    hash_algorithm: 'sha256',
    signature_algorithm: 'Ed25519',
    encryption_algorithm: 'AES-256-GCM',
    signing_key_version: keyRing.signing.active,
    encryption_key_version: keyRing.encryption.active,
    objects: [objectEntry],
    completeness_state: 'complete',
  };
  const signedManifest = createSignedManifest({
    unsignedManifest,
    keyRing,
  });
  const checkpointManifestKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: job.export_epoch ?? checkpointId,
    artifactKind: 'checkpoint-manifest',
    scope: job.scope,
    objectId: checkpointId,
  });
  await putArchiveJsonObject(archiveBucket, checkpointManifestKey, signedManifest);

  return Object.freeze({
    checkpoint_id: checkpointId,
    shard_type: 'control-plane',
    shard_key: 'ops-core',
    manifest: signedManifest,
    manifest_hash: signedManifest.manifest_hash,
    manifest_r2_object_key: checkpointManifestKey,
    object_entries: [objectEntry],
    source_watermark: snapshot.watermark,
  });
}

function deriveBundleCompleteness({
  registryRows,
  completedCheckpoints,
}) {
  if (registryRows.length === 0) {
    return 'incomplete';
  }
  let matched = 0;
  for (const row of registryRows) {
    const key = `${row.shard_type}:${row.shard_key}`;
    const checkpoint = completedCheckpoints.get(key) ?? null;
    if (!checkpoint) {
      continue;
    }
    if (checkpoint.manifest_completeness_state !== 'complete') {
      return matched > 0 ? 'partial' : 'incomplete';
    }
    matched += 1;
  }
  if (matched === registryRows.length) {
    return 'complete';
  }
  return matched > 0 ? 'partial' : 'incomplete';
}

export async function finalizeExportBundleManifest({
  persistence,
  archiveBucket,
  keyRing,
  job,
  now,
}) {
  if (!archiveBucket) {
    throw Object.assign(new Error('Missing MATRIX_ARCHIVE_BUCKET binding'), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  const registrySnapshot = await persistence.getRegistrySnapshot(job.registry_snapshot_id);
  if (!registrySnapshot) {
    throw Object.assign(new Error(`Registry snapshot ${job.registry_snapshot_id} is required before bundle finalization`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  const registryRows = registrySnapshot.snapshot?.rows ?? [];
  const checkpoints = await persistence.listJobCheckpoints(job.job_id);
  const completedCheckpoints = new Map(
    checkpoints
      .filter((entry) => entry.checkpoint?.status === 'complete')
      .map((entry) => [`${entry.shard_type}:${entry.shard_key}`, entry.checkpoint]),
  );
  const registrySnapshotObject = {
    object_id: registrySnapshot.registry_snapshot_id,
    object_kind: 'registry-snapshot',
    shard_type: 'control-plane',
    shard_key: 'ops-core',
    data_ids: ['DATA-OPS-011'],
    required_for_restore: true,
    apply_phase: 'control-plane',
    range_start: registrySnapshot.created_at,
    range_end: registrySnapshot.created_at,
    content_hash: canonicalHash(registrySnapshot.snapshot),
    codec: 'jcs-json',
    encryption_key_version: keyRing.encryption.active,
    byte_size: jsonUtf8Size(registrySnapshot.snapshot),
    record_count: 1,
    r2_object_key: registrySnapshot.r2_object_key,
    completeness_state: registrySnapshot.snapshot?.completeness_state ?? 'complete',
  };
  const checkpointRefs = [...completedCheckpoints.values()]
    .map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      shard_type: checkpoint.shard_type,
      shard_key: checkpoint.shard_key,
      manifest_hash: checkpoint.manifest_hash,
      manifest_r2_object_key: checkpoint.manifest_r2_object_key,
      source_watermark: checkpoint.source_watermark,
      completeness_state: checkpoint.manifest_completeness_state,
      apply_phase: checkpoint.apply_phase ?? 'control-plane',
      object_count: checkpoint.object_entries?.length ?? 0,
    }))
    .sort((left, right) => `${left.shard_type}:${left.shard_key}`.localeCompare(`${right.shard_type}:${right.shard_key}`));
  const completenessState = deriveBundleCompleteness({
    registryRows,
    completedCheckpoints,
  });
  const checkpointManifestObjects = [];
  for (const ref of checkpointRefs) {
    const checkpointManifest = await readArchiveJsonObject(archiveBucket, ref.manifest_r2_object_key);
    if (!checkpointManifest) {
      throw Object.assign(new Error(`Checkpoint manifest ${ref.manifest_r2_object_key} is required before bundle finalization`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (checkpointManifest.manifest_hash !== ref.manifest_hash) {
      throw Object.assign(new Error(`Checkpoint manifest hash mismatch for ${ref.checkpoint_id} during bundle finalization`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    checkpointManifestObjects.push({
      object_id: ref.checkpoint_id,
      object_kind: 'checkpoint-manifest',
      shard_type: ref.shard_type,
      shard_key: ref.shard_key,
      data_ids: ['DATA-R2-005'],
      required_for_restore: true,
      apply_phase: ref.apply_phase,
      range_start: ref.source_watermark,
      range_end: ref.source_watermark,
      content_hash: canonicalHash(checkpointManifest),
      codec: 'jcs-json',
      encryption_key_version: keyRing.encryption.active,
      byte_size: jsonUtf8Size(checkpointManifest),
      record_count: 1,
      r2_object_key: ref.manifest_r2_object_key,
      completeness_state: checkpointManifest.completeness_state,
    });
  }
  const manifestObjects = [
    registrySnapshotObject,
    ...checkpointManifestObjects,
  ];
  const unsignedManifest = {
    manifest_version: CONTROL_PLANE_SCHEMA_VERSION,
    job_id: job.job_id,
    job_type: job.job_type,
    bundle_id: job.job_id,
    scope: job.scope,
    created_at: now.toISOString(),
    export_epoch: job.export_epoch ?? null,
    registry_snapshot_id: registrySnapshot.registry_snapshot_id,
    registry_snapshot_hash: registrySnapshot.snapshot_hash,
    registry_snapshot_r2_object_key: registrySnapshot.r2_object_key,
    spec: job.spec,
    hash_algorithm: 'sha256',
    signature_algorithm: 'Ed25519',
    encryption_algorithm: 'AES-256-GCM',
    signing_key_version: keyRing.signing.active,
    encryption_key_version: keyRing.encryption.active,
    objects: manifestObjects,
    checkpoint_refs: checkpointRefs,
    completeness_state: completenessState,
  };
  const bundleManifest = createSignedManifest({
    unsignedManifest,
    keyRing,
  });
  const objectKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: job.export_epoch ?? job.job_id,
    artifactKind: 'bundle-manifest',
    scope: job.scope,
    objectId: job.job_id,
  });
  await putArchiveJsonObject(archiveBucket, objectKey, bundleManifest);
  await persistence.upsertReplayManifest({
    job_id: job.job_id,
    manifest_kind: 'bundle-manifest',
    manifest: bundleManifest,
    manifest_hash: bundleManifest.manifest_hash,
    created_at: now.toISOString(),
    export_epoch: job.export_epoch ?? null,
    registry_snapshot_id: job.registry_snapshot_id ?? null,
    r2_object_key: objectKey,
  });
  return Object.freeze({
    manifest: bundleManifest,
    object_key: objectKey,
  });
}

function findBundleRegistrySnapshotObject(bundleManifest) {
  const objects = Array.isArray(bundleManifest.objects) ? bundleManifest.objects : [];
  return objects.find((entry) => entry?.object_kind === 'registry-snapshot') ?? null;
}

async function resolveBundleRegistrySnapshot({
  persistence,
  archiveBucket,
  keyRing,
  requestBody,
  bundleManifest,
}) {
  if (bundleManifest.registry_snapshot_id == null || bundleManifest.registry_snapshot_hash == null) {
    throw Object.assign(new Error('Bundle manifest must include registry snapshot id and hash for restore preflight'), {
      code: 'job_conflict',
      retryable: false,
    });
  }

  const registrySnapshotObject = findBundleRegistrySnapshotObject(bundleManifest);
  const snapshotObjectKey = bundleManifest.registry_snapshot_r2_object_key
    ?? registrySnapshotObject?.r2_object_key
    ?? null;
  if (snapshotObjectKey) {
    const registrySnapshot = await readArchiveJsonObject(archiveBucket, snapshotObjectKey);
    if (!registrySnapshot) {
      throw Object.assign(new Error(`Registry snapshot ${snapshotObjectKey} referenced by bundle manifest was not found`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (registrySnapshot.registry_snapshot_id !== bundleManifest.registry_snapshot_id) {
      throw Object.assign(new Error(`Registry snapshot ${snapshotObjectKey} resolved to unexpected registry_snapshot_id ${registrySnapshot.registry_snapshot_id}`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (registrySnapshot.manifest_hash !== bundleManifest.registry_snapshot_hash) {
      throw Object.assign(new Error(`Registry snapshot hash mismatch for ${bundleManifest.registry_snapshot_id}`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (registrySnapshotObject && registrySnapshotObject.content_hash !== canonicalHash(registrySnapshot)) {
      throw Object.assign(new Error(`Bundle manifest registry snapshot object hash mismatch for ${bundleManifest.registry_snapshot_id}`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    assertAllowedKeyVersion(
      requestBody.allowed_signing_key_versions,
      registrySnapshot.signing_key_version,
      'registry snapshot signing_key_version',
    );
    assertAllowedKeyVersion(
      requestBody.allowed_encryption_key_versions,
      registrySnapshot.encryption_key_version,
      'registry snapshot encryption_key_version',
    );
    assertSignedManifestIntegrity(registrySnapshot, keyRing, `Registry snapshot ${bundleManifest.registry_snapshot_id}`);
    if (registrySnapshot.completeness_state !== 'complete') {
      throw Object.assign(new Error(`Registry snapshot ${bundleManifest.registry_snapshot_id} is ${registrySnapshot.completeness_state} and cannot be used for restore`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    return Object.freeze({
      registry_snapshot_id: registrySnapshot.registry_snapshot_id,
      rows: Array.isArray(registrySnapshot.rows) ? registrySnapshot.rows : [],
    });
  }

  const registrySnapshot = await persistence.getRegistrySnapshot(bundleManifest.registry_snapshot_id);
  if (!registrySnapshot) {
    throw Object.assign(new Error(`Registry snapshot ${bundleManifest.registry_snapshot_id} referenced by bundle manifest was not found`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  if (registrySnapshot.snapshot_hash !== bundleManifest.registry_snapshot_hash) {
    throw Object.assign(new Error(`Registry snapshot hash mismatch for ${bundleManifest.registry_snapshot_id}`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  assertAllowedKeyVersion(
    requestBody.allowed_signing_key_versions,
    registrySnapshot.snapshot?.signing_key_version,
    'registry snapshot signing_key_version',
  );
  assertAllowedKeyVersion(
    requestBody.allowed_encryption_key_versions,
    registrySnapshot.snapshot?.encryption_key_version,
    'registry snapshot encryption_key_version',
  );
  assertSignedManifestIntegrity(registrySnapshot.snapshot, keyRing, `Registry snapshot ${bundleManifest.registry_snapshot_id}`);
  if (registrySnapshot.snapshot?.completeness_state !== 'complete') {
    throw Object.assign(new Error(`Registry snapshot ${bundleManifest.registry_snapshot_id} is ${registrySnapshot.snapshot?.completeness_state} and cannot be used for restore`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  return Object.freeze({
    registry_snapshot_id: registrySnapshot.registry_snapshot_id,
    rows: registrySnapshot.snapshot?.rows ?? [],
  });
}

function selectRestoreCheckpointRefs({
  bundleManifest,
  registryRows,
  requestBody,
}) {
  const checkpointRefs = Array.isArray(bundleManifest.checkpoint_refs)
    ? bundleManifest.checkpoint_refs
    : [];
  if (requestBody.restore_mode === 'full_namespace') {
    if (registryRows.length === 0) {
      throw Object.assign(new Error('Full namespace restore requires a non-empty frozen registry snapshot'), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    return registryRows.map((row) => {
      const matches = checkpointRefs.filter((entry) => (
        entry.shard_type === row.shard_type
        && entry.shard_key === row.shard_key
      ));
      if (matches.length !== 1) {
        throw Object.assign(new Error(`Bundle manifest must contain exactly one checkpoint for ${row.shard_type}/${row.shard_key}`), {
          code: 'job_conflict',
          retryable: false,
        });
      }
      return matches[0];
    });
  }

  const targetShard = scopeToShardIdentity(requestBody.scope);
  const scopedMatches = checkpointRefs.filter((entry) => (
    entry.shard_type === targetShard.shard_type
    && entry.shard_key === targetShard.shard_key
  ));
  if (scopedMatches.length !== 1) {
    throw Object.assign(new Error(`Bundle manifest must contain exactly one checkpoint for ${targetShard.shard_type}/${targetShard.shard_key}`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  return scopedMatches;
}

async function validateRestoreCheckpointRef({
  archiveBucket,
  keyRing,
  requestBody,
  checkpointRef,
}) {
  const checkpointManifest = await readArchiveJsonObject(archiveBucket, checkpointRef.manifest_r2_object_key);
  if (!checkpointManifest) {
    throw Object.assign(new Error(`Checkpoint manifest ${checkpointRef.manifest_r2_object_key} was not found`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  if (checkpointManifest.manifest_hash !== checkpointRef.manifest_hash) {
    throw Object.assign(new Error(`Checkpoint manifest hash mismatch for ${checkpointRef.checkpoint_id}`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  if (checkpointManifest.checkpoint_id !== checkpointRef.checkpoint_id) {
    throw Object.assign(new Error(`Checkpoint manifest ${checkpointRef.manifest_r2_object_key} resolved to unexpected checkpoint_id ${checkpointManifest.checkpoint_id}`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  if (checkpointManifest.shard_type !== checkpointRef.shard_type || checkpointManifest.shard_key !== checkpointRef.shard_key) {
    throw Object.assign(new Error(`Checkpoint manifest ${checkpointRef.manifest_r2_object_key} resolved to unexpected shard identity ${checkpointManifest.shard_type}/${checkpointManifest.shard_key}`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  assertAllowedKeyVersion(
    requestBody.allowed_signing_key_versions,
    checkpointManifest.signing_key_version,
    'checkpoint manifest signing_key_version',
  );
  assertAllowedKeyVersion(
    requestBody.allowed_encryption_key_versions,
    checkpointManifest.encryption_key_version,
    'checkpoint manifest encryption_key_version',
  );
  assertSignedManifestIntegrity(checkpointManifest, keyRing, `Checkpoint manifest ${checkpointRef.checkpoint_id}`);
  if (!requestBody.allow_incomplete && checkpointManifest.completeness_state !== 'complete') {
    throw Object.assign(new Error(`Checkpoint ${checkpointRef.checkpoint_id} is ${checkpointManifest.completeness_state} and cannot be used for restore`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  assertValidSourceWatermark(
    checkpointManifest.source_watermark,
    checkpointManifest.shard_type,
    checkpointManifest.checkpoint_id,
  );

  const requiredKinds = REQUIRED_RESTORE_OBJECT_KINDS[checkpointRef.shard_type] ?? [];
  const objects = Array.isArray(checkpointManifest.objects) ? checkpointManifest.objects : [];
  for (const objectKind of requiredKinds) {
    if (!objects.some((entry) => entry.object_kind === objectKind && entry.required_for_restore)) {
      throw Object.assign(new Error(`Checkpoint ${checkpointRef.checkpoint_id} is missing required object_kind ${objectKind}`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
  }

  for (const objectEntry of objects) {
    assertRestoreObjectMetadata(objectEntry, checkpointManifest);
    const objectEnvelope = await readArchiveJsonObject(archiveBucket, objectEntry.r2_object_key);
    if (!objectEnvelope) {
      throw Object.assign(new Error(`Checkpoint object ${objectEntry.r2_object_key} was not found`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (canonicalHash(objectEnvelope) !== objectEntry.content_hash) {
      throw Object.assign(new Error(`Checkpoint object hash mismatch for ${objectEntry.object_id}`), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    assertAllowedKeyVersion(
      requestBody.allowed_encryption_key_versions,
      objectEntry.encryption_key_version,
      `checkpoint object ${objectEntry.object_id} encryption_key_version`,
    );
    let plaintext;
    try {
      plaintext = decryptBytes(objectEnvelope, keyRing, {
        aad: `${checkpointManifest.checkpoint_id}:${objectEntry.object_id}`,
      });
    } catch (error) {
      throw buildRestorePreflightConflict(`Checkpoint object ${objectEntry.object_id} failed decryptability validation`, error);
    }
    if (objectEntry.codec === 'jcs-json') {
      try {
        JSON.parse(plaintext.toString('utf8'));
      } catch (error) {
        throw buildRestorePreflightConflict(`Checkpoint object ${objectEntry.object_id} does not contain valid jcs-json`, error);
      }
      continue;
    }
    if (objectEntry.codec === 'jsonl-gzip') {
      let decompressed;
      try {
        decompressed = gunzipSync(plaintext).toString('utf8');
      } catch (error) {
        throw buildRestorePreflightConflict(`Checkpoint object ${objectEntry.object_id} is not valid jsonl-gzip`, error);
      }
      const trimmed = decompressed.trimEnd();
      const lines = trimmed.length === 0 ? [] : trimmed.split('\n');
      if (lines.length !== objectEntry.record_count) {
        throw Object.assign(new Error(`Checkpoint object ${objectEntry.object_id} record_count mismatch`), {
          code: 'job_conflict',
          retryable: false,
        });
      }
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch (error) {
          throw buildRestorePreflightConflict(`Checkpoint object ${objectEntry.object_id} contains invalid jsonl-gzip records`, error);
        }
      }
    }
  }

  return Object.freeze({
    checkpoint_id: checkpointManifest.checkpoint_id,
    shard_type: checkpointManifest.shard_type,
    shard_key: checkpointManifest.shard_key,
    apply_phase: computeRestorePhaseFromObjects(objects),
    manifest_hash: checkpointManifest.manifest_hash,
    manifest_r2_object_key: checkpointRef.manifest_r2_object_key,
    checkpoint_manifest: checkpointManifest,
  });
}

export async function resolveRestoreCheckpointRefs({
  persistence,
  archiveBucket,
  keyRing,
  requestBody,
}) {
  const bundleObjectKey = parseArchiveObjectKeyFromUri(requestBody.source_bundle_uri);
  const bundleManifest = await readArchiveJsonObject(archiveBucket, bundleObjectKey);
  if (!bundleManifest) {
    throw Object.assign(new Error(`Bundle manifest ${bundleObjectKey} was not found`), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  if (bundleManifest.manifest_hash !== requestBody.source_bundle_hash) {
    throw Object.assign(new Error('source_bundle_hash does not match the referenced bundle manifest'), {
      code: 'job_conflict',
      retryable: false,
    });
  }
  assertAllowedKeyVersion(
    requestBody.allowed_signing_key_versions,
    bundleManifest.signing_key_version,
    'bundle manifest signing_key_version',
  );
  assertAllowedKeyVersion(
    requestBody.allowed_encryption_key_versions,
    bundleManifest.encryption_key_version,
    'bundle manifest encryption_key_version',
  );
  assertSignedManifestIntegrity(bundleManifest, keyRing, `Bundle manifest ${bundleObjectKey}`);

  if (requestBody.restore_mode === 'full_namespace' && bundleManifest.completeness_state !== 'complete') {
    throw Object.assign(new Error(`Bundle manifest completeness_state must be complete for full_namespace restore (got ${bundleManifest.completeness_state})`), {
      code: 'job_conflict',
      retryable: false,
    });
  }

  const resolvedRegistrySnapshot = await resolveBundleRegistrySnapshot({
    persistence,
    archiveBucket,
    keyRing,
    requestBody,
    bundleManifest,
  });
  const registryRows = resolvedRegistrySnapshot.rows;
  const selectedRefs = selectRestoreCheckpointRefs({
    bundleManifest,
    registryRows,
    requestBody,
  });
  const resolved = [];
  for (const checkpointRef of selectedRefs) {
    resolved.push(await validateRestoreCheckpointRef({
      archiveBucket,
      keyRing,
      requestBody,
      checkpointRef,
    }));
  }
  return Object.freeze(resolved);
}

export async function createReplayManifest({
  persistence,
  archiveBucket,
  keyRing,
  jobRecord,
  manifestKind,
  scope,
  now,
}) {
  const scopeToken = scopeToToken(scope);
  const registrySnapshot = jobRecord.registry_snapshot_id == null
    ? null
    : await persistence.getRegistrySnapshot(jobRecord.registry_snapshot_id);
  if (jobRecord.registry_snapshot_id != null && !registrySnapshot) {
    throw new Error(`Registry snapshot ${jobRecord.registry_snapshot_id} is required before manifest creation`);
  }
  const unsignedManifest = {
    manifest_version: CONTROL_PLANE_SCHEMA_VERSION,
    job_id: jobRecord.job_id,
    job_type: jobRecord.job_type,
    ...(manifestKind === 'bundle-manifest'
      ? { bundle_id: jobRecord.job_id }
      : { shard_id: scopeToken }),
    scope,
    created_at: now.toISOString(),
    export_epoch: jobRecord.export_epoch ?? null,
    registry_snapshot_id: jobRecord.registry_snapshot_id ?? null,
    registry_snapshot_hash: registrySnapshot?.snapshot_hash ?? null,
    spec: jobRecord.spec,
    hash_algorithm: 'sha256',
    signature_algorithm: keyRing ? 'Ed25519' : 'none',
    encryption_algorithm: keyRing ? 'AES-256-GCM' : 'none',
    signing_key_version: keyRing ? keyRing.signing.active : null,
    encryption_key_version: keyRing ? keyRing.encryption.active : null,
    objects: [],
    completeness_state: 'pending',
  };
  const manifest = keyRing
    ? createSignedManifest({
      unsignedManifest,
      keyRing,
    })
    : {
      ...unsignedManifest,
      manifest_hash: canonicalHash(unsignedManifest),
      signature_algorithm: 'none',
      signing_key_version: null,
      encryption_key_version: null,
      signature: null,
    };
  const objectKey = buildArchiveObjectKey({
    exportEpochOrImportBatch: jobRecord.export_epoch ?? jobRecord.job_id,
    artifactKind: manifestKind,
    scope,
    objectId: jobRecord.job_id,
  });
  await putArchiveJsonObject(archiveBucket, objectKey, manifest);
  await persistence.upsertReplayManifest({
    job_id: jobRecord.job_id,
    manifest_kind: manifestKind,
    manifest,
    manifest_hash: manifest.manifest_hash,
    created_at: now.toISOString(),
    export_epoch: jobRecord.export_epoch ?? null,
    registry_snapshot_id: jobRecord.registry_snapshot_id ?? null,
    r2_object_key: objectKey,
  });
  return {
    manifest,
    object_key: objectKey,
  };
}

export function parseExportKeyRingFromEnv(config, env) {
  const secretValue = config.secrets.get('export_bundle_key_ring');
  if (secretValue == null) {
    throw new Error('Missing export bundle key ring secret');
  }
  return parseExportKeyRing(secretValue);
}

export async function sendQueueMessage(binding, payload) {
  if (!binding) {
    throw new Error('Missing queue binding');
  }
  if (typeof binding.send === 'function') {
    await binding.send(payload);
    return;
  }
  if (typeof binding.sendBatch === 'function') {
    await binding.sendBatch([payload]);
    return;
  }
  throw new TypeError('queue binding must expose send() or sendBatch()');
}

export async function dispatchJobStart({
  env,
  routeTemplate,
  spec,
}) {
  const jobsBinding = env?.JOBS_WORKER;
  if (!jobsBinding || typeof jobsBinding.fetch !== 'function') {
    throw new Error('Missing JOBS_WORKER service binding');
  }
  const response = await jobsBinding.fetch(new Request(`https://jobs.internal${routeTemplate}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-job-id': spec.job_id,
    },
    body: JSON.stringify(spec),
  }));
  const responseBody = await response.json();
  if (!response.ok) {
    try {
      const internalError = parseInternalErrorEnvelope(responseBody);
      throw Object.assign(new Error(internalError.message), {
        code: internalError.code,
        retryable: internalError.retryable,
        details: internalError.details,
        status: response.status,
      });
    } catch (parseError) {
      if (parseError?.message === responseBody?.message && parseError?.code === responseBody?.code) {
        throw parseError;
      }
      throw Object.assign(new Error(`jobs-worker start failed with ${response.status}: ${JSON.stringify(responseBody)}`), {
        retryable: response.status >= 500,
        status: response.status,
      });
    }
  }
  return responseBody;
}

export function makeOpsContext(workerName, request, env, { routeFamily }) {
  const config = loadWorkerRuntimeConfig(workerName, env);
  const requestContext = createRequestContext({
    workerName,
    workerVersion: config.text.WORKER_VERSION_ID,
    request,
    routeFamily,
  });
  return {
    config,
    requestContext,
    persistence: getControlPlanePersistence(env),
    now: getNow(env),
  };
}

export function parseJobsQueryFromUrl(url) {
  const searchParams = url.searchParams;
  const scopeKind = searchParams.get('scope_kind');
  const scopeId = searchParams.get('scope_id');
  return normalizeJobStatusQuery({
    job_id: null,
    job_type: searchParams.get('type'),
    state: searchParams.get('state'),
    scope: scopeKind
      ? {
        scope_kind: scopeKind,
        scope_id: scopeKind === 'global' ? null : scopeId,
      }
      : null,
    limit: searchParams.get('limit') == null ? null : Number.parseInt(searchParams.get('limit'), 10),
    cursor: searchParams.get('cursor'),
  });
}

function mapPublicStateFilterToInternalStates(publicState) {
  if (publicState == null) {
    return null;
  }
  const mapping = {
    accepted: ['pending'],
    queued: ['checkpointed'],
    running: ['scanning', 'applying', 'materializing', 'uploading', 'validating', 'importing', 'cutover-ready', 'cutover', 'verifying'],
    succeeded: ['completed', 'finalized'],
    failed: ['failed'],
    cancel_requested: ['cancel_requested'],
    canceled: ['canceled'],
  };
  return mapping[publicState] ?? null;
}

export async function queryJobs({
  persistence,
  query,
}) {
  if (query.job_id) {
    const job = await persistence.getJob(query.job_id);
    return buildJobStatusResponseFromRecords({ job });
  }
  const decodedCursor = decodeCursor(query.cursor);
  const jobs = await persistence.listJobs({
    job_type: query.job_type,
    internal_states: mapPublicStateFilterToInternalStates(query.state),
    scope: query.scope,
    limit: query.limit,
    cursor: decodedCursor,
  });
  const nextCursor = jobs.length === query.limit
    ? encodeCursor({
      created_at: jobs.at(-1).created_at,
      job_id: jobs.at(-1).job_id,
    })
    : null;
  return buildJobStatusResponseFromRecords({
    jobs,
    nextCursor,
  });
}

export async function createAppserviceMutation({
  request,
  routeTemplate,
  operator,
  requestContext,
  persistence,
  scope,
  body,
  mutate,
}) {
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'validation_failed',
      message: 'Idempotency-Key header is required for control-plane writes',
      details: {
        route_template: routeTemplate,
      },
    });
  }
  if (operator.require_ticket && !body.ticket_id) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'validation_failed',
      message: 'ticket_id is required by the matched operator policy',
      details: {
        route_template: routeTemplate,
      },
    });
  }
  const requestFingerprint = buildRequestFingerprint({
    request,
    routeTemplate,
    principalId: operator.principal_id,
    body,
  });
  const dedupeKey = `appservice_id:${scope.scope_id}`;
  const affectedObjects = [{ kind: 'appservice', id: scope.scope_id }];
  const scopeToken = createDedupeScopeToken({ scope, dedupeKey });
  const acceptedAt = new Date().toISOString();
  const acceptedEnvelope = serializeEnvelope('success', 200, {
    appservice: body.appservice ?? null,
    appservices: null,
    next_cursor: null,
  });

  try {
    const finalEnvelope = await persistence.transaction(async (tx) => {
      await appendAuditEvent({
        persistence: tx,
        eventType: 'appservice.accepted',
        operator,
        scope,
        requestContext,
        idempotencyKey,
        requestFingerprint,
        resultCode: 'accepted',
        affectedObjects,
        details: {
          action: 'accepted',
        },
        occurredAt: acceptedAt,
      });

      await tx.insertDedupeRecord({
        operator_principal_id: operator.principal_id,
        idempotency_key: idempotencyKey,
        scope_token: scopeToken,
        request_fingerprint: requestFingerprint,
        job_id: null,
        result_code: 'accepted',
        response_payload: acceptedEnvelope,
        created_at: acceptedAt,
        updated_at: acceptedAt,
      });

      let envelope;
      let resultCode;
      let eventType;
      let finalDetails = {
        route_template: routeTemplate,
      };
      try {
        const responseBody = await mutate();
        envelope = serializeEnvelope('success', 200, responseBody);
        resultCode = 'succeeded';
        eventType = 'appservice.succeeded';
      } catch (error) {
        envelope = serializeEnvelope('error', 500, buildOpsErrorJson({
          code: 'internal',
          message: error.message,
          requestId: requestContext.requestId,
          retryable: false,
        }));
        resultCode = 'failed';
        eventType = 'appservice.failed';
        finalDetails = {
          ...finalDetails,
          failure: error.message,
        };
      }

      const finalizedAt = new Date().toISOString();
      await tx.updateDedupeRecord({
        operator_principal_id: operator.principal_id,
        idempotency_key: idempotencyKey,
        scope_token: scopeToken,
        result_code: resultCode,
        response_payload: envelope,
        updated_at: finalizedAt,
      });

      await appendAuditEvent({
        persistence: tx,
        eventType,
        operator,
        scope,
        requestContext,
        idempotencyKey,
        requestFingerprint,
        resultCode,
        affectedObjects,
        details: finalDetails,
        occurredAt: finalizedAt,
      });

      return envelope;
    });

    return responseFromEnvelope(finalEnvelope);
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await persistence.getDedupeRecord({
      operator_principal_id: operator.principal_id,
      idempotency_key: idempotencyKey,
      scope_token: scopeToken,
    });
    if (!existing) {
      throw error;
    }
    if (existing.request_fingerprint !== requestFingerprint) {
      return responseFromEnvelope(serializeEnvelope('error', 409, buildOpsErrorJson({
        code: 'idempotency_conflict',
        message: 'Idempotency-Key already exists with a different request fingerprint',
        requestId: requestContext.requestId,
        retryable: false,
        details: {
          operator_principal_id: operator.principal_id,
          scope_token: scopeToken,
        },
      })));
    }
    return responseFromEnvelope(existing.response_payload);
  }
}

export function parseJobCreateRequest(routeTemplate, body) {
  if (routeTemplate === ROUTE_TEMPLATES.exports) {
    return {
      job_type: 'export',
      request: normalizeExportJobRequest(body),
    };
  }
  if (routeTemplate === ROUTE_TEMPLATES.restores) {
    return {
      job_type: 'restore',
      request: normalizeRestoreJobRequest(body),
    };
  }
  if (routeTemplate === ROUTE_TEMPLATES.rebuilds) {
    return {
      job_type: 'rebuild',
      request: normalizeRebuildJobRequest(body),
    };
  }
  if (routeTemplate === ROUTE_TEMPLATES.repairs) {
    return {
      job_type: 'repair',
      request: normalizeRepairJobRequest(body),
    };
  }
  throw new RangeError(`Unsupported route template ${routeTemplate}`);
}

export function buildInternalStartSpec({
  jobType,
  jobId,
  operator,
  requestBody,
  acceptedAt,
  idempotencyKey,
  requestFingerprint,
  registrySnapshotId = null,
  exportEpoch = null,
}) {
  const base = buildInternalJobSpec({
    jobId,
    jobType,
    operatorPrincipalId: operator.principal_id,
    authMechanism: operator.auth_mechanism,
    scope: requestBody.scope,
    reason: requestBody.reason,
    ticketId: requestBody.ticket_id,
    idempotencyKey,
    requestFingerprint,
    extra: {
      accepted_at: normalizeString(acceptedAt, 'accepted_at'),
    },
  });
  if (jobType === 'export') {
    return {
      ...base,
      export_mode: requestBody.export_mode,
      reuse_checkpoint_policy: requestBody.reuse_checkpoint_policy === 'reuse_complete_if_cut_satisfied'
        ? 'reuse_complete'
        : 'force_fresh',
      max_checkpoint_age_seconds: requestBody.max_checkpoint_age_seconds,
      include_optional_objects: requestBody.include_optional_objects,
      output_encryption_key_version: requestBody.output_encryption_key_version,
      registry_snapshot_id: registrySnapshotId,
      export_epoch: exportEpoch,
    };
  }
  if (jobType === 'restore') {
    return {
      ...base,
      restore_mode: requestBody.restore_mode,
      source_bundle_uri: requestBody.source_bundle_uri,
      source_bundle_hash: requestBody.source_bundle_hash,
      target_environment_id: requestBody.target_environment_id,
      allow_incomplete: requestBody.allow_incomplete,
      allowed_signing_key_versions: requestBody.allowed_signing_key_versions,
      allowed_encryption_key_versions: requestBody.allowed_encryption_key_versions,
    };
  }
  if (jobType === 'rebuild') {
    return {
      ...base,
      rebuild_target: requestBody.rebuild_target,
      force_full_scan: requestBody.force_full_scan,
    };
  }
  return {
    ...base,
    repair_kind: requestBody.repair_kind,
    dry_run: requestBody.dry_run,
    source_bundle_uri: requestBody.source_bundle_uri,
  };
}

export async function startControlPlaneJob({
  env,
  config,
  persistence,
  requestContext,
  operator,
  routeTemplate,
  request,
  requestBody,
}) {
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'validation_failed',
      message: 'Idempotency-Key header is required for control-plane writes',
      details: {
        route_template: routeTemplate,
      },
    });
  }
  const requestFingerprint = buildRequestFingerprint({
    request,
    routeTemplate,
    principalId: operator.principal_id,
    body: requestBody,
  });
  if (operator.require_ticket && !requestBody.ticket_id) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'validation_failed',
      message: 'ticket_id is required by the matched operator policy',
    });
  }
  const jobType = parseJobCreateRequest(routeTemplate, requestBody).job_type;
  const acceptedAt = new Date().toISOString();
  const jobId = makeId(jobType);
  let registrySnapshotId = null;
  let exportEpoch = jobType === 'export' ? makeId('export_epoch') : null;
  let keyRing = null;
  const internalSpec = buildInternalStartSpec({
    jobType,
    jobId,
    operator,
    requestBody,
    acceptedAt,
    idempotencyKey,
    requestFingerprint,
    registrySnapshotId,
    exportEpoch,
  });
  const jobRecord = createJobRecord({
    jobId,
    jobType,
    scope: requestBody.scope,
    operator,
    idempotencyKey,
    requestFingerprint,
    spec: internalSpec,
    acceptedAt,
    registrySnapshotId,
    exportEpoch,
  });
  const acceptedHandle = buildJobHandleFromRecord(jobRecord);
  const acceptedEnvelope = serializeEnvelope('success', 202, acceptedHandle);

  const reservation = await reserveIdempotentWrite({
    persistence,
    operator,
    scope: requestBody.scope,
    idempotencyKey,
    requestFingerprint,
    initialEnvelope: acceptedEnvelope,
    auditEventType: `${jobType}.accepted`,
    requestContext,
    jobRecord,
  });
  if (reservation.outcome === 'conflict') {
    return responseFromEnvelope(reservation.envelope);
  }
  if (reservation.outcome === 'replay') {
    const replayJob = reservation.job_id == null
      ? null
      : await persistence.getJob(reservation.job_id);
    const replayBody = reservation.envelope?.body ?? null;
    const replayableQueueStart = replayJob
      && replayBody?.retryable === true
      && replayJob.checkpoint_state?.queue_delivery_state === 'staged'
      && replayJob.job_type === jobType;
    if (!replayableQueueStart) {
      return responseFromEnvelope(reservation.envelope);
    }
    try {
      const internalRoute = jobType === 'export'
        ? ROUTE_TEMPLATES.internalStartExport
        : jobType === 'restore'
          ? ROUTE_TEMPLATES.internalStartRestore
          : jobType === 'rebuild'
            ? ROUTE_TEMPLATES.internalStartRebuild
            : ROUTE_TEMPLATES.internalStartRepair;
      await dispatchJobStart({
        env,
        routeTemplate: internalRoute,
        spec: replayJob.spec,
      });
      const storedReplayJob = await persistence.getJob(replayJob.job_id);
      const successEnvelope = serializeEnvelope('success', 202, buildJobHandleFromRecord(storedReplayJob ?? replayJob));
      await finalizeReservedWrite({
        persistence,
        operator,
        scope: requestBody.scope,
        idempotencyKey,
        envelope: successEnvelope,
        resultCode: 'queued',
        requestContext,
        requestFingerprint,
        jobId: replayJob.job_id,
        eventType: `${jobType}.queued`,
        details: {
          route_template: routeTemplate,
          recovered_from_retryable_start_failure: true,
        },
      });
      return responseFromEnvelope(successEnvelope);
    } catch {
      return responseFromEnvelope(reservation.envelope);
    }
  }

  try {
    if (jobType === 'restore') {
      await resolveRestoreCheckpointRefs({
        persistence,
        archiveBucket: env.MATRIX_ARCHIVE_BUCKET,
        keyRing: parseExportKeyRingFromEnv(config, env),
        requestBody,
      });
    }
    if (jobType === 'export') {
      await ensureControlPlaneShardRegistered({
        persistence,
        now: new Date().toISOString(),
      });
      keyRing = parseExportKeyRingFromEnv(config, env);
      const snapshot = await freezeShardRegistrySnapshot({
        persistence,
        archiveBucket: env.MATRIX_ARCHIVE_BUCKET,
        exportEpoch,
        scope: requestBody.scope,
        keyRing,
        now: new Date(),
      });
      registrySnapshotId = snapshot.registry_snapshot_id;
      const updatedSpec = buildInternalStartSpec({
        jobType,
        jobId,
        operator,
        requestBody,
        acceptedAt,
        idempotencyKey,
        requestFingerprint,
        registrySnapshotId,
        exportEpoch,
      });
      const updatedJobRecord = {
        ...jobRecord,
        spec: updatedSpec,
        registry_snapshot_id: registrySnapshotId,
        export_epoch: exportEpoch,
      };
      await persistence.updateJob(updatedJobRecord);
      jobRecord.spec = updatedSpec;
      jobRecord.registry_snapshot_id = registrySnapshotId;
      jobRecord.export_epoch = exportEpoch;
    }
    if (jobType !== 'export') {
      await createReplayManifest({
        persistence,
        archiveBucket: env.MATRIX_ARCHIVE_BUCKET,
        keyRing,
        jobRecord,
        manifestKind: 'shard-manifest',
        scope: requestBody.scope,
        now: new Date(),
      });
    }
    const internalRoute = jobType === 'export'
      ? ROUTE_TEMPLATES.internalStartExport
      : jobType === 'restore'
        ? ROUTE_TEMPLATES.internalStartRestore
        : jobType === 'rebuild'
          ? ROUTE_TEMPLATES.internalStartRebuild
          : ROUTE_TEMPLATES.internalStartRepair;
    await dispatchJobStart({
      env,
      routeTemplate: internalRoute,
      spec: jobRecord.spec,
    });
    const storedJob = await persistence.getJob(jobId);
    const successEnvelope = serializeEnvelope('success', 202, buildJobHandleFromRecord(storedJob ?? jobRecord));
    await finalizeReservedWrite({
      persistence,
      operator,
      scope: requestBody.scope,
      idempotencyKey,
      envelope: successEnvelope,
      resultCode: 'queued',
      requestContext,
      requestFingerprint,
      jobId,
      eventType: `${jobType}.queued`,
      details: {
        route_template: routeTemplate,
      },
    });
    return responseFromEnvelope(successEnvelope);
  } catch (error) {
    const failureCode = error.code === 'job_conflict'
      ? 'precondition_failed'
      : error.code === 'unsupported_schema_version'
        ? 'validation_failed'
      : error instanceof TypeError || error instanceof RangeError
        ? 'validation_failed'
        : 'internal';
    const retryable = failureCode === 'internal'
      ? (error.retryable == null ? true : Boolean(error.retryable))
      : Boolean(error.retryable);
    const failureStatus = failureCode === 'precondition_failed'
      ? 409
      : failureCode === 'validation_failed'
        ? 422
        : retryable
          ? 503
          : 500;
    const storedJob = await persistence.getJob(jobId);
    const failureBase = storedJob ?? jobRecord;
    const failureBody = buildOpsErrorJson({
      code: failureCode,
      message: error.message,
      requestId: requestContext.requestId,
      retryable,
      details: {
        job_id: jobId,
      },
    });
    const failedJob = {
      ...failureBase,
      internal_state: 'failed',
      completed_at: new Date().toISOString(),
      last_error: failureBody,
      result_summary: {
        failure: error.message,
      },
    };
    await persistence.updateJob(failedJob);
    const errorEnvelope = serializeEnvelope('error', failureStatus, failureBody);
    await finalizeReservedWrite({
      persistence,
      operator,
      scope: requestBody.scope,
      idempotencyKey,
      envelope: errorEnvelope,
      resultCode: 'failed',
      requestContext,
      requestFingerprint,
      jobId,
      eventType: `${jobType}.failed`,
      details: {
        route_template: routeTemplate,
      },
    });
    return responseFromEnvelope(errorEnvelope);
  }
}

export async function updateJobState({
  persistence,
  job,
  newState,
  now,
  checkpointState = null,
  lastError = null,
  progress = null,
  resultSummary = null,
  auditEventType = null,
  auditDetails = null,
  requestContext = null,
  skipTransaction = false,
}) {
  const updated = {
    ...job,
    internal_state: newState,
    scope: job.scope,
    started_at: job.started_at ?? (mapInternalJobStateToPublicState(newState) === 'running' ? now.toISOString() : null),
    completed_at: ['completed', 'finalized', 'failed', 'canceled'].includes(newState) ? now.toISOString() : job.completed_at,
    canceled_at: newState === 'canceled' ? now.toISOString() : job.canceled_at,
    checkpoint_state: checkpointState ?? job.checkpoint_state,
    progress_completed_units: progress?.completed_units ?? job.progress_completed_units,
    progress_total_units: progress?.total_units ?? job.progress_total_units,
    progress_unit_name: progress?.unit_name ?? job.progress_unit_name,
    last_error: lastError ?? job.last_error,
    result_summary: resultSummary ?? job.result_summary,
  };
  if (auditEventType) {
    const writeStateAndAudit = async (targetPersistence) => {
      await targetPersistence.updateJob(updated);
      await appendAuditEvent({
        persistence: targetPersistence,
        eventType: auditEventType,
        operator: {
          principal_id: job.operator_principal_id,
          auth_mechanism: job.auth_mechanism,
        },
        scope: job.scope,
        requestContext,
        idempotencyKey: job.idempotency_key,
        requestFingerprint: job.request_fingerprint,
        jobId: job.job_id,
        resultCode: newState,
        affectedObjects: [{ kind: 'job', id: job.job_id }],
        details: auditDetails,
        occurredAt: now.toISOString(),
      });
    };
    if (skipTransaction) {
      await writeStateAndAudit(persistence);
    } else {
      await persistence.transaction(async (tx) => {
        await writeStateAndAudit(tx);
      });
    }
  } else {
    await persistence.updateJob(updated);
  }
  return updated;
}
