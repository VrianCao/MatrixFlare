import {
  ROUTE_TEMPLATES,
  buildJobStatusResponseFromRecords,
  normalizeAppserviceConfigRequest,
  normalizeExportJobRequest,
  normalizeJobCancelRequest,
  normalizeRebuildJobRequest,
  normalizeRepairJobRequest,
  normalizeRolloutSkewProbeRequest,
  normalizeRolloutSkewProbeResponse,
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
    worker_version_id: deploymentRecord.worker_version_id,
    deployment_id: deploymentRecord.deployment_id,
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
  if (pathname === ROUTE_TEMPLATES.rolloutSkewProbe) {
    return { kind: 'rollout-skew-probe', routeTemplate: ROUTE_TEMPLATES.rolloutSkewProbe, requiredScope: 'ops.rebuild.write' };
  }
  if (pathname === ROUTE_TEMPLATES.costObservation) {
    return { kind: 'cost-observation', routeTemplate: ROUTE_TEMPLATES.costObservation, requiredScope: 'ops.read' };
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

const ROLLOUT_PROBE_SECRET_HEADER = 'x-matrix-rollout-probe-secret';
const ROLLOUT_PROBE_GATEWAY_VERSION_ID_HEADER = 'x-matrix-rollout-probe-gateway-version-id';
const PROBE_PASSWORD_SUFFIX = '-password';
const ROLLOUT_PROBE_MAX_SEED_ATTEMPTS = 24;
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_GRAPHQL_API_DOC_URI = 'https://developers.cloudflare.com/analytics/graphql-api/';
const WORKERS_METRICS_DOC_URI = 'https://developers.cloudflare.com/workers/observability/metrics-and-analytics/';
const DURABLE_OBJECTS_METRICS_DOC_URI = 'https://developers.cloudflare.com/durable-objects/observability/graphql-analytics/';
const DURABLE_OBJECTS_PRICING_DOC_URI = 'https://developers.cloudflare.com/durable-objects/platform/pricing/';
const WORKERS_SCRIPT_SETTINGS_DOC_URI = 'https://developers.cloudflare.com/api-next/resources/workers/subresources/scripts/subresources/settings/methods/get/';
const BILLING_USAGE_API_DOC_URI = 'https://developers.cloudflare.com/api/resources/billing/subresources/usage/';

function stableString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProbeToken(value, {
  fallback = 'probe',
} = {}) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._=-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : fallback;
}

function sanitizeProbeToken(value, {
  fallback = 'probe',
  maxLength = 48,
} = {}) {
  const resolved = normalizeProbeToken(value, {
    fallback,
  });
  return resolved.slice(0, Math.max(1, maxLength));
}

function buildProbeScopedToken(baseLabel, uniqueScope, {
  fallback = 'probe',
  maxLength = 48,
  uniqueTailLength = 8,
} = {}) {
  const resolvedMaxLength = Math.max(1, maxLength);
  const baseToken = sanitizeProbeToken(baseLabel, {
    fallback,
    maxLength: resolvedMaxLength,
  });
  const compactScopeToken = normalizeProbeToken(uniqueScope, {
    fallback: 'scope',
  }).replace(/[^a-z0-9]+/g, '');
  if (compactScopeToken.length === 0 || resolvedMaxLength <= 1) {
    return baseToken.slice(0, resolvedMaxLength);
  }
  const suffixLength = Math.min(
    Math.max(1, uniqueTailLength),
    compactScopeToken.length,
    Math.max(1, resolvedMaxLength - 2),
  );
  const suffix = compactScopeToken.slice(-suffixLength);
  const prefixBudget = Math.max(0, resolvedMaxLength - 1 - suffix.length);
  const prefix = prefixBudget > 0 ? baseToken.slice(0, prefixBudget) : '';
  return prefix.length > 0 ? `${prefix}-${suffix}` : suffix;
}

function sanitizeDeviceId(value) {
  const normalized = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 16);
  return normalized.length > 0 ? normalized : 'ROLLPROBE01';
}

function buildSeedAttemptLabel(baseLabel, attemptIndex) {
  return `${baseLabel}-${attemptIndex}`;
}

function summarizeObservedProbeVersions(observedVersionIds) {
  const uniqueVersionIds = [...new Set(
    observedVersionIds
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => String(value)),
  )];
  return uniqueVersionIds.length === 0 ? 'none' : uniqueVersionIds.join(', ');
}

