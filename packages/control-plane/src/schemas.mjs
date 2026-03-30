import { createOpsErrorResponse } from '../../contracts/src/index.mjs';

export const CONTROL_PLANE_SCHEMA_VERSION = 1;
export const TARGET_SCOPE_KINDS = Object.freeze(['global', 'room_id', 'user_id', 'server_name', 'appservice_id']);
export const JOB_TYPES = Object.freeze(['export', 'restore', 'rebuild', 'repair']);
export const JOB_INTERNAL_STATES = Object.freeze([
  'pending',
  'checkpointed',
  'scanning',
  'applying',
  'materializing',
  'uploading',
  'validating',
  'importing',
  'cutover-ready',
  'cutover',
  'verifying',
  'completed',
  'finalized',
  'failed',
  'cancel_requested',
  'canceled',
]);
export const JOB_PUBLIC_STATES = Object.freeze([
  'accepted',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancel_requested',
  'canceled',
]);
export const EXPORT_MODES = Object.freeze(['full_bundle', 'scoped_bundle']);
export const RESTORE_MODES = Object.freeze(['full_namespace', 'scoped_repair']);
export const REBUILD_TARGETS = Object.freeze([
  'search_index',
  'user_directory',
  'public_room_directory',
  'all_derived',
  'appservice_projection',
]);
export const REPAIR_KINDS = Object.freeze([
  'room_graph',
  'room_user_fanout',
  'user_device_keys',
  'remote_server_txn_queue',
  'remote_media_catalog',
  'search_reindex',
]);
export const CHECKPOINT_REUSE_POLICIES = Object.freeze(['reuse_complete_if_cut_satisfied', 'force_fresh']);
export const CHECKPOINT_STRATEGIES = Object.freeze(['reuse_complete', 'force_fresh']);
export const RESTORE_APPLY_PHASES = Object.freeze([
  'truth-core',
  'truth-aux',
  'ephemeral-current',
  'dedupe-and-outbox',
  'control-plane',
]);
export const EXPORT_ARTIFACT_KINDS = Object.freeze([
  'bundle-manifest',
  'shard-manifest',
  'registry-snapshot',
  'checkpoint-manifest',
  'checkpoint-object',
]);
export const OBJECT_CODECS = Object.freeze(['jcs-json', 'jsonl-gzip']);
export const COMPLETENESS_STATES = Object.freeze(['pending', 'complete', 'partial', 'incomplete']);
export const OPS_SCOPE_VOCABULARY = Object.freeze([
  'ops.read',
  'ops.audit.read',
  'ops.export.write',
  'ops.restore.write',
  'ops.rebuild.write',
  'ops.repair.write',
  'ops.appservice.write',
  'ops.schema.write',
]);
export const QUEUE_NAMES = Object.freeze({
  rebuild: 'matrix-rebuild-shard-job',
  export: 'matrix-export-shard-job',
  restore: 'matrix-restore-shard-job',
  repair: 'matrix-repair-shard-job',
});
export const JOB_TO_SCOPE = Object.freeze({
  export: 'ops.export.write',
  restore: 'ops.restore.write',
  rebuild: 'ops.rebuild.write',
  repair: 'ops.repair.write',
});
export const ROUTE_TEMPLATES = Object.freeze({
  healthz: '/_ops/v1/healthz',
  readyz: '/_ops/v1/readyz',
  exports: '/_ops/v1/exports',
  restores: '/_ops/v1/restores',
  rebuilds: '/_ops/v1/rebuilds',
  repairs: '/_ops/v1/repairs',
  jobsList: '/_ops/v1/jobs',
  jobsItem: '/_ops/v1/jobs/{jobId}',
  jobsCancel: '/_ops/v1/jobs/{jobId}/cancel',
  appservicesList: '/_ops/v1/appservices',
  appservicesItem: '/_ops/v1/appservices/{appserviceId}',
  internalStartExport: '/_internal/jobs/start/export',
  internalStartRestore: '/_internal/jobs/start/restore',
  internalStartRebuild: '/_internal/jobs/start/rebuild',
  internalStartRepair: '/_internal/jobs/start/repair',
});

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
}

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

function normalizeBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function normalizeInteger(value, label, { min = 0, allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) {
      return null;
    }
    throw new TypeError(`${label} must be an integer`);
  }
  if (!Number.isInteger(value) || value < min) {
    throw new TypeError(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function normalizeEnum(value, label, allowedValues) {
  const normalized = normalizeString(value, label);
  if (!allowedValues.includes(normalized)) {
    throw new RangeError(`${label} must be one of ${allowedValues.join(', ')}`);
  }
  return normalized;
}

function normalizeNullableStringArray(value, label) {
  if (value == null) {
    return null;
  }
  assertArray(value, label);
  return value.map((entry, index) => normalizeString(entry, `${label}[${index}]`));
}

export function normalizeTargetScope(value) {
  assertObject(value, 'scope');
  const scopeKind = normalizeEnum(value.scope_kind, 'scope.scope_kind', TARGET_SCOPE_KINDS);
  const scopeId = value.scope_id == null ? null : normalizeString(value.scope_id, 'scope.scope_id');
  if (scopeKind === 'global' && scopeId !== null) {
    throw new RangeError('scope.scope_id must be null when scope.scope_kind is global');
  }
  if (scopeKind !== 'global' && scopeId == null) {
    throw new RangeError('scope.scope_id must be non-null when scope.scope_kind is not global');
  }
  return Object.freeze({
    scope_kind: scopeKind,
    scope_id: scopeId,
  });
}

export function scopeToToken(scope) {
  const normalized = normalizeTargetScope(scope);
  return `${normalized.scope_kind}:${normalized.scope_id ?? 'global'}`;
}

export function parseScopeToken(scopeToken) {
  const normalized = normalizeString(scopeToken, 'scopeToken');
  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex < 0) {
    throw new TypeError('scopeToken must contain ":"');
  }
  const scopeKind = normalized.slice(0, separatorIndex);
  const rawScopeId = normalized.slice(separatorIndex + 1);
  return normalizeTargetScope({
    scope_kind: scopeKind,
    scope_id: scopeKind === 'global' ? null : rawScopeId,
  });
}

export function normalizeOpsHealthResponse(value) {
  assertObject(value, 'OpsHealthResponse');
  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies.map((entry, index) => {
      assertObject(entry, `dependencies[${index}]`);
      return {
        name: normalizeString(entry.name, `dependencies[${index}].name`),
        kind: normalizeString(entry.kind, `dependencies[${index}].kind`),
        status: normalizeEnum(entry.status, `dependencies[${index}].status`, ['ok', 'degraded', 'fail']),
        detail: normalizeString(entry.detail, `dependencies[${index}].detail`),
      };
    })
    : [];
  return {
    service: normalizeString(value.service, 'service'),
    status: normalizeEnum(value.status, 'status', ['ok', 'degraded', 'fail']),
    observed_at: normalizeString(value.observed_at, 'observed_at'),
    worker_version_id: normalizeString(value.worker_version_id, 'worker_version_id'),
    deployment_id: normalizeString(value.deployment_id, 'deployment_id'),
    compatibility_date: normalizeString(value.compatibility_date, 'compatibility_date'),
    release_profile: normalizeString(value.release_profile, 'release_profile'),
    dependencies,
  };
}

export function normalizeExportJobRequest(value) {
  assertObject(value, 'ExportJobRequest');
  const exportMode = normalizeEnum(value.export_mode, 'export_mode', EXPORT_MODES);
  const scope = normalizeTargetScope(value.scope);
  if (exportMode === 'full_bundle' && scope.scope_kind !== 'global') {
    throw new RangeError('scope must be global for full_bundle exports');
  }
  return {
    export_mode: exportMode,
    scope,
    reason: normalizeString(value.reason, 'reason'),
    ticket_id: value.ticket_id == null ? null : normalizeString(value.ticket_id, 'ticket_id'),
    reuse_checkpoint_policy: normalizeEnum(
      value.reuse_checkpoint_policy,
      'reuse_checkpoint_policy',
      CHECKPOINT_REUSE_POLICIES,
    ),
    max_checkpoint_age_seconds: normalizeInteger(
      value.max_checkpoint_age_seconds,
      'max_checkpoint_age_seconds',
      { min: 1, allowNull: true },
    ),
    include_optional_objects: normalizeBoolean(value.include_optional_objects, 'include_optional_objects'),
    output_encryption_key_version: normalizeString(value.output_encryption_key_version, 'output_encryption_key_version'),
  };
}

export function normalizeRestoreJobRequest(value) {
  assertObject(value, 'RestoreJobRequest');
  const restoreMode = normalizeEnum(value.restore_mode, 'restore_mode', RESTORE_MODES);
  const scope = normalizeTargetScope(value.scope);
  if (restoreMode === 'full_namespace' && scope.scope_kind !== 'global') {
    throw new RangeError('scope must be global for full_namespace restores');
  }
  const allowIncomplete = normalizeBoolean(value.allow_incomplete, 'allow_incomplete');
  if (restoreMode === 'full_namespace' && allowIncomplete) {
    throw new RangeError('allow_incomplete must be false for full_namespace restores');
  }
  return {
    restore_mode: restoreMode,
    scope,
    reason: normalizeString(value.reason, 'reason'),
    ticket_id: value.ticket_id == null ? null : normalizeString(value.ticket_id, 'ticket_id'),
    source_bundle_uri: normalizeString(value.source_bundle_uri, 'source_bundle_uri'),
    source_bundle_hash: normalizeString(value.source_bundle_hash, 'source_bundle_hash'),
    target_environment_id: normalizeString(value.target_environment_id, 'target_environment_id'),
    allow_incomplete: allowIncomplete,
    allowed_signing_key_versions: normalizeNullableStringArray(value.allowed_signing_key_versions ?? [], 'allowed_signing_key_versions') ?? [],
    allowed_encryption_key_versions: normalizeNullableStringArray(value.allowed_encryption_key_versions ?? [], 'allowed_encryption_key_versions') ?? [],
  };
}

export function normalizeRebuildJobRequest(value) {
  assertObject(value, 'RebuildJobRequest');
  return {
    rebuild_target: normalizeEnum(value.rebuild_target, 'rebuild_target', REBUILD_TARGETS),
    scope: normalizeTargetScope(value.scope),
    reason: normalizeString(value.reason, 'reason'),
    ticket_id: value.ticket_id == null ? null : normalizeString(value.ticket_id, 'ticket_id'),
    force_full_scan: normalizeBoolean(value.force_full_scan, 'force_full_scan'),
  };
}

const REPAIR_SCOPE_COMPATIBILITY = Object.freeze({
  room_graph: ['room_id'],
  room_user_fanout: ['room_id', 'user_id'],
  user_device_keys: ['user_id'],
  remote_server_txn_queue: ['server_name'],
  remote_media_catalog: ['server_name', 'global'],
  search_reindex: ['global', 'room_id', 'user_id', 'appservice_id'],
});

export function normalizeRepairJobRequest(value) {
  assertObject(value, 'RepairJobRequest');
  const repairKind = normalizeEnum(value.repair_kind, 'repair_kind', REPAIR_KINDS);
  const scope = normalizeTargetScope(value.scope);
  if (!REPAIR_SCOPE_COMPATIBILITY[repairKind].includes(scope.scope_kind)) {
    throw new RangeError(`scope.scope_kind ${scope.scope_kind} is incompatible with repair_kind ${repairKind}`);
  }
  return {
    repair_kind: repairKind,
    scope,
    reason: normalizeString(value.reason, 'reason'),
    ticket_id: value.ticket_id == null ? null : normalizeString(value.ticket_id, 'ticket_id'),
    dry_run: normalizeBoolean(value.dry_run, 'dry_run'),
    source_bundle_uri: value.source_bundle_uri == null ? null : normalizeString(value.source_bundle_uri, 'source_bundle_uri'),
  };
}

export function normalizeJobStatusQuery(value) {
  assertObject(value, 'JobStatusQuery');
  const jobId = value.job_id == null ? null : normalizeString(value.job_id, 'job_id');
  const scope = value.scope == null ? null : normalizeTargetScope(value.scope);
  const normalized = {
    job_id: jobId,
    job_type: value.job_type == null ? null : normalizeEnum(value.job_type, 'job_type', JOB_TYPES),
    state: value.state == null ? null : normalizeEnum(value.state, 'state', JOB_PUBLIC_STATES),
    scope,
    limit: normalizeInteger(value.limit ?? 25, 'limit', { min: 1, allowNull: false }),
    cursor: value.cursor == null ? null : normalizeString(value.cursor, 'cursor'),
  };
  if (normalized.limit > 100) {
    throw new RangeError('limit must be <= 100');
  }
  if (jobId != null && (
    normalized.job_type != null ||
    normalized.state != null ||
    normalized.scope != null ||
    normalized.cursor != null
  )) {
    throw new RangeError('job_id queries may not include job_type, state, scope, or cursor');
  }
  return normalized;
}

export function normalizeJobCancelRequest(value) {
  assertObject(value, 'JobCancelRequest');
  return {
    reason: normalizeString(value.reason, 'reason'),
    ticket_id: value.ticket_id == null ? null : normalizeString(value.ticket_id, 'ticket_id'),
    if_in_states: normalizeNullableStringArray(value.if_in_states, 'if_in_states'),
  };
}

export function normalizeAppserviceNamespaceRule(value, label = 'AppserviceNamespaceRule') {
  assertObject(value, label);
  return {
    regex: normalizeString(value.regex, `${label}.regex`),
    exclusive: normalizeBoolean(value.exclusive, `${label}.exclusive`),
  };
}

export function normalizeAppserviceDescriptor(value) {
  assertObject(value, 'AppserviceDescriptor');
  assertObject(value.namespaces, 'namespaces');
  const deliveryState = value.delivery_state == null ? {
    last_success_at: null,
    backlog_depth: 0,
    retry_state: 'idle',
    last_error: null,
  } : (() => {
    assertObject(value.delivery_state, 'delivery_state');
    return {
      last_success_at: value.delivery_state.last_success_at == null
        ? null
        : normalizeString(value.delivery_state.last_success_at, 'delivery_state.last_success_at'),
      backlog_depth: normalizeInteger(value.delivery_state.backlog_depth ?? 0, 'delivery_state.backlog_depth', { min: 0 }),
      retry_state: normalizeString(value.delivery_state.retry_state ?? 'idle', 'delivery_state.retry_state'),
      last_error: value.delivery_state.last_error == null ? null : value.delivery_state.last_error,
    };
  })();

  return {
    appservice_id: normalizeString(value.appservice_id, 'appservice_id'),
    url: normalizeString(value.url, 'url'),
    sender_localpart: normalizeString(value.sender_localpart, 'sender_localpart'),
    hs_token_secret_ref: normalizeString(value.hs_token_secret_ref, 'hs_token_secret_ref'),
    as_token_secret_ref: normalizeString(value.as_token_secret_ref, 'as_token_secret_ref'),
    namespaces: {
      users: (value.namespaces.users ?? []).map((entry, index) => normalizeAppserviceNamespaceRule(entry, `namespaces.users[${index}]`)),
      aliases: (value.namespaces.aliases ?? []).map((entry, index) => normalizeAppserviceNamespaceRule(entry, `namespaces.aliases[${index}]`)),
      rooms: (value.namespaces.rooms ?? []).map((entry, index) => normalizeAppserviceNamespaceRule(entry, `namespaces.rooms[${index}]`)),
    },
    protocols: normalizeNullableStringArray(value.protocols ?? [], 'protocols') ?? [],
    rate_limited: normalizeBoolean(value.rate_limited, 'rate_limited'),
    receive_ephemeral: normalizeBoolean(value.receive_ephemeral, 'receive_ephemeral'),
    healthcheck_enabled: normalizeBoolean(value.healthcheck_enabled, 'healthcheck_enabled'),
    disabled_at: value.disabled_at == null ? null : normalizeString(value.disabled_at, 'disabled_at'),
    delivery_state: deliveryState,
  };
}

export function normalizeAppserviceConfigRequest(value) {
  assertObject(value, 'AppserviceConfigRequest');
  return {
    appservice: value.appservice == null ? null : normalizeAppserviceDescriptor(value.appservice),
    ticket_id: value.ticket_id == null ? null : normalizeString(value.ticket_id, 'ticket_id'),
  };
}

export function normalizeJobHandle(value) {
  assertObject(value, 'JobHandle');
  return {
    job_id: normalizeString(value.job_id, 'job_id'),
    job_type: normalizeEnum(value.job_type, 'job_type', JOB_TYPES),
    state: normalizeEnum(value.state, 'state', JOB_PUBLIC_STATES),
    scope: normalizeTargetScope(value.scope),
    accepted_at: normalizeString(value.accepted_at, 'accepted_at'),
    request_fingerprint: normalizeString(value.request_fingerprint, 'request_fingerprint'),
    idempotency_key_echo: normalizeString(value.idempotency_key_echo, 'idempotency_key_echo'),
  };
}

export function normalizeJobSummary(value) {
  assertObject(value, 'JobSummary');
  return {
    job_id: normalizeString(value.job_id, 'job_id'),
    job_type: normalizeEnum(value.job_type, 'job_type', JOB_TYPES),
    state: normalizeEnum(value.state, 'state', JOB_PUBLIC_STATES),
    scope: normalizeTargetScope(value.scope),
    created_at: normalizeString(value.created_at, 'created_at'),
    started_at: value.started_at == null ? null : normalizeString(value.started_at, 'started_at'),
    completed_at: value.completed_at == null ? null : normalizeString(value.completed_at, 'completed_at'),
    progress: value.progress ?? { completed_units: 0, total_units: 0, unit_name: 'shard' },
    checkpoint_state: value.checkpoint_state ?? null,
    last_error: value.last_error ?? null,
  };
}

export function normalizeJobStatusResponse(value) {
  assertObject(value, 'JobStatusResponse');
  const job = value.job == null ? null : normalizeJobSummary(value.job);
  const jobs = value.jobs == null ? null : value.jobs.map((entry, index) => normalizeJobSummary(entry, `jobs[${index}]`));
  if ((job == null && jobs == null) || (job != null && jobs != null)) {
    throw new RangeError('JobStatusResponse must contain exactly one of job or jobs');
  }
  return {
    job,
    jobs,
    next_cursor: value.next_cursor == null ? null : normalizeString(value.next_cursor, 'next_cursor'),
  };
}

export function mapInternalJobStateToPublicState(internalState) {
  const normalized = normalizeEnum(internalState, 'internalState', JOB_INTERNAL_STATES);
  if (normalized === 'pending') {
    return 'accepted';
  }
  if (normalized === 'checkpointed') {
    return 'queued';
  }
  if (['scanning', 'applying', 'materializing', 'uploading', 'validating', 'importing', 'cutover-ready', 'cutover', 'verifying'].includes(normalized)) {
    return 'running';
  }
  if (['completed', 'finalized'].includes(normalized)) {
    return 'succeeded';
  }
  if (normalized === 'failed') {
    return 'failed';
  }
  if (normalized === 'cancel_requested') {
    return 'cancel_requested';
  }
  return 'canceled';
}

export function buildJobHandleFromRecord(record) {
  return normalizeJobHandle({
    job_id: record.job_id,
    job_type: record.job_type,
    state: mapInternalJobStateToPublicState(record.internal_state),
    scope: record.scope,
    accepted_at: record.accepted_at,
    request_fingerprint: record.request_fingerprint,
    idempotency_key_echo: record.idempotency_key,
  });
}

export function buildJobSummaryFromRecord(record) {
  return normalizeJobSummary({
    job_id: record.job_id,
    job_type: record.job_type,
    state: mapInternalJobStateToPublicState(record.internal_state),
    scope: record.scope,
    created_at: record.created_at,
    started_at: record.started_at,
    completed_at: record.completed_at,
    progress: {
      completed_units: record.progress_completed_units ?? 0,
      total_units: record.progress_total_units ?? 0,
      unit_name: record.progress_unit_name ?? 'shard',
    },
    checkpoint_state: record.checkpoint_state ?? null,
    last_error: record.last_error ?? null,
  });
}

export function buildJobStatusResponseFromRecords({ job = null, jobs = null, nextCursor = null }) {
  if (job != null) {
    return normalizeJobStatusResponse({
      job: buildJobSummaryFromRecord(job),
      jobs: null,
      next_cursor: null,
    });
  }
  return normalizeJobStatusResponse({
    job: null,
    jobs: (jobs ?? []).map(buildJobSummaryFromRecord),
    next_cursor: nextCursor,
  });
}

export function buildOpsErrorJson({
  code,
  message,
  requestId,
  retryable = false,
  details = null,
}) {
  return createOpsErrorResponse({
    code,
    message,
    requestId,
    retryable,
    details,
  });
}

export function buildInternalJobSpec({
  jobId,
  jobType,
  operatorPrincipalId,
  authMechanism,
  scope,
  reason,
  ticketId,
  schemaVersion = CONTROL_PLANE_SCHEMA_VERSION,
  idempotencyKey,
  requestFingerprint,
  extra = {},
}) {
  return {
    schema_version: normalizeInteger(schemaVersion, 'schema_version', { min: 1 }),
    job_id: normalizeString(jobId, 'job_id'),
    job_type: normalizeEnum(jobType, 'job_type', JOB_TYPES),
    operator_principal_id: normalizeString(operatorPrincipalId, 'operator_principal_id'),
    auth_mechanism: normalizeString(authMechanism, 'auth_mechanism'),
    scope: normalizeTargetScope(scope),
    reason: normalizeString(reason, 'reason'),
    ticket_id: ticketId == null ? null : normalizeString(ticketId, 'ticket_id'),
    idempotency_key: normalizeString(idempotencyKey, 'idempotency_key'),
    request_fingerprint: normalizeString(requestFingerprint, 'request_fingerprint'),
    ...extra,
  };
}

export function buildExportShardJob({
  jobId,
  exportEpoch,
  shardType,
  shardKey,
  checkpointStrategy,
  attempt = 0,
}) {
  return {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    job_id: normalizeString(jobId, 'job_id'),
    export_epoch: normalizeString(exportEpoch, 'export_epoch'),
    shard_type: normalizeString(shardType, 'shard_type'),
    shard_key: normalizeString(shardKey, 'shard_key'),
    checkpoint_strategy: normalizeEnum(checkpointStrategy, 'checkpoint_strategy', CHECKPOINT_STRATEGIES),
    attempt: normalizeInteger(attempt, 'attempt', { min: 0 }),
  };
}

export function buildRebuildShardJob({
  jobId,
  rebuildTarget,
  shardType,
  shardKey,
  attempt = 0,
}) {
  return {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    job_id: normalizeString(jobId, 'job_id'),
    rebuild_target: normalizeEnum(rebuildTarget, 'rebuild_target', REBUILD_TARGETS),
    shard_type: normalizeString(shardType, 'shard_type'),
    shard_key: normalizeString(shardKey, 'shard_key'),
    attempt: normalizeInteger(attempt, 'attempt', { min: 0 }),
  };
}

export function buildRestoreShardJob({
  jobId,
  checkpointId,
  shardType,
  shardKey,
  applyPhase,
  attempt = 0,
}) {
  return {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    job_id: normalizeString(jobId, 'job_id'),
    checkpoint_id: normalizeString(checkpointId, 'checkpoint_id'),
    shard_type: normalizeString(shardType, 'shard_type'),
    shard_key: normalizeString(shardKey, 'shard_key'),
    apply_phase: normalizeEnum(applyPhase, 'apply_phase', RESTORE_APPLY_PHASES),
    attempt: normalizeInteger(attempt, 'attempt', { min: 0 }),
  };
}

export function buildRepairShardJob({
  jobId,
  repairKind,
  scope,
  attempt = 0,
}) {
  const normalizedScope = normalizeTargetScope(scope);
  return {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    job_id: normalizeString(jobId, 'job_id'),
    repair_kind: normalizeEnum(repairKind, 'repair_kind', REPAIR_KINDS),
    scope_kind: normalizedScope.scope_kind,
    scope_id: normalizedScope.scope_id,
    attempt: normalizeInteger(attempt, 'attempt', { min: 0 }),
  };
}

export function normalizeQueuePayload(queueName, value) {
  assertObject(value, 'queue payload');
  const schemaVersion = normalizeInteger(value.schema_version, 'schema_version', { min: 1 });
  if (schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw Object.assign(
      new RangeError(`Unsupported schema_version ${schemaVersion}`),
      { code: 'unsupported_schema_version', retryable: false },
    );
  }
  if (queueName === QUEUE_NAMES.export) {
    return buildExportShardJob({
      jobId: value.job_id,
      exportEpoch: value.export_epoch,
      shardType: value.shard_type,
      shardKey: value.shard_key,
      checkpointStrategy: value.checkpoint_strategy,
      attempt: value.attempt,
    });
  }
  if (queueName === QUEUE_NAMES.rebuild) {
    return buildRebuildShardJob({
      jobId: value.job_id,
      rebuildTarget: value.rebuild_target,
      shardType: value.shard_type,
      shardKey: value.shard_key,
      attempt: value.attempt,
    });
  }
  if (queueName === QUEUE_NAMES.restore) {
    return buildRestoreShardJob({
      jobId: value.job_id,
      checkpointId: value.checkpoint_id,
      shardType: value.shard_type,
      shardKey: value.shard_key,
      applyPhase: value.apply_phase,
      attempt: value.attempt,
    });
  }
  if (queueName === QUEUE_NAMES.repair) {
    return buildRepairShardJob({
      jobId: value.job_id,
      repairKind: value.repair_kind,
      scope: {
        scope_kind: value.scope_kind,
        scope_id: value.scope_id,
      },
      attempt: value.attempt,
    });
  }
  throw new RangeError(`Unsupported queue name ${queueName}`);
}
