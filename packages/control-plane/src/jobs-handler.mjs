import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import {
  applyPublicRoomDirectoryProjection,
  applySearchIndexProjection,
  applySearchIndexProjectionBatch,
  applyUserDirectoryProjection,
  clearDerivedTarget,
  createAsyncTaskContext,
  loadWorkerRuntimeConfig,
  makeId,
  resolveWorkerResourceBindingNames,
  SEARCH_INDEX_BATCH_ROWS_PER_STATEMENT,
} from '../../runtime-core/src/index.mjs';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  QUEUE_NAMES,
  ROUTE_TEMPLATES,
  buildExportShardJob,
  buildJobHandleFromRecord,
  buildOpsErrorJson,
  buildRebuildShardJob,
  buildRepairShardJob,
  buildRestoreShardJob,
  mapInternalJobStateToPublicState,
  normalizeQueuePayload,
  resolveCanonicalControlPlaneQueueName,
} from './schemas.mjs';
import {
  buildControlPlaneCheckpointArtifact,
  finalizeExportBundleManifest,
  ensureControlPlaneShardRegistered,
  getControlPlanePersistence,
  jsonResponse,
  parseExportKeyRingFromEnv,
  resolveRestoreCheckpointRefs,
  sendQueueMessage,
  updateJobState,
} from './services.mjs';

const TERMINAL_JOB_STATES = new Set(['completed', 'finalized', 'failed', 'canceled']);
const MAX_D1_QUERIES_PER_INVOCATION = 1_000;
const REBUILD_D1_QUERY_HEADROOM = 32;
const MAX_SEARCH_ROWS_PER_REBUILD_CHUNK = 10_000;

function assertRebuildInvocationBudget({
  includeSearchIndex = false,
  searchRowCount = 0,
  includeSearchClear = false,
  includePublicRoomDirectory = false,
  includePublicRoomDirectoryClear = false,
  includeUserDirectory = false,
  includeUserDirectoryClear = false,
}) {
  const normalizedSearchRowCount = Number.isInteger(searchRowCount) && searchRowCount > 0
    ? searchRowCount
    : 0;
  let estimatedQueries = 1 + REBUILD_D1_QUERY_HEADROOM;
  if (includeSearchIndex) {
    estimatedQueries += 1 + Math.ceil(normalizedSearchRowCount / SEARCH_INDEX_BATCH_ROWS_PER_STATEMENT);
    if (includeSearchClear) {
      estimatedQueries += 1;
    }
  }
  if (includePublicRoomDirectory) {
    estimatedQueries += 1;
    if (includePublicRoomDirectoryClear) {
      estimatedQueries += 1;
    }
  }
  if (includeUserDirectory) {
    estimatedQueries += 1;
    if (includeUserDirectoryClear) {
      estimatedQueries += 1;
    }
  }
  if (estimatedQueries > MAX_D1_QUERIES_PER_INVOCATION) {
    throw Object.assign(new Error(
      `Rebuild shard exceeds the single-invocation D1 budget (${estimatedQueries} estimated queries > ${MAX_D1_QUERIES_PER_INVOCATION})`,
    ), {
      code: 'job_conflict',
      retryable: false,
    });
  }
}

function normalizeRebuildChunkCursor(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const maxRoomPos = Number.isInteger(value.max_room_pos) && value.max_room_pos >= 0
    ? value.max_room_pos
    : null;
  const searchRowOffset = Number.isInteger(value.search_row_offset) && value.search_row_offset >= 0
    ? value.search_row_offset
    : 0;
  if (maxRoomPos == null) {
    return null;
  }
  return {
    max_room_pos: maxRoomPos,
    search_row_offset: searchRowOffset,
  };
}

function sameRebuildChunkCursor(left, right) {
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return left.max_room_pos === right.max_room_pos
    && left.search_row_offset === right.search_row_offset;
}

function normalizeRebuildProgress(checkpoint, messageBody) {
  const stored = checkpoint?.rebuild_progress ?? {};
  return {
    chunks_completed: Number.isInteger(stored.chunks_completed) && stored.chunks_completed >= 0
      ? stored.chunks_completed
      : 0,
    search_rows_applied: Number.isInteger(stored.search_rows_applied) && stored.search_rows_applied >= 0
      ? stored.search_rows_applied
      : 0,
    total_search_index_rows: Number.isInteger(stored.total_search_index_rows) && stored.total_search_index_rows >= 0
      ? stored.total_search_index_rows
      : null,
    next_chunk_cursor: normalizeRebuildChunkCursor(stored.next_chunk_cursor)
      ?? normalizeRebuildChunkCursor(messageBody.chunk_cursor),
    search_index_cleared: stored.search_index_cleared === true,
    public_room_directory_cleared: stored.public_room_directory_cleared === true,
    public_room_directory_applied: stored.public_room_directory_applied === true,
  };
}

function buildRebuildCheckpointState(progress, { shardType, shardKey }) {
  return {
    rebuild_shard_progress: {
      shard_type: shardType,
      shard_key: shardKey,
      chunks_completed: progress.chunks_completed,
      search_rows_applied: progress.search_rows_applied,
      total_search_index_rows: progress.total_search_index_rows,
      next_chunk_cursor: progress.next_chunk_cursor,
      search_index_cleared: progress.search_index_cleared,
      public_room_directory_cleared: progress.public_room_directory_cleared,
      public_room_directory_applied: progress.public_room_directory_applied,
    },
  };
}

function assertSupportedExportMaterializationTarget({ shardType, shardKey }) {
  if (shardType === 'control-plane' && shardKey === 'ops-core') {
    return;
  }
  throw Object.assign(new Error(
    `Export shard ${shardType}/${shardKey} cannot be materialized by the current Phase 02 runtime; only control-plane/ops-core is implemented`,
  ), {
    code: 'job_conflict',
    retryable: false,
  });
}