function createOpsValidationError(message, {
  status = 422,
  code = 'validation_failed',
  retryable = false,
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function createOpsPreconditionError(message, {
  status = 409,
  code = 'precondition_failed',
  retryable = false,
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function createRetryableProbeAttemptError(message) {
  const error = createOpsPreconditionError(message, {
    retryable: true,
  });
  error.attempt_retryable = true;
  return error;
}

function isRetryableProbeAttemptError(error) {
  return error?.attempt_retryable === true;
}

function requireGatewayProbeConfiguration(env) {
  const baseUrl = stableString(env.MATRIX_PUBLIC_BASE_URL).replace(/\/+$/, '');
  const scriptName = stableString(env.GATEWAY_WORKER_SCRIPT_NAME);
  const sharedSecret = stableString(env.ROLLOUT_PROBE_SHARED_SECRET);
  if (baseUrl.length === 0) {
      throw createOpsPreconditionError('ops-worker requires MATRIX_PUBLIC_BASE_URL for rollout-skew probing', {
        status: 503,
        code: 'internal',
        retryable: true,
      });
  }
  if (scriptName.length === 0) {
      throw createOpsPreconditionError('ops-worker requires GATEWAY_WORKER_SCRIPT_NAME for rollout-skew probing', {
        status: 503,
        code: 'internal',
        retryable: true,
      });
  }
  if (sharedSecret.length === 0) {
      throw createOpsPreconditionError('ops-worker requires ROLLOUT_PROBE_SHARED_SECRET for rollout-skew probing', {
        status: 503,
        code: 'internal',
        retryable: true,
      });
  }
  return {
    base_url: baseUrl,
    script_name: scriptName,
    shared_secret: sharedSecret,
  };
}

function buildVersionOverrideHeader(scriptName, versionId) {
  return `${scriptName}="${String(versionId).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function readGatewayPayload(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('json')) {
    return response.json();
  }
  return response.text();
}

function describeGatewayFailure(result) {
  return JSON.stringify({
    status: result.response.status,
    content_type: result.response.headers.get('content-type') ?? '',
    body: result.payload,
  });
}

function indicatesExistingProbeIdentity(result) {
  return (
    result.response.status === 400
    || result.response.status === 409
  ) && result.payload?.errcode === 'M_USER_IN_USE';
}

async function fetchGatewayWithVersionOverride(env, gatewayConfig, {
  versionId,
  pathname,
  method = 'GET',
  accessToken = null,
  json = undefined,
  requireObservedGatewayVersionId = true,
} = {}) {
  const headers = new Headers();
  headers.set('Cloudflare-Workers-Version-Overrides', buildVersionOverrideHeader(gatewayConfig.script_name, versionId));
  headers.set(ROLLOUT_PROBE_SECRET_HEADER, gatewayConfig.shared_secret);
  if (accessToken != null) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  if (json !== undefined) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetch(`${gatewayConfig.base_url}${pathname}`, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const payload = await readGatewayPayload(response);
  const observedGatewayVersionId = stableString(response.headers.get(ROLLOUT_PROBE_GATEWAY_VERSION_ID_HEADER));
  if (observedGatewayVersionId.length === 0 && requireObservedGatewayVersionId) {
    throw createOpsPreconditionError(`Gateway response for ${pathname} did not include ${ROLLOUT_PROBE_GATEWAY_VERSION_ID_HEADER}`);
  }
  if (observedGatewayVersionId.length > 0 && observedGatewayVersionId !== versionId) {
    throw createOpsPreconditionError(
      `Gateway version override mismatch for ${pathname}: requested ${versionId}, observed ${observedGatewayVersionId}`,
    );
  }
  return {
    response,
    payload,
    observed_gateway_version_id: observedGatewayVersionId,
  };
}

function getUserDoStub(env, userId) {
  const namespace = env.USER_DO;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
      throw createOpsPreconditionError('ops-worker requires USER_DO binding for rollout-skew probing', {
        status: 503,
        code: 'internal',
        retryable: true,
      });
  }
  return namespace.get(namespace.idFromName(userId));
}

function getRoomDoStub(env, roomId) {
  const namespace = env.ROOM_DO;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
      throw createOpsPreconditionError('ops-worker requires ROOM_DO binding for rollout-skew probing', {
        status: 503,
        code: 'internal',
        retryable: true,
      });
  }
  return namespace.get(namespace.idFromName(roomId));
}

async function inspectUserAuthority(env, userId) {
  const result = await getUserDoStub(env, userId).inspectRuntimeIdentity();
  if (!result?.ok || stableString(result.worker_version_id).length === 0) {
    throw createOpsPreconditionError(`UserDO ${userId} did not expose a usable runtime identity`);
  }
  return result;
}

async function inspectRoomAuthority(env, roomId) {
  const result = await getRoomDoStub(env, roomId).inspectRuntimeIdentity();
  if (!result?.ok || stableString(result.worker_version_id).length === 0) {
    throw createOpsPreconditionError(`RoomDO ${roomId} did not expose a usable runtime identity`);
  }
  return result;
}

async function loginProbeUser(env, gatewayConfig, {
  username,
  password,
  deviceId,
  gatewayVersionId,
} = {}) {
  const result = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
    versionId: gatewayVersionId,
    pathname: '/_matrix/client/v3/login',
    method: 'POST',
    requireObservedGatewayVersionId: false,
    json: {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user: username,
      },
      password,
      device_id: deviceId,
    },
  });
  if (result.response.status !== 200 || typeof result.payload?.access_token !== 'string' || typeof result.payload?.user_id !== 'string') {
    throw createRetryableProbeAttemptError(`Probe login failed for ${username}: ${describeGatewayFailure(result)}`);
  }
  return {
    username,
    password,
    device_id: deviceId,
    access_token: result.payload.access_token,
    user_id: result.payload.user_id,
  };
}

async function ensureProbeUser(env, gatewayConfig, probeRequest, {
  userLabel,
  gatewayVersionId,
} = {}) {
  const username = buildProbeScopedToken(userLabel, `${probeRequest.seed_prefix}-${probeRequest.probe_run_id}`, {
    fallback: userLabel,
    maxLength: 32,
    uniqueTailLength: 8,
  });
  const password = sanitizeProbeToken(`${probeRequest.probe_run_id}${PROBE_PASSWORD_SUFFIX}`, {
    fallback: 'phase08-rollout-password',
    maxLength: 48,
  });
  const deviceId = sanitizeDeviceId(`${userLabel}-${probeRequest.probe_run_id}`);
  const challenge = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
    versionId: gatewayVersionId,
    pathname: '/_matrix/client/v3/register',
    method: 'POST',
    requireObservedGatewayVersionId: false,
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  if (challenge.response.status === 200 && typeof challenge.payload?.access_token === 'string' && typeof challenge.payload?.user_id === 'string') {
    return {
      username,
      password,
      device_id: deviceId,
      access_token: challenge.payload.access_token,
      user_id: challenge.payload.user_id,
    };
  }
  if (challenge.response.status === 401 && typeof challenge.payload?.session === 'string') {
    const completed = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
      versionId: gatewayVersionId,
      pathname: '/_matrix/client/v3/register',
      method: 'POST',
      requireObservedGatewayVersionId: false,
      json: {
        username,
        password,
        device_id: deviceId,
        auth: {
          type: 'm.login.dummy',
          session: challenge.payload.session,
        },
      },
    });
    if (completed.response.status === 200 && typeof completed.payload?.access_token === 'string' && typeof completed.payload?.user_id === 'string') {
      return {
        username,
        password,
        device_id: deviceId,
        access_token: completed.payload.access_token,
        user_id: completed.payload.user_id,
      };
    }
    if (indicatesExistingProbeIdentity(completed)) {
      return loginProbeUser(env, gatewayConfig, {
        username,
        password,
        deviceId,
        gatewayVersionId,
      });
    }
    throw createRetryableProbeAttemptError(`Probe register completion failed for ${username}: ${describeGatewayFailure(completed)}`);
  }
  if (indicatesExistingProbeIdentity(challenge)) {
    return loginProbeUser(env, gatewayConfig, {
      username,
      password,
      deviceId,
      gatewayVersionId,
    });
  }
  throw createRetryableProbeAttemptError(`Probe register challenge failed for ${username}: ${describeGatewayFailure(challenge)}`);
}

async function ensureProbeRoom(env, gatewayConfig, probeRequest, {
  roomLabel,
  gatewayVersionId,
  accessToken,
  serverName,
} = {}) {
  const aliasLocalpart = buildProbeScopedToken(roomLabel, `${probeRequest.seed_prefix}-${probeRequest.probe_run_id}`, {
    fallback: roomLabel,
    maxLength: 48,
    uniqueTailLength: 12,
  });
  const roomAlias = `#${aliasLocalpart}:${serverName}`;
  const created = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
    versionId: gatewayVersionId,
    pathname: '/_matrix/client/v3/createRoom',
    method: 'POST',
    accessToken,
    requireObservedGatewayVersionId: false,
    json: {
      visibility: 'public',
      preset: 'public_chat',
      room_alias_name: aliasLocalpart,
      name: `Phase08 rollout ${roomLabel}`,
    },
  });
  if (created.response.status === 200 && typeof created.payload?.room_id === 'string') {
    return {
      room_id: created.payload.room_id,
      room_alias: roomAlias,
    };
  }
  const joined = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
    versionId: gatewayVersionId,
    pathname: `/_matrix/client/v3/join/${encodeURIComponent(roomAlias)}`,
    method: 'POST',
    accessToken,
    requireObservedGatewayVersionId: false,
    json: {},
  });
  if (joined.response.status !== 200 || typeof joined.payload?.room_id !== 'string') {
    throw createRetryableProbeAttemptError(`Probe room setup failed for ${roomAlias}: ${JSON.stringify(created.payload)}`);
  }
  return {
    room_id: joined.payload.room_id,
    room_alias: roomAlias,
  };
}

