import {
  ROUTE_TEMPLATES,
  buildJobStatusResponseFromRecords,
  normalizeAppserviceConfigRequest,
  normalizeExportJobRequest,
  normalizeJobCancelRequest,
  normalizeRebuildJobRequest,
  normalizeRepairJobRequest,
  normalizeRestoreJobRequest,
  mapInternalJobStateToPublicState,
} from './schemas.mjs';
import {
  authenticateOperatorIdentity,
  authorizeOperatorRequest,
  buildRequestFingerprint,
  createAppserviceMutation,
  finalizeReservedWrite,
  jsonResponse,
  makeOpsContext,
  opsErrorResponse,
  parseJobsQueryFromUrl,
  queryJobs,
  readJsonBody,
  readOptionalJsonBody,
  reserveIdempotentWrite,
  responseFromEnvelope,
  startControlPlaneJob,
} from './services.mjs';

function buildHealthResponse(config, deploymentRecord, dependencies, status) {
  return {
    service: 'ops-worker',
    status,
    observed_at: new Date().toISOString(),
    worker_version_id: config.text.WORKER_VERSION_ID,
    deployment_id: config.text.DEPLOYMENT_ID,
    compatibility_date: config.compatibilityDate,
    release_profile: config.releaseProfile,
    cpu_limit_class: deploymentRecord.cpu_limit_class,
    startup_time_ms: deploymentRecord.startup_time_ms,
    deployment_composition: deploymentRecord.deployment_composition,
    feature_gates: deploymentRecord.feature_gates,
    secret_versions: deploymentRecord.secret_versions,
    dependencies,
  };
}

function routeInfo(url) {
  const pathname = url.pathname;
  if (pathname === ROUTE_TEMPLATES.healthz) {
    return { kind: 'healthz' };
  }
  if (pathname === ROUTE_TEMPLATES.readyz) {
    return { kind: 'readyz' };
  }
  if (pathname === ROUTE_TEMPLATES.exports) {
    return { kind: 'job-create', routeTemplate: ROUTE_TEMPLATES.exports, requiredScope: 'ops.export.write' };
  }
  if (pathname === ROUTE_TEMPLATES.restores) {
    return { kind: 'job-create', routeTemplate: ROUTE_TEMPLATES.restores, requiredScope: 'ops.restore.write' };
  }
  if (pathname === ROUTE_TEMPLATES.rebuilds) {
    return { kind: 'job-create', routeTemplate: ROUTE_TEMPLATES.rebuilds, requiredScope: 'ops.rebuild.write' };
  }
  if (pathname === ROUTE_TEMPLATES.repairs) {
    return { kind: 'job-create', routeTemplate: ROUTE_TEMPLATES.repairs, requiredScope: 'ops.repair.write' };
  }
  if (pathname === ROUTE_TEMPLATES.jobsList) {
    return { kind: 'jobs-list', routeTemplate: ROUTE_TEMPLATES.jobsList, requiredScope: 'ops.read' };
  }
  const cancelMatch = pathname.match(/^\/_ops\/v1\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch) {
    return { kind: 'jobs-cancel', routeTemplate: ROUTE_TEMPLATES.jobsCancel, jobId: cancelMatch[1] };
  }
  const jobMatch = pathname.match(/^\/_ops\/v1\/jobs\/([^/]+)$/);
  if (jobMatch) {
    return { kind: 'jobs-item', routeTemplate: ROUTE_TEMPLATES.jobsItem, jobId: jobMatch[1], requiredScope: 'ops.read' };
  }
  if (pathname === ROUTE_TEMPLATES.appservicesList) {
    return { kind: 'appservices-list', routeTemplate: ROUTE_TEMPLATES.appservicesList };
  }
  const appserviceMatch = pathname.match(/^\/_ops\/v1\/appservices\/([^/]+)$/);
  if (appserviceMatch) {
    return {
      kind: 'appservices-item',
      routeTemplate: ROUTE_TEMPLATES.appservicesItem,
      appserviceId: appserviceMatch[1],
    };
  }
  return null;
}

async function buildHealthDependencies(env, persistence) {
  const dependencies = [];
  dependencies.push({
    name: 'control-d1',
    kind: 'd1',
    status: env.MATRIX_CONTROL_D1 ? 'ok' : 'fail',
    detail: env.MATRIX_CONTROL_D1 ? 'binding present' : 'binding missing',
  });
  dependencies.push({
    name: 'archive-bucket',
    kind: 'r2',
    status: env.MATRIX_ARCHIVE_BUCKET ? 'ok' : 'degraded',
    detail: env.MATRIX_ARCHIVE_BUCKET ? 'binding present' : 'binding missing',
  });
  dependencies.push({
    name: 'jobs-worker',
    kind: 'service-binding',
    status: env.JOBS_WORKER ? 'ok' : 'fail',
    detail: env.JOBS_WORKER ? 'binding present' : 'binding missing',
  });
  try {
    const schemaReady = await persistence.isSchemaReady();
    dependencies.push({
      name: 'control-plane-schema',
      kind: 'd1-schema',
      status: schemaReady ? 'ok' : 'fail',
      detail: schemaReady ? 'schema ready' : 'schema missing or incomplete',
    });
  } catch (error) {
    dependencies.push({
      name: 'control-plane-schema',
      kind: 'd1-schema',
      status: 'fail',
      detail: error.message,
    });
  }
  return dependencies;
}