function parseInternalRoute(pathname) {
  if (pathname === ROUTE_TEMPLATES.internalStartExport) {
    return { kind: 'start-export' };
  }
  if (pathname === ROUTE_TEMPLATES.internalStartRestore) {
    return { kind: 'start-restore' };
  }
  if (pathname === ROUTE_TEMPLATES.internalStartRebuild) {
    return { kind: 'start-rebuild' };
  }
  if (pathname === ROUTE_TEMPLATES.internalStartRepair) {
    return { kind: 'start-repair' };
  }
  return null;
}

function internalErrorResponse({
  status = 409,
  code = 'job_conflict',
  message,
  retryable = false,
  details = null,
}) {
  return jsonResponse(createInternalErrorEnvelope({
    code,
    message,
    retryable,
    details,
  }), status);
}

function scopeKindToShardType(scopeKind) {
  if (scopeKind === 'room_id') {
    return 'RoomDO';
  }
  if (scopeKind === 'user_id') {
    return 'UserDO';
  }
  if (scopeKind === 'server_name') {
    return 'RemoteServerDO';
  }
  return 'control-plane';
}

function expectedJobTypeForKind(kind) {
  if (kind === 'start-export') {
    return 'export';
  }
  if (kind === 'start-restore') {
    return 'restore';
  }
  if (kind === 'start-rebuild') {
    return 'rebuild';
  }
  return 'repair';
}

function queueNameForKind(kind) {
  if (kind === 'start-export') {
    return QUEUE_NAMES.export;
  }
  if (kind === 'start-rebuild') {
    return QUEUE_NAMES.rebuild;
  }
  if (kind === 'start-restore') {
    return QUEUE_NAMES.restore;
  }
  return QUEUE_NAMES.repair;
}

function checkpointTargetForPayload({ kind, payload }) {
  if (kind === 'start-repair') {
    return {
      shard_type: scopeKindToShardType(payload.scope_kind),
      shard_key: payload.scope_id ?? 'global',
    };
  }
  return {
    shard_type: payload.shard_type,
    shard_key: payload.shard_key,
  };
}

function isRebuildShardRelevant(rebuildTarget, shardType) {
  if (rebuildTarget === 'search_index') {
    return shardType === 'RoomDO';
  }
  if (rebuildTarget === 'public_room_directory') {
    return shardType === 'RoomDO';
  }
  if (rebuildTarget === 'user_directory') {
    return shardType === 'UserDO';
  }
  if (rebuildTarget === 'all_derived') {
    return shardType === 'RoomDO' || shardType === 'UserDO';
  }
  return false;
}

function isActiveShardRegistryRow(row) {
  return row?.disabled_at == null;
}

function classifyFanOutError(error, { job, kind }) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'job_conflict' || message.includes('Registry snapshot') || message.includes('contains no shard rows')) {
    return {
      status: 409,
      code: 'job_conflict',
      message,
      retryable: false,
      details: {
        job_id: job.job_id,
        start_kind: kind,
      },
    };
  }
  return {
    status: 503,
    code: 'backpressure',
    message,
    retryable: true,
    details: {
      job_id: job.job_id,
      start_kind: kind,
    },
  };
}

function classifyQueueTerminalFailure(error, { queueName, schemaVersion }) {
  if (error.code === 'job_conflict') {
    return {
      opsCode: 'precondition_failed',
      details: {
        queue_name: queueName,
      },
      auditDetails: {
        queue_name: queueName,
        reason: 'job_conflict',
      },
    };
  }
  if (error.code === 'unsupported_schema_version' || error instanceof TypeError || error instanceof RangeError) {
    return {
      opsCode: 'validation_failed',
      details: {
        queue_name: queueName,
        schema_version: schemaVersion,
        expected_schema_version: CONTROL_PLANE_SCHEMA_VERSION,
      },
      auditDetails: {
        queue_name: queueName,
        reason: error.code ?? 'validation_failed',
        schema_version: schemaVersion,
      },
    };
  }
  return {
    opsCode: 'internal',
    details: {
      queue_name: queueName,
    },
    auditDetails: {
      queue_name: queueName,
      reason: error.code ?? 'queue_processing_failed',
    },
  };
}

async function failJobForQueueMessage({
  persistence,
  queueName,
  message,
  asyncContext,
  env,
  error,
}) {
  const jobId = typeof message?.body?.job_id === 'string' ? message.body.job_id.trim() : '';
  if (!jobId) {
    return;
  }
  const job = await persistence.getJob(jobId);
  if (!job || TERMINAL_JOB_STATES.has(job.internal_state)) {
    return;
  }
  const classified = classifyQueueTerminalFailure(error, {
    queueName,
    schemaVersion: message?.body?.schema_version ?? null,
  });
  await updateJobState({
    env,
    persistence,
    job,
    newState: 'failed',
    now: new Date(),
    lastError: buildOpsErrorJson({
      code: classified.opsCode,
      message: error.message,
      requestId: asyncContext.causationId ?? jobId,
      retryable: false,
      details: classified.details,
    }),
    auditEventType: `${job.job_type}.failed`,
    auditDetails: classified.auditDetails,
    requestContext: asyncContext,
    resultSummary: {
      failure: error.message,
    },
  });
}