async function seedProbeUserForVersion(env, gatewayConfig, probeRequest, {
  userLabel,
  gatewayVersionId,
  expectedAuthorityVersionId,
} = {}) {
  const observedVersionIds = [];
  const attemptErrors = [];
  for (let attemptIndex = 1; attemptIndex <= ROLLOUT_PROBE_MAX_SEED_ATTEMPTS; attemptIndex += 1) {
    let seededUser;
    try {
      seededUser = await ensureProbeUser(env, gatewayConfig, probeRequest, {
        userLabel: buildSeedAttemptLabel(userLabel, attemptIndex),
        gatewayVersionId,
      });
    } catch (error) {
      if (!isRetryableProbeAttemptError(error)) {
        throw error;
      }
      attemptErrors.push(`attempt ${attemptIndex}: ${error.message}`);
      continue;
    }
    const identity = await inspectUserAuthority(env, seededUser.user_id);
    observedVersionIds.push(identity.worker_version_id);
    if (identity.worker_version_id === expectedAuthorityVersionId) {
      return seededUser;
    }
  }
  throw createOpsPreconditionError(
    `Unable to seed ${userLabel} on ${expectedAuthorityVersionId} within ${ROLLOUT_PROBE_MAX_SEED_ATTEMPTS} attempts; observed ${summarizeObservedProbeVersions(observedVersionIds)}${attemptErrors.length > 0 ? `; setup_failures=${attemptErrors.join(' | ')}` : ''}`,
    { retryable: true },
  );
}

