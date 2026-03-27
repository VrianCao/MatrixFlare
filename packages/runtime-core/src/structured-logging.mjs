import { randomUUID } from 'node:crypto';

function omitUndefinedEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function defaultLogSink(record) {
  console.log(JSON.stringify(record));
}

export function createStructuredLogger({
  workerName,
  workerVersion,
  routeFamily = 'unrouted',
  baseFields = {},
  sink = defaultLogSink,
  now = () => new Date(),
}) {
  if (typeof workerName !== 'string' || workerName.length === 0) {
    throw new TypeError('workerName must be a non-empty string');
  }
  if (typeof workerVersion !== 'string' || workerVersion.length === 0) {
    throw new TypeError('workerVersion must be a non-empty string');
  }
  if (typeof routeFamily !== 'string' || routeFamily.length === 0) {
    throw new TypeError('routeFamily must be a non-empty string');
  }
  if (typeof sink !== 'function') {
    throw new TypeError('sink must be a function');
  }

  function emit(severity, event, fields = {}) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('event must be a non-empty string');
    }

    const record = omitUndefinedEntries({
      timestamp: now().toISOString(),
      severity,
      event,
      worker_name: workerName,
      worker_version: workerVersion,
      route_family: routeFamily,
      ...baseFields,
      ...fields,
    });
    sink(record);
    return record;
  }

  return Object.freeze({
    emit,
    debug(event, fields) {
      return emit('debug', event, fields);
    },
    info(event, fields) {
      return emit('info', event, fields);
    },
    warn(event, fields) {
      return emit('warn', event, fields);
    },
    error(event, fields) {
      return emit('error', event, fields);
    },
    child(extraFields = {}) {
      return createStructuredLogger({
        workerName,
        workerVersion,
        routeFamily,
        baseFields: { ...baseFields, ...extraFields },
        sink,
        now,
      });
    },
  });
}

export function createRequestContext({
  workerName,
  workerVersion,
  request,
  routeFamily = 'unrouted',
  sink,
  now,
}) {
  const requestId = request.headers.get('x-request-id')?.trim() || `req_${randomUUID()}`;
  const causationId = request.headers.get('x-causation-id')?.trim() || requestId;
  const jobId = request.headers.get('x-job-id')?.trim() || null;
  const txnId = request.headers.get('x-matrix-txn-id')?.trim() || null;
  const cfRay = request.headers.get('cf-ray')?.trim() || null;

  const logger = createStructuredLogger({
    workerName,
    workerVersion,
    routeFamily,
    sink,
    now,
    baseFields: omitUndefinedEntries({
      request_id: requestId,
      causation_id: causationId,
      job_id: jobId ?? undefined,
      txn_id: txnId ?? undefined,
      cf_ray: cfRay ?? undefined,
    }),
  });

  return Object.freeze({
    requestId,
    causationId,
    jobId,
    txnId,
    cfRay,
    logger,
  });
}

export function createAsyncTaskContext({
  workerName,
  workerVersion,
  routeFamily = 'async',
  jobId = null,
  causationId = null,
  txnId = null,
  sink,
  now,
}) {
  const resolvedJobId = jobId ?? `job_${randomUUID()}`;
  const resolvedCausationId = causationId ?? resolvedJobId;
  const logger = createStructuredLogger({
    workerName,
    workerVersion,
    routeFamily,
    sink,
    now,
    baseFields: {
      job_id: resolvedJobId,
      causation_id: resolvedCausationId,
      ...(txnId ? { txn_id: txnId } : {}),
    },
  });

  return Object.freeze({
    jobId: resolvedJobId,
    causationId: resolvedCausationId,
    txnId,
    logger,
  });
}