async function stageQueuedPayloads({
  env,
  persistence,
  job,
  kind,
  payloads,
  now,
}) {
  const queueName = queueNameForKind(kind);
  const nextState = payloads.length > 0 ? 'checkpointed' : (kind === 'start-export' ? 'finalized' : 'completed');
  await persistence.transaction(async (tx) => {
    for (const payload of payloads) {
      const target = checkpointTargetForPayload({ kind, payload });
      await tx.upsertJobCheckpoint({
        job_id: job.job_id,
        shard_type: target.shard_type,
        shard_key: target.shard_key,
        checkpoint: {
          status: 'queued',
          queue_name: queueName,
          attempt: payload.attempt,
        },
        updated_at: now.toISOString(),
      });
    }
    await updateJobState({
      env,
      persistence: tx,
      job,
      newState: nextState,
      now,
      auditEventType: `${job.job_type}.${nextState}`,
      auditDetails: {
        queue_ready: payloads.length,
        queue_kind: kind,
      },
      checkpointState: {
        queue_ready: payloads.length,
        queue_name: queueName,
        queue_delivery_state: payloads.length > 0 ? 'staged' : 'not_required',
      },
      progress: {
        completed_units: 0,
        total_units: payloads.length,
        unit_name: 'shard',
      },
      resultSummary: payloads.length === 0 ? {
        terminal_state: mapInternalJobStateToPublicState(nextState),
      } : null,
      skipTransaction: true,
    });
  });
}

async function markQueuedPayloadsPublished({
  persistence,
  jobId,
  payloadCount,
  queueName,
}) {
  const job = await persistence.getJob(jobId);
  if (!job) {
    return null;
  }
  const updatedJob = {
    ...job,
    checkpoint_state: {
      ...(job.checkpoint_state ?? {}),
      queue_ready: payloadCount,
      queue_name: queueName,
      queue_delivery_state: 'published',
      queue_published: payloadCount,
    },
  };
  await persistence.updateJob(updatedJob);
  return updatedJob;
}

async function fanOutJobTasks({ env, persistence, job, kind }) {
  const config = loadWorkerRuntimeConfig('jobs-worker', env);
  const now = new Date();
  const queueName = queueNameForKind(kind);
  const queueBindings = {
    export: env.EXPORT_SHARD_QUEUE,
    rebuild: env.REBUILD_SHARD_QUEUE,
    restore: env.RESTORE_SHARD_QUEUE,
    repair: env.REPAIR_SHARD_QUEUE,
  };
  let payloads = [];
  if (kind === 'start-export') {
    const snapshot = await persistence.getRegistrySnapshot(job.registry_snapshot_id);
    if (!snapshot) {
      throw new Error(`Registry snapshot ${job.registry_snapshot_id} not found for export job ${job.job_id}`);
    }
    const rows = snapshot?.snapshot?.rows ?? [];
    if (rows.length === 0) {
      throw new Error(`Registry snapshot ${job.registry_snapshot_id} contains no shard rows`);
    }
    for (const row of rows) {
      assertSupportedExportMaterializationTarget({
        shardType: row.shard_type,
        shardKey: row.shard_key,
      });
    }
    payloads = rows.map((row) => buildExportShardJob({
      jobId: job.job_id,
      exportEpoch: job.export_epoch,
      shardType: row.shard_type,
      shardKey: row.shard_key,
      checkpointStrategy: job.spec.reuse_checkpoint_policy ?? 'force_fresh',
      attempt: 0,
    }));
  } else if (kind === 'start-rebuild') {
    const rows = job.scope.scope_kind === 'global'
      ? await persistence.listShardRegistry({})
      : [{
        shard_type: job.scope.scope_kind === 'room_id'
          ? 'RoomDO'
          : job.scope.scope_kind === 'user_id'
            ? 'UserDO'
            : job.scope.scope_kind === 'server_name'
              ? 'RemoteServerDO'
              : 'control-plane',
        shard_key: job.scope.scope_id ?? 'ops-core',
      }];
    const relevantRows = rows
      .filter((row) => job.scope.scope_kind !== 'global' || isActiveShardRegistryRow(row))
      .filter((row) => isRebuildShardRelevant(job.spec.rebuild_target, row.shard_type));
    if (job.scope.scope_kind === 'global' && relevantRows.length === 0) {
      throw Object.assign(
        new Error(`Global rebuild target ${job.spec.rebuild_target} has no relevant shard registry rows; retry after registry repair completes`),
        {
          code: 'job_conflict',
          retryable: false,
        },
      );
    }
    if (job.scope.scope_kind === 'global') {
      await clearDerivedTarget(env, {
        target: job.spec.rebuild_target,
      });
    }
    payloads = relevantRows
      .map((row) => buildRebuildShardJob({
        jobId: job.job_id,
        rebuildTarget: job.spec.rebuild_target,
        shardType: row.shard_type,
        shardKey: row.shard_key,
        attempt: 0,
      }));
  } else if (kind === 'start-restore') {
    const restoreCheckpoints = await resolveRestoreCheckpointRefs({
      persistence,
      archiveBucket: env.MATRIX_ARCHIVE_BUCKET,
      keyRing: parseExportKeyRingFromEnv(config, env),
      requestBody: {
        ...job.spec,
        scope: job.scope,
      },
    });
    payloads = restoreCheckpoints.map((checkpoint) => buildRestoreShardJob({
      jobId: job.job_id,
      checkpointId: checkpoint.checkpoint_id,
      shardType: checkpoint.shard_type,
      shardKey: checkpoint.shard_key,
      applyPhase: checkpoint.apply_phase,
      attempt: 0,
    }));
  } else {
    payloads = [buildRepairShardJob({
      jobId: job.job_id,
      repairKind: job.spec.repair_kind,
      scope: job.scope,
      attempt: 0,
    })];
  }
  await stageQueuedPayloads({
    env,
    persistence,
    job,
    kind,
    payloads,
    now,
  });
  const queueBinding = kind === 'start-export'
    ? queueBindings.export
    : kind === 'start-rebuild'
      ? queueBindings.rebuild
      : kind === 'start-restore'
        ? queueBindings.restore
        : queueBindings.repair;
  for (const payload of payloads) {
    await sendQueueMessage(queueBinding, payload);
  }
  if (payloads.length > 0) {
    await markQueuedPayloadsPublished({
      persistence,
      jobId: job.job_id,
      payloadCount: payloads.length,
      queueName,
    });
  }
  return payloads.length;
}