async function seedProbeRoomForVersion(env, gatewayConfig, probeRequest, {
  roomLabel,
  gatewayVersionId,
  accessToken,
  serverName,
  expectedAuthorityVersionId,
} = {}) {
  const observedVersionIds = [];
  const attemptErrors = [];
  for (let attemptIndex = 1; attemptIndex <= ROLLOUT_PROBE_MAX_SEED_ATTEMPTS; attemptIndex += 1) {
    let seededRoom;
    try {
      seededRoom = await ensureProbeRoom(env, gatewayConfig, probeRequest, {
        roomLabel: buildSeedAttemptLabel(roomLabel, attemptIndex),
        gatewayVersionId,
        accessToken,
        serverName,
      });
    } catch (error) {
      if (!isRetryableProbeAttemptError(error)) {
        throw error;
      }
      attemptErrors.push(`attempt ${attemptIndex}: ${error.message}`);
      continue;
    }
    const identity = await inspectRoomAuthority(env, seededRoom.room_id);
    observedVersionIds.push(identity.worker_version_id);
    if (identity.worker_version_id === expectedAuthorityVersionId) {
      return seededRoom;
    }
  }
  throw createOpsPreconditionError(
    `Unable to seed ${roomLabel} on ${expectedAuthorityVersionId} within ${ROLLOUT_PROBE_MAX_SEED_ATTEMPTS} attempts; observed ${summarizeObservedProbeVersions(observedVersionIds)}${attemptErrors.length > 0 ? `; setup_failures=${attemptErrors.join(' | ')}` : ''}`,
    { retryable: true },
  );
}

function buildRolloutObservation({
  probeName,
  requestGatewayVersionId,
  observedGatewayVersionId,
  authorityVersionId,
  authorityKind,
  authorityKey,
  requestPath,
}) {
  return {
    probe_name: probeName,
    request_gateway_version_id: requestGatewayVersionId,
    observed_gateway_version_id: observedGatewayVersionId,
    observed_authority_version_id: authorityVersionId,
    authority_kind: authorityKind,
    authority_key: authorityKey,
    request_path: requestPath,
    observed_at: new Date().toISOString(),
  };
}

function evaluateRolloutAssertions(observations, {
  baselineGatewayVersionId,
  candidateGatewayVersionId,
} = {}) {
  const hasExpectedObservation = (probeName, authorityKind, expectedGatewayVersionId, expectedAuthorityVersionId) => observations.some((entry) => (
    entry.probe_name === probeName
    && entry.authority_kind === authorityKind
    && entry.observed_gateway_version_id === expectedGatewayVersionId
    && entry.observed_authority_version_id === expectedAuthorityVersionId
  ));
  return {
    new_worker_old_authority: ['UserDO', 'RoomDO'].every((authorityKind) => hasExpectedObservation(
      'new-worker-old-authority',
      authorityKind,
      candidateGatewayVersionId,
      baselineGatewayVersionId,
    )),
    old_worker_new_authority: ['UserDO', 'RoomDO'].every((authorityKind) => hasExpectedObservation(
      'old-worker-new-authority',
      authorityKind,
      baselineGatewayVersionId,
      candidateGatewayVersionId,
    )),
  };
}