async function handleAppserviceList(request, env, config, requestContext, persistence) {
  const requiredScope = request.method === 'GET' ? 'ops.read' : 'ops.appservice.write';
  const operator = await authenticateOperatorIdentity({
    request,
    env,
    config,
    requiredScope,
  });
  if (request.method === 'GET') {
    authorizeOperatorRequest({
      operator,
      targetScope: {
        scope_kind: 'global',
        scope_id: null,
      },
    });
    const appservices = await persistence.listAppserviceConfigs({ limit: 100 });
    return jsonResponse({
      appservice: null,
      appservices: appservices.map((entry) => entry.descriptor),
      next_cursor: null,
    });
  }
  if (request.method !== 'POST') {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'not_found',
      message: 'Unsupported appservice collection method',
    });
  }
  const body = normalizeAppserviceConfigRequest(await readJsonBody(request));
  if (!body.appservice) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'validation_failed',
      message: 'appservice is required for POST /_ops/v1/appservices',
    });
  }
  const scope = {
    scope_kind: 'appservice_id',
    scope_id: body.appservice.appservice_id,
  };
  authorizeOperatorRequest({
    operator,
    targetScope: scope,
  });
  await persistence.ensureSchema();
  return createAppserviceMutation({
    request,
    routeTemplate: ROUTE_TEMPLATES.appservicesList,
    operator,
    requestContext,
    persistence,
    scope,
    body,
    mutate: async () => {
      const now = new Date().toISOString();
      await persistence.upsertAppserviceConfig({
        appservice_id: body.appservice.appservice_id,
        descriptor: body.appservice,
        created_at: now,
        updated_at: now,
        disabled_at: body.appservice.disabled_at,
      });
      return {
        appservice: body.appservice,
        appservices: null,
        next_cursor: null,
      };
    },
  });
}

async function handleAppserviceItem(request, env, config, requestContext, persistence, appserviceId) {
  const scope = {
    scope_kind: 'appservice_id',
    scope_id: appserviceId,
  };
  const requiredScope = request.method === 'GET' ? 'ops.read' : 'ops.appservice.write';
  const operator = await authenticateOperatorIdentity({
    request,
    env,
    config,
    requiredScope,
  });
  authorizeOperatorRequest({
    operator,
    targetScope: scope,
  });
  if (request.method === 'GET') {
    const configRow = await persistence.getAppserviceConfig(appserviceId);
    if (!configRow) {
      return opsErrorResponse({
        requestId: requestContext.requestId,
        code: 'not_found',
        message: `Appservice ${appserviceId} was not found`,
      });
    }
    return jsonResponse({
      appservice: configRow.descriptor,
      appservices: null,
      next_cursor: null,
    });
  }
  if (request.method === 'DELETE') {
    const body = normalizeAppserviceConfigRequest(await readOptionalJsonBody(request));
    if (body.appservice !== null) {
      return opsErrorResponse({
        requestId: requestContext.requestId,
        code: 'validation_failed',
        message: 'appservice must be null for DELETE /_ops/v1/appservices/{appserviceId}',
      });
    }
    return createAppserviceMutation({
      request,
      routeTemplate: ROUTE_TEMPLATES.appservicesItem,
      operator,
      requestContext,
      persistence,
      scope,
      body,
      mutate: async () => {
        await persistence.deleteAppserviceConfig(appserviceId);
        return {
          appservice: null,
          appservices: null,
          next_cursor: null,
        };
      },
    });
  }
  if (request.method !== 'PUT') {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'not_found',
      message: 'Unsupported appservice item method',
    });
  }
  const body = normalizeAppserviceConfigRequest(await readJsonBody(request));
  if (!body.appservice || body.appservice.appservice_id !== appserviceId) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'validation_failed',
      message: 'appservice.appservice_id must match the URL path',
    });
  }
  return createAppserviceMutation({
    request,
    routeTemplate: ROUTE_TEMPLATES.appservicesItem,
    operator,
    requestContext,
    persistence,
    scope,
    body,
    mutate: async () => {
      const existing = await persistence.getAppserviceConfig(appserviceId);
      const createdAt = existing?.created_at ?? new Date().toISOString();
      await persistence.upsertAppserviceConfig({
        appservice_id: appserviceId,
        descriptor: body.appservice,
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        disabled_at: body.appservice.disabled_at,
      });
      return {
        appservice: body.appservice,
        appservices: null,
        next_cursor: null,
      };
    },
  });
}