function getDurableObjectStub(namespace, id, bindingName) {
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw Object.assign(new TypeError(`${bindingName} Durable Object binding is not available`), {
      retryable: false,
    });
  }
  return namespace.get(namespace.idFromName(id));
}

async function executeRepairAction({
  job,
  messageBody,
  env,
}) {
  if (messageBody.repair_kind !== 'room_user_fanout') {
    return {
      scope_count: 0,
      noop: true,
    };
  }

  if (messageBody.scope_kind === 'room_id') {
    const roomDo = getDurableObjectStub(env.ROOM_DO, messageBody.scope_id, 'ROOM_DO');
    const result = await runScopedFanoutRepair({
      roomDo,
      dryRun: job.spec?.dry_run === true,
    });
    return {
      scope_count: 1,
      results: result,
    };
  }

  if (messageBody.scope_kind === 'user_id') {
    const userDo = getDurableObjectStub(env.USER_DO, messageBody.scope_id, 'USER_DO');
    const memberships = await userDo.listRoomSyncMemberships({
      user_id: messageBody.scope_id,
    });
    if (!memberships?.ok) {
      throw memberships?.error ?? new Error('User membership enumeration failed');
    }
    const roomResults = [];
    for (const entry of memberships.entries ?? []) {
      const roomDo = getDurableObjectStub(env.ROOM_DO, entry.room_id, 'ROOM_DO');
      const result = await runScopedFanoutRepair({
        roomDo,
        targetUserId: messageBody.scope_id,
        dryRun: job.spec?.dry_run === true,
      });
      roomResults.push({
        room_id: entry.room_id,
        results: result,
      });
    }
    return {
      scope_count: roomResults.length,
      rooms: roomResults,
    };
  }

  return {
    scope_count: 0,
    noop: true,
  };
}

async function runScopedFanoutRepair({
  roomDo,
  targetUserId = null,
  dryRun = false,
}) {
  const allResults = [];
  for (let pass = 0; pass < 128; pass += 1) {
    const result = await roomDo.reconcileFanout({
      limit: 1_000,
      ...(targetUserId == null ? {} : { target_user_id: targetUserId }),
      dry_run: dryRun,
    });
    if (!result?.ok) {
      throw result?.error ?? new Error('Room fanout repair failed');
    }
    allResults.push(...(result.results ?? []));
    if (dryRun || result.has_more !== true) {
      return allResults;
    }
  }
  throw Object.assign(new Error('Room fanout repair did not converge within 128 passes'), {
    retryable: false,
  });
}

