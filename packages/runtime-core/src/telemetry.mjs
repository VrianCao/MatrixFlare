import { performance } from 'node:perf_hooks';

const TELEMETRY_BINDINGS_INSTRUMENTED = Symbol.for('matrix.telemetry.bindings.instrumented');

function stableDimensions(dimensions = {}) {
  return Object.fromEntries(
    Object.entries(dimensions)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function metricKey(name, dimensions) {
  return JSON.stringify([name, stableDimensions(dimensions)]);
}

function cloneMetricEntry(entry) {
  return {
    name: entry.name,
    kind: entry.kind,
    dimensions: { ...entry.dimensions },
    value: entry.value,
    count: entry.count,
    min: entry.min,
    max: entry.max,
    sum: entry.sum,
    last_recorded_at: entry.last_recorded_at,
  };
}

function makeMetricEntry({ name, kind, dimensions, nowIso }) {
  return {
    name,
    kind,
    dimensions: stableDimensions(dimensions),
    value: kind === 'gauge' ? 0 : null,
    count: 0,
    min: null,
    max: null,
    sum: 0,
    last_recorded_at: nowIso,
  };
}

function updateMetricEntry(entry, kind, value, nowIso) {
  if (kind === 'counter') {
    entry.value = (entry.value ?? 0) + value;
  } else if (kind === 'gauge') {
    entry.value = value;
  } else if (kind === 'histogram') {
    entry.count += 1;
    entry.sum += value;
    entry.min = entry.min == null ? value : Math.min(entry.min, value);
    entry.max = entry.max == null ? value : Math.max(entry.max, value);
    entry.value = value;
  } else {
    throw new RangeError(`Unsupported metric kind: ${kind}`);
  }

  if (kind !== 'histogram') {
    entry.count += 1;
    entry.sum += value;
    entry.min = entry.min == null ? value : Math.min(entry.min, value);
    entry.max = entry.max == null ? value : Math.max(entry.max, value);
  }
  entry.last_recorded_at = nowIso;
  return entry;
}

function ensureMetricMap(env) {
  const telemetry = getRuntimeTelemetry(env);
  return telemetry.metrics;
}

function classifySqlOperation(sql) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return 'unknown';
  }
  const match = sql.trim().match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : 'unknown';
}

function measureAsync(env, {
  metricName,
  dimensions,
  onFinish = null,
}) {
  const startedAt = performance.now();
  return async (operation) => {
    try {
      const result = await operation();
      const durationMs = performance.now() - startedAt;
      observeMetric(env, metricName, durationMs, dimensions);
      onFinish?.({
        ok: true,
        durationMs,
      });
      return result;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      observeMetric(env, metricName, durationMs, dimensions);
      onFinish?.({
        ok: false,
        durationMs,
        error,
      });
      throw error;
    }
  };
}

function bindProxyFunction(target, property, wrapperFactory) {
  const original = target[property];
  if (typeof original !== 'function') {
    return original;
  }
  return wrapperFactory(original.bind(target));
}

