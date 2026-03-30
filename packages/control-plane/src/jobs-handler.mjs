import { createInternalErrorEnvelope } from '../../contracts/src/index.mjs';
import { createAsyncTaskContext, loadWorkerRuntimeConfig, makeId } from '../../runtime-core/src/index.mjs';
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
} from './schemas.mjs';
import {
  buildArchiveObjectKey,
  ensureControlPlaneShardRegistered,
  getControlPlanePersistence,
  jsonResponse,
  putArchiveJsonObject,
  sendQueueMessage,
  updateJobState,
} from './services.mjs';

const TERMINAL_JOB_STATES = new Set(['completed', 'finalized', 'failed', 'canceled']);

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

function classifyFanOutError(error, { job, kind }) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Registry snapshot') || message.includes('contains no shard rows')) {
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

async function stageQueuedPayloads({
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

async function fanOutJobTasks({ env, persistence, job, kind }) {
  const now = new Date();
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
    payloads = rows.map((row) => buildRebuildShardJob({
      jobId: job.job_id,
      rebuildTarget: job.spec.rebuild_target,
      shardType: row.shard_type,
      shardKey: row.shard_key,
      attempt: 0,
    }));
  } else if (kind === 'start-restore') {
    payloads = [buildRestoreShardJob({
      jobId: job.job_id,
      checkpointId: job.spec.source_bundle_hash,
      shardType: 'control-plane',
      shardKey: 'ops-core',
      applyPhase: 'control-plane',
      attempt: 0,
    })];
  } else {
    payloads = [buildRepairShardJob({
      jobId: job.job_id,
      repairKind: job.spec.repair_kind,
      scope: job.scope,
      attempt: 0,
    })];
  }
  await stageQueuedPayloads({
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
  return payloads.length;
}

async function processQueueMessage({
  queueName,
  messageBody,
  persistence,
  archiveBucket,
  asyncContext,
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

  const runningState = queueName === QUEUE_NAMES.export
    ? 'materializing'
    : queueName === QUEUE_NAMES.restore
      ? 'validating'
      : queueName === QUEUE_NAMES.repair
        ? 'scanning'
        : 'scanning';
  const terminalState = queueName === QUEUE_NAMES.export ? 'finalized' : 'completed';
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
  if (existingCheckpoint?.checkpoint?.status === 'complete') {
    const checkpoints = await persistence.listJobCheckpoints(job.job_id);
    const completedUnits = checkpoints.filter((entry) => entry.checkpoint?.status === 'complete').length;
    const totalUnits = Math.max(job.progress_total_units ?? 1, 1);
    const isTerminal = completedUnits >= totalUnits;
    if (isTerminal && !['completed', 'finalized', 'failed', 'canceled'].includes(job.internal_state)) {
      await updateJobState({
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
    await updateJobState({
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
  }
  const checkpointId = makeId('checkpoint');
  const placeholderManifest = {
    manifest_version: CONTROL_PLANE_SCHEMA_VERSION,
    checkpoint_id: checkpointId,
    job_id: job.job_id,
    shard_type: checkpointShardType,
    shard_key: checkpointShardKey,
    queue_name: queueName,
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    hash_algorithm: 'sha256',
    signature_algorithm: 'none',
    signing_key_version: null,
    encryption_key_version: null,
    source_watermark: {
      placeholder: true,
      queue_name: queueName,
    },
    objects: [],
    completeness_state: 'incomplete',
  };
  let objectKey = null;
  if (archiveBucket) {
    objectKey = buildArchiveObjectKey({
      exportEpochOrImportBatch: job.export_epoch ?? job.job_id,
      artifactKind: 'checkpoint-manifest',
      scope: job.scope,
      objectId: checkpointId,
    });
    await putArchiveJsonObject(archiveBucket, objectKey, placeholderManifest);
  }
  await persistence.upsertJobCheckpoint({
    job_id: job.job_id,
    shard_type: checkpointShardType,
    shard_key: checkpointShardKey,
    checkpoint: {
      status: 'complete',
      checkpoint_id: checkpointId,
      queue_name: queueName,
      completed_at: now.toISOString(),
      manifest_completeness_state: placeholderManifest.completeness_state,
      r2_object_key: objectKey,
    },
    updated_at: now.toISOString(),
  });
  const checkpoints = await persistence.listJobCheckpoints(job.job_id);
  const completedUnits = checkpoints.filter((entry) => entry.checkpoint?.status === 'complete').length;
  const totalUnits = Math.max(job.progress_total_units ?? 1, 1);
  const isTerminal = completedUnits >= totalUnits;
  await updateJobState({
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
      last_completed_checkpoint_id: checkpointId,
      queue_name: queueName,
    },
    progress: {
      completed_units: completedUnits,
      total_units: totalUnits,
      unit_name: 'shard',
    },
    resultSummary: isTerminal ? {
      terminal_state: mapInternalJobStateToPublicState(terminalState),
      last_checkpoint_id: checkpointId,
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
    if (job.internal_state !== 'pending') {
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
    const persistence = getControlPlanePersistence(env);
    await persistence.ensureSchema();
    const asyncContext = createAsyncTaskContext({
      workerName: 'jobs-worker',
      workerVersion: config.text.WORKER_VERSION_ID,
      routeFamily: `queue:${batch.queue}`,
      jobId: batch.messages[0]?.body?.job_id ?? null,
    });
    for (const message of batch.messages) {
      try {
        const normalizedBody = normalizeQueuePayload(batch.queue, message.body);
        const result = await processQueueMessage({
          queueName: batch.queue,
          messageBody: normalizedBody,
          persistence,
          archiveBucket: env.MATRIX_ARCHIVE_BUCKET,
          asyncContext,
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
        if (error.code === 'unsupported_schema_version') {
          const jobId = typeof message?.body?.job_id === 'string' ? message.body.job_id.trim() : '';
          if (jobId) {
            const job = await persistence.getJob(jobId);
            if (job && !['completed', 'finalized', 'failed', 'canceled'].includes(job.internal_state)) {
              await updateJobState({
                persistence,
                job,
                newState: 'failed',
                now: new Date(),
                lastError: buildOpsErrorJson({
                  code: 'internal',
                  message: error.message,
                  requestId: asyncContext.causationId ?? jobId,
                  retryable: false,
                  details: {
                    queue_name: batch.queue,
                    schema_version: message?.body?.schema_version ?? null,
                    expected_schema_version: CONTROL_PLANE_SCHEMA_VERSION,
                  },
                }),
                auditEventType: `${job.job_type}.failed`,
                auditDetails: {
                  queue_name: batch.queue,
                  reason: 'unsupported_schema_version',
                  schema_version: message?.body?.schema_version ?? null,
                },
              });
            }
          }
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