async function executeRebuildAction({
  job,
  messageBody,
  env,
  existingCheckpoint,
}) {
  const target = messageBody.rebuild_target;
  if (messageBody.shard_type === 'RoomDO') {
    const existingProgress = normalizeRebuildProgress(existingCheckpoint?.checkpoint, messageBody);
    const includeSearchIndex = target === 'search_index' || target === 'all_derived';
    const includePublicRoomDirectory = target === 'public_room_directory' || target === 'all_derived';
    const chunkCursor = normalizeRebuildChunkCursor(messageBody.chunk_cursor);
    const roomDo = getDurableObjectStub(env.ROOM_DO, messageBody.shard_key, 'ROOM_DO');
    const snapshot = await roomDo.exportDerivedShard({
      updated_at: new Date().toISOString(),
      include_search_index_rows: includeSearchIndex,
      include_public_room_directory_entry: includePublicRoomDirectory,
      max_room_pos: chunkCursor?.max_room_pos ?? null,
      search_row_offset: chunkCursor?.search_row_offset ?? 0,
      search_limit: includeSearchIndex
        ? (messageBody.chunk_limit ?? MAX_SEARCH_ROWS_PER_REBUILD_CHUNK)
        : null,
    });
    if (!snapshot?.ok) {
      throw snapshot?.error ?? new Error(`RoomDO exportDerivedShard failed for ${messageBody.shard_key}`);
    }
    assertRebuildInvocationBudget({
      includeSearchIndex,
      searchRowCount: snapshot.search_index_rows?.length ?? 0,
      includeSearchClear: includeSearchIndex && existingProgress.search_index_cleared !== true,
      includePublicRoomDirectory: includePublicRoomDirectory && snapshot.has_more_search_index_rows !== true,
      includePublicRoomDirectoryClear: includePublicRoomDirectory && existingProgress.public_room_directory_cleared !== true,
    });
    if (includeSearchIndex && existingProgress.search_index_cleared !== true) {
      await clearDerivedTarget(env, {
        target: 'search_index',
        roomId: messageBody.shard_key,
      });
    }
    if (includePublicRoomDirectory && existingProgress.public_room_directory_cleared !== true) {
      await clearDerivedTarget(env, {
        target: 'public_room_directory',
        roomId: messageBody.shard_key,
      });
    }
    if (includeSearchIndex && (snapshot.search_index_rows?.length ?? 0) > MAX_SEARCH_ROWS_PER_REBUILD_CHUNK) {
      throw Object.assign(new Error(
        `RoomDO exportDerivedShard exceeded the chunk budget (${snapshot.search_index_rows.length} rows > ${MAX_SEARCH_ROWS_PER_REBUILD_CHUNK})`,
      ), {
        code: 'job_conflict',
        retryable: false,
      });
    }
    if (includeSearchIndex) {
      await applySearchIndexProjectionBatch(env, snapshot.search_index_rows ?? []);
    }
    const nextProgress = {
      ...existingProgress,
      chunks_completed: existingProgress.chunks_completed + 1,
      search_rows_applied: existingProgress.search_rows_applied + (snapshot.search_index_rows?.length ?? 0),
      total_search_index_rows: includeSearchIndex
        ? (snapshot.total_search_index_rows ?? existingProgress.total_search_index_rows ?? 0)
        : (existingProgress.total_search_index_rows ?? 0),
      next_chunk_cursor: null,
      search_index_cleared: existingProgress.search_index_cleared || includeSearchIndex,
      public_room_directory_cleared: existingProgress.public_room_directory_cleared || includePublicRoomDirectory,
      public_room_directory_applied: existingProgress.public_room_directory_applied,
    };
    if (includeSearchIndex && snapshot.has_more_search_index_rows === true) {
      const nextChunkCursor = {
        max_room_pos: snapshot.max_room_pos,
        search_row_offset: snapshot.next_search_row_offset,
      };
      const continuationPayload = buildRebuildShardJob({
        jobId: job.job_id,
        rebuildTarget: messageBody.rebuild_target,
        shardType: messageBody.shard_type,
        shardKey: messageBody.shard_key,
        chunkCursor: nextChunkCursor,
        chunkLimit: messageBody.chunk_limit ?? MAX_SEARCH_ROWS_PER_REBUILD_CHUNK,
        attempt: messageBody.attempt + 1,
      });
      nextProgress.next_chunk_cursor = nextChunkCursor;
      return {
        continuationPayload,
        queuedCheckpoint: {
          status: 'queued',
          queue_name: QUEUE_NAMES.rebuild,
          attempt: continuationPayload.attempt,
          queue_delivery_state: 'staged',
          queued_payload: continuationPayload,
          rebuild_progress: nextProgress,
        },
        checkpointState: buildRebuildCheckpointState(nextProgress, {
          shardType: messageBody.shard_type,
          shardKey: messageBody.shard_key,
        }),
      };
    }
    if (includePublicRoomDirectory && snapshot.public_room_directory_entry) {
      await applyPublicRoomDirectoryProjection(env, snapshot.public_room_directory_entry);
      nextProgress.public_room_directory_applied = true;
    }
    return {
      rebuilt_kind: 'room',
      room_id: messageBody.shard_key,
      search_rows: nextProgress.search_rows_applied,
      public_room_directory: nextProgress.public_room_directory_applied ? 1 : 0,
      chunks_completed: nextProgress.chunks_completed,
      rebuild_progress: nextProgress,
    };
  }

  if (messageBody.shard_type === 'UserDO') {
    const userDo = getDurableObjectStub(env.USER_DO, messageBody.shard_key, 'USER_DO');
    const snapshot = await userDo.getUserDirectoryEntry({
      user_id: messageBody.shard_key,
      updated_at: new Date().toISOString(),
    });
    if (!snapshot?.ok) {
      throw snapshot?.error ?? new Error(`UserDO getUserDirectoryEntry failed for ${messageBody.shard_key}`);
    }
    assertRebuildInvocationBudget({
      includeUserDirectory: target === 'user_directory' || target === 'all_derived',
      includeUserDirectoryClear: target === 'user_directory' || target === 'all_derived',
    });
    if (target === 'user_directory' || target === 'all_derived') {
      await clearDerivedTarget(env, {
        target: 'user_directory',
        userId: messageBody.shard_key,
      });
      if (snapshot.entry) {
        await applyUserDirectoryProjection(env, snapshot.entry);
      }
    }
    return {
      rebuilt_kind: 'user',
      user_id: messageBody.shard_key,
      user_directory: snapshot.entry ? 1 : 0,
    };
  }

  return {
    rebuilt_kind: 'noop',
    shard_type: messageBody.shard_type,
    shard_key: messageBody.shard_key,
  };
}