function wrapQueueBinding(env, binding, queueName) {
  if (!binding || binding[TELEMETRY_BINDINGS_INSTRUMENTED]) {
    return binding;
  }
  const proxy = new Proxy(binding, {
    get(target, property, receiver) {
      if (property === TELEMETRY_BINDINGS_INSTRUMENTED) {
        return true;
      }
      if (property === 'send') {
        const sendMethod = target.send;
        return async (body) => {
          recordCostAttribution(env, { surface: 'queue.write', quantity: 1, dimensions: { queue_name: queueName } });
          incrementMetric(env, 'queue.enqueue.count', 1, { queue_name: queueName });
          const result = await sendMethod.call(target, body);
          if (Array.isArray(target.messages)) {
            setGaugeMetric(env, 'queue.backlog.depth', target.messages.length, { queue_name: queueName });
          }
          return result;
        };
      }
      if (property === 'sendBatch') {
        const sendBatchMethod = target.sendBatch;
        return async (bodies) => {
          const quantity = Array.isArray(bodies) ? bodies.length : 0;
          recordCostAttribution(env, { surface: 'queue.write', quantity, dimensions: { queue_name: queueName } });
          incrementMetric(env, 'queue.enqueue.count', quantity, { queue_name: queueName });
          const result = await sendBatchMethod.call(target, bodies);
          if (Array.isArray(target.messages)) {
            setGaugeMetric(env, 'queue.backlog.depth', target.messages.length, { queue_name: queueName });
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

function wrapR2Bucket(env, binding, bucketName) {
  if (!binding || binding[TELEMETRY_BINDINGS_INSTRUMENTED]) {
    return binding;
  }
  const proxy = new Proxy(binding, {
    get(target, property, receiver) {
      if (property === TELEMETRY_BINDINGS_INSTRUMENTED) {
        return true;
      }
      if (property === 'get') {
        const getMethod = target.get;
        return async (key, options) => {
          recordCostAttribution(env, { surface: 'r2.class_b', quantity: 1, dimensions: { bucket: bucketName } });
          incrementMetric(env, 'r2.class_b.count', 1, { bucket: bucketName });
          return measureAsync(env, {
            metricName: 'r2.operation.latency_ms',
            dimensions: {
              bucket: bucketName,
              operation: 'get',
            },
          })(() => getMethod.call(target, key, options));
        };
      }
      if (property === 'put' || property === 'delete' || property === 'list' || property === 'head') {
        const operationMethod = target[property];
        return async (...args) => {
          recordCostAttribution(env, { surface: 'r2.class_a', quantity: 1, dimensions: { bucket: bucketName } });
          incrementMetric(env, 'r2.class_a.count', 1, { bucket: bucketName, operation: String(property) });
          return measureAsync(env, {
            metricName: 'r2.operation.latency_ms',
            dimensions: {
              bucket: bucketName,
              operation: String(property),
            },
          })(() => operationMethod.call(target, ...args));
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

function wrapKvNamespace(env, binding, namespaceName) {
  if (!binding || binding[TELEMETRY_BINDINGS_INSTRUMENTED]) {
    return binding;
  }
  const proxy = new Proxy(binding, {
    get(target, property, receiver) {
      if (property === TELEMETRY_BINDINGS_INSTRUMENTED) {
        return true;
      }
      if (['get', 'put', 'delete', 'list'].includes(String(property))) {
        const namespaceMethod = target[property];
        return async (...args) => {
          const operation = String(property);
          incrementMetric(env, 'kv.operation.count', 1, {
            namespace: namespaceName,
            operation,
          });
          recordCostAttribution(env, { surface: `kv.${operation}`, quantity: 1, dimensions: { namespace: namespaceName } });
          return measureAsync(env, {
            metricName: 'kv.operation.latency_ms',
            dimensions: {
              namespace: namespaceName,
              operation,
            },
          })(() => namespaceMethod.call(target, ...args));
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

function wrapD1Binding(env, binding, databaseName) {
  if (!binding || binding[TELEMETRY_BINDINGS_INSTRUMENTED]) {
    return binding;
  }
  const proxy = new Proxy(binding, {
    get(target, property, receiver) {
      if (property === TELEMETRY_BINDINGS_INSTRUMENTED) {
        return true;
      }
      if (property === 'exec') {
        const execMethod = target.exec;
        return async (sql) => {
          const operation = classifySqlOperation(sql);
          incrementMetric(env, 'd1.query.count', 1, {
            database: databaseName,
            operation,
          });
          recordCostAttribution(env, { surface: 'd1.query', quantity: 1, dimensions: { database: databaseName, operation } });
          return measureAsync(env, {
            metricName: 'd1.query.latency_ms',
            dimensions: {
              database: databaseName,
              operation,
            },
          })(() => execMethod.call(target, sql));
        };
      }
      if (property === 'prepare') {
        const prepareMethod = target.prepare;
        return (sql) => {
          const operation = classifySqlOperation(sql);
          const prepared = prepareMethod.call(target, sql);
          if (!prepared || typeof prepared.bind !== 'function') {
            return prepared;
          }
          return {
            bind(...bindings) {
              const bound = prepared.bind(...bindings);
              const wrapStatementMethod = (methodName) => {
                const method = bound?.[methodName];
                if (typeof method !== 'function') {
                  return method;
                }
                return async (...args) => {
                  incrementMetric(env, 'd1.query.count', 1, {
                    database: databaseName,
                    operation,
                    method: methodName,
                  });
                  recordCostAttribution(env, {
                    surface: 'd1.query',
                    quantity: 1,
                    dimensions: {
                      database: databaseName,
                      operation,
                      method: methodName,
                    },
                  });
                  return measureAsync(env, {
                    metricName: 'd1.query.latency_ms',
                    dimensions: {
                      database: databaseName,
                      operation,
                      method: methodName,
                    },
                  })(() => method.call(bound, ...args));
                };
              };
              return {
                run: wrapStatementMethod('run'),
                first: wrapStatementMethod('first'),
                all: wrapStatementMethod('all'),
              };
            },
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

export function getRuntimeTelemetry(env) {
  if (!env.__MATRIX_RUNTIME_TELEMETRY__) {
    env.__MATRIX_RUNTIME_TELEMETRY__ = {
      metrics: new Map(),
      deployment_records: new Map(),
      cost_totals: new Map(),
      events: [],
    };
  }
  return env.__MATRIX_RUNTIME_TELEMETRY__;
}

export function incrementMetric(env, name, value = 1, dimensions = {}) {
  return recordMetric(env, {
    name,
    kind: 'counter',
    value,
    dimensions,
  });
}

export function setGaugeMetric(env, name, value, dimensions = {}) {
  return recordMetric(env, {
    name,
    kind: 'gauge',
    value,
    dimensions,
  });
}

export function observeMetric(env, name, value, dimensions = {}) {
  return recordMetric(env, {
    name,
    kind: 'histogram',
    value,
    dimensions,
  });
}

export function recordMetric(env, {
  name,
  kind = 'counter',
  value = 1,
  dimensions = {},
}) {
  const metrics = ensureMetricMap(env);
  const nowIso = new Date().toISOString();
  const normalizedDimensions = stableDimensions(dimensions);
  const key = metricKey(name, normalizedDimensions);
  const entry = metrics.get(key) ?? makeMetricEntry({
    name,
    kind,
    dimensions: normalizedDimensions,
    nowIso,
  });
  updateMetricEntry(entry, kind, value, nowIso);
  metrics.set(key, entry);
  return cloneMetricEntry(entry);
}

export function recordCostAttribution(env, {
  surface,
  quantity = 1,
  dimensions = {},
}) {
  const telemetry = getRuntimeTelemetry(env);
  const normalizedDimensions = stableDimensions(dimensions);
  const key = metricKey(surface, normalizedDimensions);
  const current = telemetry.cost_totals.get(key) ?? {
    surface,
    quantity: 0,
    dimensions: normalizedDimensions,
  };
  current.quantity += quantity;
  telemetry.cost_totals.set(key, current);
  incrementMetric(env, 'cost.attribution.count', quantity, {
    surface,
    ...normalizedDimensions,
  });
  return {
    surface,
    quantity: current.quantity,
    dimensions: { ...normalizedDimensions },
  };
}

export function startRequestMetrics(env, {
  workerName,
  workerVersion,
  routeFamily,
}) {
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  incrementMetric(env, 'worker.request.count', 1, {
    worker: workerName,
    route_family: routeFamily,
    version: workerVersion,
  });
  return {
    finish({
      status = 200,
      error = null,
    } = {}) {
      const wallMs = performance.now() - startedAt;
      const cpuUsage = process.cpuUsage(cpuStartedAt);
      const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
      observeMetric(env, 'worker.wall_ms', wallMs, {
        worker: workerName,
        route_family: routeFamily,
        status,
        version: workerVersion,
      });
      observeMetric(env, 'worker.cpu_ms', cpuMs, {
        worker: workerName,
        route_family: routeFamily,
        status,
        version: workerVersion,
      });
      if (status >= 500 || error) {
        incrementMetric(env, 'worker.error.count', 1, {
          worker: workerName,
          route_family: routeFamily,
          status,
          version: workerVersion,
        });
      }
      return {
        wall_ms: wallMs,
        cpu_ms: cpuMs,
      };
    },
  };
}

export function recordDeploymentRecord(env, record) {
  const telemetry = getRuntimeTelemetry(env);
  const key = `${record.worker_name}|${record.worker_version_id}|${record.deployment_id}`;
  telemetry.deployment_records.set(key, structuredClone(record));
  return structuredClone(record);
}

export function listDeploymentRecords(env) {
  return [...getRuntimeTelemetry(env).deployment_records.values()].map((entry) => structuredClone(entry));
}

export function recordJobMetric(env, {
  jobType,
  jobId = null,
  state,
  queueName = null,
}) {
  incrementMetric(env, 'ops.job.state.count', 1, {
    job_type: jobType,
    state,
    ...(jobId ? { job_id: jobId } : {}),
    ...(queueName ? { queue_name: queueName } : {}),
  });
}

export function instrumentEnvironmentBindings(env) {
  if (!env || env.__MATRIX_TELEMETRY_BINDINGS_WRAPPED__ === true) {
    return env;
  }
  env.MATRIX_CONTROL_D1 = wrapD1Binding(env, env.MATRIX_CONTROL_D1, 'matrix-control-and-derived');
  env.MATRIX_MEDIA_BUCKET = wrapR2Bucket(env, env.MATRIX_MEDIA_BUCKET, 'matrix-media');
  env.MATRIX_ARCHIVE_BUCKET = wrapR2Bucket(env, env.MATRIX_ARCHIVE_BUCKET, 'matrix-archive');
  env.MATRIX_EDGE_CACHE = wrapKvNamespace(env, env.MATRIX_EDGE_CACHE, 'matrix-edge-cache');

  const queueBindings = [
    ['SEARCH_INDEX_QUEUE', 'matrix-search-index-job'],
    ['MEDIA_THUMBNAIL_QUEUE', 'matrix-media-thumbnail-job'],
    ['APPSERVICE_TXN_QUEUE', 'matrix-appservice-txn-job'],
    ['REBUILD_SHARD_QUEUE', 'matrix-rebuild-shard-job'],
    ['EXPORT_SHARD_QUEUE', 'matrix-export-shard-job'],
    ['RESTORE_SHARD_QUEUE', 'matrix-restore-shard-job'],
    ['REPAIR_SHARD_QUEUE', 'matrix-repair-shard-job'],
  ];
  for (const [bindingName, queueName] of queueBindings) {
    env[bindingName] = wrapQueueBinding(env, env[bindingName], queueName);
  }

  env.__MATRIX_TELEMETRY_BINDINGS_WRAPPED__ = true;
  return env;
}

export function snapshotTelemetry(env) {
  const telemetry = getRuntimeTelemetry(env);
  return {
    metrics: [...telemetry.metrics.values()].map((entry) => cloneMetricEntry(entry)),
    deployment_records: listDeploymentRecords(env),
    cost_totals: [...telemetry.cost_totals.values()].map((entry) => ({
      surface: entry.surface,
      quantity: entry.quantity,
      dimensions: { ...entry.dimensions },
    })),
  };
}