function createOpsInternalError(message, {
  retryable = false,
  details = null,
} = {}) {
  const error = new Error(message);
  error.code = 'internal';
  error.retryable = retryable;
  error.details = details;
  return error;
}

function getObservabilityFetch(env) {
  return env?.__CLOUDFLARE_OBSERVABILITY_FETCH__ ?? globalThis.fetch;
}

function parseJsonObjectText(rawValue, label) {
  const normalized = stableString(rawValue);
  if (normalized.length === 0) {
    throw createOpsPreconditionError(`${label} is required for cost observation`, {
      status: 503,
      code: 'internal',
      retryable: true,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw createOpsPreconditionError(`${label} must be valid JSON: ${error.message}`, {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createOpsPreconditionError(`${label} must decode to an object`, {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  return parsed;
}

function normalizeStringMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createOpsPreconditionError(`${label} must be an object`, {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  const normalized = {};
  for (const [key, rawEntry] of Object.entries(value)) {
    const normalizedKey = stableString(key);
    const normalizedValue = stableString(rawEntry);
    if (normalizedKey.length > 0 && normalizedValue.length > 0) {
      normalized[normalizedKey] = normalizedValue;
    }
  }
  return Object.freeze(normalized);
}

function requireCostObservationConfiguration(env, config) {
  const accountId = stableString(env.CLOUDFLARE_ACCOUNT_ID);
  if (accountId.length === 0) {
    throw createOpsPreconditionError('ops-worker requires CLOUDFLARE_ACCOUNT_ID for cost observation', {
      status: 503,
      code: 'internal',
      retryable: true,
    });
  }
  const apiToken = stableString(
    config?.secrets?.get?.('cloudflare_observability_api_token')
    ?? env.CLOUDFLARE_OBSERVABILITY_API_TOKEN,
  );
  if (apiToken.length === 0) {
    throw createOpsPreconditionError('ops-worker requires CLOUDFLARE_OBSERVABILITY_API_TOKEN for cost observation', {
      status: 503,
      code: 'internal',
      retryable: true,
    });
  }
  const rawResourceIds = parseJsonObjectText(env.CLOUDFLARE_RESOURCE_IDS_JSON, 'CLOUDFLARE_RESOURCE_IDS_JSON');
  const workerScripts = normalizeStringMap(
    rawResourceIds.worker_scripts ?? {
      'gateway-worker': env.GATEWAY_WORKER_SCRIPT_NAME,
    },
    'CLOUDFLARE_RESOURCE_IDS_JSON.worker_scripts',
  );
  const queueIds = normalizeStringMap(rawResourceIds.queue_ids ?? {}, 'CLOUDFLARE_RESOURCE_IDS_JSON.queue_ids');
  const bucketNames = normalizeStringMap(rawResourceIds.r2_bucket_names ?? {}, 'CLOUDFLARE_RESOURCE_IDS_JSON.r2_bucket_names');
  const resourceSnapshot = rawResourceIds.cloudflare_resources;
  if (!resourceSnapshot || typeof resourceSnapshot !== 'object' || Array.isArray(resourceSnapshot)) {
    throw createOpsPreconditionError('CLOUDFLARE_RESOURCE_IDS_JSON.cloudflare_resources must be present for cost observation', {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  const gatewayScriptName = workerScripts['gateway-worker'] ?? stableString(env.GATEWAY_WORKER_SCRIPT_NAME);
  const jobsScriptName = workerScripts['jobs-worker'];
  const opsScriptName = workerScripts['ops-worker'];
  if (gatewayScriptName.length === 0 || jobsScriptName == null || opsScriptName == null) {
    throw createOpsPreconditionError('CLOUDFLARE_RESOURCE_IDS_JSON.worker_scripts must include gateway-worker, jobs-worker, and ops-worker', {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  const mediaBucketName = bucketNames.MATRIX_MEDIA_BUCKET;
  const archiveBucketName = bucketNames.MATRIX_ARCHIVE_BUCKET;
  if (mediaBucketName == null || archiveBucketName == null) {
    throw createOpsPreconditionError('CLOUDFLARE_RESOURCE_IDS_JSON.r2_bucket_names must include MATRIX_MEDIA_BUCKET and MATRIX_ARCHIVE_BUCKET', {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  const d1DatabaseId = stableString(rawResourceIds.d1_database_id);
  const kvNamespaceId = stableString(rawResourceIds.kv_namespace_id);
  if (d1DatabaseId.length === 0 || kvNamespaceId.length === 0) {
    throw createOpsPreconditionError('CLOUDFLARE_RESOURCE_IDS_JSON must include d1_database_id and kv_namespace_id', {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  if (Object.keys(queueIds).length === 0) {
    throw createOpsPreconditionError('CLOUDFLARE_RESOURCE_IDS_JSON.queue_ids must not be empty', {
      status: 503,
      code: 'internal',
      retryable: false,
    });
  }
  return Object.freeze({
    account_id: accountId,
    api_token: apiToken,
    worker_scripts: workerScripts,
    gateway_script_name: gatewayScriptName,
    d1_database_id: d1DatabaseId,
    kv_namespace_id: kvNamespaceId,
    queue_ids: queueIds,
    r2_bucket_names: bucketNames,
    cloudflare_resources: resourceSnapshot,
  });
}

async function callCloudflareAccountApi(fetchImpl, {
  accountId,
  apiToken,
  method = 'GET',
  pathname,
  body = null,
}) {
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: 'application/json',
      ...(body == null ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    payload = {
      success: false,
      errors: [{ message: text.length === 0 ? `${method} ${pathname} returned an empty response body` : text }],
    };
  }
  if (!response.ok || payload?.success === false) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const errorMessage = errors.length > 0
      ? errors.map((entry) => entry?.message ?? JSON.stringify(entry)).join('; ')
      : `${method} ${pathname} failed`;
    throw createOpsInternalError(`Cloudflare API ${method} ${pathname} failed: ${errorMessage}`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  return payload;
}

async function fetchWorkerUsageModel(fetchImpl, {
  accountId,
  apiToken,
  scriptName,
}) {
  const payload = await callCloudflareAccountApi(fetchImpl, {
    accountId,
    apiToken,
    pathname: `/workers/scripts/${scriptName}/settings`,
  });
  const result = payload?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw createOpsInternalError('Cloudflare Worker settings did not include a result object', {
      retryable: false,
    });
  }
  const usageModel = stableString(result.usage_model ?? result.usageModel);
  if (usageModel.length === 0) {
    throw createOpsInternalError(`Cloudflare Worker settings for ${scriptName} did not expose usage_model`, {
      retryable: false,
    });
  }
  return usageModel.toLowerCase();
}

function buildCostObservationBlockerDetails() {
  return Object.freeze({
    blocker_ids: Object.freeze(['OQ-0006']),
    blocker_reasons: Object.freeze([
      'Cloudflare GraphQL Analytics is aggregated analytics and the official GraphQL docs say not to use it for billing.',
      'Workers metrics expose request counts and CPU percentiles, but not a billing-safe total CPU figure for the bounded pre-release workload window.',
      'Durable Objects pricing bills wall-clock duration GB-s, while the official Durable Objects analytics surface exposes cpuTime and storage, not billed duration.',
      'Cloudflare Billing Usage and PayGo API automation remains beta/select-account and is not yet proven for per-environment pre-release snapshots in the current same-account topology.',
    ]),
    official_source_uris: Object.freeze([
      CLOUDFLARE_GRAPHQL_API_DOC_URI,
      WORKERS_METRICS_DOC_URI,
      DURABLE_OBJECTS_METRICS_DOC_URI,
      DURABLE_OBJECTS_PRICING_DOC_URI,
      WORKERS_SCRIPT_SETTINGS_DOC_URI,
      BILLING_USAGE_API_DOC_URI,
    ]),
  });
}

async function handleCostObservation(request, env, config, requestContext) {
  const operator = await authenticateOperatorIdentity({
    request,
    env,
    config,
    requiredScope: 'ops.read',
  });
  if (request.method !== 'GET') {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'internal',
      message: 'Unsupported cost observation method',
    });
  }
  authorizeOperatorRequest({
    operator,
    targetScope: {
      scope_kind: 'global',
      scope_id: null,
    },
  });
  if (config.environmentName !== 'pre-release') {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'internal',
      message: 'Cost observation is only supported in pre-release',
    });
  }

  try {
    const fetchImpl = getObservabilityFetch(env);
    const costConfig = requireCostObservationConfiguration(env, config);
    const usageModels = await Promise.all(
      [...new Set(Object.values(costConfig.worker_scripts))]
        .map(async (scriptName) => ({
          script_name: scriptName,
          usage_model: await fetchWorkerUsageModel(fetchImpl, {
            accountId: costConfig.account_id,
            apiToken: costConfig.api_token,
            scriptName,
          }),
        })),
    );
    const nonStandardUsageModels = usageModels.filter((entry) => entry.usage_model !== 'standard');
    if (nonStandardUsageModels.length > 0) {
      throw createOpsPreconditionError(
        `Cloudflare Worker usage_model must be standard for TEST-COST-001, received ${nonStandardUsageModels.map((entry) => `${entry.script_name}=${entry.usage_model}`).join(', ')}`,
        {
          status: 503,
          code: 'internal',
          retryable: false,
        },
      );
    }
    throw createOpsInternalError(
      'TEST-COST-001 pre-release proof remains fail-closed: current official Cloudflare surfaces do not yet support a truthful actual_total_usd and model_comparison for this bounded pre-release window; see OQ-0006.',
      {
        retryable: false,
        details: buildCostObservationBlockerDetails(),
      },
    );
  } catch (error) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: stableString(error?.code) || 'internal',
      message: error?.message ?? 'Cost observation failed',
      retryable: error?.retryable === true,
      details: error?.details ?? null,
    });
  }
}

async function handleRolloutSkewProbe(request, env, config, requestContext) {
  const operator = await authenticateOperatorIdentity({
    request,
    env,
    config,
    requiredScope: 'ops.rebuild.write',
  });
  if (request.method !== 'POST') {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'not_found',
      message: 'Unsupported rollout skew probe method',
    });
  }
  authorizeOperatorRequest({
    operator,
    targetScope: {
      scope_kind: 'global',
      scope_id: null,
    },
  });
  if (config.environmentName !== 'pre-release') {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: 'precondition_failed',
      message: 'Rollout skew probing is only supported in pre-release',
    });
  }

  try {
    const probeRequest = normalizeRolloutSkewProbeRequest(await readJsonBody(request));
    const gatewayConfig = requireGatewayProbeConfiguration(env);
    const serverName = stableString(env.MATRIX_SERVER_NAME);
    if (serverName.length === 0) {
      throw createOpsPreconditionError('ops-worker requires MATRIX_SERVER_NAME for rollout-skew probing', {
        status: 503,
        code: 'internal',
        retryable: true,
      });
    }

    const baselineUser = await seedProbeUserForVersion(env, gatewayConfig, probeRequest, {
      userLabel: 'baseline-user',
      gatewayVersionId: probeRequest.baseline_gateway_version_id,
      expectedAuthorityVersionId: probeRequest.baseline_gateway_version_id,
    });

    const baselineRoom = await seedProbeRoomForVersion(env, gatewayConfig, probeRequest, {
      roomLabel: 'baseline-room',
      gatewayVersionId: probeRequest.baseline_gateway_version_id,
      accessToken: baselineUser.access_token,
      serverName,
      expectedAuthorityVersionId: probeRequest.baseline_gateway_version_id,
    });

    const candidateUser = await seedProbeUserForVersion(env, gatewayConfig, probeRequest, {
      userLabel: 'candidate-user',
      gatewayVersionId: probeRequest.candidate_gateway_version_id,
      expectedAuthorityVersionId: probeRequest.candidate_gateway_version_id,
    });

    const candidateRoom = await seedProbeRoomForVersion(env, gatewayConfig, probeRequest, {
      roomLabel: 'candidate-room',
      gatewayVersionId: probeRequest.candidate_gateway_version_id,
      accessToken: candidateUser.access_token,
      serverName,
      expectedAuthorityVersionId: probeRequest.candidate_gateway_version_id,
    });

    const observations = [];

    const candidateWhoAmI = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
      versionId: probeRequest.candidate_gateway_version_id,
      pathname: '/_matrix/client/v3/account/whoami',
      accessToken: baselineUser.access_token,
    });
    if (candidateWhoAmI.response.status !== 200) {
      throw createOpsPreconditionError(`Candidate-targeted whoami probe failed: ${JSON.stringify(candidateWhoAmI.payload)}`);
    }
    const postCandidateUserIdentity = await inspectUserAuthority(env, baselineUser.user_id);
    observations.push(buildRolloutObservation({
      probeName: 'new-worker-old-authority',
      requestGatewayVersionId: probeRequest.candidate_gateway_version_id,
      observedGatewayVersionId: candidateWhoAmI.observed_gateway_version_id,
      authorityVersionId: postCandidateUserIdentity.worker_version_id,
      authorityKind: 'UserDO',
      authorityKey: baselineUser.user_id,
      requestPath: '/_matrix/client/v3/account/whoami',
    }));

    const candidateRoomState = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
      versionId: probeRequest.candidate_gateway_version_id,
      pathname: `/_matrix/client/v3/rooms/${encodeURIComponent(baselineRoom.room_id)}/state`,
      accessToken: baselineUser.access_token,
    });
    if (candidateRoomState.response.status !== 200) {
      throw createOpsPreconditionError(`Candidate-targeted room state probe failed: ${JSON.stringify(candidateRoomState.payload)}`);
    }
    const postCandidateRoomIdentity = await inspectRoomAuthority(env, baselineRoom.room_id);
    observations.push(buildRolloutObservation({
      probeName: 'new-worker-old-authority',
      requestGatewayVersionId: probeRequest.candidate_gateway_version_id,
      observedGatewayVersionId: candidateRoomState.observed_gateway_version_id,
      authorityVersionId: postCandidateRoomIdentity.worker_version_id,
      authorityKind: 'RoomDO',
      authorityKey: baselineRoom.room_id,
      requestPath: `/_matrix/client/v3/rooms/${baselineRoom.room_id}/state`,
    }));

    const baselineWhoAmI = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
      versionId: probeRequest.baseline_gateway_version_id,
      pathname: '/_matrix/client/v3/account/whoami',
      accessToken: candidateUser.access_token,
    });
    if (baselineWhoAmI.response.status !== 200) {
      throw createOpsPreconditionError(`Baseline-targeted whoami probe failed: ${JSON.stringify(baselineWhoAmI.payload)}`);
    }
    const postBaselineUserIdentity = await inspectUserAuthority(env, candidateUser.user_id);
    observations.push(buildRolloutObservation({
      probeName: 'old-worker-new-authority',
      requestGatewayVersionId: probeRequest.baseline_gateway_version_id,
      observedGatewayVersionId: baselineWhoAmI.observed_gateway_version_id,
      authorityVersionId: postBaselineUserIdentity.worker_version_id,
      authorityKind: 'UserDO',
      authorityKey: candidateUser.user_id,
      requestPath: '/_matrix/client/v3/account/whoami',
    }));

    const baselineRoomState = await fetchGatewayWithVersionOverride(env, gatewayConfig, {
      versionId: probeRequest.baseline_gateway_version_id,
      pathname: `/_matrix/client/v3/rooms/${encodeURIComponent(candidateRoom.room_id)}/state`,
      accessToken: candidateUser.access_token,
    });
    if (baselineRoomState.response.status !== 200) {
      throw createOpsPreconditionError(`Baseline-targeted room state probe failed: ${JSON.stringify(baselineRoomState.payload)}`);
    }
    const postBaselineRoomIdentity = await inspectRoomAuthority(env, candidateRoom.room_id);
    observations.push(buildRolloutObservation({
      probeName: 'old-worker-new-authority',
      requestGatewayVersionId: probeRequest.baseline_gateway_version_id,
      observedGatewayVersionId: baselineRoomState.observed_gateway_version_id,
      authorityVersionId: postBaselineRoomIdentity.worker_version_id,
      authorityKind: 'RoomDO',
      authorityKey: candidateRoom.room_id,
      requestPath: `/_matrix/client/v3/rooms/${candidateRoom.room_id}/state`,
    }));

    const assertions = evaluateRolloutAssertions(observations, {
      baselineGatewayVersionId: probeRequest.baseline_gateway_version_id,
      candidateGatewayVersionId: probeRequest.candidate_gateway_version_id,
    });

    return jsonResponse(normalizeRolloutSkewProbeResponse({
      environment_name: config.environmentName,
      probe_run_id: probeRequest.probe_run_id,
      dual_version_deployment_id: probeRequest.dual_version_deployment_id,
      baseline_gateway_version_id: probeRequest.baseline_gateway_version_id,
      candidate_gateway_version_id: probeRequest.candidate_gateway_version_id,
      override_strategy: 'cloudflare-version-overrides',
      observations,
      assertions,
    }));
  } catch (error) {
    return opsErrorResponse({
      requestId: requestContext.requestId,
      code: stableString(error?.code) || 'validation_failed',
      message: error?.message ?? 'Rollout skew probe failed',
      retryable: error?.retryable === true,
    });
  }
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
    mutate: async (tx) => {
      const now = new Date().toISOString();
      await tx.upsertAppserviceConfig({
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
      mutate: async (tx) => {
        await tx.deleteAppserviceConfig(appserviceId);
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
    prepare: async (tx) => tx.getAppserviceConfig(appserviceId),
    mutate: async (tx, existing) => {
      const createdAt = existing?.created_at ?? new Date().toISOString();
      await tx.upsertAppserviceConfig({
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

      if (info.kind === 'rollout-skew-probe') {
        return await handleRolloutSkewProbe(request, env, config, requestContext);
      }

      if (info.kind === 'cost-observation') {
        return await handleCostObservation(request, env, config, requestContext);
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