async function processQueueMessage({
  queueName,
  canonicalQueueName = queueName,
  messageBody,
  persistence,
  archiveBucket,
  asyncContext,
  env,
}) {
  const job = await persistence.getJob(messageBody.job_id);
  if (!job) {
    return {
      acknowledged: true,
      reason: 'job_missing',
    };
  }
  if (job.internal_state === 'cancel_requested') {
    await updateJobState({
      env,
      persistence,
      job,
      newState: 'canceled',
      now: new Date(),
      auditEventType: `${job.job_type}.canceled`,
      auditDetails: {
        queue_name: queueName,
        canceled_from_queue: true,
      },
      requestContext: asyncContext,
      checkpointState: {
        canceled_from_queue: queueName,
      },
      resultSummary: {
        canceled: true,
      },
    });
    return {
      acknowledged: true,
      reason: 'job_canceled',
    };
  }

  const runningState = canonicalQueueName === QUEUE_NAMES.export
    ? 'materializing'
    : canonicalQueueName === QUEUE_NAMES.restore
      ? 'validating'
      : canonicalQueueName === QUEUE_NAMES.repair
        ? 'scanning'
        : 'scanning';
  const terminalState = canonicalQueueName === QUEUE_NAMES.export ? 'finalized' : 'completed';
  const now = new Date();

  const checkpointShardType = messageBody.shard_type ?? scopeKindToShardType(messageBody.scope_kind);
  const checkpointShardKey = messageBody.shard_key ?? messageBody.scope_id ?? 'global';
  const existingCheckpoint = await persistence.getJobCheckpoint({
    job_id: job.job_id,
    shard_type: checkpointShardType,
    shard_key: checkpointShardKey,
  });
  if (!existingCheckpoint) {
    throw new Error(`Checkpoint ${job.job_id}/${checkpointShardType}/${checkpointShardKey} was not staged before queue delivery`);
  }
  if (canonicalQueueName === QUEUE_NAMES.export) {
    assertSupportedExportMaterializationTarget({
      shardType: checkpointShardType,
      shardKey: checkpointShardKey,
    });
  }
  if (existingCheckpoint?.checkpoint?.status === 'complete') {
    const checkpoints = await persistence.listJobCheckpoints(job.job_id);
    const completedUnits = checkpoints.filter((entry) => entry.checkpoint?.status === 'complete').length;
    const totalUnits = Math.max(job.progress_total_units ?? 1, 1);
    const isTerminal = completedUnits >= totalUnits;
    if (isTerminal && !['completed', 'finalized', 'failed', 'canceled'].includes(job.internal_state)) {
      if (canonicalQueueName === QUEUE_NAMES.export) {
        const keyRing = parseExportKeyRingFromEnv(loadWorkerRuntimeConfig('jobs-worker', env), env);
        await finalizeExportBundleManifest({
          persistence,
          archiveBucket,
          keyRing,
          job,
          now,
        });
      }
      await updateJobState({
        env,
        persistence,
        job,
        newState: terminalState,
        now,
        auditEventType: `${job.job_type}.${terminalState}`,
        auditDetails: {
          queue_name: queueName,
          replay_from_duplicate_message: true,
        },
        requestContext: asyncContext,
        checkpointState: {
          last_completed_checkpoint_id: existingCheckpoint.checkpoint.checkpoint_id ?? null,
          queue_name: queueName,
        },
        progress: {
          completed_units: completedUnits,
          total_units: totalUnits,
          unit_name: 'shard',
        },
        resultSummary: {
          terminal_state: mapInternalJobStateToPublicState(terminalState),
          last_checkpoint_id: existingCheckpoint.checkpoint.checkpoint_id ?? null,
        },
      });
    }
    return {
      acknowledged: true,
      reason: 'checkpoint_already_complete',
    };
  }
  if (canonicalQueueName === QUEUE_NAMES.rebuild && existingCheckpoint?.checkpoint?.status === 'queued') {
    const expectedChunkCursor = normalizeRebuildProgress(existingCheckpoint.checkpoint, messageBody).next_chunk_cursor;
    const messageChunkCursor = normalizeRebuildChunkCursor(messageBody.chunk_cursor);
    if (!sameRebuildChunkCursor(expectedChunkCursor, messageChunkCursor)) {
      if (
        existingCheckpoint.checkpoint.queue_delivery_state === 'staged'
        && existingCheckpoint.checkpoint.queued_payload != null
      ) {
        await sendQueueMessage(env.REBUILD_SHARD_QUEUE, existingCheckpoint.checkpoint.queued_payload);
        await persistence.upsertJobCheckpoint({
          job_id: job.job_id,
          shard_type: checkpointShardType,
          shard_key: checkpointShardKey,
          checkpoint: {
            ...existingCheckpoint.checkpoint,
            queue_delivery_state: 'published',
          },
          updated_at: now.toISOString(),
        });
        return {
          acknowledged: true,
          reason: 'rebuild_continuation_republished',
        };
      }
      return {
        acknowledged: true,
        reason: 'stale_rebuild_chunk',
      };
    }
  }
  if (existingCheckpoint.checkpoint?.status !== 'queued') {
    throw new Error(`Checkpoint ${job.job_id}/${checkpointShardType}/${checkpointShardKey} has unexpected status ${existingCheckpoint.checkpoint?.status ?? 'missing'}`);
  }
  if (TERMINAL_JOB_STATES.has(job.internal_state)) {
    return {
      acknowledged: true,
      reason: 'job_terminal',
    };
  }
  if (job.internal_state === 'pending') {
    throw new Error(`Job ${job.job_id} has not entered checkpointed state before queue delivery`);
  }
  if (job.internal_state !== runningState) {
    const runningJob = await updateJobState({
      env,
      persistence,
      job,
      newState: runningState,
      now,
      auditEventType: `${job.job_type}.${runningState}`,
      auditDetails: {
        queue_name: queueName,
      },
      requestContext: asyncContext,
    });
    job.started_at = runningJob.started_at;
    job.internal_state = runningJob.internal_state;
  }
  let checkpointId = makeId('checkpoint');
  let completedCheckpoint = {
    status: 'complete',
    checkpoint_id: checkpointId,
    queue_name: queueName,
    completed_at: now.toISOString(),
    shard_type: checkpointShardType,
    shard_key: checkpointShardKey,
    manifest_completeness_state: canonicalQueueName === QUEUE_NAMES.restore ? 'complete' : null,
    manifest_hash: null,
    manifest_r2_object_key: null,
    source_watermark: null,
    object_entries: [],
    apply_phase: messageBody.apply_phase ?? null,
  };
  let resultSummary = null;

  if (canonicalQueueName === QUEUE_NAMES.export) {
    const keyRing = parseExportKeyRingFromEnv(loadWorkerRuntimeConfig('jobs-worker', env), env);
    const artifact = await buildControlPlaneCheckpointArtifact({
      persistence,
      archiveBucket,
      keyRing,
      job,
      checkpointId,
      now,
    });
    completedCheckpoint = {
      ...completedCheckpoint,
      checkpoint_id: artifact.checkpoint_id,
      manifest_completeness_state: artifact.manifest.completeness_state,
      manifest_hash: artifact.manifest_hash,
      manifest_r2_object_key: artifact.manifest_r2_object_key,
      source_watermark: artifact.source_watermark,
      object_entries: artifact.object_entries,
      apply_phase: 'control-plane',
    };
  } else if (canonicalQueueName === QUEUE_NAMES.restore) {
    checkpointId = messageBody.checkpoint_id;
    const keyRing = parseExportKeyRingFromEnv(loadWorkerRuntimeConfig('jobs-worker', env), env);
    const restoreCheckpoints = await resolveRestoreCheckpointRefs({
      persistence,
      archiveBucket,
      keyRing,
      requestBody: {
        ...job.spec,
        scope: job.scope,
      },
    });
    const matchedCheckpoint = restoreCheckpoints.find((entry) => (
      entry.checkpoint_id === checkpointId
      && entry.shard_type === checkpointShardType
      && entry.shard_key === checkpointShardKey
    ));
    if (!matchedCheckpoint) {
      throw new Error(`Restore checkpoint ${checkpointId} for ${checkpointShardType}/${checkpointShardKey} is no longer resolvable from the source bundle`);
    }
    completedCheckpoint = {
      ...completedCheckpoint,
      checkpoint_id: checkpointId,
      manifest_completeness_state: matchedCheckpoint.checkpoint_manifest.completeness_state,
      manifest_hash: matchedCheckpoint.manifest_hash,
      manifest_r2_object_key: matchedCheckpoint.manifest_r2_object_key,
      source_watermark: matchedCheckpoint.checkpoint_manifest.source_watermark ?? null,
      object_entries: matchedCheckpoint.checkpoint_manifest.objects ?? [],
      apply_phase: matchedCheckpoint.apply_phase,
    };
  } else if (canonicalQueueName === QUEUE_NAMES.rebuild) {
    const rebuildResult = await executeRebuildAction({
      job,
      messageBody,
      env,
      existingCheckpoint,
    });
    if (rebuildResult?.continuationPayload) {
      await persistence.upsertJobCheckpoint({
        job_id: job.job_id,
        shard_type: checkpointShardType,
        shard_key: checkpointShardKey,
        checkpoint: rebuildResult.queuedCheckpoint,
        updated_at: now.toISOString(),
      });
      await sendQueueMessage(env.REBUILD_SHARD_QUEUE, rebuildResult.continuationPayload);
      await persistence.upsertJobCheckpoint({
        job_id: job.job_id,
        shard_type: checkpointShardType,
        shard_key: checkpointShardKey,
        checkpoint: {
          ...rebuildResult.queuedCheckpoint,
          queue_delivery_state: 'published',
        },
        updated_at: now.toISOString(),
      });
      const checkpoints = await persistence.listJobCheckpoints(job.job_id);
      const completedUnits = checkpoints.filter((entry) => entry.checkpoint?.status === 'complete').length;
      const totalUnits = Math.max(job.progress_total_units ?? 1, 1);
      await updateJobState({
        env,
        persistence,
        job,
        newState: 'checkpointed',
        now,
        auditEventType: `${job.job_type}.checkpointed`,
        auditDetails: {
          queue_name: queueName,
          shard_type: checkpointShardType,
          shard_key: checkpointShardKey,
          continuation_queued: true,
        },
        requestContext: asyncContext,
        checkpointState: {
          ...(job.checkpoint_state ?? {}),
          queue_name: queueName,
          ...rebuildResult.checkpointState,
        },
        progress: {
          completed_units: completedUnits,
          total_units: totalUnits,
          unit_name: 'shard',
        },
      });
      asyncContext.logger.info('jobs.queue.processed', {
        queue_name: queueName,
        job_id: job.job_id,
        shard_type: checkpointShardType,
        shard_key: checkpointShardKey,
        continuation_queued: true,
      });
      return {
        acknowledged: true,
        reason: 'rebuild_continuation_queued',
      };
    }
    resultSummary = {
      rebuild_target: messageBody.rebuild_target,
      ...rebuildResult,
    };
    completedCheckpoint = {
      ...completedCheckpoint,
      rebuild_progress: rebuildResult.rebuild_progress ?? null,
    };
  } else if (canonicalQueueName === QUEUE_NAMES.repair) {
    const repairSummary = await executeRepairAction({
      job,
      messageBody,
      env,
    });
    resultSummary = {
      repair_kind: messageBody.repair_kind,
      scope_kind: messageBody.scope_kind,
      scope_id: messageBody.scope_id ?? null,
      dry_run: job.spec?.dry_run === true,
      ...repairSummary,
    };
  }
  await persistence.upsertJobCheckpoint({
    job_id: job.job_id,
    shard_type: checkpointShardType,
    shard_key: checkpointShardKey,
    checkpoint: completedCheckpoint,
    updated_at: now.toISOString(),
  });
  const checkpoints = await persistence.listJobCheckpoints(job.job_id);
  const completedUnits = checkpoints.filter((entry) => entry.checkpoint?.status === 'complete').length;
  const totalUnits = Math.max(job.progress_total_units ?? 1, 1);
  const isTerminal = completedUnits >= totalUnits;
  if (canonicalQueueName === QUEUE_NAMES.export && isTerminal) {
    const keyRing = parseExportKeyRingFromEnv(loadWorkerRuntimeConfig('jobs-worker', env), env);
    await finalizeExportBundleManifest({
      persistence,
      archiveBucket,
      keyRing,
      job: await persistence.getJob(job.job_id) ?? job,
      now,
    });
  }
  await updateJobState({
    env,
    persistence,
    job,
    newState: isTerminal ? terminalState : 'checkpointed',
    now,
    auditEventType: `${job.job_type}.${isTerminal ? terminalState : 'checkpointed'}`,
    auditDetails: {
      queue_name: queueName,
      shard_type: checkpointShardType,
      shard_key: checkpointShardKey,
    },
    requestContext: asyncContext,
    checkpointState: {
      ...(job.checkpoint_state ?? {}),
      last_completed_checkpoint_id: checkpointId,
      queue_name: queueName,
      ...(canonicalQueueName === QUEUE_NAMES.rebuild
        ? buildRebuildCheckpointState(resultSummary?.rebuild_progress ?? {}, {
          shardType: checkpointShardType,
          shardKey: checkpointShardKey,
        })
        : {}),
    },
    progress: {
      completed_units: completedUnits,
      total_units: totalUnits,
      unit_name: 'shard',
    },
    resultSummary: isTerminal ? {
      terminal_state: mapInternalJobStateToPublicState(terminalState),
      last_checkpoint_id: checkpointId,
      ...(resultSummary == null ? {} : {
        [canonicalQueueName === QUEUE_NAMES.repair ? 'repair_summary' : (canonicalQueueName === QUEUE_NAMES.rebuild ? 'rebuild_summary' : 'queue_summary')]: resultSummary,
      }),
    } : null,
  });
  asyncContext.logger.info('jobs.queue.processed', {
    queue_name: queueName,
    job_id: job.job_id,
    shard_type: checkpointShardType,
    shard_key: checkpointShardKey,
  });
  return {
    acknowledged: true,
    reason: 'processed',
  };
}