export function createOpsWorkerFetchHandler() {
  return async function opsWorkerFetch(request, env) {
    const {
      config,
      deploymentRecord,
      requestContext,
      persistence,
    } = makeOpsContext('ops-worker', request, env, {
      routeFamily: 'ops-control-plane',
    });

    try {
      const info = routeInfo(new URL(request.url));
      if (!info) {
        return opsErrorResponse({
          requestId: requestContext.requestId,
          code: 'not_found',
          message: 'Unsupported control-plane route',
        });
      }

      if (info.kind === 'healthz' || info.kind === 'readyz') {
        const operator = await authenticateOperatorIdentity({
          request,
          env,
          config,
          requiredScope: 'ops.read',
        });
        if (request.method !== 'GET') {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: `Unsupported ${info.kind} method`,
          });
        }
        authorizeOperatorRequest({
          operator,
          targetScope: {
            scope_kind: 'global',
            scope_id: null,
          },
        });
        const dependencies = await buildHealthDependencies(env, persistence);
        const status = dependencies.some((entry) => entry.status === 'fail')
          ? 'fail'
          : dependencies.some((entry) => entry.status === 'degraded')
            ? 'degraded'
            : 'ok';
        return jsonResponse(buildHealthResponse(config, deploymentRecord, dependencies, status), status === 'fail' ? 503 : 200);
      }

      if (info.kind === 'job-create') {
        const operator = await authenticateOperatorIdentity({
          request,
          env,
          config,
          requiredScope: info.requiredScope,
        });
        if (request.method !== 'POST') {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: 'Unsupported job create method',
          });
        }
        const body = await readJsonBody(request);
        const parsed = info.routeTemplate === ROUTE_TEMPLATES.exports
          ? normalizeExportJobRequest(body)
          : info.routeTemplate === ROUTE_TEMPLATES.restores
            ? normalizeRestoreJobRequest(body)
            : info.routeTemplate === ROUTE_TEMPLATES.rebuilds
              ? normalizeRebuildJobRequest(body)
              : normalizeRepairJobRequest(body);
        authorizeOperatorRequest({
          operator,
          targetScope: parsed.scope,
        });
        return await startControlPlaneJob({
          env,
          config,
          persistence,
          requestContext,
          operator,
          routeTemplate: info.routeTemplate,
          request,
          requestBody: parsed,
        });
      }

      if (info.kind === 'jobs-list') {
        const operator = await authenticateOperatorIdentity({
          request,
          env,
          config,
          requiredScope: info.requiredScope,
        });
        if (request.method !== 'GET') {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: 'Unsupported jobs list method',
          });
        }
        const query = parseJobsQueryFromUrl(new URL(request.url));
        authorizeOperatorRequest({
          operator,
          targetScope: query.scope ?? {
            scope_kind: 'global',
            scope_id: null,
          },
        });
        const payload = await queryJobs({
          persistence,
          query,
        });
        return jsonResponse(payload);
      }

      if (info.kind === 'jobs-item') {
        const operator = await authenticateOperatorIdentity({
          request,
          env,
          config,
          requiredScope: info.requiredScope,
        });
        if (request.method !== 'GET') {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: 'Unsupported job status method',
          });
        }
        const job = await persistence.getJob(info.jobId);
        if (!job) {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: `Job ${info.jobId} was not found`,
          });
        }
        authorizeOperatorRequest({
          operator,
          targetScope: job.scope,
        });
        return jsonResponse(buildJobStatusResponseFromRecords({ job }));
      }

      if (info.kind === 'jobs-cancel') {
        const operator = await authenticateOperatorIdentity({
          request,
          env,
          config,
        });
        if (request.method !== 'POST') {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: 'Unsupported job cancel method',
          });
        }
        const existingJob = await persistence.getJob(info.jobId);
        if (!existingJob) {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'not_found',
            message: `Job ${info.jobId} was not found`,
          });
        }
        const requiredScope = existingJob.job_type === 'export'
          ? 'ops.export.write'
          : existingJob.job_type === 'restore'
            ? 'ops.restore.write'
          : existingJob.job_type === 'rebuild'
              ? 'ops.rebuild.write'
              : 'ops.repair.write';
        authorizeOperatorRequest({
          operator,
          requiredScope,
          targetScope: existingJob.scope,
        });
        const cancelBody = await readJsonBody(request);
        const normalized = normalizeJobCancelRequest(cancelBody);
        const idempotencyKey = request.headers.get('Idempotency-Key');
        if (!idempotencyKey) {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'validation_failed',
            message: 'Idempotency-Key header is required for cancel requests',
          });
        }
        if (operator.require_ticket && !normalized.ticket_id) {
          return opsErrorResponse({
            requestId: requestContext.requestId,
            code: 'validation_failed',
            message: 'ticket_id is required by the matched operator policy',
          });
        }
        const requestFingerprint = buildRequestFingerprint({
          request,
          routeTemplate: ROUTE_TEMPLATES.jobsCancel,
          principalId: operator.principal_id,
          semanticQuery: {
            job_id: info.jobId,
          },
          body: normalized,
        });
        const scope = existingJob.scope;
        const dedupeKey = `job_id:${existingJob.job_id}`;
        const affectedObjects = [{ kind: 'job', id: existingJob.job_id }];
        const currentPublicState = mapInternalJobStateToPublicState(existingJob.internal_state);
        const acceptedEnvelope = {
          kind: 'success',
          status: 202,
          body: {
            job_id: existingJob.job_id,
            previous_state: currentPublicState,
            new_state: 'cancel_requested',
            accepted_at: new Date().toISOString(),
          },
        };
        const reservation = await reserveIdempotentWrite({
          persistence,
          operator,
          scope,
          idempotencyKey,
          requestFingerprint,
          initialEnvelope: acceptedEnvelope,
          auditEventType: 'job.cancel.accepted',
          requestContext,
          jobRecord: null,
          dedupeKey,
          affectedObjects,
        });
        if (reservation.outcome === 'conflict' || reservation.outcome === 'replay') {
          return responseFromEnvelope(reservation.envelope);
        }
        const allowedStates = normalized.if_in_states ?? null;
        if (allowedStates && !allowedStates.includes(currentPublicState)) {
          const preconditionEnvelope = {
            kind: 'error',
            status: 409,
            body: {
              code: 'precondition_failed',
              message: `Job ${info.jobId} is currently ${currentPublicState}`,
              request_id: requestContext.requestId,
              retryable: false,
              details: {
                previous_state: currentPublicState,
              },
            },
          };
          await finalizeReservedWrite({
            persistence,
            operator,
            scope,
            idempotencyKey,
            envelope: preconditionEnvelope,
            resultCode: 'precondition_failed',
            requestContext,
            requestFingerprint,
            jobId: existingJob.job_id,
            eventType: 'job.cancel.precondition_failed',
            dedupeKey,
            affectedObjects,
            details: {
              previous_state: currentPublicState,
            },
          });
          return responseFromEnvelope(preconditionEnvelope);
        }
        const newInternalState = ['pending', 'checkpointed'].includes(existingJob.internal_state)
          ? 'canceled'
          : 'cancel_requested';
        await persistence.updateJob({
          ...existingJob,
          scope: existingJob.scope,
          internal_state: newInternalState,
          canceled_at: newInternalState === 'canceled' ? new Date().toISOString() : existingJob.canceled_at,
          cancel_reason: normalized.reason,
        });
        const previousState = currentPublicState;
        const newState = mapInternalJobStateToPublicState(newInternalState);
        const successEnvelope = {
          kind: 'success',
          status: 202,
          body: {
            job_id: existingJob.job_id,
            previous_state: previousState,
            new_state: newState,
            accepted_at: new Date().toISOString(),
          },
        };
        await finalizeReservedWrite({
          persistence,
          operator,
          scope,
          idempotencyKey,
          envelope: successEnvelope,
          resultCode: newInternalState,
          requestContext,
          requestFingerprint,
          jobId: existingJob.job_id,
          eventType: 'job.cancel.succeeded',
          dedupeKey,
          affectedObjects,
          details: {
            previous_state: previousState,
            new_state: newState,
          },
        });
        return responseFromEnvelope(successEnvelope);
      }

      if (info.kind === 'appservices-list') {
        return await handleAppserviceList(request, env, config, requestContext, persistence);
      }

      if (info.kind === 'appservices-item') {
        return await handleAppserviceItem(request, env, config, requestContext, persistence, info.appserviceId);
      }

      return opsErrorResponse({
        requestId: requestContext.requestId,
        code: 'not_found',
        message: 'Unsupported control-plane route',
      });
    } catch (error) {
      const code = error.code === 'unauthorized'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
            ? 'validation_failed'
            : 'internal';
      requestContext.logger.error('ops.request.failed', {
        error_message: error.message,
        error_code: code,
      });
      return opsErrorResponse({
        requestId: requestContext.requestId,
        code,
        message: error.message,
        retryable: code === 'internal',
      });
    }
  };
}
