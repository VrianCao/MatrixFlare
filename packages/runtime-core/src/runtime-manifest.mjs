const COMPATIBILITY_DATE = '2026-03-26';
const COMPATIBILITY_FLAGS = Object.freeze([
  'nodejs_compat',
  'nodejs_compat_do_not_populate_process_env',
]);

const RELEASE_PROFILES = ['L1', 'L2', 'L3'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const CPU_LIMIT_CLASSES = ['default', 'extended', 'legacy-50ms'];

const FEATURE_GATE_CATALOG = Object.freeze({
  federation: { env: 'FF_FEDERATION', default: false },
  media_remote_fetch: { env: 'FF_MEDIA_REMOTE_FETCH', default: false },
  appservice_api: { env: 'FF_APPSERVICE_API', default: false },
  otel_export: { env: 'FF_OTEL_EXPORT', default: false },
  otel_persist: { env: 'FF_OTEL_PERSIST', default: true },
  sso_login: { env: 'FF_SSO_LOGIN', default: false },
  login_token: { env: 'FF_LOGIN_TOKEN', default: false },
  threepid_changes: { env: 'FF_THREEPID_CHANGES', default: false },
  url_preview: { env: 'FF_URL_PREVIEW', default: false },
  push_gateway: { env: 'FF_PUSH_GATEWAY', default: false },
  request_token_bootstrap: { env: 'FF_REQUEST_TOKEN_BOOTSTRAP', default: false },
  turn_credentials: { env: 'FF_TURN_CREDENTIALS', default: false },
});

const SHARED_TEXT_BINDINGS = Object.freeze({
  ENVIRONMENT_NAME: { type: 'string', required: true },
  MATRIX_SERVER_NAME: { type: 'string', required: true },
  RELEASE_PROFILE: { type: 'enum', required: true, values: RELEASE_PROFILES },
  WORKER_VERSION_ID: { type: 'string', required: false, default: 'dev' },
  DEPLOYMENT_ID: { type: 'string', required: false, default: 'local-dev' },
  LOG_LEVEL: { type: 'enum', required: false, values: LOG_LEVELS, default: 'info' },
  CPU_LIMIT_CLASS: { type: 'enum', required: false, values: CPU_LIMIT_CLASSES, default: 'default' },
});

const WORKER_RUNTIME_MANIFEST = Object.freeze({
  'gateway-worker': Object.freeze({
    compatibilityDate: COMPATIBILITY_DATE,
    vars: Object.freeze({
      ...SHARED_TEXT_BINDINGS,
      MATRIX_PUBLIC_BASE_URL: { type: 'string', required: true },
      MANAGEMENT_API_BASE_URL: { type: 'string', required: true },
      MATRIX_MEDIA_MAX_UPLOAD_BYTES: { type: 'integer', required: false, default: 104857600 },
      MATRIX_MEDIA_LEGACY_UNAUTH_FREEZE_AT: { type: 'string', required: false, default: '' },
    }),
    secrets: Object.freeze({
      homeserver_signing_key_ring: 'HOMESERVER_SIGNING_KEY_RING',
      session_root_key_ring: 'SESSION_ROOT_KEY_RING',
      uia_root_key_ring: 'UIA_ROOT_KEY_RING',
      appservice_token_set: 'APPSERVICE_TOKEN_SET',
    }),
    featureGates: Object.freeze([
      'federation',
      'media_remote_fetch',
      'appservice_api',
      'otel_export',
      'otel_persist',
      'sso_login',
      'login_token',
      'threepid_changes',
      'url_preview',
      'push_gateway',
      'request_token_bootstrap',
      'turn_credentials',
    ]),
    bindings: Object.freeze({
      durableObjects: Object.freeze([
        { name: 'USER_DO', className: 'UserDO' },
        { name: 'ROOM_DO', className: 'RoomDO' },
        { name: 'REMOTE_SERVER_DO', className: 'RemoteServerDO' },
      ]),
      migrations: Object.freeze([
        {
          tag: 'phase-01-runtime-skeleton',
          newSqliteClasses: Object.freeze(['UserDO', 'RoomDO', 'RemoteServerDO']),
        },
      ]),
      services: Object.freeze([
        { binding: 'JOBS_WORKER', service: 'matrix-jobs-worker' },
      ]),
      queues: Object.freeze({
        producers: Object.freeze([
          { binding: 'SEARCH_INDEX_QUEUE', queue: 'matrix-search-index-job' },
          { binding: 'MEDIA_THUMBNAIL_QUEUE', queue: 'matrix-media-thumbnail-job' },
          { binding: 'APPSERVICE_TXN_QUEUE', queue: 'matrix-appservice-txn-job' },
          { binding: 'REBUILD_SHARD_QUEUE', queue: 'matrix-rebuild-shard-job' },
          { binding: 'EXPORT_SHARD_QUEUE', queue: 'matrix-export-shard-job' },
          { binding: 'RESTORE_SHARD_QUEUE', queue: 'matrix-restore-shard-job' },
          { binding: 'REPAIR_SHARD_QUEUE', queue: 'matrix-repair-shard-job' },
        ]),
      }),
      d1: Object.freeze([
        {
          binding: 'MATRIX_CONTROL_D1',
          databaseName: 'matrix-control-and-derived',
          databaseId: '00000000-0000-0000-0000-000000000001',
        },
      ]),
      r2: Object.freeze([
        { binding: 'MATRIX_MEDIA_BUCKET', bucketName: 'matrix-media' },
        { binding: 'MATRIX_ARCHIVE_BUCKET', bucketName: 'matrix-archive' },
      ]),
      kv: Object.freeze([
        { binding: 'MATRIX_EDGE_CACHE', id: '00000000000000000000000000000001' },
      ]),
    }),
  }),
  'jobs-worker': Object.freeze({
    compatibilityDate: COMPATIBILITY_DATE,
    vars: Object.freeze({
      ...SHARED_TEXT_BINDINGS,
      MANAGEMENT_API_BASE_URL: { type: 'string', required: true },
      MATRIX_MEDIA_LEGACY_UNAUTH_FREEZE_AT: { type: 'string', required: false, default: '' },
    }),
    secrets: Object.freeze({
      export_bundle_key_ring: 'EXPORT_BUNDLE_KEY_RING',
    }),
    featureGates: Object.freeze([
      'federation',
      'media_remote_fetch',
      'appservice_api',
      'otel_export',
      'otel_persist',
    ]),
    bindings: Object.freeze({
      durableObjects: Object.freeze([
        { name: 'USER_DO', className: 'UserDO', scriptName: 'matrix-gateway-worker' },
        { name: 'ROOM_DO', className: 'RoomDO', scriptName: 'matrix-gateway-worker' },
        { name: 'REMOTE_SERVER_DO', className: 'RemoteServerDO', scriptName: 'matrix-gateway-worker' },
      ]),
      migrations: Object.freeze([]),
      services: Object.freeze([]),
      queues: Object.freeze({
        producers: Object.freeze([
          { binding: 'REBUILD_SHARD_QUEUE', queue: 'matrix-rebuild-shard-job' },
          { binding: 'EXPORT_SHARD_QUEUE', queue: 'matrix-export-shard-job' },
          { binding: 'RESTORE_SHARD_QUEUE', queue: 'matrix-restore-shard-job' },
          { binding: 'REPAIR_SHARD_QUEUE', queue: 'matrix-repair-shard-job' },
        ]),
        consumers: Object.freeze([
          { queue: 'matrix-search-index-job' },
          { queue: 'matrix-media-thumbnail-job' },
          { queue: 'matrix-appservice-txn-job' },
          { queue: 'matrix-rebuild-shard-job' },
          { queue: 'matrix-export-shard-job' },
          { queue: 'matrix-restore-shard-job' },
          { queue: 'matrix-repair-shard-job' },
        ]),
      }),
      d1: Object.freeze([
        {
          binding: 'MATRIX_CONTROL_D1',
          databaseName: 'matrix-control-and-derived',
          databaseId: '00000000-0000-0000-0000-000000000001',
        },
      ]),
      r2: Object.freeze([
        { binding: 'MATRIX_MEDIA_BUCKET', bucketName: 'matrix-media' },
        { binding: 'MATRIX_ARCHIVE_BUCKET', bucketName: 'matrix-archive' },
      ]),
      kv: Object.freeze([
        { binding: 'MATRIX_EDGE_CACHE', id: '00000000000000000000000000000001' },
      ]),
    }),
  }),
  'ops-worker': Object.freeze({
    compatibilityDate: COMPATIBILITY_DATE,
    vars: Object.freeze({
      ...SHARED_TEXT_BINDINGS,
      MANAGEMENT_API_BASE_URL: { type: 'string', required: true },
      ACCESS_TEAM_DOMAIN: { type: 'string', required: true },
      ACCESS_AUDIENCE: { type: 'string', required: true },
    }),
    secrets: Object.freeze({
      export_bundle_key_ring: 'EXPORT_BUNDLE_KEY_RING',
    }),
    featureGates: Object.freeze([
      'appservice_api',
      'otel_export',
      'otel_persist',
    ]),
    bindings: Object.freeze({
      durableObjects: Object.freeze([
        { name: 'USER_DO', className: 'UserDO', scriptName: 'matrix-gateway-worker' },
        { name: 'ROOM_DO', className: 'RoomDO', scriptName: 'matrix-gateway-worker' },
        { name: 'REMOTE_SERVER_DO', className: 'RemoteServerDO', scriptName: 'matrix-gateway-worker' },
      ]),
      migrations: Object.freeze([]),
      services: Object.freeze([
        { binding: 'JOBS_WORKER', service: 'matrix-jobs-worker' },
      ]),
      queues: Object.freeze({}),
      d1: Object.freeze([
        {
          binding: 'MATRIX_CONTROL_D1',
          databaseName: 'matrix-control-and-derived',
          databaseId: '00000000-0000-0000-0000-000000000001',
        },
      ]),
      r2: Object.freeze([
        { binding: 'MATRIX_ARCHIVE_BUCKET', bucketName: 'matrix-archive' },
      ]),
      kv: Object.freeze([]),
    }),
  }),
});

function parseBooleanString(value, envName) {
  if (typeof value !== 'string') {
    throw new TypeError(`${envName} must be a string when provided`);
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new TypeError(`${envName} must be one of true/false/1/0/yes/no/on/off`);
}

function readBindingValue(env, envName) {
  return env?.[envName];
}

function parseTextBinding(env, envName, definition) {
  const value = readBindingValue(env, envName);
  if (value == null || value === '') {
    if (definition.required) {
      throw new TypeError(`Missing required binding ${envName}`);
    }
    return definition.default ?? null;
  }

  if (definition.type === 'string') {
    if (typeof value !== 'string') {
      throw new TypeError(`${envName} must be a string`);
    }
    return value;
  }

  if (definition.type === 'enum') {
    if (typeof value !== 'string' || !definition.values.includes(value)) {
      throw new TypeError(`${envName} must be one of ${definition.values.join(', ')}`);
    }
    return value;
  }

  if (definition.type === 'integer') {
    const parsed = typeof value === 'number'
      ? value
      : (/^[0-9]+$/.test(String(value).trim()) ? Number.parseInt(String(value).trim(), 10) : Number.NaN);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new TypeError(`${envName} must be a positive integer`);
    }
    return parsed;
  }

  throw new RangeError(`Unsupported binding definition type for ${envName}`);
}

function createSecretAccessor(workerName, secretsManifest, env) {
  const logicalSecretNames = Object.keys(secretsManifest);

  return Object.freeze({
    names() {
      return [...logicalSecretNames];
    },
    get(logicalName) {
      const envName = secretsManifest[logicalName];
      if (!envName) {
        throw new RangeError(`Unknown secret "${logicalName}" for ${workerName}`);
      }
      const value = readBindingValue(env, envName);
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
    require(logicalName) {
      const value = this.get(logicalName);
      if (value == null) {
        throw new TypeError(`Missing required secret "${logicalName}" for ${workerName}`);
      }
      return value;
    },
  });
}

function parseFeatureGates(featureGateIds, env) {
  const featureGates = {};
  for (const featureGateId of featureGateIds) {
    const definition = FEATURE_GATE_CATALOG[featureGateId];
    const rawValue = readBindingValue(env, definition.env);
    featureGates[featureGateId] = rawValue == null ? definition.default : parseBooleanString(rawValue, definition.env);
  }
  return Object.freeze(featureGates);
}

export function getWorkerRuntimeManifest(workerName) {
  const manifest = WORKER_RUNTIME_MANIFEST[workerName];
  if (!manifest) {
    throw new RangeError(`Unknown worker runtime manifest: ${workerName}`);
  }
  return manifest;
}

export function listWorkerNames() {
  return Object.keys(WORKER_RUNTIME_MANIFEST);
}

export function listDurableObjectClassNames() {
  return ['UserDO', 'RoomDO', 'RemoteServerDO'];
}

export function listFeatureGateIds() {
  return Object.keys(FEATURE_GATE_CATALOG);
}

export function loadWorkerRuntimeConfig(workerName, env = {}) {
  const manifest = getWorkerRuntimeManifest(workerName);
  const text = {};

  for (const [envName, definition] of Object.entries(manifest.vars)) {
    text[envName] = parseTextBinding(env, envName, definition);
  }

  return Object.freeze({
    workerName,
    compatibilityDate: manifest.compatibilityDate,
    bindings: manifest.bindings,
    text: Object.freeze(text),
    environmentName: text.ENVIRONMENT_NAME,
    releaseProfile: text.RELEASE_PROFILE,
    logLevel: text.LOG_LEVEL,
    featureGates: parseFeatureGates(manifest.featureGates, env),
    secrets: createSecretAccessor(workerName, manifest.secrets, env),
  });
}

export function createWranglerConfigSnapshot(workerName) {
  const manifest = getWorkerRuntimeManifest(workerName);
  const config = {
    name: `matrix-${workerName}`,
    main: 'src/index.mjs',
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: [...COMPATIBILITY_FLAGS],
    vars: {},
  };

  for (const [envName, definition] of Object.entries(manifest.vars)) {
    config.vars[envName] = definition.default
      ?? definition.values?.[0]
      ?? `${envName.toLowerCase()}-placeholder`;
  }

  for (const featureGateId of manifest.featureGates) {
    const gate = FEATURE_GATE_CATALOG[featureGateId];
    config.vars[gate.env] = String(gate.default);
  }

  if (manifest.bindings.durableObjects.length > 0) {
    config.durable_objects = {
      bindings: manifest.bindings.durableObjects.map((binding) => ({
        name: binding.name,
        class_name: binding.className,
        ...(binding.scriptName ? { script_name: binding.scriptName } : {}),
      })),
    };
  }

  if (manifest.bindings.migrations.length > 0) {
    config.migrations = manifest.bindings.migrations.map((migration) => ({
      tag: migration.tag,
      new_sqlite_classes: [...migration.newSqliteClasses],
    }));
  }

  if (manifest.bindings.services.length > 0) {
    config.services = manifest.bindings.services.map((binding) => ({
      binding: binding.binding,
      service: binding.service,
    }));
  }

  const queueSections = {};
  if (manifest.bindings.queues.producers?.length) {
    queueSections.producers = manifest.bindings.queues.producers.map((queue) => ({
      binding: queue.binding,
      queue: queue.queue,
    }));
  }
  if (manifest.bindings.queues.consumers?.length) {
    queueSections.consumers = manifest.bindings.queues.consumers.map((queue) => ({
      queue: queue.queue,
    }));
  }
  if (Object.keys(queueSections).length > 0) {
    config.queues = queueSections;
  }

  if (manifest.bindings.d1.length > 0) {
    config.d1_databases = manifest.bindings.d1.map((binding) => ({
      binding: binding.binding,
      database_name: binding.databaseName,
      database_id: binding.databaseId,
    }));
  }

  if (manifest.bindings.r2.length > 0) {
    config.r2_buckets = manifest.bindings.r2.map((binding) => ({
      binding: binding.binding,
      bucket_name: binding.bucketName,
    }));
  }

  if (manifest.bindings.kv.length > 0) {
    config.kv_namespaces = manifest.bindings.kv.map((binding) => ({
      binding: binding.binding,
      id: binding.id,
    }));
  }

  return config;
}