export function createJobsWorkerFetchHandler() {
  return async function jobsWorkerFetch(request, env) {
    const info = parseInternalRoute(new URL(request.url).pathname);
    if (!info) {
      return internalErrorResponse({
        status: 404,
        code: 'job_conflict',
        message: 'jobs-worker runtime control-plane endpoint not found',
      });
    }
    const config = loadWorkerRuntimeConfig('jobs-worker', env);
    const persistence = getControlPlanePersistence(env);
    await persistence.ensureSchema();
    await ensureControlPlaneShardRegistered({
      persistence,
      now: new Date().toISOString(),
    });
    let spec;
    try {
      spec = await request.json();
    } catch (error) {
      return internalErrorResponse({
        status: 400,
        code: 'job_conflict',
        message: `Invalid internal job start payload: ${error.message}`,
      });
    }
    if (spec?.schema_version !== CONTROL_PLANE_SCHEMA_VERSION) {
      return internalErrorResponse({
        status: 422,
        code: 'unsupported_schema_version',
        message: `Unsupported schema_version ${spec?.schema_version ?? 'missing'}`,
      });
    }
    const job = await persistence.getJob(spec.job_id);
    if (!job) {
      return internalErrorResponse({
        status: 404,
        code: 'job_conflict',
        message: `Job ${spec.job_id} not found`,
      });
    }
    if (job.job_type !== expectedJobTypeForKind(info.kind)) {
      return internalErrorResponse({
        status: 409,
        code: 'job_conflict',
        message: `Job ${job.job_id} type ${job.job_type} does not match ${info.kind}`,
      });
    }
    const stagedQueueDelivery = job.checkpoint_state?.queue_delivery_state === 'staged';
    if (job.internal_state === 'failed' && stagedQueueDelivery) {
      await persistence.updateJob({
        ...job,
        internal_state: 'pending',
        completed_at: null,
        last_error: null,
        result_summary: null,
      });
    } else if (job.internal_state !== 'pending') {
      return jsonResponse(buildJobHandleFromRecord(job));
    }
    try {
      await fanOutJobTasks({
        env,
        persistence,
        job,
        kind: info.kind,
      });
    } catch (error) {
      return internalErrorResponse(classifyFanOutError(error, {
        job,
        kind: info.kind,
      }));
    }
    const updatedJob = await persistence.getJob(job.job_id);
    return jsonResponse(buildJobHandleFromRecord(updatedJob ?? job), 202);
  };
}

export function createJobsWorkerQueueHandler() {
  return async function jobsWorkerQueue(batch, env) {
    const config = loadWorkerRuntimeConfig('jobs-worker', env);
    const queueBindingNames = resolveWorkerResourceBindingNames(env).queues;
    const persistence = getControlPlanePersistence(env);
    await persistence.ensureSchema();
    for (const message of batch.messages) {
      const rawJobId = typeof message?.body?.job_id === 'string' && message.body.job_id.trim().length > 0
        ? message.body.job_id.trim()
        : null;
      const asyncContext = createAsyncTaskContext({
        workerName: 'jobs-worker',
        workerVersion: config.text.WORKER_VERSION_ID,
        routeFamily: `queue:${batch.queue}`,
        jobId: rawJobId,
      });
      try {
        const canonicalQueueName = resolveCanonicalControlPlaneQueueName(batch.queue, queueBindingNames);
        const normalizedBody = normalizeQueuePayload(batch.queue, message.body, queueBindingNames);
        const result = await processQueueMessage({
          queueName: batch.queue,
          canonicalQueueName,
          messageBody: normalizedBody,
          persistence,
          archiveBucket: env.MATRIX_ARCHIVE_BUCKET,
          asyncContext,
          env,
        });
        if (typeof message.ack === 'function' && result.acknowledged) {
          message.ack();
        }
      } catch (error) {
        asyncContext.logger.error('jobs.queue.failed', {
          queue_name: batch.queue,
          error_message: error.message,
          error_code: error.code ?? null,
          retryable: error.retryable ?? null,
        });
        const retryable = error.retryable ?? !(error instanceof TypeError || error instanceof RangeError);
        if (!retryable) {
          await failJobForQueueMessage({
            env,
            persistence,
            queueName: batch.queue,
            message,
            asyncContext,
            error,
          });
        }
        if (typeof message.retry === 'function' && retryable) {
          message.retry();
        } else if (typeof message.ack === 'function') {
          message.ack();
        }
      }
    }
  };
}
