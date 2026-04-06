import { spawn } from 'node:child_process';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  webcrypto,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  createWranglerConfigSnapshot,
  listDurableObjectClassNames,
  listWorkerNames,
} from '../../runtime-core/src/index.mjs';
import {
  CONTROL_PLANE_SCHEMA_SQL,
  normalizePreReleaseCostObservation,
  normalizeRolloutSkewProbeResponse,
} from '../../control-plane/src/index.mjs';
import {
  assessNonLocalEnvironmentHarnessReadiness,
  validateEnvironmentRunExecutionProof,
  validateRolloutSkewProbeSemantics,
  validateEvidenceAttestationBundle,
  validateManualArtifactPayload,
} from './evidence.mjs';
import {
  buildEnvironmentRateLimitNamespaceId,
  listEnvironmentRateLimitNamespaces,
  listProductionRateLimitNamespaces,
} from './cloudflare-resources.mjs';
import {
  getTestEnvironmentDirectory,
  getReleaseGateTestFiles,
} from './bootstrap.mjs';
import {
  CLIENT_DISCOVERY_BROWSER_ORIGIN,
  hasClientDiscoveryBrowserCors,
  summarizeClientDiscoveryVersionPayload,
} from './client-discovery.mjs';

const NON_LOCAL_ENVIRONMENT_NAMES = Object.freeze([
  'ci-integration',
  'staging',
  'pre-release',
]);
const PRODUCTION_ENVIRONMENT_NAME = 'prod';
const DEPLOYABLE_ENVIRONMENT_NAMES = Object.freeze([
  ...NON_LOCAL_ENVIRONMENT_NAMES,
  PRODUCTION_ENVIRONMENT_NAME,
]);

const WORKER_DEPLOYMENT_ORDER = Object.freeze([
  'jobs-worker',
  'ops-worker',
  'gateway-worker',
]);

const WORKER_BOOTSTRAP_ORDER = Object.freeze([
  'gateway-worker',
  'jobs-worker',
  'ops-worker',
  'gateway-worker',
]);

const WORKER_SECRETS = Object.freeze({
  'gateway-worker': Object.freeze([
    'HOMESERVER_SIGNING_KEY_RING',
    'SESSION_ROOT_KEY_RING',
    'UIA_ROOT_KEY_RING',
    'APPSERVICE_TOKEN_SET',
  ]),
  'jobs-worker': Object.freeze([
    'EXPORT_BUNDLE_KEY_RING',
  ]),
  'ops-worker': Object.freeze([
    'EXPORT_BUNDLE_KEY_RING',
  ]),
});

const QUEUE_BINDING_NAMES = Object.freeze([
  ['SEARCH_INDEX_QUEUE', 'matrix-search-index-job'],
  ['MEDIA_THUMBNAIL_QUEUE', 'matrix-media-thumbnail-job'],
  ['APPSERVICE_TXN_QUEUE', 'matrix-appservice-txn-job'],
  ['REBUILD_SHARD_QUEUE', 'matrix-rebuild-shard-job'],
  ['EXPORT_SHARD_QUEUE', 'matrix-export-shard-job'],
  ['RESTORE_SHARD_QUEUE', 'matrix-restore-shard-job'],
  ['REPAIR_SHARD_QUEUE', 'matrix-repair-shard-job'],
]);

const WORKER_TAG_ALIASES = Object.freeze({
  'gateway-worker': 'gw',
  'jobs-worker': 'jw',
  'ops-worker': 'ow',
});

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DEFAULT_RELEASE_PROFILE = 'L1';
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_MISSING_WORKER_ERROR_MESSAGE = 'This Worker does not exist on your account.';
const CLOUDFLARE_WORKER_TAG_MAX_LENGTH = 25;
const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_ACTIONS_OIDC_JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const GITHUB_ACTIONS_OIDC_AUDIENCE = 'matrix-phase08-nonlocal';
const NON_LOCAL_ACCESS_APPLICATION_SESSION_DURATION = '24h';
const NON_LOCAL_ACCESS_SERVICE_TOKEN_DURATION = '8760h';
const NON_LOCAL_READINESS_MAX_ATTEMPTS = 7;
const NON_LOCAL_READINESS_INITIAL_DELAY_MS = 2_000;
const NON_LOCAL_READINESS_MAX_DELAY_MS = 15_000;
const NON_LOCAL_READINESS_REQUEST_TIMEOUT_MS = 10_000;
const PRE_RELEASE_ROLLOUT_BASELINE_PERCENTAGE = 50;
const PRE_RELEASE_ROLLOUT_CANDIDATE_PERCENTAGE = 50;
const PROD_GATEWAY_GRADUAL_PERCENTAGES = Object.freeze([10, 50, 100]);
const BILLING_PERIOD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GIT_SHA1_RE = /^[a-f0-9]{40}$/;
let githubActionsOidcIdentityPromise = null;
let githubActionsJwksPromise = null;

export function buildProductionWorkerPromotionReadinessOptions(workerName) {
  if (!WORKER_DEPLOYMENT_ORDER.includes(workerName)) {
    throw new RangeError(`Unsupported production worker "${workerName}"`);
  }
  return Object.freeze({
    requireBrowserCompatibleVersionLadder: workerName === 'gateway-worker',
  });
}

export function buildProductionGatewayRolloutReadinessOptions(percentage) {
  if (!Number.isInteger(percentage) || percentage <= 0 || percentage > 100) {
    throw new RangeError('production gateway rollout percentage must be an integer between 1 and 100');
  }
  return Object.freeze({
    requireBrowserCompatibleVersionLadder: percentage === 100,
  });
}

function assertNonLocalEnvironmentName(environmentName) {
  if (!NON_LOCAL_ENVIRONMENT_NAMES.includes(environmentName)) {
    throw new RangeError(`Unsupported non-local environment "${environmentName}"`);
  }
  return environmentName;
}

function assertDeployableEnvironmentName(environmentName) {
  if (!DEPLOYABLE_ENVIRONMENT_NAMES.includes(environmentName)) {
    throw new RangeError(`Unsupported deployable environment "${environmentName}"`);
  }
  return environmentName;
}

function environmentRequiresOpsAccess(environmentName) {
  return environmentName === 'staging'
    || environmentName === 'pre-release'
    || environmentName === PRODUCTION_ENVIRONMENT_NAME;
}

function assertRequiredOpsAccessRemoteHarnessEnv(environmentName, remoteHarnessEnv) {
  if (!environmentRequiresOpsAccess(environmentName)) {
    return;
  }
  if (!isNonEmptyString(remoteHarnessEnv.MATRIX_REMOTE_OPS_BASE_URL)) {
    throw new RangeError(`Remote ${environmentName} harness must expose MATRIX_REMOTE_OPS_BASE_URL`);
  }
  if (!isNonEmptyString(remoteHarnessEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID)) {
    throw new RangeError(`Remote ${environmentName} harness must provide MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID`);
  }
  if (!isNonEmptyString(remoteHarnessEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET)) {
    throw new RangeError(`Remote ${environmentName} harness must provide MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET`);
  }
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function stableString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeBase64UrlToBuffer(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`GitHub Actions OIDC ${label} must be non-empty`);
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    throw new Error(`GitHub Actions OIDC ${label} is not valid base64url`);
  }
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`GitHub Actions OIDC ${label} is not valid JSON`);
  }
}

function audClaimIncludesAudience(audClaim, expectedAudience) {
  return audClaim === expectedAudience
    || (Array.isArray(audClaim) && audClaim.includes(expectedAudience));
}

async function fetchGitHubActionsJwks() {
  if (githubActionsJwksPromise == null) {
    githubActionsJwksPromise = (async () => {
      const response = await fetch(GITHUB_ACTIONS_OIDC_JWKS_URI);
      if (!response.ok) {
        throw new Error(`Unable to fetch GitHub Actions JWKS: ${response.status}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.keys) || payload.keys.length === 0) {
        throw new Error('GitHub Actions JWKS response did not include keys');
      }
      return payload.keys;
    })().catch((error) => {
      githubActionsJwksPromise = null;
      throw error;
    });
  }
  return githubActionsJwksPromise;
}

async function verifyGitHubActionsOidcToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('GitHub Actions OIDC token must be non-empty');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('GitHub Actions OIDC token must be a JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonBuffer(decodeBase64UrlToBuffer(encodedHeader, 'token header'), 'token header');
  const claims = parseJsonBuffer(decodeBase64UrlToBuffer(encodedPayload, 'token payload'), 'token payload');
  if (header.alg !== 'RS256') {
    throw new Error('GitHub Actions OIDC token must use RS256');
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new Error('GitHub Actions OIDC token must include a key id');
  }
  const signature = decodeBase64UrlToBuffer(encodedSignature, 'token signature');
  const jwks = await fetchGitHubActionsJwks();
  const jwk = jwks.find((candidate) => candidate?.kid === header.kid);
  if (jwk == null) {
    throw new Error('Unable to verify GitHub Actions OIDC token signature');
  }
  const verificationKey = await webcrypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify'],
  );
  const data = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
  const verified = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', verificationKey, signature, data);
  if (!verified) {
    throw new Error('Unable to verify GitHub Actions OIDC token signature');
  }
  return claims;
}

async function requestGitHubActionsOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? null;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? null;
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) {
    throw new Error('GitHub Actions OIDC request URL is required');
  }
  if (typeof requestToken !== 'string' || requestToken.length === 0) {
    throw new Error('GitHub Actions OIDC request token is required');
  }
  const tokenUrl = new URL(requestUrl);
  tokenUrl.searchParams.set('audience', GITHUB_ACTIONS_OIDC_AUDIENCE);
  const response = await fetch(tokenUrl, {
    headers: {
      authorization: `Bearer ${requestToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Actions OIDC token request failed: ${response.status}`);
  }
  const payload = await response.json();
  if (typeof payload?.value !== 'string' || payload.value.length === 0) {
    throw new Error('GitHub Actions OIDC token response did not include a token value');
  }
  return payload.value;
}

async function getGitHubActionsOidcIdentity() {
  if (githubActionsOidcIdentityPromise == null) {
    githubActionsOidcIdentityPromise = (async () => {
      if (process.env.GITHUB_ACTIONS !== 'true') {
        throw new Error('GitHub Actions job identity is required');
      }
      const repository = process.env.GITHUB_REPOSITORY ?? null;
      const runId = process.env.GITHUB_RUN_ID ?? null;
      const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? null;
      if (typeof repository !== 'string' || repository.length === 0) {
        throw new Error('GitHub Actions repository identity is required');
      }
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new Error('GitHub Actions run id is required');
      }
      if (typeof runAttempt !== 'string' || runAttempt.length === 0) {
        throw new Error('GitHub Actions run attempt is required');
      }
      const token = await requestGitHubActionsOidcToken();
      const claims = await verifyGitHubActionsOidcToken(token);
      if (claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER) {
        throw new Error('GitHub Actions OIDC issuer mismatch');
      }
      if (!audClaimIncludesAudience(claims.aud, GITHUB_ACTIONS_OIDC_AUDIENCE)) {
        throw new Error('GitHub Actions OIDC audience mismatch');
      }
      if (String(claims.repository ?? '') !== repository) {
        throw new Error('GitHub Actions OIDC repository claim mismatch');
      }
      if (String(claims.run_id ?? '') !== runId) {
        throw new Error('GitHub Actions OIDC run_id claim mismatch');
      }
      if (String(claims.run_attempt ?? '') !== runAttempt) {
        throw new Error('GitHub Actions OIDC run_attempt claim mismatch');
      }
      if (typeof claims.runner_environment !== 'string' || claims.runner_environment.length === 0) {
        throw new Error('GitHub Actions OIDC runner_environment claim is required');
      }
      if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
        throw new Error('GitHub Actions OIDC token is expired');
      }
      return claims;
    })().catch((error) => {
      githubActionsOidcIdentityPromise = null;
      throw error;
    });
  }
  return githubActionsOidcIdentityPromise;
}

async function requireGitHubActionsExecution(operationName, {
  expectedEnvironmentName = null,
} = {}) {
  const claims = await getGitHubActionsOidcIdentity();
  if (expectedEnvironmentName != null) {
    if (typeof claims.environment !== 'string' || claims.environment.length === 0) {
      throw new Error(`GitHub Actions OIDC environment claim is required for ${operationName}`);
    }
    if (claims.environment !== expectedEnvironmentName) {
      throw new Error(`${operationName} requires GitHub Actions environment ${expectedEnvironmentName}`);
    }
  }
  return claims;
}

function sortUniqueStringArray(values) {
  return [...new Set(
    values
      .filter((value) => isNonEmptyString(value))
      .map((value) => String(value)),
  )].sort();
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256FileHex(filePath) {
  return sha256Hex(await fs.readFile(filePath));
}

function normalizePathForMarkdown(value) {
  return String(value).replaceAll(path.sep, '/');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry));
}

function normalizeWorkersSubdomain(value, label = 'workersSubdomain') {
  if (!isNonEmptyString(value)) {
    throw new RangeError(`${label} must be non-empty`);
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new RangeError(`${label} must contain only lowercase letters, digits, and hyphens`);
  }
  return normalized;
}

function buildWorkersDevHost(scriptName, workersSubdomain) {
  return `${scriptName}.${normalizeWorkersSubdomain(workersSubdomain)}.workers.dev`;
}

function isDisallowedLocalHostname(hostname) {
  if (!isNonEmptyString(hostname)) {
    return true;
  }
  const normalized = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const isPrivateOrLoopbackIpv4 = (value) => {
    const normalizedIpv4 = String(value).trim().toLowerCase();
    const [firstOctet, secondOctet] = normalizedIpv4.split('.').map(Number);
    return firstOctet === 0
      || firstOctet === 10
      || firstOctet === 127
      || (firstOctet === 169 && secondOctet === 254)
      || (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31)
      || (firstOctet === 192 && secondOctet === 168);
  };
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'local'
    || normalized.endsWith('.local')
    || normalized === '0.0.0.0'
    || normalized === '::1'
  ) {
    return true;
  }
  if (normalized.startsWith('::ffff:') || normalized.startsWith('0:0:0:0:0:ffff:')) {
    return true;
  }
  if (/^[0-9.]+$/.test(normalized) && normalized.includes('.')) {
    return isPrivateOrLoopbackIpv4(normalized);
  }
  return false;
}

function parseAbsoluteHttpsUrl(value, label) {
  if (!isNonEmptyString(value)) {
    throw new RangeError(`${label} must be non-empty`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError(`${label} must be an absolute https URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.host.length === 0) {
    throw new RangeError(`${label} must be an absolute https URL`);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new RangeError(`${label} must not include query or fragment components`);
  }
  if (isDisallowedLocalHostname(parsed.hostname)) {
    throw new RangeError(`${label} must not target a local or loopback host`);
  }
  return parsed;
}

function slugifyLabel(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function buildWorkerScriptBaseName(workerName) {
  return `matrix-${workerName}`;
}

export function buildWorkerScriptName(workerName, environmentName) {
  return `${buildWorkerScriptBaseName(workerName)}-${assertNonLocalEnvironmentName(environmentName)}`;
}

export function buildProductionWorkerScriptName(workerName) {
  return `${buildWorkerScriptBaseName(workerName)}-${PRODUCTION_ENVIRONMENT_NAME}`;
}

function buildResourceSuffix(environmentName) {
  return assertDeployableEnvironmentName(environmentName);
}

function buildAccessApplicationName(environmentName) {
  return `matrix-phase08-${assertDeployableEnvironmentName(environmentName)}-ops`;
}

function buildAccessPolicyName(environmentName) {
  return `matrix-phase08-${assertDeployableEnvironmentName(environmentName)}-gha-service-auth`;
}

function buildAccessServiceTokenName(environmentName) {
  return `matrix-phase08-${assertDeployableEnvironmentName(environmentName)}-gha-service-token`;
}

function buildOperatorPolicyPrincipalId(environmentName) {
  return `matrix-phase08-${assertDeployableEnvironmentName(environmentName)}-gha-ops`;
}

function buildResourceBindingNames(environmentName) {
  const suffix = buildResourceSuffix(environmentName);
  return Object.freeze({
    d1_databases: Object.freeze({
      MATRIX_CONTROL_D1: `matrix-control-and-derived-${suffix}`,
    }),
    r2_buckets: Object.freeze({
      MATRIX_MEDIA_BUCKET: `matrix-media-${suffix}`,
      MATRIX_ARCHIVE_BUCKET: `matrix-archive-${suffix}`,
    }),
    kv_namespaces: Object.freeze({
      MATRIX_EDGE_CACHE: `matrix-edge-cache-${suffix}`,
    }),
    queues: Object.freeze(Object.fromEntries(
      QUEUE_BINDING_NAMES.map(([bindingName, baseQueueName]) => [bindingName, `${baseQueueName}-${suffix}`]),
    )),
  });
}

function buildEnvironmentPlan(environmentName, {
  workersSubdomain = null,
  releaseProfile = DEFAULT_RELEASE_PROFILE,
} = {}) {
  const normalizedEnvironmentName = assertDeployableEnvironmentName(environmentName);
  const normalizedWorkersSubdomain = workersSubdomain == null
    ? null
    : normalizeWorkersSubdomain(workersSubdomain, 'workersSubdomain');
  const workerScripts = Object.freeze(Object.fromEntries(
    listWorkerNames().map((workerName) => [
      workerName,
      normalizedEnvironmentName === PRODUCTION_ENVIRONMENT_NAME
        ? buildProductionWorkerScriptName(workerName)
        : buildWorkerScriptName(workerName, normalizedEnvironmentName),
    ]),
  ));
  const resourceBindingNames = buildResourceBindingNames(normalizedEnvironmentName);
  const workerUrls = normalizedWorkersSubdomain == null
    ? Object.freeze({})
    : Object.freeze(Object.fromEntries(
      Object.entries(workerScripts).map(([workerName, scriptName]) => [
        workerName,
        `https://${buildWorkersDevHost(scriptName, normalizedWorkersSubdomain)}`,
      ]),
    ));
  return Object.freeze({
    environment_name: normalizedEnvironmentName,
    release_profile: releaseProfile,
    workers_subdomain: normalizedWorkersSubdomain,
    worker_scripts: workerScripts,
    worker_urls: workerUrls,
    runtime_resource_binding_names: resourceBindingNames,
    artifact_bucket_name: `matrix-evidence-${normalizedEnvironmentName}`,
    kv_namespace_title: resourceBindingNames.kv_namespaces.MATRIX_EDGE_CACHE,
    d1_database_name: resourceBindingNames.d1_databases.MATRIX_CONTROL_D1,
    cloudflare_resources: Object.freeze({
      workers: Object.freeze(Object.values(workerScripts)),
      durable_objects: Object.freeze(listDurableObjectClassNames()),
      d1_databases: Object.freeze([resourceBindingNames.d1_databases.MATRIX_CONTROL_D1]),
      r2_buckets: Object.freeze([
        resourceBindingNames.r2_buckets.MATRIX_MEDIA_BUCKET,
        resourceBindingNames.r2_buckets.MATRIX_ARCHIVE_BUCKET,
      ]),
      kv_namespaces: Object.freeze([resourceBindingNames.kv_namespaces.MATRIX_EDGE_CACHE]),
      ratelimit_namespaces: normalizedEnvironmentName === PRODUCTION_ENVIRONMENT_NAME
        ? listProductionRateLimitNamespaces()
        : listEnvironmentRateLimitNamespaces(normalizedEnvironmentName),
      queues: Object.freeze(Object.values(resourceBindingNames.queues)),
    }),
    deployment_order: WORKER_DEPLOYMENT_ORDER,
    bootstrap_order: WORKER_BOOTSTRAP_ORDER,
  });
}

export function buildNonLocalEnvironmentPlan(environmentName, options = {}) {
  assertNonLocalEnvironmentName(environmentName);
  return buildEnvironmentPlan(environmentName, options);
}

export function buildProductionEnvironmentPlan({
  workersSubdomain = null,
  releaseProfile = DEFAULT_RELEASE_PROFILE,
} = {}) {
  return buildEnvironmentPlan(PRODUCTION_ENVIRONMENT_NAME, {
    workersSubdomain,
    releaseProfile,
  });
}

function buildExpectedProductionCloudflareResources() {
  return Object.freeze({
    workers: Object.freeze(listWorkerNames().map((workerName) => buildProductionWorkerScriptName(workerName)).sort()),
    durable_objects: Object.freeze(listDurableObjectClassNames()),
    d1_databases: Object.freeze(['matrix-control-and-derived-prod']),
    r2_buckets: Object.freeze([
      'matrix-archive-prod',
      'matrix-evidence-prod',
      'matrix-media-prod',
    ].sort()),
    kv_namespaces: Object.freeze(['matrix-edge-cache-prod']),
    ratelimit_namespaces: listProductionRateLimitNamespaces(),
    queues: Object.freeze(QUEUE_BINDING_NAMES.map(([, baseQueueName]) => `${baseQueueName}-prod`).sort()),
  });
}

function normalizeAccessDomainPath(value, label) {
  if (!isNonEmptyString(value)) {
    throw new RangeError(`${label} must be non-empty`);
  }
  const normalized = value.trim().replace(/^https?:\/\//iu, '').replace(/\/+$/, '');
  if (normalized.length === 0 || normalized.includes('?') || normalized.includes('#')) {
    throw new RangeError(`${label} must be a hostname or hostname/path without query or fragment`);
  }
  if (normalized.includes('://')) {
    throw new RangeError(`${label} must not include a scheme`);
  }
  return normalized;
}

function buildAccessAppDomainForPlan(plan) {
  const opsUrl = plan.worker_urls['ops-worker'] ?? `https://${plan.worker_scripts['ops-worker']}.workers.dev`;
  const parsedOpsUrl = parseAbsoluteHttpsUrl(opsUrl, 'ops worker URL');
  return normalizeAccessDomainPath(parsedOpsUrl.host, 'ops access app domain');
}

function buildAccessApplicationRequestBody(plan) {
  const accessDomain = buildAccessAppDomainForPlan(plan);
  return Object.freeze({
    name: buildAccessApplicationName(plan.environment_name),
    type: 'self_hosted',
    domain: accessDomain,
    app_launcher_visible: false,
    self_hosted_domains: [accessDomain],
    destinations: [
      {
        type: 'public',
        uri: accessDomain,
      },
    ],
    service_auth_401_redirect: true,
    session_duration: NON_LOCAL_ACCESS_APPLICATION_SESSION_DURATION,
  });
}

function deriveStableSecretBytes({
  secretMaterial,
  accountId,
  environmentName,
  label,
}) {
  return createHmac('sha256', String(secretMaterial))
    .update(`matrixflare:${accountId}:${environmentName}:${label}`)
    .digest();
}

function buildOpaqueKeyRing(secretBytes) {
  return JSON.stringify({
    active: 'v1',
    keys: {
      v1: {
        secret_base64: secretBytes.toString('base64'),
      },
    },
  });
}

function buildDeterministicEd25519PemPair(secretBytes) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, secretBytes.subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  return {
    private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    public_key_pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function buildEnvironmentSecretBundle({
  environmentName,
  accountId,
  secretMaterial,
  observabilityApiToken,
}) {
  const normalizedEnvironmentName = assertDeployableEnvironmentName(environmentName);
  if (!isNonEmptyString(accountId)) {
    throw new TypeError('accountId must be non-empty');
  }
  if (!isNonEmptyString(secretMaterial)) {
    throw new TypeError('secretMaterial must be non-empty');
  }
  const resolvedObservabilityApiToken = typeof observabilityApiToken === 'string' && observabilityApiToken.trim().length > 0
    ? observabilityApiToken
    : secretMaterial;
  const signingKeyBytes = deriveStableSecretBytes({
    secretMaterial,
    accountId,
    environmentName: normalizedEnvironmentName,
    label: 'export-signing-key',
  });
  const encryptionKeyBytes = deriveStableSecretBytes({
    secretMaterial,
    accountId,
    environmentName: normalizedEnvironmentName,
    label: 'export-encryption-key',
  });
  const exportPemPair = buildDeterministicEd25519PemPair(signingKeyBytes);
  const rolloutProbeSharedSecret = createHash('sha256')
    .update(deriveStableSecretBytes({
      secretMaterial,
      accountId,
      environmentName: normalizedEnvironmentName,
      label: 'rollout-probe-shared-secret',
    }))
    .digest('hex');
  return Object.freeze({
    gateway: Object.freeze({
      HOMESERVER_SIGNING_KEY_RING: buildOpaqueKeyRing(deriveStableSecretBytes({
        secretMaterial,
        accountId,
        environmentName: normalizedEnvironmentName,
        label: 'homeserver-signing-key-ring',
      })),
      SESSION_ROOT_KEY_RING: buildOpaqueKeyRing(deriveStableSecretBytes({
        secretMaterial,
        accountId,
        environmentName: normalizedEnvironmentName,
        label: 'session-root-key-ring',
      })),
      UIA_ROOT_KEY_RING: buildOpaqueKeyRing(deriveStableSecretBytes({
        secretMaterial,
        accountId,
        environmentName: normalizedEnvironmentName,
        label: 'uia-root-key-ring',
      })),
      APPSERVICE_TOKEN_SET: createHash('sha256')
        .update(deriveStableSecretBytes({
          secretMaterial,
          accountId,
          environmentName: normalizedEnvironmentName,
          label: 'appservice-token-set',
        }))
        .digest('hex'),
      ROLLOUT_PROBE_SHARED_SECRET: rolloutProbeSharedSecret,
    }),
    jobs: Object.freeze({
      EXPORT_BUNDLE_KEY_RING: JSON.stringify({
        signing: {
          active: 'sig-v1',
          keys: {
            'sig-v1': exportPemPair,
          },
        },
        encryption: {
          active: 'enc-v1',
          keys: {
            'enc-v1': {
              key_base64: encryptionKeyBytes.subarray(0, 32).toString('base64'),
            },
          },
        },
      }),
    }),
    ops: Object.freeze({
      EXPORT_BUNDLE_KEY_RING: JSON.stringify({
        signing: {
          active: 'sig-v1',
          keys: {
            'sig-v1': exportPemPair,
          },
        },
        encryption: {
          active: 'enc-v1',
          keys: {
            'enc-v1': {
              key_base64: encryptionKeyBytes.subarray(0, 32).toString('base64'),
            },
          },
        },
      }),
      ROLLOUT_PROBE_SHARED_SECRET: rolloutProbeSharedSecret,
      CLOUDFLARE_OBSERVABILITY_API_TOKEN: String(resolvedObservabilityApiToken),
    }),
  });
}

export function buildNonProductionSecretBundle({
  environmentName,
  accountId,
  apiToken,
  observabilityApiToken = apiToken,
}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  return buildEnvironmentSecretBundle({
    environmentName: normalizedEnvironmentName,
    accountId,
    secretMaterial: apiToken,
    observabilityApiToken,
  });
}

export function buildProductionSecretBundle({
  accountId,
  secretSeed,
  observabilityApiToken = process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN ?? secretSeed,
}) {
  return buildEnvironmentSecretBundle({
    environmentName: PRODUCTION_ENVIRONMENT_NAME,
    accountId,
    secretMaterial: secretSeed,
    observabilityApiToken,
  });
}

function structuredCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolvePlanRateLimitNamespaceId(environmentName, namespaceId) {
  if (environmentName === PRODUCTION_ENVIRONMENT_NAME) {
    return String(namespaceId);
  }
  return buildEnvironmentRateLimitNamespaceId(environmentName, namespaceId);
}

function requireProductionSecretSeed(explicitSecretSeed = null) {
  const secretSeed = explicitSecretSeed ?? process.env.MATRIX_PROD_SECRET_SEED ?? null;
  if (!isNonEmptyString(secretSeed)) {
    throw new RangeError('MATRIX_PROD_SECRET_SEED is required for production deploy/promote tooling');
  }
  return secretSeed;
}

function buildDeploymentSecretBundle(environmentName, {
  accountId,
  apiToken,
  productionSecretSeed = null,
  observabilityApiToken = process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN,
}) {
  if (environmentName === PRODUCTION_ENVIRONMENT_NAME) {
    return buildProductionSecretBundle({
      accountId,
      secretSeed: requireProductionSecretSeed(productionSecretSeed),
      observabilityApiToken,
    });
  }
  return buildNonProductionSecretBundle({
    environmentName,
    accountId,
    apiToken,
    observabilityApiToken,
  });
}

function buildWorkerVars(workerName, plan, {
  deploymentId,
  workerVersionId,
  activeDeploymentComposition,
  access = null,
  cloudflareAccountId = '',
  cloudflareResourceIds = null,
}) {
  const baseUrl = plan.worker_urls['gateway-worker'] ?? `https://${plan.worker_scripts['gateway-worker']}.workers.dev`;
  const opsUrl = plan.worker_urls['ops-worker'] ?? `https://${plan.worker_scripts['ops-worker']}.workers.dev`;
  const vars = {
    ENVIRONMENT_NAME: plan.environment_name,
    MATRIX_SERVER_NAME: new URL(baseUrl).host,
    RELEASE_PROFILE: plan.release_profile,
    WORKER_VERSION_ID: workerVersionId,
    DEPLOYMENT_ID: deploymentId,
    ACTIVE_DEPLOYMENT_COMPOSITION: JSON.stringify(activeDeploymentComposition),
    RESOURCE_BINDING_NAMES_JSON: JSON.stringify(plan.runtime_resource_binding_names),
    MATRIX_PUBLIC_BASE_URL: baseUrl,
    MANAGEMENT_API_BASE_URL: opsUrl,
  };
  if (workerName === 'ops-worker') {
    if (!isPlainObject(access)) {
      throw new TypeError('ops-worker non-local deploy requires access metadata');
    }
    vars.GATEWAY_WORKER_SCRIPT_NAME = plan.worker_scripts['gateway-worker'];
    if (!isNonEmptyString(access.auth_domain)) {
      throw new TypeError('ops-worker access.auth_domain must be non-empty');
    }
    if (!isNonEmptyString(access.application_audience)) {
      throw new TypeError('ops-worker access.application_audience must be non-empty');
    }
    vars.ACCESS_TEAM_DOMAIN = access.auth_domain;
    vars.ACCESS_AUDIENCE = access.application_audience;
    vars.CLOUDFLARE_ACCOUNT_ID = String(cloudflareAccountId ?? '');
    vars.CLOUDFLARE_RESOURCE_IDS_JSON = cloudflareResourceIds == null
      ? ''
      : JSON.stringify(cloudflareResourceIds);
  }
  return vars;
}

function toWranglerPath(value) {
  return String(value).split(path.sep).join('/');
}

function resolveWorkerEntryPointPath(workerName, repoRoot, relativeMainPath) {
  return path.resolve(repoRoot, 'apps', workerName, relativeMainPath);
}

export function createEnvironmentWranglerConfig(workerName, plan, {
  d1DatabaseId,
  kvNamespaceId,
  gatewayBootstrapMode = false,
  deploymentId = `gha-${plan.environment_name}`,
  workerVersionId = 'pending-runtime-version',
  activeDeploymentComposition = [],
  access = null,
  cloudflareAccountId = '',
  cloudflareResourceIds = null,
} = {}) {
  const baseConfig = structuredCloneJson(createWranglerConfigSnapshot(workerName));
  const envName = plan.environment_name;
  const workerVars = {
    ...baseConfig.vars,
    ...buildWorkerVars(workerName, plan, {
      deploymentId,
      workerVersionId,
      activeDeploymentComposition,
      access,
      cloudflareAccountId,
      cloudflareResourceIds,
    }),
  };
  const envConfig = {
    vars: workerVars,
    workers_dev: true,
  };
  if (baseConfig.version_metadata != null) {
    envConfig.version_metadata = structuredCloneJson(baseConfig.version_metadata);
  }

  if (baseConfig.durable_objects) {
    envConfig.durable_objects = {
      bindings: baseConfig.durable_objects.bindings.map((binding) => ({
        ...binding,
        ...(binding.script_name != null
          ? { script_name: plan.worker_scripts['gateway-worker'] }
          : {}),
      })),
    };
  }

  if (Array.isArray(baseConfig.services) && baseConfig.services.length > 0 && !(gatewayBootstrapMode && workerName === 'gateway-worker')) {
    envConfig.services = baseConfig.services.map((binding) => ({
      ...binding,
      service: plan.worker_scripts['jobs-worker'],
    }));
  }

  if (baseConfig.queues) {
    envConfig.queues = {};
    if (Array.isArray(baseConfig.queues.producers)) {
      envConfig.queues.producers = baseConfig.queues.producers.map((binding) => ({
        ...binding,
        queue: plan.runtime_resource_binding_names.queues[binding.binding],
      }));
    }
    if (Array.isArray(baseConfig.queues.consumers)) {
      envConfig.queues.consumers = baseConfig.queues.consumers.map((binding) => ({
        ...binding,
        queue: `${binding.queue}-${envName}`,
      }));
    }
  }

  if (Array.isArray(baseConfig.d1_databases) && baseConfig.d1_databases.length > 0) {
    if (typeof d1DatabaseId !== 'string' || d1DatabaseId.length === 0) {
      throw new TypeError('d1DatabaseId must be provided for non-local wrangler config generation');
    }
    envConfig.d1_databases = baseConfig.d1_databases.map((binding) => ({
      binding: binding.binding,
      database_name: plan.d1_database_name,
      database_id: d1DatabaseId,
    }));
  }

  if (Array.isArray(baseConfig.r2_buckets) && baseConfig.r2_buckets.length > 0) {
    envConfig.r2_buckets = baseConfig.r2_buckets.map((binding) => ({
      binding: binding.binding,
      bucket_name: plan.runtime_resource_binding_names.r2_buckets[binding.binding],
    }));
  }

  if (Array.isArray(baseConfig.kv_namespaces) && baseConfig.kv_namespaces.length > 0) {
    if (typeof kvNamespaceId !== 'string' || kvNamespaceId.length === 0) {
      throw new TypeError('kvNamespaceId must be provided for non-local wrangler config generation');
    }
    envConfig.kv_namespaces = baseConfig.kv_namespaces.map((binding) => ({
      binding: binding.binding,
      id: kvNamespaceId,
    }));
  }

  if (Array.isArray(baseConfig.ratelimits) && baseConfig.ratelimits.length > 0) {
    envConfig.ratelimits = baseConfig.ratelimits.map((binding) => ({
      ...binding,
      namespace_id: resolvePlanRateLimitNamespaceId(envName, binding.namespace_id),
    }));
  }

  return {
    name: baseConfig.name,
    main: baseConfig.main,
    compatibility_date: baseConfig.compatibility_date,
    compatibility_flags: baseConfig.compatibility_flags,
    migrations: baseConfig.migrations,
    env: {
      [envName]: envConfig,
    },
  };
}

export async function writeEnvironmentWranglerConfig(workerName, plan, options) {
  const outputPath = options.outputPath;
  const config = createEnvironmentWranglerConfig(workerName, plan, options);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const workerEntryPointPath = resolveWorkerEntryPointPath(workerName, repoRoot, config.main);
  await fs.access(workerEntryPointPath);
  config.main = toWranglerPath(path.relative(path.dirname(outputPath), workerEntryPointPath));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(config));
  return {
    worker_name: workerName,
    output_path: outputPath,
    config,
  };
}

function quoteCommand(argumentsList) {
  return argumentsList.map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument)).join(' ');
}

function buildOpsWorkerCloudflareResourceIds(provisionedEnvironment) {
  const queues = Array.isArray(provisionedEnvironment?.resources?.queues)
    ? provisionedEnvironment.resources.queues
    : [];
  const plan = provisionedEnvironment?.plan ?? null;
  const cloudflareResources = plan == null
    ? null
    : {
      ...plan.cloudflare_resources,
      r2_buckets: [
        ...plan.cloudflare_resources.r2_buckets,
        plan.artifact_bucket_name,
      ],
    };
  return Object.freeze({
    worker_scripts: Object.freeze({
      'gateway-worker': String(plan?.worker_scripts?.['gateway-worker'] ?? ''),
      'jobs-worker': String(plan?.worker_scripts?.['jobs-worker'] ?? ''),
      'ops-worker': String(plan?.worker_scripts?.['ops-worker'] ?? ''),
    }),
    d1_database_id: String(provisionedEnvironment?.resources?.d1_database?.id ?? ''),
    kv_namespace_id: String(provisionedEnvironment?.resources?.kv_namespace?.id ?? ''),
    r2_bucket_names: Object.freeze({
      MATRIX_MEDIA_BUCKET: String(plan?.runtime_resource_binding_names?.r2_buckets?.MATRIX_MEDIA_BUCKET ?? ''),
      MATRIX_ARCHIVE_BUCKET: String(plan?.runtime_resource_binding_names?.r2_buckets?.MATRIX_ARCHIVE_BUCKET ?? ''),
    }),
    queue_ids: Object.freeze(Object.fromEntries(queues.map((queue) => [
      String(queue?.queue_name ?? queue?.name ?? ''),
      String(queue?.id ?? ''),
    ]).filter(([queueName, queueId]) => queueName.length > 0 && queueId.length > 0))),
    cloudflare_resources: cloudflareResources == null ? null : Object.freeze(structuredCloneJson(cloudflareResources)),
  });
}

function runCommand(command, args, {
  cwd,
  env,
  stdin = null,
  allowFailure = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0 || allowFailure) {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
        return;
      }
      reject(Object.assign(new Error(`${command} exited with code ${code}`), {
        code,
        stdout,
        stderr,
      }));
    });
    if (stdin != null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function requireCloudflareCredentials(options = {}) {
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
  const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? null;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new RangeError('CLOUDFLARE_ACCOUNT_ID is required');
  }
  if (typeof apiToken !== 'string' || apiToken.length === 0) {
    throw new RangeError('CLOUDFLARE_API_TOKEN is required');
  }
  return {
    accountId,
    apiToken,
  };
}

function buildCloudflareHeaders(apiToken) {
  return {
    authorization: `Bearer ${apiToken}`,
    'content-type': 'application/json',
  };
}

async function callCloudflareApi({
  accountId,
  apiToken,
  method = 'GET',
  pathname,
  body,
}) {
  const response = await fetch(`${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}${pathname}`, {
    method,
    headers: buildCloudflareHeaders(apiToken),
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    payload = {
      success: false,
      errors: [{ message: text }],
      raw: text,
    };
  }
  if (!response.ok || payload?.success === false) {
    const errorMessage = Array.isArray(payload?.errors) && payload.errors.length > 0
      ? payload.errors.map((entry) => entry.message ?? JSON.stringify(entry)).join('; ')
      : `${method} ${pathname} failed`;
    throw Object.assign(new Error(`Cloudflare API ${method} ${pathname} failed: ${errorMessage}`), {
      response_status: response.status,
      pathname,
      method,
      cloudflare_errors: Array.isArray(payload?.errors) ? payload.errors : [],
    });
  }
  return payload;
}

async function getZeroTrustOrganization({
  accountId,
  apiToken,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/access/organizations',
  });
  const result = Array.isArray(payload.result) ? payload.result[0] : payload.result;
  return normalizeCloudflareAccessOrganization(result);
}

async function listAccessApplications({
  accountId,
  apiToken,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/access/apps?per_page=100',
  });
  return extractArrayResult(payload.result, ['result']).map((entry) => normalizeCloudflareAccessApplication(entry));
}

async function createAccessApplication({
  accountId,
  apiToken,
  body,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: '/access/apps',
    body,
  });
  return normalizeCloudflareAccessApplication(payload.result);
}

async function updateAccessApplication({
  accountId,
  apiToken,
  appId,
  body,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'PUT',
    pathname: `/access/apps/${appId}`,
    body,
  });
  return normalizeCloudflareAccessApplication(payload.result);
}

async function ensureAccessApplication({
  accountId,
  apiToken,
  plan,
}) {
  const requestBody = buildAccessApplicationRequestBody(plan);
  const apps = await listAccessApplications({
    accountId,
    apiToken,
  });
  const matching = apps.filter((entry) => entry.domain === requestBody.domain);
  if (matching.length > 1) {
    throw new Error(`Multiple Cloudflare Access applications matched ops domain ${requestBody.domain}; refusing to guess`);
  }
  if (matching.length === 0) {
    const created = await createAccessApplication({
      accountId,
      apiToken,
      body: requestBody,
    });
    return {
      application: created,
      created: true,
      updated: false,
    };
  }
  const existing = matching[0];
  const updated = await updateAccessApplication({
    accountId,
    apiToken,
    appId: existing.id,
    body: requestBody,
  });
  return {
    application: updated,
    created: false,
    updated: true,
  };
}

async function listAccessApplicationPolicies({
  accountId,
  apiToken,
  appId,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: `/access/apps/${appId}/policies?per_page=100`,
  });
  return extractArrayResult(payload.result, ['result']).map((entry) => normalizeCloudflareAccessPolicy(entry));
}

async function createAccessApplicationPolicy({
  accountId,
  apiToken,
  appId,
  body,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: `/access/apps/${appId}/policies`,
    body,
  });
  return normalizeCloudflareAccessPolicy(payload.result);
}

async function updateAccessApplicationPolicy({
  accountId,
  apiToken,
  appId,
  policyId,
  body,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'PUT',
    pathname: `/access/apps/${appId}/policies/${policyId}`,
    body,
  });
  return normalizeCloudflareAccessPolicy(payload.result);
}

async function ensureAccessApplicationPolicy({
  accountId,
  apiToken,
  appId,
  environmentName,
  serviceTokenId,
}) {
  const policies = await listAccessApplicationPolicies({
    accountId,
    apiToken,
    appId,
  });
  const expectedName = buildAccessPolicyName(environmentName);
  const matching = policies.filter((entry) => entry.name === expectedName);
  if (matching.length > 1) {
    throw new Error(`Multiple Cloudflare Access policies matched ${expectedName}; refusing to guess`);
  }
  const body = buildCloudflareAccessPolicyRequestBody({
    environmentName,
    serviceTokenId,
  });
  if (matching.length === 0) {
    const created = await createAccessApplicationPolicy({
      accountId,
      apiToken,
      appId,
      body,
    });
    return {
      policy: created,
      created: true,
      updated: false,
    };
  }
  const updated = await updateAccessApplicationPolicy({
    accountId,
    apiToken,
    appId,
    policyId: matching[0].id,
    body,
  });
  return {
    policy: updated,
    created: false,
    updated: true,
  };
}

async function listServiceTokens({
  accountId,
  apiToken,
  name = null,
}) {
  const querySuffix = name == null ? '?per_page=100' : `?per_page=100&name=${encodeURIComponent(name)}`;
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: `/access/service_tokens${querySuffix}`,
  });
  return extractArrayResult(payload.result, ['result']).map((entry) => normalizeCloudflareServiceToken(entry));
}

async function createServiceToken({
  accountId,
  apiToken,
  body,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: '/access/service_tokens',
    body,
  });
  return normalizeCloudflareServiceToken(payload.result);
}

async function rotateServiceToken({
  accountId,
  apiToken,
  serviceTokenId,
}) {
  const payload = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: `/access/service_tokens/${serviceTokenId}/rotate`,
    body: {
      previous_client_secret_expires_at: new Date().toISOString(),
    },
  });
  return normalizeCloudflareServiceToken(payload.result);
}

async function ensureServiceToken({
  accountId,
  apiToken,
  environmentName,
}) {
  const expectedName = buildAccessServiceTokenName(environmentName);
  const existing = await listServiceTokens({
    accountId,
    apiToken,
    name: expectedName,
  });
  if (existing.length > 1) {
    throw new Error(`Multiple Cloudflare service tokens matched ${expectedName}; refusing to guess`);
  }
  if (existing.length === 0) {
    const created = await createServiceToken({
      accountId,
      apiToken,
      body: {
        name: expectedName,
        duration: NON_LOCAL_ACCESS_SERVICE_TOKEN_DURATION,
      },
    });
    return {
      service_token: created,
      created: true,
      rotated: false,
    };
  }
  const rotated = await rotateServiceToken({
    accountId,
    apiToken,
    serviceTokenId: existing[0].id,
  });
  return {
    service_token: rotated,
    created: false,
    rotated: true,
  };
}

function extractArrayResult(result, candidateKeys = []) {
  if (Array.isArray(result)) {
    return result;
  }
  if (isPlainObject(result)) {
    for (const key of candidateKeys) {
      if (Array.isArray(result[key])) {
        return result[key];
      }
    }
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return [];
}

function extractStringField(value, candidateKeys) {
  if (!isPlainObject(value)) {
    return null;
  }
  for (const key of candidateKeys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function findNamedResult(entries, expectedName, candidateKeys) {
  return entries.find((entry) => extractStringField(entry, candidateKeys) === expectedName) ?? null;
}

function normalizeCloudflareAccessOrganization(result) {
  const authDomain = extractStringField(result, ['auth_domain']);
  if (!isNonEmptyString(authDomain)) {
    throw new TypeError('Cloudflare Zero Trust organization must include auth_domain');
  }
  return Object.freeze({
    auth_domain: authDomain.trim().toLowerCase(),
  });
}

function normalizeCloudflareAccessApplication(result) {
  const id = extractStringField(result, ['id']);
  const aud = extractStringField(result, ['aud']);
  const domain = extractStringField(result, ['domain']);
  const type = extractStringField(result, ['type']);
  const name = extractStringField(result, ['name']);
  if (!isNonEmptyString(id)) {
    throw new TypeError('Cloudflare Access application must include id');
  }
  if (!isNonEmptyString(aud)) {
    throw new TypeError('Cloudflare Access application must include aud');
  }
  if (!isNonEmptyString(domain)) {
    throw new TypeError('Cloudflare Access application must include domain');
  }
  if (!isNonEmptyString(type)) {
    throw new TypeError('Cloudflare Access application must include type');
  }
  return Object.freeze({
    id,
    aud,
    domain: normalizeAccessDomainPath(domain, 'Cloudflare Access application domain'),
    type,
    name: name ?? null,
  });
}

function normalizeCloudflareAccessPolicy(result) {
  const id = extractStringField(result, ['id']);
  const name = extractStringField(result, ['name']);
  const decision = extractStringField(result, ['decision']);
  if (!isNonEmptyString(id)) {
    throw new TypeError('Cloudflare Access policy must include id');
  }
  if (!isNonEmptyString(name)) {
    throw new TypeError('Cloudflare Access policy must include name');
  }
  if (!isNonEmptyString(decision)) {
    throw new TypeError('Cloudflare Access policy must include decision');
  }
  return Object.freeze({
    id,
    name,
    decision,
  });
}

function normalizeCloudflareServiceToken(result) {
  const id = extractStringField(result, ['id']);
  const name = extractStringField(result, ['name']);
  const clientId = extractStringField(result, ['client_id']);
  const clientSecret = extractStringField(result, ['client_secret']);
  const duration = extractStringField(result, ['duration']);
  if (!isNonEmptyString(id)) {
    throw new TypeError('Cloudflare service token must include id');
  }
  if (!isNonEmptyString(name)) {
    throw new TypeError('Cloudflare service token must include name');
  }
  if (!isNonEmptyString(clientId)) {
    throw new TypeError('Cloudflare service token must include client_id');
  }
  return Object.freeze({
    id,
    name,
    client_id: clientId,
    client_secret: clientSecret ?? null,
    duration: duration ?? null,
  });
}

function buildCloudflareAccessPolicyRequestBody({
  environmentName,
  serviceTokenId,
}) {
  if (!isNonEmptyString(serviceTokenId)) {
    throw new TypeError('serviceTokenId must be non-empty');
  }
  return Object.freeze({
    name: buildAccessPolicyName(environmentName),
    decision: 'non_identity',
    precedence: 1,
    include: [
      {
        service_token: {
          token_id: serviceTokenId,
        },
      },
    ],
  });
}

function buildOperatorPolicyRecord({
  environmentName,
  authDomain,
  audience,
  accessSubjectValue,
}) {
  const now = new Date().toISOString();
  return Object.freeze({
    principal_id: buildOperatorPolicyPrincipalId(environmentName),
    principal_type: 'service',
    access_issuer: `https://${authDomain}`,
    access_audience: audience,
    access_subject_binding: {
      mode: 'claim_priority',
      claims: ['common_name', 'sub'],
    },
    access_subject_value: accessSubjectValue,
    allowed_scopes: ['ops.read', 'ops.rebuild.write'],
    target_scope_constraints: {
      global: true,
    },
    expires_at: null,
    disabled_at: null,
    require_reason: false,
    require_ticket: false,
    created_at: now,
    updated_at: now,
  });
}

async function ensureWorkersSubdomain({
  accountId,
  apiToken,
  preferredSubdomain = null,
}) {
  const currentSubdomain = await readWorkersSubdomain({
    accountId,
    apiToken,
  });
  if (currentSubdomain != null) {
    return {
      subdomain: currentSubdomain,
      created: false,
    };
  }
  const requestedSubdomain = preferredSubdomain ?? `matrixflare-${String(accountId).slice(0, 8).toLowerCase()}`;
  const created = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'PUT',
    pathname: '/workers/subdomain',
    body: {
      enabled: true,
      subdomain: requestedSubdomain,
    },
  });
  const createdSubdomain = extractStringField(created.result, ['subdomain']);
  if (createdSubdomain == null) {
    throw new Error('Cloudflare API did not return a workers.dev subdomain after creation');
  }
  return {
    subdomain: createdSubdomain,
    created: true,
  };
}

async function readWorkersSubdomain({
  accountId,
  apiToken,
}) {
  const current = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/workers/subdomain',
  });
  return extractStringField(current.result, ['subdomain']);
}

async function ensureD1Database({
  accountId,
  apiToken,
  databaseName,
}) {
  const listed = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/d1/database',
  });
  const databases = extractArrayResult(listed.result);
  const existing = findNamedResult(databases, databaseName, ['name', 'database_name']);
  if (existing != null) {
    return {
      name: databaseName,
      id: extractStringField(existing, ['uuid', 'id']),
      created: false,
    };
  }
  const created = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: '/d1/database',
    body: {
      name: databaseName,
    },
  });
  return {
    name: databaseName,
    id: extractStringField(created.result, ['uuid', 'id']),
    created: true,
  };
}

async function ensureKvNamespace({
  accountId,
  apiToken,
  title,
}) {
  const listed = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/storage/kv/namespaces',
  });
  const namespaces = extractArrayResult(listed.result);
  const existing = findNamedResult(namespaces, title, ['title', 'namespace']);
  if (existing != null) {
    return {
      title,
      id: extractStringField(existing, ['id']),
      created: false,
    };
  }
  const created = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: '/storage/kv/namespaces',
    body: {
      title,
    },
  });
  return {
    title,
    id: extractStringField(created.result, ['id']),
    created: true,
  };
}

async function ensureR2Bucket({
  accountId,
  apiToken,
  bucketName,
}) {
  const listed = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/r2/buckets',
  });
  const buckets = extractArrayResult(listed.result, ['buckets']);
  const existing = findNamedResult(buckets, bucketName, ['name']);
  if (existing != null) {
    return {
      name: bucketName,
      created: false,
    };
  }
  await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: '/r2/buckets',
    body: {
      name: bucketName,
    },
  });
  return {
    name: bucketName,
    created: true,
  };
}

async function ensureQueue({
  accountId,
  apiToken,
  queueName,
}) {
  const listed = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: '/queues',
  });
  const queues = extractArrayResult(listed.result);
  const existing = findNamedResult(queues, queueName, ['queue_name', 'name']);
  if (existing != null) {
    return {
      name: queueName,
      id: extractStringField(existing, ['queue_id', 'id']),
      created: false,
    };
  }
  const created = await callCloudflareApi({
    accountId,
    apiToken,
    method: 'POST',
    pathname: '/queues',
    body: {
      queue_name: queueName,
    },
  });
  return {
    name: queueName,
    id: extractStringField(created.result, ['queue_id', 'id']),
    created: true,
  };
}

function buildWranglerEnv(accountId) {
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error('Expected JSON output, received empty stdout');
  }
  const candidates = [trimmed];
  const firstBrace = Math.min(
    ...['{', '[']
      .map((token) => trimmed.indexOf(token))
      .filter((index) => index >= 0),
  );
  if (Number.isFinite(firstBrace) && firstBrace > 0) {
    candidates.push(trimmed.slice(firstBrace));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new Error(`Unable to parse JSON output: ${trimmed}`);
}

async function runWrangler(args, {
  repoRoot = process.cwd(),
  accountId,
}) {
  return runCommand('npx', ['--yes', 'wrangler@latest', ...args], {
    cwd: repoRoot,
    env: buildWranglerEnv(accountId),
  });
}

async function runWranglerJson(args, options) {
  const result = await runWrangler(args, options);
  return parseJsonOutput(result.stdout);
}

async function executeRemoteD1Sql({
  repoRoot = process.cwd(),
  accountId,
  databaseName,
  sql,
  workingRoot,
}) {
  if (!isNonEmptyString(databaseName)) {
    throw new TypeError('databaseName must be non-empty');
  }
  if (!isNonEmptyString(sql)) {
    throw new TypeError('sql must be non-empty');
  }
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'nonlocal-d1'));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const sqlPath = path.join(resolvedWorkingRoot, `${slugifyLabel(databaseName)}-${Date.now().toString(36)}.sql`);
  await fs.writeFile(sqlPath, sql);
  try {
    await runWrangler([
      'd1',
      'execute',
      databaseName,
      '--remote',
      '--json',
      '--file',
      sqlPath,
    ], {
      repoRoot,
      accountId,
    });
  } finally {
    await fs.rm(sqlPath, { force: true });
  }
}

function escapeSqlString(value) {
  return String(value).replaceAll("'", "''");
}

function buildOperatorPolicyUpsertSql(record) {
  return `
INSERT INTO operator_authz_policies (
  principal_id,
  principal_type,
  access_issuer,
  access_audience,
  access_subject_binding,
  access_subject_value,
  allowed_scopes,
  target_scope_constraints,
  expires_at,
  disabled_at,
  require_reason,
  require_ticket,
  created_at,
  updated_at
) VALUES (
  '${escapeSqlString(record.principal_id)}',
  '${escapeSqlString(record.principal_type)}',
  '${escapeSqlString(record.access_issuer)}',
  '${escapeSqlString(record.access_audience)}',
  '${escapeSqlString(JSON.stringify(record.access_subject_binding))}',
  '${escapeSqlString(record.access_subject_value)}',
  '${escapeSqlString(JSON.stringify(record.allowed_scopes))}',
  '${escapeSqlString(JSON.stringify(record.target_scope_constraints))}',
  NULL,
  NULL,
  ${record.require_reason ? 1 : 0},
  ${record.require_ticket ? 1 : 0},
  '${escapeSqlString(record.created_at)}',
  '${escapeSqlString(record.updated_at)}'
)
ON CONFLICT(principal_id) DO UPDATE SET
  principal_type = excluded.principal_type,
  access_issuer = excluded.access_issuer,
  access_audience = excluded.access_audience,
  access_subject_binding = excluded.access_subject_binding,
  access_subject_value = excluded.access_subject_value,
  allowed_scopes = excluded.allowed_scopes,
  target_scope_constraints = excluded.target_scope_constraints,
  expires_at = excluded.expires_at,
  disabled_at = excluded.disabled_at,
  require_reason = excluded.require_reason,
  require_ticket = excluded.require_ticket,
  updated_at = excluded.updated_at;
`.trim();
}

export function summarizeWorkerDeploymentState({
  deployments,
  versions,
}) {
  const deploymentEntries = extractArrayResult({ deployments }, ['deployments'])
    .map((entry) => {
      const deploymentId = extractStringField(entry, ['id']);
      if (!deploymentId) {
        return null;
      }
      const workerVersionIds = extractArrayResult(entry, ['versions'])
        .map((versionEntry) => extractStringField(versionEntry, ['version_id', 'id']))
        .filter(Boolean);
      return Object.freeze({
        deployment_id: deploymentId,
        worker_version_ids: Object.freeze(workerVersionIds),
      });
    })
    .filter(Boolean);
  const deploymentIds = Object.freeze(deploymentEntries.map((entry) => entry.deployment_id));
  const versionIds = Object.freeze(
    extractArrayResult({ versions }, ['versions'])
      .map((entry) => extractStringField(entry, ['id']))
      .filter(Boolean),
  );
  const latestActiveDeployment = deploymentEntries[0] ?? null;
  return Object.freeze({
    deployment_ids: deploymentIds,
    active_worker_version_ids: Object.freeze(latestActiveDeployment?.worker_version_ids ?? []),
    latest_active_deployment_id: latestActiveDeployment?.deployment_id ?? null,
    worker_version_ids: versionIds,
  });
}

export async function fetchWorkerDeploymentState({
  accountId,
  apiToken,
  scriptName,
  allowMissingScript = false,
  includeRawPayload = false,
}) {
  const fetchResults = await Promise.allSettled([
    callCloudflareApi({
      accountId,
      apiToken,
      pathname: `/workers/scripts/${scriptName}/deployments`,
    }),
    callCloudflareApi({
      accountId,
      apiToken,
      pathname: `/workers/scripts/${scriptName}/versions`,
    }),
  ]);
  const failures = fetchResults.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    if (allowMissingScript) {
      const resolved = resolvePreDeployWorkerDeploymentState(scriptName, fetchResults);
      if (!includeRawPayload) {
        return resolved;
      }
      return Object.freeze({
        ...resolved,
        raw_payloads: null,
      });
    }
    if (includeRawPayload) {
      attachPartialWorkerDeploymentRawPayloads(failures[0].reason, fetchResults);
    }
    throw failures[0].reason;
  }
  const [deploymentsPayload, versionsPayload] = fetchResults.map((result) => result.value);
  const summary = summarizeWorkerDeploymentState({
    deployments: extractArrayResult(deploymentsPayload.result, ['deployments']),
    versions: extractArrayResult(versionsPayload.result, ['items', 'versions']),
  });
  if (!includeRawPayload) {
    return summary;
  }
  return Object.freeze({
    ...summary,
    raw_payloads: Object.freeze({
      deployments: structuredCloneJson(deploymentsPayload.result),
      versions: structuredCloneJson(versionsPayload.result),
    }),
  });
}

function buildPartialWorkerDeploymentRawPayloads(fetchResults) {
  if (!Array.isArray(fetchResults) || fetchResults.length !== 2) {
    return null;
  }
  const payloads = Object.freeze({
    deployments: fetchResults[0]?.status === 'fulfilled'
      ? structuredCloneJson(fetchResults[0].value?.result ?? null)
      : null,
    versions: fetchResults[1]?.status === 'fulfilled'
      ? structuredCloneJson(fetchResults[1].value?.result ?? null)
      : null,
  });
  return payloads.deployments == null && payloads.versions == null
    ? null
    : payloads;
}

function attachPartialWorkerDeploymentRawPayloads(error, fetchResults) {
  const partialRawPayloads = buildPartialWorkerDeploymentRawPayloads(fetchResults);
  if (partialRawPayloads == null || error == null || typeof error !== 'object') {
    return;
  }
  Object.defineProperty(error, 'partial_raw_payloads', {
    value: partialRawPayloads,
    enumerable: true,
    configurable: true,
  });
}

function summarizeWorkerDeploymentRawPayloads(rawPayloads) {
  if (rawPayloads == null || typeof rawPayloads !== 'object') {
    return null;
  }
  const deployments = rawPayloads.deployments ?? null;
  const versions = rawPayloads.versions ?? null;
  if (deployments == null && versions == null) {
    return null;
  }
  return summarizeWorkerDeploymentState({
    deployments: extractArrayResult(deployments, ['deployments']),
    versions: extractArrayResult(versions, ['items', 'versions']),
  });
}

function summarizeWorkerBindingState({
  bindings,
}) {
  const ratelimitNamespaceIds = [];
  for (const binding of extractArrayResult({ bindings }, ['bindings'])) {
    if (!isPlainObject(binding)) {
      continue;
    }
    if (extractStringField(binding, ['type']) !== 'ratelimit') {
      continue;
    }
    const namespaceId = extractStringField(binding, ['namespace_id', 'namespaceId']);
    if (!isNonEmptyString(namespaceId)) {
      throw new TypeError('Cloudflare ratelimit binding must include namespace_id');
    }
    ratelimitNamespaceIds.push(namespaceId);
  }
  return Object.freeze({
    ratelimit_namespace_ids: Object.freeze(sortUniqueStringArray(ratelimitNamespaceIds)),
  });
}

export async function fetchWorkerBindingState({
  accountId,
  apiToken,
  scriptName,
}) {
  const settingsPayload = await callCloudflareApi({
    accountId,
    apiToken,
    pathname: `/workers/scripts/${scriptName}/settings`,
  });
  return summarizeWorkerBindingState({
    bindings: extractArrayResult(settingsPayload.result, ['bindings']),
  });
}

function assertBillingPeriodDate(value, label) {
  if (!isNonEmptyString(value) || !BILLING_PERIOD_DATE_RE.test(value)) {
    throw new RangeError(`${label} must use YYYY-MM-DD format`);
  }
  return value;
}

function buildBillingUsageApiPath({
  fromDate = null,
  toDate = null,
} = {}) {
  const params = new URLSearchParams();
  if (fromDate != null) {
    params.set('from', assertBillingPeriodDate(fromDate, 'billing from date'));
  }
  if (toDate != null) {
    params.set('to', assertBillingPeriodDate(toDate, 'billing to date'));
  }
  const query = params.toString();
  return `/billing/usage/paygo${query.length > 0 ? `?${query}` : ''}`;
}

const PROD_BILLING_WINDOW_RESOLUTION_METHODS = Object.freeze({
  profileNextBillDate: 'cloudflare-account-billing-profile-next-bill-date',
  subscriptionsCurrentPeriodEnd: 'cloudflare-account-subscriptions-current-period-end',
});

const PROD_BILLING_WINDOW_RESOLUTION_METHOD_PATHS = Object.freeze({
  [PROD_BILLING_WINDOW_RESOLUTION_METHODS.profileNextBillDate]: '/billing/profile',
  [PROD_BILLING_WINDOW_RESOLUTION_METHODS.subscriptionsCurrentPeriodEnd]: '/subscriptions',
});

function formatBillingPeriodDateFromUtcMillis(utcMillis, label) {
  if (!Number.isFinite(utcMillis)) {
    throw new RangeError(`${label} must be a valid UTC timestamp`);
  }
  return new Date(utcMillis).toISOString().slice(0, 10);
}

function currentUtcBillingDate(now = new Date(), label = 'current UTC date') {
  return formatBillingPeriodDateFromUtcMillis(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    label,
  );
}

function parseBillingPeriodDateToUtcMillis(value, label) {
  const normalized = assertBillingPeriodDate(value, label);
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${label} must be a valid UTC date`);
  }
  return parsed;
}

function normalizeObservedBillingDate(value, label) {
  if (!isNonEmptyString(value)) {
    throw new RangeError(`${label} must be non-empty`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${label} must be a valid date`);
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function shiftBillingPeriodDateByMonths(value, months, label) {
  const normalized = assertBillingPeriodDate(value, label);
  const [yearString, monthString, dayString] = normalized.split('-');
  const year = Number(yearString);
  const monthIndex = Number(monthString) - 1;
  const day = Number(dayString);
  const shiftedMonthIndex = monthIndex + Number(months);
  const normalizedYear = year + Math.floor(shiftedMonthIndex / 12);
  const normalizedMonthIndex = ((shiftedMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(normalizedYear, normalizedMonthIndex + 1, 0)).getUTCDate();
  const normalizedDay = Math.min(day, lastDayOfTargetMonth);
  return formatBillingPeriodDateFromUtcMillis(
    Date.UTC(normalizedYear, normalizedMonthIndex, normalizedDay),
    label,
  );
}

function addBillingPeriodDays(value, days, label) {
  const utcMillis = parseBillingPeriodDateToUtcMillis(value, label);
  return formatBillingPeriodDateFromUtcMillis(utcMillis + (Number(days) * 24 * 60 * 60 * 1000), label);
}

function normalizeUpcomingBillingProfileNextBillDate(nextBillDate, {
  now = new Date(),
  label = 'Cloudflare billing profile next_bill_date',
} = {}) {
  const normalizedNextBillDate = normalizeObservedBillingDate(nextBillDate, label);
  const todayDate = currentUtcBillingDate(now, 'current UTC date');
  const nextBillDateMillis = parseBillingPeriodDateToUtcMillis(normalizedNextBillDate, label);
  const todayMillis = parseBillingPeriodDateToUtcMillis(todayDate, 'current UTC date');
  if (nextBillDateMillis < todayMillis) {
    throw new Error(`${label} must not be earlier than the current UTC date when resolving the latest closed billing period`);
  }
  const latestExpectedNextBillDate = addBillingPeriodDays(
    todayDate,
    31,
    `${label} upper bound`,
  );
  if (nextBillDateMillis > parseBillingPeriodDateToUtcMillis(latestExpectedNextBillDate, `${label} upper bound`)) {
    throw new Error(`${label} must be within 31 days of the current UTC date when resolving the latest closed billing period`);
  }
  return normalizedNextBillDate;
}

function normalizeCloudflareBillingProfile(value) {
  if (!isPlainObject(value)) {
    throw new TypeError('Cloudflare billing profile result must be an object');
  }
  const nextBillDate = stableString(value.next_bill_date);
  if (!isNonEmptyString(nextBillDate)) {
    return Object.freeze({
      next_bill_date: null,
    });
  }
  if (!Number.isFinite(Date.parse(nextBillDate))) {
    throw new Error('Cloudflare billing profile next_bill_date must be a valid date');
  }
  return Object.freeze({
    next_bill_date: nextBillDate,
  });
}

function normalizeCloudflareSubscription(value, index) {
  if (!isPlainObject(value)) {
    throw new TypeError(`Cloudflare account subscription ${index} must be an object`);
  }
  return Object.freeze({
    id: stableString(value.id),
    current_period_end: stableString(value.current_period_end),
  });
}

function normalizeClosedBillingWindow({
  fromDate = null,
  toDate = null,
  now = new Date(),
} = {}) {
  if (fromDate == null || toDate == null) {
    throw new Error('production cost snapshot requires explicit --from and --to dates for a closed billing window');
  }
  const normalizedFromDate = assertBillingPeriodDate(fromDate, 'billing from date');
  const normalizedToDate = assertBillingPeriodDate(toDate, 'billing to date');
  const fromMillis = parseBillingPeriodDateToUtcMillis(normalizedFromDate, 'billing from date');
  const toMillis = parseBillingPeriodDateToUtcMillis(normalizedToDate, 'billing to date');
  if (fromMillis > toMillis) {
    throw new Error('production cost snapshot billing window start must be on or before the billing window end');
  }
  const todayStartMillis = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (toMillis >= todayStartMillis) {
    throw new Error('production cost snapshot requires a closed billing window that ends before today');
  }
  return Object.freeze({
    fromDate: normalizedFromDate,
    toDate: normalizedToDate,
  });
}

function deriveClosedBillingWindowFromNextBillDate({
  nextBillDate,
  now = new Date(),
} = {}) {
  const normalizedNextBillDate = normalizeUpcomingBillingProfileNextBillDate(nextBillDate, {
    now,
    label: 'Cloudflare billing profile next_bill_date',
  });
  const closedPeriodEndDate = shiftBillingPeriodDateByMonths(
    normalizedNextBillDate,
    -1,
    'Cloudflare billing profile next_bill_date',
  );
  const previousBillingAnchorDate = shiftBillingPeriodDateByMonths(
    normalizedNextBillDate,
    -2,
    'Cloudflare billing profile next_bill_date',
  );
  const closedPeriodStartDate = addBillingPeriodDays(
    previousBillingAnchorDate,
    1,
    'resolved production billing window start',
  );
  return Object.freeze({
    nextBillDate: normalizedNextBillDate,
    ...normalizeClosedBillingWindow({
      fromDate: closedPeriodStartDate,
      toDate: closedPeriodEndDate,
      now,
    }),
  });
}

function deriveClosedBillingWindowFromSubscriptionCurrentPeriodEnd({
  currentPeriodEnd,
  now = new Date(),
} = {}) {
  return deriveClosedBillingWindowFromNextBillDate({
    nextBillDate: normalizeUpcomingBillingProfileNextBillDate(currentPeriodEnd, {
      now,
      label: 'Cloudflare account subscriptions current_period_end',
    }),
    now,
  });
}

function normalizeCloudflareSubscriptionsBillingCycleAnchor(value, {
  now = new Date(),
} = {}) {
  const subscriptions = extractArrayResult(value).map((entry, index) => normalizeCloudflareSubscription(entry, index));
  const observedAnchors = sortUniqueStringArray(
    subscriptions
      .map((entry) => {
        if (!isNonEmptyString(entry.current_period_end) || !Number.isFinite(Date.parse(entry.current_period_end))) {
          return null;
        }
        return entry.current_period_end;
      })
      .filter((entry) => entry != null),
  );
  if (observedAnchors.length === 0) {
    throw new Error('Cloudflare account subscriptions must include at least one valid current_period_end');
  }
  if (observedAnchors.length !== 1) {
    throw new Error(`Cloudflare account subscriptions returned multiple current_period_end anchors: ${observedAnchors.join(', ')}`);
  }
  const derivedBillingWindow = deriveClosedBillingWindowFromSubscriptionCurrentPeriodEnd({
    currentPeriodEnd: observedAnchors[0],
    now,
  });
  return Object.freeze({
    nextBillDate: observedAnchors[0],
    fromDate: derivedBillingWindow.fromDate,
    toDate: derivedBillingWindow.toDate,
  });
}

function normalizeResolvedClosedProdBillingWindow(value, {
  now = new Date(),
} = {}) {
  if (!isPlainObject(value)) {
    throw new TypeError('resolved production billing window must be an object');
  }
  const resolutionMethod = stableString(value.resolution_method);
  if (!Object.values(PROD_BILLING_WINDOW_RESOLUTION_METHODS).includes(resolutionMethod)) {
    throw new Error(
      'resolved production billing window resolution_method must be cloudflare-account-billing-profile-next-bill-date or cloudflare-account-subscriptions-current-period-end',
    );
  }
  const billingProfile = normalizeCloudflareBillingProfile({
    next_bill_date: value.next_bill_date,
  });
  const derivedBillingWindow = deriveClosedBillingWindowFromNextBillDate({
    nextBillDate: billingProfile.next_bill_date,
    now,
  });
  if (stableString(value.from_date) !== derivedBillingWindow.fromDate) {
    throw new Error('resolved production billing window from_date must match the latest closed billing period derived from next_bill_date');
  }
  if (stableString(value.to_date) !== derivedBillingWindow.toDate) {
    throw new Error('resolved production billing window to_date must match the latest closed billing period derived from next_bill_date');
  }
  return Object.freeze({
    resolutionMethod,
    nextBillDate: billingProfile.next_bill_date,
    fromDate: derivedBillingWindow.fromDate,
    toDate: derivedBillingWindow.toDate,
  });
}

function buildProdBillingCycleAnchorSourceUri(accountId, resolutionMethod) {
  const normalizedAccountId = stableString(accountId);
  if (!isNonEmptyString(normalizedAccountId)) {
    throw new RangeError('Cloudflare account id is required to build the prod billing-cycle anchor source URI');
  }
  const normalizedResolutionMethod = stableString(resolutionMethod);
  const pathname = PROD_BILLING_WINDOW_RESOLUTION_METHOD_PATHS[normalizedResolutionMethod];
  if (!isNonEmptyString(pathname)) {
    throw new RangeError(`Unsupported prod billing window resolution method "${normalizedResolutionMethod}"`);
  }
  return `https://api.cloudflare.com/client/v4/accounts/${normalizedAccountId}${pathname}`;
}

function buildProdBillingCycleAnchorArtifactReference(resolutionMethod) {
  const normalizedResolutionMethod = stableString(resolutionMethod);
  if (normalizedResolutionMethod === PROD_BILLING_WINDOW_RESOLUTION_METHODS.profileNextBillDate) {
    return Object.freeze({
      artifact_path: 'billing-profile.json',
      field_selector: 'result.next_bill_date',
    });
  }
  if (normalizedResolutionMethod === PROD_BILLING_WINDOW_RESOLUTION_METHODS.subscriptionsCurrentPeriodEnd) {
    return Object.freeze({
      artifact_path: 'billing-subscriptions.json',
      field_selector: 'result[*].current_period_end',
    });
  }
  throw new RangeError(`Unsupported prod billing window resolution method "${normalizedResolutionMethod}"`);
}

function normalizeBillingLookupKey(value) {
  return stableString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeBillingUsageRecord(value, index) {
  if (!isPlainObject(value)) {
    throw new TypeError(`Cloudflare billing usage record ${index} must be an object`);
  }
  const serviceName = stableString(value.ServiceName);
  const consumedUnit = stableString(value.ConsumedUnit);
  const billingCurrency = stableString(value.BillingCurrency);
  const billingPeriodStart = stableString(value.BillingPeriodStart);
  const chargePeriodStart = stableString(value.ChargePeriodStart);
  const chargePeriodEnd = stableString(value.ChargePeriodEnd);
  const consumedQuantity = Number(value.ConsumedQuantity);
  const contractedCost = Number(value.ContractedCost);
  const pricingQuantity = Number(value.PricingQuantity);
  if (!isNonEmptyString(serviceName)) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include ServiceName`);
  }
  if (!isNonEmptyString(consumedUnit)) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include ConsumedUnit`);
  }
  if (!isNonEmptyString(billingCurrency)) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include BillingCurrency`);
  }
  if (!Number.isFinite(consumedQuantity) || consumedQuantity < 0) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include a non-negative ConsumedQuantity`);
  }
  if (!Number.isFinite(contractedCost) || contractedCost < 0) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include a non-negative ContractedCost`);
  }
  if (!Number.isFinite(pricingQuantity) || pricingQuantity < 0) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include a non-negative PricingQuantity`);
  }
  if (!isNonEmptyString(billingPeriodStart) || !Number.isFinite(Date.parse(billingPeriodStart))) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include a valid BillingPeriodStart`);
  }
  if (!isNonEmptyString(chargePeriodStart) || !Number.isFinite(Date.parse(chargePeriodStart))) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include a valid ChargePeriodStart`);
  }
  if (!isNonEmptyString(chargePeriodEnd) || !Number.isFinite(Date.parse(chargePeriodEnd))) {
    throw new TypeError(`Cloudflare billing usage record ${index} must include a valid ChargePeriodEnd`);
  }
  return Object.freeze({
    service_name: serviceName,
    service_key: normalizeBillingLookupKey(serviceName),
    consumed_unit: consumedUnit,
    unit_key: normalizeBillingLookupKey(consumedUnit),
    billing_currency: billingCurrency,
    billing_period_start: billingPeriodStart,
    charge_period_start: chargePeriodStart,
    charge_period_end: chargePeriodEnd,
    consumed_quantity: consumedQuantity,
    contracted_cost: contractedCost,
    pricing_quantity: pricingQuantity,
  });
}

function createZeroProdCostSurfaces() {
  return {
    workers: {
      request_count: 0,
      cpu_ms: 0,
      log_event_count: 0,
    },
    durable_objects: {
      request_count: 0,
      duration_gb_s: 0,
      sqlite_row_reads: 0,
      sqlite_row_writes: 0,
      sql_storage_gb_month: 0,
    },
    d1: {
      read_rows: 0,
      write_rows: 0,
      storage_gb_month: 0,
    },
    r2: {
      storage_gb_month: 0,
      class_a_ops: 0,
      class_b_ops: 0,
    },
    kv: {
      read_ops: 0,
      write_ops: 0,
      delete_ops: 0,
      list_ops: 0,
      storage_gb_month: 0,
    },
    queues: {
      write_ops: 0,
      read_ops: 0,
      delete_ops: 0,
    },
  };
}

function incrementSurfaceMetric(costSurfaces, surfaceName, metricName, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`cost surface ${surfaceName}.${metricName} must be a non-negative number`);
  }
  costSurfaces[surfaceName][metricName] = Number(costSurfaces[surfaceName][metricName] ?? 0) + value;
}

function classifyBillingUsageRecord(record) {
  const serviceKey = record.service_key;
  const unitKey = record.unit_key;
  if (serviceKey.includes('trace') || serviceKey.includes('opentelemetry') || serviceKey.includes('logpush')) {
    return {
      unsupported_reason: `telemetry-export billing record ${record.service_name}/${record.consumed_unit} remains unresolved under OQ-0002`,
    };
  }
  if (
    serviceKey.includes('workers')
    && (unitKey === 'month' || unitKey === 'months' || unitKey.includes('subscription'))
  ) {
    return {
      pass_through_kind: 'workers_subscription',
    };
  }
  if (serviceKey.includes('workerslogs') && unitKey.includes('logevent')) {
    return { surface_name: 'workers', metric_name: 'log_event_count' };
  }
  if (
    serviceKey === 'workers'
    || serviceKey.includes('workersstandard')
  ) {
    if (unitKey.includes('request')) {
      return { surface_name: 'workers', metric_name: 'request_count' };
    }
    if (unitKey.includes('cpu') && (unitKey.includes('ms') || unitKey.includes('millisecond'))) {
      return { surface_name: 'workers', metric_name: 'cpu_ms' };
    }
  }
  if (serviceKey.includes('pagesfunctions')) {
    return {
      unsupported_reason: `Pages Functions billing record ${record.service_name}/${record.consumed_unit} is not attributable to the Matrix production worker topology`,
    };
  }
  if (serviceKey.includes('durableobjects')) {
    if (unitKey.includes('request')) {
      return { surface_name: 'durable_objects', metric_name: 'request_count' };
    }
    if (unitKey.includes('duration') && unitKey.includes('gb')) {
      return { surface_name: 'durable_objects', metric_name: 'duration_gb_s' };
    }
    if (unitKey.includes('row') && unitKey.includes('read')) {
      return { surface_name: 'durable_objects', metric_name: 'sqlite_row_reads' };
    }
    if (unitKey.includes('row') && (unitKey.includes('write') || unitKey.includes('written'))) {
      return { surface_name: 'durable_objects', metric_name: 'sqlite_row_writes' };
    }
    if (
      unitKey.includes('storage')
      || unitKey.includes('storeddata')
      || (unitKey.includes('gbmonth') && unitKey.includes('sql'))
    ) {
      return { surface_name: 'durable_objects', metric_name: 'sql_storage_gb_month' };
    }
  }
  if (serviceKey === 'd1' || serviceKey.includes('workersd1')) {
    if (unitKey.includes('row') && unitKey.includes('read')) {
      return { surface_name: 'd1', metric_name: 'read_rows' };
    }
    if (unitKey.includes('row') && (unitKey.includes('write') || unitKey.includes('written'))) {
      return { surface_name: 'd1', metric_name: 'write_rows' };
    }
    if (unitKey.includes('storage') || unitKey.includes('gbmonth')) {
      return { surface_name: 'd1', metric_name: 'storage_gb_month' };
    }
  }
  if (serviceKey === 'r2' || serviceKey.startsWith('r2')) {
    if (unitKey.includes('classa')) {
      return { surface_name: 'r2', metric_name: 'class_a_ops' };
    }
    if (unitKey.includes('classb')) {
      return { surface_name: 'r2', metric_name: 'class_b_ops' };
    }
    if (unitKey.includes('storage') || unitKey.includes('gbmonth')) {
      if (serviceKey.includes('infrequentaccess') || unitKey.includes('retrieval')) {
        return {
          unsupported_reason: `R2 Infrequent Access billing record ${record.service_name}/${record.consumed_unit} is not representable by the current ProdCostSnapshot contract`,
        };
      }
      return { surface_name: 'r2', metric_name: 'storage_gb_month' };
    }
    if (unitKey.includes('retrieval')) {
      return {
        unsupported_reason: `R2 retrieval billing record ${record.service_name}/${record.consumed_unit} is not representable by the current ProdCostSnapshot contract`,
      };
    }
  }
  if (serviceKey === 'kv' || serviceKey.includes('workerskv')) {
    if (unitKey.includes('list')) {
      return { surface_name: 'kv', metric_name: 'list_ops' };
    }
    if (unitKey.includes('delete')) {
      return { surface_name: 'kv', metric_name: 'delete_ops' };
    }
    if (unitKey.includes('write') || unitKey.includes('written')) {
      return { surface_name: 'kv', metric_name: 'write_ops' };
    }
    if (unitKey.includes('read')) {
      return { surface_name: 'kv', metric_name: 'read_ops' };
    }
    if (unitKey.includes('storage') || unitKey.includes('gbmonth')) {
      return { surface_name: 'kv', metric_name: 'storage_gb_month' };
    }
  }
  if (serviceKey.includes('queues')) {
    if (unitKey.includes('write')) {
      return { surface_name: 'queues', metric_name: 'write_ops' };
    }
    if (unitKey.includes('read')) {
      return { surface_name: 'queues', metric_name: 'read_ops' };
    }
    if (unitKey.includes('delete')) {
      return { surface_name: 'queues', metric_name: 'delete_ops' };
    }
    if (unitKey.includes('operation')) {
      return {
        unsupported_reason: `Queues billing record ${record.service_name}/${record.consumed_unit} does not distinguish write/read/delete operations`,
      };
    }
  }
  return {
    unsupported_reason: `unsupported billing usage record ${record.service_name}/${record.consumed_unit}`,
  };
}

function calculateModeledProdCost(costSurfaces, {
  passThroughFixedCostUsd = 0,
} = {}) {
  let modeledTotal = 0;
  const addOverage = (quantity, included, unitPricePerMillion) => {
    modeledTotal += Math.max(0, quantity - included) / 1_000_000 * unitPricePerMillion;
  };
  const addStorageOverage = (quantity, included, pricePerGbMonth) => {
    modeledTotal += Math.max(0, quantity - included) * pricePerGbMonth;
  };
  addOverage(costSurfaces.workers.request_count, 10_000_000, 0.30);
  addOverage(costSurfaces.workers.cpu_ms, 30_000_000, 0.02);
  addOverage(costSurfaces.workers.log_event_count, 20_000_000, 0.60);
  addOverage(costSurfaces.durable_objects.request_count, 1_000_000, 0.15);
  addOverage(costSurfaces.durable_objects.duration_gb_s, 400_000, 12.50);
  addOverage(costSurfaces.durable_objects.sqlite_row_reads, 25_000_000_000, 0.001);
  addOverage(costSurfaces.durable_objects.sqlite_row_writes, 50_000_000, 1.00);
  addStorageOverage(costSurfaces.durable_objects.sql_storage_gb_month, 5, 0.20);
  addOverage(costSurfaces.d1.read_rows, 25_000_000_000, 0.001);
  addOverage(costSurfaces.d1.write_rows, 50_000_000, 1.00);
  addStorageOverage(costSurfaces.d1.storage_gb_month, 5, 0.75);
  addStorageOverage(costSurfaces.r2.storage_gb_month, 10, 0.015);
  addOverage(costSurfaces.r2.class_a_ops, 1_000_000, 4.50);
  addOverage(costSurfaces.r2.class_b_ops, 10_000_000, 0.36);
  addOverage(costSurfaces.kv.read_ops, 10_000_000, 0.50);
  addOverage(costSurfaces.kv.write_ops, 1_000_000, 5.00);
  addOverage(costSurfaces.kv.delete_ops, 1_000_000, 5.00);
  addOverage(costSurfaces.kv.list_ops, 1_000_000, 5.00);
  addStorageOverage(costSurfaces.kv.storage_gb_month, 1, 0.50);
  const queueTotalOps = costSurfaces.queues.write_ops + costSurfaces.queues.read_ops + costSurfaces.queues.delete_ops;
  addOverage(queueTotalOps, 1_000_000, 0.40);
  modeledTotal += passThroughFixedCostUsd;
  return modeledTotal;
}

function buildProdCostModelComparison(actualTotalUsd, modeledTotalUsd, {
  passThroughFixedCostUsd = 0,
} = {}) {
  const denominator = Math.max(actualTotalUsd, modeledTotalUsd, 1);
  const driftRatio = denominator === 0 ? 0 : Math.abs(actualTotalUsd - modeledTotalUsd) / denominator;
  const status = driftRatio <= 0.10
    ? 'within_expected'
    : driftRatio <= 0.25
      ? 'review_required'
      : 'out_of_expected';
  const summaryParts = [];
  if (passThroughFixedCostUsd > 0) {
    summaryParts.push(`pass-through fixed charges ${passThroughFixedCostUsd.toFixed(2)} USD`);
  }
  summaryParts.push(`actual ${actualTotalUsd.toFixed(2)} USD vs modeled ${modeledTotalUsd.toFixed(2)} USD`);
  if (status === 'within_expected') {
    summaryParts.push('no abnormal budget drift detected');
  } else if (status === 'review_required') {
    summaryParts.push('drift exceeds the normal review threshold');
  } else {
    summaryParts.push('drift is outside the expected budget range');
  }
  return Object.freeze({
    status,
    summary: summaryParts.join('; '),
    actual_total_usd: actualTotalUsd,
    modeled_total_usd: modeledTotalUsd,
    drift_ratio: driftRatio,
  });
}

function aggregateProdCostSurfaces(billingUsageRecords) {
  const costSurfaces = createZeroProdCostSurfaces();
  let actualTotalUsd = 0;
  let matchedRecordCount = 0;
  let passThroughFixedCostUsd = 0;
  const unsupportedReasons = [];
  for (const record of billingUsageRecords) {
    const classification = classifyBillingUsageRecord(record);
    if (classification.unsupported_reason) {
      if (record.contracted_cost > 0 || record.consumed_quantity > 0) {
        unsupportedReasons.push(classification.unsupported_reason);
      }
      continue;
    }
    matchedRecordCount += 1;
    actualTotalUsd += record.contracted_cost;
    if (classification.pass_through_kind != null) {
      passThroughFixedCostUsd += record.contracted_cost;
      continue;
    }
    incrementSurfaceMetric(costSurfaces, classification.surface_name, classification.metric_name, record.consumed_quantity);
  }
  if (matchedRecordCount === 0) {
    throw new Error('Cloudflare billing usage API did not return any recognizable records for the production account');
  }
  if (unsupportedReasons.length > 0) {
    throw new Error(`Cloudflare billing usage records remain unsupported for prod cost normalization: ${unsupportedReasons.join('; ')}`);
  }
  const modeledTotalUsd = calculateModeledProdCost(costSurfaces, {
    passThroughFixedCostUsd,
  });
  return Object.freeze({
    cost_surfaces: costSurfaces,
    model_comparison: buildProdCostModelComparison(actualTotalUsd, modeledTotalUsd, {
      passThroughFixedCostUsd,
    }),
  });
}

function deriveBillingPeriodFromUsageRecords(billingUsageRecords) {
  const starts = billingUsageRecords.map((record) => Date.parse(record.billing_period_start));
  const ends = billingUsageRecords.map((record) => Date.parse(record.charge_period_end));
  return Object.freeze({
    start: new Date(Math.min(...starts)).toISOString(),
    end: new Date(Math.max(...ends)).toISOString(),
  });
}

function assertBillingUsageMatchesClosedMonthlyWindow(billingUsageRecords, billingWindow) {
  for (const [index, record] of billingUsageRecords.entries()) {
    const observedBillingPeriodStart = normalizeObservedBillingDate(record.billing_period_start, `billing usage record ${index} BillingPeriodStart`);
    const observedChargePeriodStart = normalizeObservedBillingDate(record.charge_period_start, `billing usage record ${index} ChargePeriodStart`);
    const observedChargePeriodEnd = normalizeObservedBillingDate(record.charge_period_end, `billing usage record ${index} ChargePeriodEnd`);
    if (observedBillingPeriodStart !== billingWindow.fromDate) {
      throw new Error(
        `Cloudflare billing usage record ${index} BillingPeriodStart ${observedBillingPeriodStart} does not match requested production billing window start ${billingWindow.fromDate}`,
      );
    }
    if (observedChargePeriodStart !== billingWindow.fromDate) {
      throw new Error(
        `Cloudflare billing usage record ${index} ChargePeriodStart ${observedChargePeriodStart} does not match requested production billing window start ${billingWindow.fromDate}`,
      );
    }
    if (observedChargePeriodEnd !== billingWindow.toDate) {
      throw new Error(
        `Cloudflare billing usage record ${index} ChargePeriodEnd ${observedChargePeriodEnd} does not match requested production billing window end ${billingWindow.toDate}`,
      );
    }
  }
}

async function listProdCloudflareResourceNames({
  accountId,
  apiToken,
}, {
  callCloudflareApiImpl = callCloudflareApi,
} = {}) {
  const [workersPayload, databasesPayload, kvNamespacesPayload, bucketsPayload, queuesPayload] = await Promise.all([
    callCloudflareApiImpl({
      accountId,
      apiToken,
      pathname: '/workers/scripts',
    }),
    callCloudflareApiImpl({
      accountId,
      apiToken,
      pathname: '/d1/database',
    }),
    callCloudflareApiImpl({
      accountId,
      apiToken,
      pathname: '/storage/kv/namespaces',
    }),
    callCloudflareApiImpl({
      accountId,
      apiToken,
      pathname: '/r2/buckets',
    }),
    callCloudflareApiImpl({
      accountId,
      apiToken,
      pathname: '/queues',
    }),
  ]);
  return Object.freeze({
    workers: Object.freeze(extractArrayResult(workersPayload.result).map((entry) => extractStringField(entry, ['id', 'script_name', 'name', 'tag'])).filter(Boolean).sort()),
    d1_databases: Object.freeze(extractArrayResult(databasesPayload.result).map((entry) => extractStringField(entry, ['name', 'database_name'])).filter(Boolean).sort()),
    kv_namespaces: Object.freeze(extractArrayResult(kvNamespacesPayload.result).map((entry) => extractStringField(entry, ['title', 'namespace'])).filter(Boolean).sort()),
    r2_buckets: Object.freeze(extractArrayResult(bucketsPayload.result, ['buckets']).map((entry) => extractStringField(entry, ['name'])).filter(Boolean).sort()),
    queues: Object.freeze(extractArrayResult(queuesPayload.result).map((entry) => extractStringField(entry, ['queue_name', 'name'])).filter(Boolean).sort()),
  });
}

function buildKnownNonProductionCloudflareResourceNames() {
  const workers = [];
  const d1Databases = [];
  const kvNamespaces = [];
  const r2Buckets = [];
  const queues = [];
  for (const environmentName of NON_LOCAL_ENVIRONMENT_NAMES) {
    workers.push(...listWorkerNames().map((workerName) => buildWorkerScriptName(workerName, environmentName)));
    d1Databases.push(`matrix-control-and-derived-${environmentName}`);
    kvNamespaces.push(`matrix-edge-cache-${environmentName}`);
    r2Buckets.push(
      `matrix-archive-${environmentName}`,
      `matrix-evidence-${environmentName}`,
      `matrix-media-${environmentName}`,
    );
    for (const [, baseQueueName] of QUEUE_BINDING_NAMES) {
      queues.push(`${baseQueueName}-${environmentName}`);
    }
  }
  return Object.freeze({
    workers: Object.freeze(sortUniqueStringArray(workers)),
    d1_databases: Object.freeze(sortUniqueStringArray(d1Databases)),
    kv_namespaces: Object.freeze(sortUniqueStringArray(kvNamespaces)),
    r2_buckets: Object.freeze(sortUniqueStringArray(r2Buckets)),
    queues: Object.freeze(sortUniqueStringArray(queues)),
  });
}

function assertProdBillingAccountIsolation(actualResourceNames, expectedResources) {
  const knownNonProductionResources = buildKnownNonProductionCloudflareResourceNames();
  const unexpectedResources = [];
  const overlappingResources = [];
  for (const key of ['workers', 'd1_databases', 'kv_namespaces', 'r2_buckets', 'queues']) {
    const actualNames = new Set(actualResourceNames[key]);
    const overlaps = knownNonProductionResources[key].filter((entry) => actualNames.has(entry));
    if (overlaps.length > 0) {
      overlappingResources.push(`${key}: ${overlaps.join(', ')}`);
    }
    const expectedNames = new Set(expectedResources[key]);
    const extras = actualResourceNames[key].filter((entry) => !expectedNames.has(entry));
    if (extras.length > 0) {
      unexpectedResources.push(`${key}: ${extras.join(', ')}`);
    }
  }
  if (overlappingResources.length > 0) {
    throw new Error(
      'production cost snapshot remains fail-closed under OQ-0002: Cloudflare Billing Usage API is account-scoped, '
      + `and the current account still contains non-production Matrix resources (${overlappingResources.join('; ')})`,
    );
  }
  if (unexpectedResources.length > 0) {
    throw new Error(
      'production cost snapshot remains fail-closed under OQ-0002: Cloudflare Billing Usage API is account-scoped, '
      + `and the current account still contains unexpected non-Matrix Cloudflare resources (${unexpectedResources.join('; ')})`,
    );
  }
}

function assertProdResourcesPresent(actualResourceNames, expectedResources) {
  const mismatches = [];
  const requiredKeys = ['workers', 'd1_databases', 'kv_namespaces', 'r2_buckets', 'queues'];
  for (const key of requiredKeys) {
    const actualNames = new Set(actualResourceNames[key]);
    const missingNames = expectedResources[key].filter((entry) => !actualNames.has(entry));
    if (missingNames.length > 0) {
      mismatches.push(`${key}: missing ${missingNames.join(', ')}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`production Cloudflare resources are incomplete: ${mismatches.join('; ')}`);
  }
}

export function buildProdCostSnapshotProvenance({
  githubRepository,
  githubRunId,
  githubRunAttempt,
  oidcClaims = null,
  deploymentIdentity,
  artifactUpload,
  githubArtifact = null,
  reviewRecordUri = null,
}) {
  if (oidcClaims != null) {
    if (String(oidcClaims.repository ?? '') !== String(githubRepository ?? '')) {
      throw new Error('GitHub Actions OIDC repository claim must match provenance repository');
    }
    if (String(oidcClaims.run_id ?? '') !== String(githubRunId ?? '')) {
      throw new Error('GitHub Actions OIDC run_id claim must match provenance run id');
    }
    if (String(oidcClaims.run_attempt ?? '') !== String(githubRunAttempt ?? '')) {
      throw new Error('GitHub Actions OIDC run_attempt claim must match provenance run attempt');
    }
  }
  if (deploymentIdentity?.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new Error('deployment identity environment_id must equal prod');
  }
  if (artifactUpload?.object_uri !== `r2://${artifactUpload?.bucket_name}/${artifactUpload?.object_key}`) {
    throw new Error('artifact upload must provide a canonical immutable R2 object_uri');
  }
  const originRunUri = buildGitHubRunUrl(githubRepository, githubRunId);
  const provenance = {
    origin_system: 'github-actions',
    origin_repository: String(githubRepository),
    origin_run_id: String(githubRunId),
    origin_run_attempt: Number(githubRunAttempt),
    origin_run_uri: originRunUri,
    artifact_store_uri: artifactUpload.object_uri,
    artifact_store_key: artifactUpload.object_key,
    artifact_sha256: artifactUpload.file_sha256,
    review_record_uri: reviewRecordUri ?? originRunUri,
    topology_kind: 'cloudflare-prod',
    deployment_identity: structuredCloneJson(deploymentIdentity),
  };
  if (githubArtifact != null) {
    provenance.origin_artifact = structuredCloneJson(githubArtifact);
  }
  return provenance;
}

export async function writeProdCostSnapshotProvenance(outputPath, options, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
} = {}) {
  const claims = await requireGitHubActionsExecutionImpl('writeProdCostSnapshotProvenance', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const provenance = buildProdCostSnapshotProvenance({
    ...options,
    githubRepository: String(claims.repository),
    githubRunId: String(claims.run_id),
    githubRunAttempt: String(claims.run_attempt),
    oidcClaims: claims,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(provenance));
  return {
    output_path: outputPath,
    provenance,
  };
}

export async function resolveClosedProdBillingWindow({
  artifactRoot = null,
  outputPath,
  profileOutputPath,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
  requireCloudflareCredentialsImpl = requireCloudflareCredentials,
  callCloudflareApiImpl = callCloudflareApi,
  now = new Date(),
} = {}) {
  await requireGitHubActionsExecutionImpl('resolveClosedProdBillingWindow', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const { accountId, apiToken } = requireCloudflareCredentialsImpl({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedArtifactRoot = path.resolve(artifactRoot ?? path.join(process.cwd(), '.tmp', 'prod-cost'));
  const resolvedOutputPath = path.resolve(outputPath ?? path.join(resolvedArtifactRoot, 'billing-window.json'));
  const resolvedProfileOutputPath = path.resolve(profileOutputPath ?? path.join(resolvedArtifactRoot, 'billing-profile.json'));
  const resolvedSubscriptionsOutputPath = path.join(resolvedArtifactRoot, 'billing-subscriptions.json');
  await Promise.all([
    fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true }),
    fs.mkdir(path.dirname(resolvedProfileOutputPath), { recursive: true }),
    fs.mkdir(path.dirname(resolvedSubscriptionsOutputPath), { recursive: true }),
  ]);

  let profilePayload = null;
  let subscriptionsPayload = null;
  const attemptedResolutionMethods = [];
  try {
    let resolutionMethod = null;
    let nextBillDate = null;
    let billingWindow = null;
    let allowSubscriptionsFallback = false;

    try {
      profilePayload = await callCloudflareApiImpl({
        accountId,
        apiToken,
        pathname: '/billing/profile',
      });
      await fs.writeFile(resolvedProfileOutputPath, stableJson(profilePayload));
      const billingProfile = normalizeCloudflareBillingProfile(profilePayload.result);
      attemptedResolutionMethods.push(PROD_BILLING_WINDOW_RESOLUTION_METHODS.profileNextBillDate);
      if (billingProfile.next_bill_date != null) {
        resolutionMethod = PROD_BILLING_WINDOW_RESOLUTION_METHODS.profileNextBillDate;
        nextBillDate = billingProfile.next_bill_date;
        billingWindow = deriveClosedBillingWindowFromNextBillDate({
          nextBillDate,
          now,
        });
      } else {
        allowSubscriptionsFallback = true;
      }
    } catch (error) {
      const diagnosticPayload = profilePayload == null
        ? {
            pathname: '/billing/profile',
            error: String(error?.message ?? error),
          }
        : {
            profile_payload: profilePayload,
            error: String(error?.message ?? error),
          };
      await fs.writeFile(resolvedProfileOutputPath, stableJson(diagnosticPayload));
      throw error;
    }

    if (billingWindow == null && allowSubscriptionsFallback) {
      try {
        attemptedResolutionMethods.push(PROD_BILLING_WINDOW_RESOLUTION_METHODS.subscriptionsCurrentPeriodEnd);
        subscriptionsPayload = await callCloudflareApiImpl({
          accountId,
          apiToken,
          pathname: '/subscriptions',
        });
        await fs.writeFile(resolvedSubscriptionsOutputPath, stableJson(subscriptionsPayload));
        const subscriptionBillingWindow = normalizeCloudflareSubscriptionsBillingCycleAnchor(
          subscriptionsPayload.result,
          { now },
        );
        resolutionMethod = PROD_BILLING_WINDOW_RESOLUTION_METHODS.subscriptionsCurrentPeriodEnd;
        nextBillDate = subscriptionBillingWindow.nextBillDate;
        billingWindow = subscriptionBillingWindow;
      } catch (subscriptionsError) {
        const diagnosticPayload = subscriptionsPayload == null
          ? {
              pathname: '/subscriptions',
              error: String(subscriptionsError?.message ?? subscriptionsError),
            }
          : {
              subscriptions_payload: subscriptionsPayload,
              error: String(subscriptionsError?.message ?? subscriptionsError),
            };
        await fs.writeFile(resolvedSubscriptionsOutputPath, stableJson(diagnosticPayload));
        throw new Error(
          `Cloudflare billing cycle anchor resolution failed: billing profile response omitted next_bill_date, and subscriptions fallback failed with "${String(subscriptionsError?.message ?? subscriptionsError)}"`,
        );
      }
    }

    const outputPayload = {
      resolution_method: resolutionMethod,
      next_bill_date: nextBillDate,
      from_date: billingWindow.fromDate,
      to_date: billingWindow.toDate,
    };
    await fs.writeFile(resolvedOutputPath, stableJson(outputPayload));
    return {
      output_path: resolvedOutputPath,
      profile_path: resolvedProfileOutputPath,
      subscriptions_path: subscriptionsPayload == null ? null : resolvedSubscriptionsOutputPath,
      from_date: billingWindow.fromDate,
      to_date: billingWindow.toDate,
      billing_window: billingWindow,
      resolution_method: resolutionMethod,
    };
  } catch (error) {
    const diagnosticPayload = profilePayload == null
      ? {
          pathname: '/billing/profile',
          error: String(error?.message ?? error),
        }
      : null;
    await Promise.allSettled([
      ...(diagnosticPayload == null ? [] : [fs.writeFile(resolvedProfileOutputPath, stableJson(diagnosticPayload))]),
      fs.writeFile(resolvedOutputPath, stableJson({
        resolution_method: attemptedResolutionMethods.length === 1 ? attemptedResolutionMethods[0] : null,
        attempted_resolution_methods: attemptedResolutionMethods,
        error: String(error?.message ?? error),
      })),
    ]);
    throw error;
  }
}

export async function captureProdCostSnapshot({
  runTimestamp,
  outputPath,
  artifactRoot,
  billingWindow = null,
  prodInstallRecord = null,
  capturedBy = null,
  reviewedBy = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
  requireCloudflareCredentialsImpl = requireCloudflareCredentials,
  callCloudflareApiImpl = callCloudflareApi,
  fetchWorkerDeploymentStateImpl = fetchWorkerDeploymentState,
  fetchWorkerBindingStateImpl = fetchWorkerBindingState,
  now = new Date(),
} = {}) {
  const claims = await requireGitHubActionsExecutionImpl('captureProdCostSnapshot', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  if (!isNonEmptyString(runTimestamp)) {
    throw new RangeError('runTimestamp is required');
  }
  const normalizedBillingWindow = normalizeResolvedClosedProdBillingWindow(billingWindow, {
    now,
  });
  const prodInstallRecordValidation = validateProdInstallRecord(prodInstallRecord, {
    expectedGitHubRepository: String(claims.repository ?? ''),
  });
  if (!prodInstallRecordValidation.valid) {
    throw new Error(`production cost snapshot requires a valid prod install record: ${prodInstallRecordValidation.error}`);
  }
  const prodInstallDate = normalizeObservedBillingDate(
    prodInstallRecord.installed_at,
    'prod install record installed_at',
  );
  if (
    parseBillingPeriodDateToUtcMillis(normalizedBillingWindow.fromDate, 'resolved production billing window from_date')
    <= parseBillingPeriodDateToUtcMillis(prodInstallDate, 'prod install record installed_at')
  ) {
    throw new Error(`production cost snapshot requires a closed billing window that starts after prod install date ${prodInstallDate}`);
  }
  const { accountId, apiToken } = requireCloudflareCredentialsImpl({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const expectedResources = buildExpectedProductionCloudflareResources();
  const resolvedArtifactRoot = path.resolve(artifactRoot ?? path.join(process.cwd(), '.tmp', 'prod-cost'));
  await fs.mkdir(resolvedArtifactRoot, { recursive: true });

  const workerStateEntries = await Promise.all(expectedResources.workers.map(async (scriptName) => ({
    script_name: scriptName,
    state: await fetchWorkerDeploymentStateImpl({
      accountId,
      apiToken,
      scriptName,
      allowMissingScript: false,
    }),
  })));
  const gatewayBindingState = await fetchWorkerBindingStateImpl({
    accountId,
    apiToken,
    scriptName: buildProductionWorkerScriptName('gateway-worker'),
  });
  const actualResourceNames = await listProdCloudflareResourceNames({
    accountId,
    apiToken,
  }, {
    callCloudflareApiImpl,
  });
  const billingUsagePath = path.join(resolvedArtifactRoot, 'billing-usage-paygo.json');
  const workerStatePath = path.join(resolvedArtifactRoot, 'prod-worker-state.json');
  const resourceSnapshotPath = path.join(resolvedArtifactRoot, 'prod-resource-snapshot.json');
  const deploymentIdentityPath = path.join(resolvedArtifactRoot, 'prod-deployment-identity.json');

  const billingUsagePathname = buildBillingUsageApiPath({
    fromDate: normalizedBillingWindow.fromDate,
    toDate: normalizedBillingWindow.toDate,
  });
  const billingUsagePayload = await callCloudflareApiImpl({
    accountId,
    apiToken,
    pathname: billingUsagePathname,
  });
  await Promise.all([
    fs.writeFile(billingUsagePath, stableJson(billingUsagePayload)),
    fs.writeFile(workerStatePath, stableJson(workerStateEntries)),
    fs.writeFile(resourceSnapshotPath, stableJson({
      expected_resources: expectedResources,
      actual_resource_names: actualResourceNames,
      gateway_binding_state: gatewayBindingState,
    })),
  ]);

  const billingUsageRecords = extractArrayResult(billingUsagePayload.result).map((entry, index) => normalizeBillingUsageRecord(entry, index));
  if (billingUsageRecords.length === 0) {
    throw new Error('Cloudflare billing usage API returned zero records for the requested production billing window');
  }
  assertBillingUsageMatchesClosedMonthlyWindow(billingUsageRecords, normalizedBillingWindow);
  const billingCurrencies = sortUniqueStringArray(billingUsageRecords.map((record) => record.billing_currency));
  if (billingCurrencies.length !== 1) {
    throw new Error(`Cloudflare billing usage API returned multiple billing currencies: ${billingCurrencies.join(', ')}`);
  }
  assertProdResourcesPresent(actualResourceNames, expectedResources);
  assertProdBillingAccountIsolation(actualResourceNames, expectedResources);
  const gatewayRatelimitNamespaces = sortUniqueStringArray(gatewayBindingState.ratelimit_namespace_ids ?? []);
  const expectedRatelimitNamespaces = [...expectedResources.ratelimit_namespaces];
  if (JSON.stringify(gatewayRatelimitNamespaces) !== JSON.stringify(expectedRatelimitNamespaces)) {
    throw new Error(`gateway-worker prod ratelimit namespaces must match expected production bindings ${expectedRatelimitNamespaces.join(', ')}`);
  }
  const deploymentIdentity = {
    environment_id: PRODUCTION_ENVIRONMENT_NAME,
    deployment_ids: workerStateEntries.map((entry) => {
      if (!isNonEmptyString(entry.state.latest_active_deployment_id)) {
        throw new Error(`Cloudflare did not expose an active deployment id for ${entry.script_name}`);
      }
      return entry.state.latest_active_deployment_id;
    }),
    worker_version_ids: workerStateEntries.map((entry) => {
      const activeVersionIds = sortUniqueStringArray(entry.state.active_worker_version_ids ?? []);
      if (activeVersionIds.length !== 1) {
        throw new Error(
          `Cloudflare must expose exactly one active worker version id for ${entry.script_name} when capturing a production monthly snapshot`,
        );
      }
      return activeVersionIds[0];
    }),
  };
  await fs.writeFile(deploymentIdentityPath, stableJson(deploymentIdentity));

  const aggregated = aggregateProdCostSurfaces(billingUsageRecords);
  const snapshot = {
    artifact_id: 'prod_cost_snapshot',
    source_environment: PRODUCTION_ENVIRONMENT_NAME,
    run_timestamp: runTimestamp,
    captured_at: now.toISOString(),
    captured_by: capturedBy ?? `github-actions:${process.env.GITHUB_ACTOR ?? 'unknown'}`,
    reviewed_by: reviewedBy ?? `github-actions-run:${claims.run_id}`,
    source_dashboard_uri: `https://api.cloudflare.com/client/v4/accounts/${accountId}${billingUsagePathname}`,
    billing_window_resolution_method: normalizedBillingWindow.resolutionMethod,
    billing_cycle_anchor_source_uri: buildProdBillingCycleAnchorSourceUri(accountId, normalizedBillingWindow.resolutionMethod),
    billing_cycle_anchor_artifact: buildProdBillingCycleAnchorArtifactReference(normalizedBillingWindow.resolutionMethod),
    billing_cycle_next_bill_date: normalizedBillingWindow.nextBillDate,
    topology_kind: 'cloudflare-prod',
    topology_baseline_install: {
      install_id: prodInstallRecord.install_id,
      installed_at: prodInstallRecord.installed_at,
      origin_run_uri: prodInstallRecord.origin_run_uri,
    },
    cloudflare_resources: expectedResources,
    billing_period: deriveBillingPeriodFromUsageRecords(billingUsageRecords),
    cost_surfaces: aggregated.cost_surfaces,
    model_comparison: aggregated.model_comparison,
  };
  const validation = validateManualArtifactPayload('prod_cost_snapshot', snapshot, {
    runTimestamp,
  });
  if (!validation.valid) {
    throw new Error(`Generated prod_cost_snapshot payload is invalid: ${validation.error}`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(snapshot));
  return {
    output_path: outputPath,
    deployment_identity_path: deploymentIdentityPath,
    billing_usage_path: billingUsagePath,
    resource_snapshot_path: resourceSnapshotPath,
    snapshot,
    deployment_identity: deploymentIdentity,
  };
}

function isMissingWorkerScriptObservationError(scriptName, error) {
  if (!isNonEmptyString(scriptName) || (!(error instanceof Error) && !isPlainObject(error))) {
    return false;
  }
  const responseStatus = Number(error.response_status ?? Number.NaN);
  if (!Number.isNaN(responseStatus) && responseStatus !== 404) {
    return false;
  }
  const message = String(error.message ?? '');
  if (!message.includes(CLOUDFLARE_MISSING_WORKER_ERROR_MESSAGE)) {
    return false;
  }
  const scriptPattern = escapeRegExp(scriptName);
  const observationPathPattern = `/workers/scripts/${scriptPattern}/(?:deployments|versions)`;
  const messagePattern = new RegExp(`Cloudflare API GET ${observationPathPattern} failed:`, 'i');
  return messagePattern.test(message);
}

export function resolvePreDeployWorkerDeploymentState(scriptName, fetchResults) {
  if (!Array.isArray(fetchResults) || fetchResults.length === 0) {
    throw new TypeError('pre-deploy worker deployment state resolution requires observation results');
  }
  if (!fetchResults.every((result) => isPlainObject(result) && (result.status === 'fulfilled' || result.status === 'rejected'))) {
    throw new TypeError('pre-deploy worker deployment state resolution requires settled promise results');
  }
  const failures = fetchResults
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (
    failures.length === fetchResults.length
    && failures.every((error) => isMissingWorkerScriptObservationError(scriptName, error))
  ) {
    return summarizeWorkerDeploymentState({
      deployments: [],
      versions: [],
    });
  }
  if (failures.length !== fetchResults.length) {
    throw new Error(`Cloudflare worker deployment observations for ${scriptName} were partially fulfilled before bootstrap; refusing to treat the worker as missing`);
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  throw new Error(`Cloudflare worker deployment observations for ${scriptName} did not expose a usable bootstrap state`);
}

export function resolveFreshCloudflareIdentity(previousIds, currentIds, label) {
  const previousSet = new Set(previousIds);
  const nextIds = currentIds.filter((candidate) => !previousSet.has(candidate));
  const uniqueNextIds = [...new Set(nextIds)];
  if (uniqueNextIds.length === 1) {
    return uniqueNextIds[0];
  }
  if (uniqueNextIds.length === 0) {
    throw new Error(`Unable to resolve a fresh ${label} from Cloudflare; rerun refused to reuse an existing identity`);
  }
  throw new Error(`Unable to resolve a unique fresh ${label} from Cloudflare`);
}

function expectedActiveWorkerVersionIdsForValidation(workerSummary) {
  if (!Array.isArray(workerSummary?.expected_active_worker_version_ids)) {
    return [workerSummary?.worker_version_id];
  }
  if (
    workerSummary.expected_active_worker_version_ids.length === 0
    || !workerSummary.expected_active_worker_version_ids.every((entry) => isNonEmptyString(entry))
  ) {
    throw new TypeError('deployment worker expected_active_worker_version_ids must be a non-empty string array when present');
  }
  const normalized = sortUniqueStringArray(workerSummary.expected_active_worker_version_ids);
  if (normalized.length !== workerSummary.expected_active_worker_version_ids.length) {
    throw new TypeError('deployment worker expected_active_worker_version_ids must not contain duplicates');
  }
  return normalized;
}

function validateNamedCloudflareResourceSnapshot(resources, expectedResources, label) {
  if (!isPlainObject(resources)) {
    throw new TypeError(`${label} must be an object`);
  }
  const validatedResources = {};
  for (const [key, expectedValues] of Object.entries(expectedResources)) {
    if (!isNonEmptyStringArray(resources[key])) {
      throw new TypeError(`${label}.${key} must be a non-empty string array`);
    }
    const declaredValues = sortUniqueStringArray(resources[key]);
    if (declaredValues.length !== resources[key].length) {
      throw new TypeError(`${label}.${key} must not contain duplicates`);
    }
    const normalizedExpectedValues = sortUniqueStringArray(expectedValues);
    if (
      declaredValues.length !== normalizedExpectedValues.length
      || declaredValues.some((entry, index) => entry !== normalizedExpectedValues[index])
    ) {
      throw new TypeError(`${label}.${key} must match the fixed environment topology`);
    }
    validatedResources[key] = Object.freeze([...normalizedExpectedValues]);
  }
  return Object.freeze(validatedResources);
}

function buildExpectedEnvironmentCloudflareResources(environmentName, workersSubdomain = null) {
  const plan = buildNonLocalEnvironmentPlan(environmentName, {
    workersSubdomain,
  });
  return Object.freeze({
    ...plan.cloudflare_resources,
    r2_buckets: Object.freeze(sortUniqueStringArray([
      ...plan.cloudflare_resources.r2_buckets,
      plan.artifact_bucket_name,
    ])),
  });
}

export function validateLatestActiveCloudflareWorkerIdentity(workerName, workerSummary, currentDeploymentState) {
  if (!isPlainObject(workerSummary)) {
    throw new TypeError(`deployment workers.${workerName} must be an object`);
  }
  if (!isPlainObject(currentDeploymentState)) {
    throw new TypeError(`current Cloudflare deployment state for ${workerName} must be an object`);
  }
  if (currentDeploymentState.latest_active_deployment_id !== workerSummary.deployment_id) {
    throw new TypeError(`deployment workers.${workerName}.deployment_id is not the latest active Cloudflare deployment for ${workerSummary.script_name}`);
  }
  if (
    !Array.isArray(currentDeploymentState.active_worker_version_ids)
    || !currentDeploymentState.active_worker_version_ids.every((entry) => isNonEmptyString(entry))
  ) {
    throw new TypeError(`current Cloudflare deployment state for ${workerName} must expose active_worker_version_ids`);
  }
  const expectedActiveWorkerVersionIds = expectedActiveWorkerVersionIdsForValidation(workerSummary);
  const normalizedActiveWorkerVersionIds = sortUniqueStringArray(currentDeploymentState.active_worker_version_ids);
  if (normalizedActiveWorkerVersionIds.length !== currentDeploymentState.active_worker_version_ids.length) {
    throw new TypeError(
      `current Cloudflare deployment state for ${workerName} must not expose duplicate active_worker_version_ids`,
    );
  }
  if (
    normalizedActiveWorkerVersionIds.length !== expectedActiveWorkerVersionIds.length
    || normalizedActiveWorkerVersionIds.some((entry, index) => entry !== expectedActiveWorkerVersionIds[index])
  ) {
    throw new TypeError(
      `deployment workers.${workerName}.active_worker_version_ids must exactly match the latest active Cloudflare deployment for ${workerSummary.script_name}`,
    );
  }
}

export async function validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
  accountId,
  apiToken,
  fetchWorkerDeploymentStateImpl = fetchWorkerDeploymentState,
  fetchWorkerBindingStateImpl = fetchWorkerBindingState,
} = {}) {
  if (!isPlainObject(deploymentSummary)) {
    throw new TypeError('deployment summary must be an object');
  }
  if (!isNonEmptyString(accountId)) {
    throw new TypeError('accountId must be a non-empty string');
  }
  if (!isNonEmptyString(apiToken)) {
    throw new TypeError('apiToken must be a non-empty string');
  }
  if (typeof fetchWorkerDeploymentStateImpl !== 'function') {
    throw new TypeError('fetchWorkerDeploymentStateImpl must be a function');
  }
  if (typeof fetchWorkerBindingStateImpl !== 'function') {
    throw new TypeError('fetchWorkerBindingStateImpl must be a function');
  }
  if (!isPlainObject(deploymentSummary.workers)) {
    throw new TypeError('deployment summary workers must be an object');
  }
  if (!isPlainObject(deploymentSummary.cloudflare_resources)) {
    throw new TypeError('deployment summary cloudflare_resources must be an object');
  }
  const validatedCloudflareResources = validateNamedCloudflareResourceSnapshot(
    deploymentSummary.cloudflare_resources,
    buildExpectedEnvironmentCloudflareResources(
      deploymentSummary.environment_name,
      deploymentSummary.workers_subdomain ?? null,
    ),
    'deployment summary cloudflare_resources',
  );

  const workers = {};
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const workerSummary = deploymentSummary.workers?.[workerName];
    const [currentDeploymentState, currentBindingState] = await Promise.all([
      fetchWorkerDeploymentStateImpl({
        accountId,
        apiToken,
        scriptName: workerSummary?.script_name,
      }),
      fetchWorkerBindingStateImpl({
        accountId,
        apiToken,
        scriptName: workerSummary?.script_name,
      }),
    ]);
    validateLatestActiveCloudflareWorkerIdentity(workerName, workerSummary, currentDeploymentState);
    if (
      !isPlainObject(currentBindingState)
      || !Array.isArray(currentBindingState.ratelimit_namespace_ids)
      || !currentBindingState.ratelimit_namespace_ids.every((namespaceId) => isNonEmptyString(namespaceId))
    ) {
      throw new TypeError(`current Cloudflare binding state for ${workerName} must expose ratelimit_namespace_ids`);
    }
    workers[workerName] = Object.freeze({
      script_name: workerSummary.script_name,
      latest_active_deployment_id: currentDeploymentState.latest_active_deployment_id,
      active_worker_version_ids: Object.freeze([
        ...currentDeploymentState.active_worker_version_ids,
      ]),
      ratelimit_namespace_ids: Object.freeze([
        ...currentBindingState.ratelimit_namespace_ids,
      ]),
    });
  }
  const observedGatewayRateLimitNamespaces = Object.freeze(sortUniqueStringArray(
    workers['gateway-worker']?.ratelimit_namespace_ids ?? [],
  ));
  if (
    validatedCloudflareResources.ratelimit_namespaces.length !== observedGatewayRateLimitNamespaces.length
    || validatedCloudflareResources.ratelimit_namespaces.some((namespaceId, index) => namespaceId !== observedGatewayRateLimitNamespaces[index])
  ) {
    throw new TypeError('deployment summary cloudflare_resources.ratelimit_namespaces must match currently deployed Cloudflare ratelimit namespace bindings on gateway-worker');
  }
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    if (workerName === 'gateway-worker') {
      continue;
    }
    if ((workers[workerName]?.ratelimit_namespace_ids?.length ?? 0) > 0) {
      throw new TypeError(`${workerName} must not expose ratelimit namespace bindings`);
    }
  }

  return Object.freeze({
    validated_at: new Date().toISOString(),
    workers: Object.freeze(workers),
    cloudflare_resources: Object.freeze({
      ...validatedCloudflareResources,
      ratelimit_namespaces: observedGatewayRateLimitNamespaces,
    }),
  });
}

function buildWorkerSecretPayload(workerName, secretBundle) {
  if (workerName === 'gateway-worker') {
    return secretBundle.gateway;
  }
  if (workerName === 'jobs-worker') {
    return secretBundle.jobs;
  }
  if (workerName === 'ops-worker') {
    return secretBundle.ops;
  }
  throw new RangeError(`Unsupported worker for secret payload: ${workerName}`);
}

function buildRuntimeWorkerVersionId(deploymentId, workerName) {
  return `${deploymentId}-${slugifyLabel(workerName)}`;
}

export function buildRuntimeWorkerVersionTag(deploymentId, workerName, {
  gatewayBootstrapMode = false,
} = {}) {
  const workerAlias = WORKER_TAG_ALIASES[workerName];
  if (!isNonEmptyString(workerAlias)) {
    throw new RangeError(`Unsupported worker for wrangler tag generation: ${workerName}`);
  }
  const modeAlias = gatewayBootstrapMode ? 'b' : 'd';
  const digest = sha256Hex(`${deploymentId}:${workerName}:${modeAlias}`).slice(0, 16);
  const tag = `mx-${workerAlias}-${modeAlias}-${digest}`;
  if (tag.length > CLOUDFLARE_WORKER_TAG_MAX_LENGTH) {
    throw new RangeError(`wrangler version tag must be <= ${CLOUDFLARE_WORKER_TAG_MAX_LENGTH} characters`);
  }
  return tag;
}

export function buildWranglerDeployArguments({
  workerName,
  environmentName,
  configPath,
  secretsPath,
  deploymentId,
  gatewayBootstrapMode = false,
}) {
  return [
    'deploy',
    '--config',
    configPath,
    '--env',
    assertDeployableEnvironmentName(environmentName),
    '--message',
    `${deploymentId}:${workerName}${gatewayBootstrapMode ? ':bootstrap' : ':deploy'}`,
    '--tag',
    buildRuntimeWorkerVersionTag(deploymentId, workerName, {
      gatewayBootstrapMode,
    }),
    '--secrets-file',
    secretsPath,
  ];
}

export async function ensureNonLocalEnvironmentResources(environmentName, {
  repoRoot = process.cwd(),
  outputPath = null,
  preferredWorkersSubdomain = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  await requireGitHubActionsExecution('ensureNonLocalEnvironmentResources', {
    expectedEnvironmentName: assertNonLocalEnvironmentName(environmentName),
  });
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const workersSubdomain = await ensureWorkersSubdomain({
    accountId,
    apiToken,
    preferredSubdomain: preferredWorkersSubdomain,
  });
  const plan = buildNonLocalEnvironmentPlan(environmentName, {
    workersSubdomain: workersSubdomain.subdomain,
  });
  const [organization, accessApp, d1Database, kvNamespace, mediaBucket, archiveBucket, artifactBucket, ...queues] = await Promise.all([
    getZeroTrustOrganization({
      accountId,
      apiToken,
    }),
    ensureAccessApplication({
      accountId,
      apiToken,
      plan,
    }),
    ensureD1Database({
      accountId,
      apiToken,
      databaseName: plan.d1_database_name,
    }),
    ensureKvNamespace({
      accountId,
      apiToken,
      title: plan.kv_namespace_title,
    }),
    ensureR2Bucket({
      accountId,
      apiToken,
      bucketName: plan.runtime_resource_binding_names.r2_buckets.MATRIX_MEDIA_BUCKET,
    }),
    ensureR2Bucket({
      accountId,
      apiToken,
      bucketName: plan.runtime_resource_binding_names.r2_buckets.MATRIX_ARCHIVE_BUCKET,
    }),
    ensureR2Bucket({
      accountId,
      apiToken,
      bucketName: plan.artifact_bucket_name,
    }),
    ...Object.values(plan.runtime_resource_binding_names.queues).map((queueName) => ensureQueue({
      accountId,
      apiToken,
      queueName,
    })),
  ]);
  const result = {
    environment_name: plan.environment_name,
    repo_root: repoRoot,
    account_id: accountId,
    workers_subdomain: workersSubdomain.subdomain,
    plan,
    access: {
      auth_domain: organization.auth_domain,
      application_id: accessApp.application.id,
      application_audience: accessApp.application.aud,
      application_domain: accessApp.application.domain,
      application_type: accessApp.application.type,
      application_name: accessApp.application.name,
      protected_ops_url: `https://${accessApp.application.domain}`,
      created: accessApp.created,
      updated: accessApp.updated,
    },
    resources: {
      d1_database: d1Database,
      kv_namespace: kvNamespace,
      r2_buckets: {
        media: mediaBucket,
        archive: archiveBucket,
        evidence: artifactBucket,
      },
      queues,
    },
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function ensureProductionEnvironmentResources({
  repoRoot = process.cwd(),
  outputPath = null,
  preferredWorkersSubdomain = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  await requireGitHubActionsExecution('ensureProductionEnvironmentResources', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const workersSubdomain = await ensureWorkersSubdomain({
    accountId,
    apiToken,
    preferredSubdomain: preferredWorkersSubdomain,
  });
  const plan = buildProductionEnvironmentPlan({
    workersSubdomain: workersSubdomain.subdomain,
  });
  const [organization, accessApp, d1Database, kvNamespace, mediaBucket, archiveBucket, artifactBucket, ...queues] = await Promise.all([
    getZeroTrustOrganization({
      accountId,
      apiToken,
    }),
    ensureAccessApplication({
      accountId,
      apiToken,
      plan,
    }),
    ensureD1Database({
      accountId,
      apiToken,
      databaseName: plan.d1_database_name,
    }),
    ensureKvNamespace({
      accountId,
      apiToken,
      title: plan.kv_namespace_title,
    }),
    ensureR2Bucket({
      accountId,
      apiToken,
      bucketName: plan.runtime_resource_binding_names.r2_buckets.MATRIX_MEDIA_BUCKET,
    }),
    ensureR2Bucket({
      accountId,
      apiToken,
      bucketName: plan.runtime_resource_binding_names.r2_buckets.MATRIX_ARCHIVE_BUCKET,
    }),
    ensureR2Bucket({
      accountId,
      apiToken,
      bucketName: plan.artifact_bucket_name,
    }),
    ...Object.values(plan.runtime_resource_binding_names.queues).map((queueName) => ensureQueue({
      accountId,
      apiToken,
      queueName,
    })),
  ]);
  const result = {
    environment_name: PRODUCTION_ENVIRONMENT_NAME,
    repo_root: repoRoot,
    account_id: accountId,
    workers_subdomain: workersSubdomain.subdomain,
    plan,
    access: {
      auth_domain: organization.auth_domain,
      application_id: accessApp.application.id,
      application_audience: accessApp.application.aud,
      application_domain: accessApp.application.domain,
      application_type: accessApp.application.type,
      application_name: accessApp.application.name,
      protected_ops_url: `https://${accessApp.application.domain}`,
      created: accessApp.created,
      updated: accessApp.updated,
    },
    resources: {
      d1_database: d1Database,
      kv_namespace: kvNamespace,
      r2_buckets: {
        media: mediaBucket,
        archive: archiveBucket,
        evidence: artifactBucket,
      },
      queues,
    },
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function prepareNonLocalOpsAccessSession(environmentName, {
  repoRoot = process.cwd(),
  provisionedEnvironment,
  deploymentSummary,
  workingRoot = null,
  outputPath = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecution('prepareNonLocalOpsAccessSession', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  if (!isPlainObject(provisionedEnvironment) || provisionedEnvironment.environment_name !== normalizedEnvironmentName) {
    throw new TypeError(`provisionedEnvironment must be the ${normalizedEnvironmentName} provisioning payload`);
  }
  if (!isPlainObject(deploymentSummary) || deploymentSummary.environment_name !== normalizedEnvironmentName) {
    throw new TypeError(`deploymentSummary must be the ${normalizedEnvironmentName} deployment payload`);
  }
  if (!isPlainObject(provisionedEnvironment.access)) {
    throw new TypeError('provisionedEnvironment.access must be present');
  }
  const accessMetadata = provisionedEnvironment.access;
  if (!isNonEmptyString(accessMetadata.auth_domain)) {
    throw new TypeError('provisionedEnvironment.access.auth_domain must be non-empty');
  }
  if (!isNonEmptyString(accessMetadata.application_id)) {
    throw new TypeError('provisionedEnvironment.access.application_id must be non-empty');
  }
  if (!isNonEmptyString(accessMetadata.application_audience)) {
    throw new TypeError('provisionedEnvironment.access.application_audience must be non-empty');
  }
  if (!isNonEmptyString(provisionedEnvironment.resources?.d1_database?.name)) {
    throw new TypeError('provisionedEnvironment.resources.d1_database.name must be non-empty');
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const serviceTokenResult = await ensureServiceToken({
    accountId,
    apiToken,
    environmentName: normalizedEnvironmentName,
  });
  if (!isNonEmptyString(serviceTokenResult.service_token.client_secret)) {
    throw new Error(`Cloudflare service token rotation for ${normalizedEnvironmentName} did not return client_secret`);
  }
  const accessPolicyResult = await ensureAccessApplicationPolicy({
    accountId,
    apiToken,
    appId: accessMetadata.application_id,
    environmentName: normalizedEnvironmentName,
    serviceTokenId: serviceTokenResult.service_token.id,
  });
  const operatorPolicyRecord = buildOperatorPolicyRecord({
    environmentName: normalizedEnvironmentName,
    authDomain: accessMetadata.auth_domain,
    audience: accessMetadata.application_audience,
    accessSubjectValue: serviceTokenResult.service_token.client_id,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'nonlocal', normalizedEnvironmentName, 'ops-access'));
  await executeRemoteD1Sql({
    repoRoot,
    accountId,
    databaseName: provisionedEnvironment.resources.d1_database.name,
    sql: CONTROL_PLANE_SCHEMA_SQL,
    workingRoot: resolvedWorkingRoot,
  });
  await executeRemoteD1Sql({
    repoRoot,
    accountId,
    databaseName: provisionedEnvironment.resources.d1_database.name,
    sql: buildOperatorPolicyUpsertSql(operatorPolicyRecord),
    workingRoot: resolvedWorkingRoot,
  });
  const result = {
    environment_name: normalizedEnvironmentName,
    account_id: accountId,
    access: {
      auth_domain: accessMetadata.auth_domain,
      application_id: accessMetadata.application_id,
      application_audience: accessMetadata.application_audience,
      application_domain: accessMetadata.application_domain,
      protected_ops_url: accessMetadata.protected_ops_url ?? deploymentSummary.workers?.['ops-worker']?.url ?? '',
      policy_id: accessPolicyResult.policy.id,
      policy_name: accessPolicyResult.policy.name,
      service_token_id: serviceTokenResult.service_token.id,
      service_token_name: serviceTokenResult.service_token.name,
      service_token_client_id: serviceTokenResult.service_token.client_id,
      service_token_client_secret: serviceTokenResult.service_token.client_secret,
    },
    operator_policy: {
      principal_id: operatorPolicyRecord.principal_id,
      access_subject_value: operatorPolicyRecord.access_subject_value,
      allowed_scopes: operatorPolicyRecord.allowed_scopes,
      target_scope_constraints: operatorPolicyRecord.target_scope_constraints,
    },
    audit: {
      service_token_created: serviceTokenResult.created,
      service_token_rotated: serviceTokenResult.rotated,
      policy_created: accessPolicyResult.created,
      policy_updated: accessPolicyResult.updated,
    },
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function prepareProductionOpsAccessSession({
  repoRoot = process.cwd(),
  provisionedEnvironment,
  deploymentSummary,
  workingRoot = null,
  outputPath = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  await requireGitHubActionsExecution('prepareProductionOpsAccessSession', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  if (!isPlainObject(provisionedEnvironment) || provisionedEnvironment.environment_name !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new TypeError('provisionedEnvironment must be the prod provisioning payload');
  }
  if (!isPlainObject(deploymentSummary) || deploymentSummary.environment_name !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new TypeError('deploymentSummary must be the prod deployment/install payload');
  }
  if (!isPlainObject(provisionedEnvironment.access)) {
    throw new TypeError('provisionedEnvironment.access must be present');
  }
  const accessMetadata = provisionedEnvironment.access;
  if (!isNonEmptyString(accessMetadata.auth_domain)) {
    throw new TypeError('provisionedEnvironment.access.auth_domain must be non-empty');
  }
  if (!isNonEmptyString(accessMetadata.application_id)) {
    throw new TypeError('provisionedEnvironment.access.application_id must be non-empty');
  }
  if (!isNonEmptyString(accessMetadata.application_audience)) {
    throw new TypeError('provisionedEnvironment.access.application_audience must be non-empty');
  }
  if (!isNonEmptyString(provisionedEnvironment.resources?.d1_database?.name)) {
    throw new TypeError('provisionedEnvironment.resources.d1_database.name must be non-empty');
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const serviceTokenResult = await ensureServiceToken({
    accountId,
    apiToken,
    environmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  if (!isNonEmptyString(serviceTokenResult.service_token.client_secret)) {
    throw new Error('Cloudflare service token rotation for prod did not return client_secret');
  }
  const accessPolicyResult = await ensureAccessApplicationPolicy({
    accountId,
    apiToken,
    appId: accessMetadata.application_id,
    environmentName: PRODUCTION_ENVIRONMENT_NAME,
    serviceTokenId: serviceTokenResult.service_token.id,
  });
  const operatorPolicyRecord = buildOperatorPolicyRecord({
    environmentName: PRODUCTION_ENVIRONMENT_NAME,
    authDomain: accessMetadata.auth_domain,
    audience: accessMetadata.application_audience,
    accessSubjectValue: serviceTokenResult.service_token.client_id,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'prod', 'ops-access'));
  await executeRemoteD1Sql({
    repoRoot,
    accountId,
    databaseName: provisionedEnvironment.resources.d1_database.name,
    sql: CONTROL_PLANE_SCHEMA_SQL,
    workingRoot: resolvedWorkingRoot,
  });
  await executeRemoteD1Sql({
    repoRoot,
    accountId,
    databaseName: provisionedEnvironment.resources.d1_database.name,
    sql: buildOperatorPolicyUpsertSql(operatorPolicyRecord),
    workingRoot: resolvedWorkingRoot,
  });
  const result = {
    environment_name: PRODUCTION_ENVIRONMENT_NAME,
    account_id: accountId,
    access: {
      auth_domain: accessMetadata.auth_domain,
      application_id: accessMetadata.application_id,
      application_audience: accessMetadata.application_audience,
      application_domain: accessMetadata.application_domain,
      protected_ops_url: accessMetadata.protected_ops_url ?? deploymentSummary.workers?.['ops-worker']?.url ?? '',
      policy_id: accessPolicyResult.policy.id,
      policy_name: accessPolicyResult.policy.name,
      service_token_id: serviceTokenResult.service_token.id,
      service_token_name: serviceTokenResult.service_token.name,
      service_token_client_id: serviceTokenResult.service_token.client_id,
      service_token_client_secret: serviceTokenResult.service_token.client_secret,
    },
    operator_policy: {
      principal_id: operatorPolicyRecord.principal_id,
      access_subject_value: operatorPolicyRecord.access_subject_value,
      allowed_scopes: operatorPolicyRecord.allowed_scopes,
      target_scope_constraints: operatorPolicyRecord.target_scope_constraints,
    },
    audit: {
      service_token_created: serviceTokenResult.created,
      service_token_rotated: serviceTokenResult.rotated,
      policy_created: accessPolicyResult.created,
      policy_updated: accessPolicyResult.updated,
    },
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export function buildRemoteHarnessEnvironmentVariables(plan) {
  const gatewayBaseUrl = plan.worker_urls['gateway-worker'] ?? `https://${plan.worker_scripts['gateway-worker']}.workers.dev`;
  return Object.freeze({
    MATRIX_REMOTE_BASE_URL: gatewayBaseUrl,
    MATRIX_REMOTE_SERVER_NAME: new URL(gatewayBaseUrl).host,
    MATRIX_REMOTE_OPS_BASE_URL: plan.worker_urls['ops-worker'] ?? `https://${plan.worker_scripts['ops-worker']}.workers.dev`,
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildExpectedWorkerScriptNameForEnvironment(workerName, environmentName) {
  return environmentName === PRODUCTION_ENVIRONMENT_NAME
    ? buildProductionWorkerScriptName(workerName)
    : buildWorkerScriptName(workerName, environmentName);
}

function validateDeploymentWorker(workerName, environmentName, workerSummary, {
  workersSubdomain = null,
  expectedDeploymentId = null,
  expectedWorkerVersionId = null,
} = {}) {
  if (!isPlainObject(workerSummary)) {
    throw new TypeError(`deployment workers.${workerName} must be an object`);
  }
  if (workerSummary.worker_name !== workerName) {
    throw new TypeError(`deployment workers.${workerName}.worker_name must equal ${workerName}`);
  }
  const expectedScriptName = buildExpectedWorkerScriptNameForEnvironment(workerName, environmentName);
  if (workerSummary.script_name !== expectedScriptName) {
    throw new TypeError(`deployment workers.${workerName}.script_name must equal ${expectedScriptName}`);
  }
  if (!isNonEmptyString(workerSummary.deployment_id)) {
    throw new TypeError(`deployment workers.${workerName}.deployment_id must be non-empty`);
  }
  if (expectedDeploymentId != null && workerSummary.deployment_id !== expectedDeploymentId) {
    throw new TypeError(`deployment workers.${workerName}.deployment_id must equal deployment_identity for ${workerName}`);
  }
  if (!isNonEmptyString(workerSummary.worker_version_id)) {
    throw new TypeError(`deployment workers.${workerName}.worker_version_id must be non-empty`);
  }
  if (expectedWorkerVersionId != null && workerSummary.worker_version_id !== expectedWorkerVersionId) {
    throw new TypeError(`deployment workers.${workerName}.worker_version_id must equal deployment_identity for ${workerName}`);
  }
  const parsedWorkerUrl = parseAbsoluteHttpsUrl(workerSummary.url, `deployment workers.${workerName}.url`);
  if (workersSubdomain != null) {
    const expectedHost = buildWorkersDevHost(expectedScriptName, workersSubdomain);
    if (parsedWorkerUrl.host.toLowerCase() !== expectedHost.toLowerCase()) {
      throw new TypeError(`deployment workers.${workerName}.url must match the workers.dev URL for ${expectedScriptName} in workers subdomain ${expectedHost}`);
    }
  } else {
    const workersDevHostPattern = new RegExp(`^${escapeRegExp(expectedScriptName)}\\.[a-z0-9-]+\\.workers\\.dev$`, 'i');
    if (!workersDevHostPattern.test(parsedWorkerUrl.host)) {
      throw new TypeError(`deployment workers.${workerName}.url must match the workers.dev URL for ${expectedScriptName}`);
    }
  }
  return Object.freeze({
    worker_name: workerName,
    script_name: expectedScriptName,
    deployment_id: workerSummary.deployment_id,
    worker_version_id: workerSummary.worker_version_id,
    url: parsedWorkerUrl.toString().replace(/\/$/, ''),
  });
}

async function requestRemoteHarnessJson(remoteHarnessEnv, pathname, {
  method = 'GET',
  headers = {},
  json = null,
  body = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = NON_LOCAL_READINESS_REQUEST_TIMEOUT_MS,
  baseUrl = null,
} = {}) {
  const requestHeaders = new Headers(headers);
  if (json != null && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetchImpl(`${baseUrl ?? remoteHarnessEnv.MATRIX_REMOTE_BASE_URL}${pathname}`, {
    method,
    headers: requestHeaders,
    body: json == null ? body : JSON.stringify(json),
    signal: typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return {
    response,
    payload,
  };
}

function summarizeReadinessProbeStepDetail(stepName, payload) {
  if (stepName === 'versions') {
    return summarizeClientDiscoveryVersionPayload(payload);
  }
  if (stepName === 'public_rooms') {
    return {
      chunk_length: Array.isArray(payload?.chunk) ? payload.chunk.length : null,
    };
  }
  if (stepName === 'login_reuse') {
    return {
      user_id_present: typeof payload?.user_id === 'string',
      access_token_present: typeof payload?.access_token === 'string',
      reused_existing_account: payload?.reused_existing_account === true,
    };
  }
  if (stepName === 'register_challenge') {
    return {
      session_present: typeof payload?.session === 'string',
      flows_count: Array.isArray(payload?.flows) ? payload.flows.length : 0,
    };
  }
  if (stepName === 'register_complete') {
    return {
      user_id_present: typeof payload?.user_id === 'string',
      access_token_present: typeof payload?.access_token === 'string',
    };
  }
  if (stepName === 'sync') {
    return {
      next_batch_present: typeof payload?.next_batch === 'string',
    };
  }
  if (stepName === 'media_create') {
    return {
      content_uri_present: typeof payload?.content_uri === 'string',
    };
  }
  if (stepName === 'ops_healthz') {
    return {
      service: payload?.service ?? null,
      status: payload?.status ?? null,
    };
  }
  if (stepName === 'ops_rebuild_start') {
    return {
      job_id_present: typeof payload?.job_id === 'string',
      job_type: payload?.job_type ?? null,
      state: payload?.state ?? null,
    };
  }
  return null;
}

function summarizeReadinessProbeFailureDetail(response, payload) {
  const detail = {
    status: response?.status ?? null,
  };
  if (typeof payload === 'string' && payload.length > 0) {
    detail.error = payload.slice(0, 256);
    return detail;
  }
  if (isPlainObject(payload)) {
    if (typeof payload.errcode === 'string') {
      detail.errcode = payload.errcode;
    }
    if (typeof payload.error === 'string') {
      detail.error = payload.error.slice(0, 256);
    }
    if (typeof payload.message === 'string') {
      detail.message = payload.message.slice(0, 256);
    }
  }
  return detail;
}

function summarizeVersionsReadinessProbeDetail(response, payload, {
  browserOrigin = CLIENT_DISCOVERY_BROWSER_ORIGIN,
} = {}) {
  return {
    ...summarizeClientDiscoveryVersionPayload(payload),
    browser_compatible_cors: hasClientDiscoveryBrowserCors(response, browserOrigin),
  };
}

function summarizeVersionsReadinessProbeFailureDetail(response, payload, options = {}) {
  return {
    status: response?.status ?? null,
    ...summarizeVersionsReadinessProbeDetail(response, payload, options),
  };
}

function buildReadinessProbeRunSeed(environmentName) {
  return [
    environmentName,
    process.env.GITHUB_RUN_ID ?? '',
    process.env.GITHUB_RUN_ATTEMPT ?? '',
    process.env.GITHUB_JOB ?? '',
    process.env.GITHUB_SHA ?? '',
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 10),
  ].join(':');
}

function buildReadinessProbeCredentials(environmentName, {
  attemptIndex,
  probeRunSeed = null,
} = {}) {
  if (!Number.isInteger(attemptIndex) || attemptIndex <= 0) {
    throw new RangeError('attemptIndex must be a positive integer');
  }
  const runSeed = probeRunSeed ?? buildReadinessProbeRunSeed(environmentName);
  const digest = createHash('sha256').update(`${runSeed}:${attemptIndex}`).digest('hex');
  return Object.freeze({
    username: `readiness-${slugifyLabel(environmentName)}-${attemptIndex.toString(36)}-${digest.slice(0, 16)}`,
    password: `phase08-nonlocal-readiness-${digest.slice(0, 32)}`,
    device_id: `RDY${digest.slice(0, 7).toUpperCase()}`,
  });
}

function buildReadinessProbeRebuildIdempotencyKey(environmentName, {
  probeRunSeed = null,
} = {}) {
  const runSeed = probeRunSeed ?? buildReadinessProbeRunSeed(environmentName);
  const digest = createHash('sha256').update(JSON.stringify({
    environmentName,
    probe_run_seed: runSeed,
  })).digest('hex');
  return `readiness-ops-${slugifyLabel(environmentName)}-${digest.slice(0, 24)}`;
}

function createReadinessProbeStep(stepName, ok, detail) {
  return {
    step: stepName,
    ok,
    detail,
  };
}

function createReadinessProbeFailure(stepName, detail) {
  return {
    step_name: stepName,
    detail,
  };
}

async function runNonLocalReadinessProbeAttempt(environmentName, remoteHarnessEnv, attemptIndex, {
  fetchImpl = globalThis.fetch,
  probeCredentials = null,
  probeRunSeed = null,
  requireBrowserCompatibleVersionLadder = true,
} = {}) {
  const steps = [];
  const readinessProbeCredentials = isPlainObject(probeCredentials)
    ? probeCredentials
    : buildReadinessProbeCredentials(environmentName, {
      attemptIndex,
      probeRunSeed,
    });
  const readinessProbeRebuildIdempotencyKey = buildReadinessProbeRebuildIdempotencyKey(
    environmentName,
    { probeRunSeed },
  );
  const recordSuccess = (stepName, payload) => {
    steps.push(createReadinessProbeStep(
      stepName,
      true,
      summarizeReadinessProbeStepDetail(stepName, payload),
    ));
  };
  const recordFailure = (stepName, response, payload) => {
    const detail = summarizeReadinessProbeFailureDetail(response, payload);
    steps.push(createReadinessProbeStep(stepName, false, detail));
    return createReadinessProbeFailure(stepName, detail);
  };

  try {
    const versions = await requestRemoteHarnessJson(remoteHarnessEnv, '/_matrix/client/versions', {
      headers: {
        origin: CLIENT_DISCOVERY_BROWSER_ORIGIN,
      },
      fetchImpl,
    });
    const versionsDetail = summarizeVersionsReadinessProbeDetail(versions.response, versions.payload);
    if (
      versions.response.status !== 200
      || !Array.isArray(versions.payload?.versions)
      || versionsDetail.browser_compatible_cors !== true
      || (requireBrowserCompatibleVersionLadder && versionsDetail.browser_compatible_version_ladder !== true)
    ) {
      steps.push(createReadinessProbeStep(
        'versions',
        false,
        summarizeVersionsReadinessProbeFailureDetail(versions.response, versions.payload),
      ));
      return {
        ok: false,
        steps,
        failure: createReadinessProbeFailure(
          'versions',
          summarizeVersionsReadinessProbeFailureDetail(versions.response, versions.payload),
        ),
      };
    }
    steps.push(createReadinessProbeStep('versions', true, versionsDetail));

    const publicRooms = await requestRemoteHarnessJson(remoteHarnessEnv, '/_matrix/client/v3/publicRooms?limit=1', {
      fetchImpl,
    });
    if (publicRooms.response.status !== 200 || !Array.isArray(publicRooms.payload?.chunk)) {
      return {
        ok: false,
        steps,
        failure: recordFailure('public_rooms', publicRooms.response, publicRooms.payload),
      };
    }
    recordSuccess('public_rooms', publicRooms.payload);

    const registerChallenge = await requestRemoteHarnessJson(remoteHarnessEnv, '/_matrix/client/v3/register', {
      method: 'POST',
      json: {
        username: readinessProbeCredentials.username,
        password: readinessProbeCredentials.password,
        device_id: readinessProbeCredentials.device_id,
      },
      fetchImpl,
    });
    if (registerChallenge.response.status !== 401 || typeof registerChallenge.payload?.session !== 'string') {
      return {
        ok: false,
        steps,
        failure: recordFailure('register_challenge', registerChallenge.response, registerChallenge.payload),
      };
    }
    recordSuccess('register_challenge', registerChallenge.payload);

    const registerComplete = await requestRemoteHarnessJson(remoteHarnessEnv, '/_matrix/client/v3/register', {
      method: 'POST',
      json: {
        username: readinessProbeCredentials.username,
        password: readinessProbeCredentials.password,
        device_id: readinessProbeCredentials.device_id,
        auth: {
          type: 'm.login.dummy',
          session: registerChallenge.payload.session,
        },
      },
      fetchImpl,
    });
    if (
      registerComplete.response.status !== 200
      || typeof registerComplete.payload?.access_token !== 'string'
      || typeof registerComplete.payload?.user_id !== 'string'
    ) {
      return {
        ok: false,
        steps,
        failure: recordFailure('register_complete', registerComplete.response, registerComplete.payload),
      };
    }
    recordSuccess('register_complete', registerComplete.payload);
    const accessToken = registerComplete.payload.access_token;
    if (!isNonEmptyString(accessToken)) {
      return {
        ok: false,
        steps,
        failure: createReadinessProbeFailure('register_complete', {
          error: 'readiness probe did not obtain an access token',
        }),
      };
    }
    const authHeaders = {
      authorization: `Bearer ${accessToken}`,
    };

    const sync = await requestRemoteHarnessJson(remoteHarnessEnv, '/_matrix/client/v3/sync?timeout=0&set_presence=offline', {
      headers: authHeaders,
      fetchImpl,
    });
    if (sync.response.status !== 200 || typeof sync.payload?.next_batch !== 'string') {
      return {
        ok: false,
        steps,
        failure: recordFailure('sync', sync.response, sync.payload),
      };
    }
    recordSuccess('sync', sync.payload);

    const mediaCreate = await requestRemoteHarnessJson(remoteHarnessEnv, '/_matrix/media/v3/create', {
      method: 'POST',
      headers: authHeaders,
      fetchImpl,
    });
    if (mediaCreate.response.status !== 200 || typeof mediaCreate.payload?.content_uri !== 'string') {
      return {
        ok: false,
        steps,
        failure: recordFailure('media_create', mediaCreate.response, mediaCreate.payload),
      };
    }
    recordSuccess('media_create', mediaCreate.payload);

    if (
      isNonEmptyString(remoteHarnessEnv.MATRIX_REMOTE_OPS_BASE_URL)
      && isNonEmptyString(remoteHarnessEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID)
      && isNonEmptyString(remoteHarnessEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET)
    ) {
      const opsHeaders = {
        'CF-Access-Client-Id': remoteHarnessEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': remoteHarnessEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET,
      };
      const opsHealthz = await requestRemoteHarnessJson(remoteHarnessEnv, '/_ops/v1/healthz', {
        headers: opsHeaders,
        fetchImpl,
        baseUrl: remoteHarnessEnv.MATRIX_REMOTE_OPS_BASE_URL,
      });
      if (opsHealthz.response.status !== 200 || opsHealthz.payload?.service !== 'ops-worker') {
        return {
          ok: false,
          steps,
          failure: recordFailure('ops_healthz', opsHealthz.response, opsHealthz.payload),
        };
      }
      recordSuccess('ops_healthz', opsHealthz.payload);

      const opsRebuildStart = await requestRemoteHarnessJson(remoteHarnessEnv, '/_ops/v1/rebuilds', {
        method: 'POST',
        headers: {
          ...opsHeaders,
          'Idempotency-Key': readinessProbeRebuildIdempotencyKey,
        },
        json: {
          rebuild_target: 'user_directory',
          scope: {
            scope_kind: 'global',
            scope_id: null,
          },
          reason: `Phase 08 readiness probe ${environmentName} ops rebuild start`,
          force_full_scan: false,
        },
        fetchImpl,
        baseUrl: remoteHarnessEnv.MATRIX_REMOTE_OPS_BASE_URL,
      });
      if (
        opsRebuildStart.response.status !== 202
        || typeof opsRebuildStart.payload?.job_id !== 'string'
        || opsRebuildStart.payload?.job_type !== 'rebuild'
        || typeof opsRebuildStart.payload?.state !== 'string'
        || opsRebuildStart.payload?.idempotency_key_echo !== readinessProbeRebuildIdempotencyKey
      ) {
        return {
          ok: false,
          steps,
          failure: recordFailure('ops_rebuild_start', opsRebuildStart.response, opsRebuildStart.payload),
        };
      }
      recordSuccess('ops_rebuild_start', opsRebuildStart.payload);
    }

    return {
      ok: true,
      steps,
      failure: null,
    };
  } catch (error) {
    const detail = {
      message: error instanceof Error ? error.message : String(error),
    };
    steps.push(createReadinessProbeStep('exception', false, detail));
    return {
      ok: false,
      steps,
      failure: createReadinessProbeFailure('exception', detail),
    };
  }
}

function buildReadinessProbeDelayMs(attemptIndex, {
  initialDelayMs,
  maxDelayMs,
} = {}) {
  return Math.min(maxDelayMs, initialDelayMs * (2 ** Math.max(attemptIndex - 1, 0)));
}

function sleepForReadinessProbe(delayMs, {
  sleepImpl = null,
} = {}) {
  if (typeof sleepImpl === 'function') {
    return sleepImpl(delayMs);
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitForDeploymentReadinessInternal(environmentName, remoteHarnessEnv, {
  fetchImpl = globalThis.fetch,
  maxAttempts = NON_LOCAL_READINESS_MAX_ATTEMPTS,
  initialDelayMs = NON_LOCAL_READINESS_INITIAL_DELAY_MS,
  maxDelayMs = NON_LOCAL_READINESS_MAX_DELAY_MS,
  sleepImpl = null,
  requireBrowserCompatibleVersionLadder = true,
} = {}) {
  const normalizedEnvironmentName = assertDeployableEnvironmentName(environmentName);
  const validatedRemoteHarnessEnv = validateRemoteHarnessEnvironmentVariables(remoteHarnessEnv);
  assertRequiredOpsAccessRemoteHarnessEnv(normalizedEnvironmentName, validatedRemoteHarnessEnv);
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new RangeError('initialDelayMs must be a non-negative integer');
  }
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new RangeError('maxDelayMs must be an integer greater than or equal to initialDelayMs');
  }
  if (typeof requireBrowserCompatibleVersionLadder !== 'boolean') {
    throw new TypeError('requireBrowserCompatibleVersionLadder must be boolean');
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const attempts = [];
  const probeRunSeed = buildReadinessProbeRunSeed(normalizedEnvironmentName);

  for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
    const attemptStartedAt = new Date().toISOString();
    const attemptStartedMs = Date.now();
    const attemptResult = await runNonLocalReadinessProbeAttempt(
      normalizedEnvironmentName,
      validatedRemoteHarnessEnv,
      attemptIndex,
      {
        fetchImpl,
        probeRunSeed,
        requireBrowserCompatibleVersionLadder,
      },
    );
    const delayBeforeNextAttemptMs = attemptResult.ok || attemptIndex === maxAttempts
      ? null
      : buildReadinessProbeDelayMs(attemptIndex, {
        initialDelayMs,
        maxDelayMs,
      });
    attempts.push({
      attempt: attemptIndex,
      started_at: attemptStartedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - attemptStartedMs,
      ok: attemptResult.ok,
      steps: attemptResult.steps,
      failure: attemptResult.failure,
      delay_before_next_attempt_ms: delayBeforeNextAttemptMs,
    });
    if (attemptResult.ok) {
      return {
        ready: true,
        environment_name: normalizedEnvironmentName,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        attempt_count: attemptIndex,
        last_error: null,
        attempts,
      };
    }
    if (delayBeforeNextAttemptMs != null) {
      await sleepForReadinessProbe(delayBeforeNextAttemptMs, {
        sleepImpl,
      });
    }
  }

  const lastFailure = attempts.at(-1)?.failure ?? null;
  const lastError = lastFailure == null
    ? 'non-local deployment readiness probe failed without a recorded cause'
    : `${lastFailure.step_name}: ${JSON.stringify(lastFailure.detail)}`;
  return {
    ready: false,
    environment_name: normalizedEnvironmentName,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    attempt_count: attempts.length,
    last_error: lastError,
    attempts,
  };
}

export async function waitForNonLocalDeploymentReadiness(environmentName, remoteHarnessEnv, options = {}) {
  assertNonLocalEnvironmentName(environmentName);
  return waitForDeploymentReadinessInternal(environmentName, remoteHarnessEnv, options);
}

export async function waitForProductionDeploymentReadiness(remoteHarnessEnv, options = {}) {
  return waitForDeploymentReadinessInternal(PRODUCTION_ENVIRONMENT_NAME, remoteHarnessEnv, options);
}

function formatDeploymentReadinessProbeLog(readinessProbe) {
  return [
    '# Deployment readiness probe',
    stableJson(readinessProbe).trimEnd(),
  ].join('\n');
}

export function buildRemoteHarnessEnvironmentVariablesFromDeployment(environmentName, deploymentSummary, {
  workersSubdomain = null,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  if (!isPlainObject(deploymentSummary)) {
    throw new TypeError('deployment summary must be an object');
  }
  if (deploymentSummary.environment_name !== normalizedEnvironmentName) {
    throw new TypeError(`deployment summary environment_name must equal ${normalizedEnvironmentName}`);
  }
  if (deploymentSummary.deployment_identity?.environment_id !== normalizedEnvironmentName) {
    throw new TypeError(`deployment summary deployment_identity.environment_id must equal ${normalizedEnvironmentName}`);
  }
  if (!Array.isArray(deploymentSummary.deployment_identity?.deployment_ids) || deploymentSummary.deployment_identity.deployment_ids.length !== WORKER_DEPLOYMENT_ORDER.length) {
    throw new TypeError('deployment summary deployment_identity.deployment_ids must enumerate each worker in WORKER_DEPLOYMENT_ORDER');
  }
  if (!Array.isArray(deploymentSummary.deployment_identity?.worker_version_ids) || deploymentSummary.deployment_identity.worker_version_ids.length !== WORKER_DEPLOYMENT_ORDER.length) {
    throw new TypeError('deployment summary deployment_identity.worker_version_ids must enumerate each worker in WORKER_DEPLOYMENT_ORDER');
  }
  const expectedWorkersSubdomain = workersSubdomain == null
    ? null
    : normalizeWorkersSubdomain(workersSubdomain, 'workersSubdomain');
  if (isNonEmptyString(deploymentSummary.workers_subdomain) && expectedWorkersSubdomain != null) {
    const deploymentWorkersSubdomain = normalizeWorkersSubdomain(
      deploymentSummary.workers_subdomain,
      'deployment summary workers_subdomain',
    );
    if (deploymentWorkersSubdomain !== expectedWorkersSubdomain) {
      throw new TypeError(`deployment summary workers_subdomain must equal ${expectedWorkersSubdomain}`);
    }
  }
  if (!isPlainObject(deploymentSummary.workers)) {
    throw new TypeError('deployment summary workers must be an object');
  }
  const gatewayWorker = validateDeploymentWorker(
    'gateway-worker',
    normalizedEnvironmentName,
    deploymentSummary.workers['gateway-worker'],
    {
      workersSubdomain: expectedWorkersSubdomain,
      expectedDeploymentId: deploymentSummary.deployment_identity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
      expectedWorkerVersionId: deploymentSummary.deployment_identity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
    },
  );
  validateDeploymentWorker(
    'jobs-worker',
    normalizedEnvironmentName,
    deploymentSummary.workers['jobs-worker'],
    {
      workersSubdomain: expectedWorkersSubdomain,
      expectedDeploymentId: deploymentSummary.deployment_identity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
      expectedWorkerVersionId: deploymentSummary.deployment_identity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
    },
  );
  const opsWorker = validateDeploymentWorker(
    'ops-worker',
    normalizedEnvironmentName,
    deploymentSummary.workers['ops-worker'],
    {
      workersSubdomain: expectedWorkersSubdomain,
      expectedDeploymentId: deploymentSummary.deployment_identity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('ops-worker')],
      expectedWorkerVersionId: deploymentSummary.deployment_identity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('ops-worker')],
    },
  );
  const declaredProtectedOpsUrl = isNonEmptyString(deploymentSummary.access?.protected_ops_url)
    ? parseAbsoluteHttpsUrl(deploymentSummary.access.protected_ops_url, 'deployment summary access.protected_ops_url')
    : null;
  if (declaredProtectedOpsUrl != null && declaredProtectedOpsUrl.host !== new URL(opsWorker.url).host) {
    throw new TypeError('deployment summary access.protected_ops_url must match the deployed ops-worker host');
  }
  return Object.freeze({
    MATRIX_REMOTE_BASE_URL: gatewayWorker.url,
    MATRIX_REMOTE_SERVER_NAME: new URL(gatewayWorker.url).host,
    MATRIX_REMOTE_OPS_BASE_URL: (declaredProtectedOpsUrl ?? new URL(opsWorker.url)).toString().replace(/\/$/, ''),
  });
}

export function validateRemoteHarnessEnvironmentVariables(env) {
  if (!isPlainObject(env)) {
    throw new TypeError('remote harness env must be an object');
  }
  const remoteBaseUrl = String(env.MATRIX_REMOTE_BASE_URL ?? '').trim();
  const remoteServerName = String(env.MATRIX_REMOTE_SERVER_NAME ?? '').trim();
  const parsedRemoteBaseUrl = parseAbsoluteHttpsUrl(remoteBaseUrl, 'MATRIX_REMOTE_BASE_URL');
  if (!isNonEmptyString(remoteServerName)) {
    throw new RangeError('MATRIX_REMOTE_SERVER_NAME must be non-empty');
  }
  if (remoteServerName !== parsedRemoteBaseUrl.host) {
    throw new RangeError('MATRIX_REMOTE_SERVER_NAME must match the host of MATRIX_REMOTE_BASE_URL');
  }
  const opsBaseUrl = String(env.MATRIX_REMOTE_OPS_BASE_URL ?? '').trim();
  if (opsBaseUrl.length > 0) {
    parseAbsoluteHttpsUrl(opsBaseUrl, 'MATRIX_REMOTE_OPS_BASE_URL');
  }
  const opsAccessClientId = String(env.MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID ?? '').trim();
  const opsAccessClientSecret = String(env.MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET ?? '').trim();
  if ((opsAccessClientId.length === 0) !== (opsAccessClientSecret.length === 0)) {
    throw new RangeError('MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID and MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET must be provided together');
  }
  return Object.freeze({
    MATRIX_REMOTE_BASE_URL: parsedRemoteBaseUrl.toString().replace(/\/$/, ''),
    MATRIX_REMOTE_SERVER_NAME: remoteServerName,
    MATRIX_REMOTE_OPS_BASE_URL: opsBaseUrl.length === 0
      ? ''
      : parseAbsoluteHttpsUrl(opsBaseUrl, 'MATRIX_REMOTE_OPS_BASE_URL').toString().replace(/\/$/, ''),
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: opsAccessClientId,
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET: opsAccessClientSecret,
  });
}

function buildRemoteHarnessEnvironmentVariablesWithAccessSession(remoteHarnessEnv, accessSession = null) {
  if (accessSession == null) {
    return validateRemoteHarnessEnvironmentVariables(remoteHarnessEnv);
  }
  if (!isPlainObject(accessSession)) {
    throw new TypeError('accessSession must be an object');
  }
  const clientId = String(accessSession.access?.service_token_client_id ?? '').trim();
  const clientSecret = String(accessSession.access?.service_token_client_secret ?? '').trim();
  if (!isNonEmptyString(clientId)) {
    throw new TypeError('accessSession.access.service_token_client_id must be non-empty');
  }
  if (!isNonEmptyString(clientSecret)) {
    throw new TypeError('accessSession.access.service_token_client_secret must be non-empty');
  }
  return validateRemoteHarnessEnvironmentVariables({
    ...remoteHarnessEnv,
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: clientId,
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET: clientSecret,
  });
}

async function writeWorkerSecretsFile(workerName, secretBundle, outputPath) {
  const payload = buildWorkerSecretPayload(workerName, secretBundle);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(payload));
  return outputPath;
}

async function deployWorker(workerName, provisionedEnvironment, {
  repoRoot,
  deploymentId,
  runtimeComposition,
  workingRoot,
  gatewayBootstrapMode = false,
  accountId,
  apiToken,
  productionSecretSeed = null,
}) {
  const scriptName = provisionedEnvironment.plan.worker_scripts[workerName];
  const workerVersionTag = buildRuntimeWorkerVersionTag(deploymentId, workerName, {
    gatewayBootstrapMode,
  });
  const previousState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
    allowMissingScript: true,
  });
  const configPath = path.join(workingRoot, `${workerName}.wrangler.json`);
  const secretsPath = path.join(workingRoot, `${workerName}.secrets.json`);
  await writeEnvironmentWranglerConfig(workerName, provisionedEnvironment.plan, {
    outputPath: configPath,
    repoRoot,
    d1DatabaseId: provisionedEnvironment.resources.d1_database.id,
    kvNamespaceId: provisionedEnvironment.resources.kv_namespace.id,
    gatewayBootstrapMode,
    deploymentId,
    workerVersionId: buildRuntimeWorkerVersionId(deploymentId, workerName),
    activeDeploymentComposition: runtimeComposition,
    access: provisionedEnvironment.access,
    cloudflareAccountId: accountId,
    cloudflareResourceIds: buildOpsWorkerCloudflareResourceIds(provisionedEnvironment),
  });
  const secretBundle = buildDeploymentSecretBundle(provisionedEnvironment.environment_name, {
    accountId,
    apiToken,
    productionSecretSeed,
  });
  await writeWorkerSecretsFile(workerName, secretBundle, secretsPath);
  await runWrangler(buildWranglerDeployArguments({
    workerName,
    environmentName: provisionedEnvironment.environment_name,
    configPath,
    secretsPath,
    deploymentId,
    gatewayBootstrapMode,
  }), {
    repoRoot,
    accountId,
  });
  const currentState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
  });
  if (!isNonEmptyString(currentState.latest_active_deployment_id)) {
    throw new Error(`Cloudflare did not expose a latest active deployment id for ${scriptName}`);
  }
  return {
    worker_name: workerName,
    script_name: scriptName,
    deployment_id: resolveFreshCloudflareIdentity(
      previousState.latest_active_deployment_id == null ? [] : [previousState.latest_active_deployment_id],
      [currentState.latest_active_deployment_id],
      `${workerName} deployment id`,
    ),
    worker_version_id: resolveFreshCloudflareIdentity(previousState.worker_version_ids, currentState.active_worker_version_ids, `${workerName} worker version id`),
    worker_version_tag: workerVersionTag,
    config_path: configPath,
    secrets_path: secretsPath,
    url: provisionedEnvironment.plan.worker_urls[workerName] ?? `https://${scriptName}.workers.dev`,
    gateway_bootstrap_mode: gatewayBootstrapMode,
  };
}

export async function deployNonLocalEnvironment(environmentName, {
  repoRoot = process.cwd(),
  provisionedEnvironment,
  workingRoot,
  outputPath = null,
  deploymentId = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecution('deployNonLocalEnvironment', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  if (!isPlainObject(provisionedEnvironment) || provisionedEnvironment.environment_name !== normalizedEnvironmentName) {
    throw new TypeError(`provisionedEnvironment must be the ${normalizedEnvironmentName} provisioning payload`);
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'nonlocal', normalizedEnvironmentName));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const resolvedDeploymentId = deploymentId ?? `gha-${normalizedEnvironmentName}-${Date.now().toString(36)}`;
  const runtimeComposition = [];
  const workers = {};

  for (const workerName of provisionedEnvironment.plan.bootstrap_order) {
    const workerRoot = path.join(resolvedWorkingRoot, workerName);
    const deployedWorker = await deployWorker(workerName, provisionedEnvironment, {
      repoRoot,
      deploymentId: resolvedDeploymentId,
      runtimeComposition,
      workingRoot: workerRoot,
      gatewayBootstrapMode: workerName === 'gateway-worker' && workers['gateway-worker'] == null,
      accountId,
      apiToken,
    });
    workers[workerName] = deployedWorker;
    const runtimeEntry = {
      worker_name: workerName,
      deployment_id: deployedWorker.deployment_id,
      worker_version_id: deployedWorker.worker_version_id,
    };
    const existingIndex = runtimeComposition.findIndex((entry) => entry.worker_name === workerName);
    if (existingIndex === -1) {
      runtimeComposition.push(runtimeEntry);
    } else {
      runtimeComposition[existingIndex] = runtimeEntry;
    }
  }

  const deploymentIdentity = {
    environment_id: normalizedEnvironmentName,
    deployment_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => workers[workerName].deployment_id),
    worker_version_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => workers[workerName].worker_version_id),
  };
  const result = {
    environment_name: normalizedEnvironmentName,
    account_id: accountId,
    deployment_id: resolvedDeploymentId,
    working_root: resolvedWorkingRoot,
    workers_subdomain: provisionedEnvironment.workers_subdomain,
    access: {
      auth_domain: provisionedEnvironment.access.auth_domain,
      application_id: provisionedEnvironment.access.application_id,
      application_audience: provisionedEnvironment.access.application_audience,
      application_domain: provisionedEnvironment.access.application_domain,
      protected_ops_url: provisionedEnvironment.access.protected_ops_url,
    },
    remote_harness_env: buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
    cloudflare_resources: {
      ...provisionedEnvironment.plan.cloudflare_resources,
      r2_buckets: [
        ...provisionedEnvironment.plan.cloudflare_resources.r2_buckets,
        provisionedEnvironment.plan.artifact_bucket_name,
      ],
    },
    deployment_identity: deploymentIdentity,
    workers,
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function deployProductionEnvironment({
  repoRoot = process.cwd(),
  provisionedEnvironment,
  workingRoot,
  outputPath = null,
  deploymentId = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
  productionSecretSeed = null,
} = {}) {
  await requireGitHubActionsExecution('deployProductionEnvironment', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  if (!isPlainObject(provisionedEnvironment) || provisionedEnvironment.environment_name !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new TypeError('provisionedEnvironment must be the prod provisioning payload');
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'prod', 'deploy'));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const resolvedDeploymentId = deploymentId ?? `gha-prod-${Date.now().toString(36)}`;
  const runtimeComposition = [];
  const workers = {};

  for (const workerName of provisionedEnvironment.plan.bootstrap_order) {
    const workerRoot = path.join(resolvedWorkingRoot, workerName);
    const deployedWorker = await deployWorker(workerName, provisionedEnvironment, {
      repoRoot,
      deploymentId: resolvedDeploymentId,
      runtimeComposition,
      workingRoot: workerRoot,
      gatewayBootstrapMode: workerName === 'gateway-worker' && workers['gateway-worker'] == null,
      accountId,
      apiToken,
      productionSecretSeed,
    });
    workers[workerName] = deployedWorker;
    const runtimeEntry = {
      worker_name: workerName,
      deployment_id: deployedWorker.deployment_id,
      worker_version_id: deployedWorker.worker_version_id,
    };
    const existingIndex = runtimeComposition.findIndex((entry) => entry.worker_name === workerName);
    if (existingIndex === -1) {
      runtimeComposition.push(runtimeEntry);
    } else {
      runtimeComposition[existingIndex] = runtimeEntry;
    }
  }

  const deploymentIdentity = {
    environment_id: PRODUCTION_ENVIRONMENT_NAME,
    deployment_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => workers[workerName].deployment_id),
    worker_version_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => workers[workerName].worker_version_id),
  };
  const result = {
    environment_name: PRODUCTION_ENVIRONMENT_NAME,
    account_id: accountId,
    deployment_id: resolvedDeploymentId,
    working_root: resolvedWorkingRoot,
    workers_subdomain: provisionedEnvironment.workers_subdomain,
    access: {
      auth_domain: provisionedEnvironment.access.auth_domain,
      application_id: provisionedEnvironment.access.application_id,
      application_audience: provisionedEnvironment.access.application_audience,
      application_domain: provisionedEnvironment.access.application_domain,
      protected_ops_url: provisionedEnvironment.access.protected_ops_url,
    },
    remote_harness_env: buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
    cloudflare_resources: {
      ...provisionedEnvironment.plan.cloudflare_resources,
      r2_buckets: [
        ...provisionedEnvironment.plan.cloudflare_resources.r2_buckets,
        provisionedEnvironment.plan.artifact_bucket_name,
      ],
    },
    deployment_identity: deploymentIdentity,
    workers,
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

function buildDeploymentCompositionFromSummary(deploymentSummary) {
  return WORKER_DEPLOYMENT_ORDER
    .map((workerName) => {
      const worker = deploymentSummary?.workers?.[workerName];
      if (!isPlainObject(worker)) {
        return null;
      }
      return {
        worker_name: workerName,
        deployment_id: worker.deployment_id ?? null,
        worker_version_id: worker.worker_version_id ?? null,
      };
    })
    .filter((entry) => isNonEmptyString(entry.deployment_id) && isNonEmptyString(entry.worker_version_id));
}

async function uploadWorkerVersion(workerName, provisionedEnvironment, {
  repoRoot,
  deploymentSummary,
  workingRoot,
  deploymentId,
  accountId,
  apiToken,
  productionSecretSeed = null,
}) {
  const scriptName = provisionedEnvironment.plan.worker_scripts[workerName];
  const workerVersionTag = buildRuntimeWorkerVersionTag(deploymentId, workerName);
  const previousState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
  });
  const configPath = path.join(workingRoot, `${workerName}.wrangler.json`);
  const secretsPath = path.join(workingRoot, `${workerName}.secrets.json`);
  await writeEnvironmentWranglerConfig(workerName, provisionedEnvironment.plan, {
    outputPath: configPath,
    repoRoot,
    d1DatabaseId: provisionedEnvironment.resources.d1_database.id,
    kvNamespaceId: provisionedEnvironment.resources.kv_namespace.id,
    deploymentId,
    workerVersionId: `pending-runtime-version-${slugifyLabel(deploymentId)}`,
    activeDeploymentComposition: buildDeploymentCompositionFromSummary(deploymentSummary),
    access: provisionedEnvironment.access,
    cloudflareAccountId: accountId,
    cloudflareResourceIds: buildOpsWorkerCloudflareResourceIds(provisionedEnvironment),
  });
  const secretBundle = buildDeploymentSecretBundle(provisionedEnvironment.environment_name, {
    accountId,
    apiToken,
    productionSecretSeed,
  });
  await writeWorkerSecretsFile(workerName, secretBundle, secretsPath);
  await runWrangler([
    'versions',
    'upload',
    '--config',
    configPath,
    '--env',
    provisionedEnvironment.environment_name,
    '--message',
    `${deploymentId}:${workerName}:rollout-candidate`,
    '--tag',
    workerVersionTag,
    '--secrets-file',
    secretsPath,
  ], {
    repoRoot,
    accountId,
  });
  const currentState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
  });
  return {
    script_name: scriptName,
    config_path: configPath,
    secrets_path: secretsPath,
    worker_version_id: resolveFreshCloudflareIdentity(previousState.worker_version_ids, currentState.worker_version_ids, `${workerName} candidate worker version id`),
    worker_version_tag: workerVersionTag,
  };
}

function buildWranglerVersionsDeployArguments({
  environmentName,
  configPath,
  versionSpecs,
  message,
}) {
  return [
    'versions',
    'deploy',
    '--config',
    configPath,
    '--env',
    assertDeployableEnvironmentName(environmentName),
    '--yes',
    ...(isNonEmptyString(message) ? ['--message', message] : []),
    ...versionSpecs,
  ];
}

export function buildPreReleaseRolloutVersionSpecs(baselineGatewayVersionId, candidateGatewayVersionId) {
  if (!isNonEmptyString(baselineGatewayVersionId)) {
    throw new TypeError('baselineGatewayVersionId must be non-empty');
  }
  if (!isNonEmptyString(candidateGatewayVersionId)) {
    throw new TypeError('candidateGatewayVersionId must be non-empty');
  }
  if (baselineGatewayVersionId === candidateGatewayVersionId) {
    throw new TypeError('candidateGatewayVersionId must differ from baselineGatewayVersionId');
  }
  if (PRE_RELEASE_ROLLOUT_BASELINE_PERCENTAGE <= 0 || PRE_RELEASE_ROLLOUT_CANDIDATE_PERCENTAGE <= 0) {
    throw new Error('pre-release rollout percentages must both be non-zero');
  }
  if ((PRE_RELEASE_ROLLOUT_BASELINE_PERCENTAGE + PRE_RELEASE_ROLLOUT_CANDIDATE_PERCENTAGE) !== 100) {
    throw new Error('pre-release rollout percentages must sum to 100');
  }
  return Object.freeze([
    `${baselineGatewayVersionId}@${PRE_RELEASE_ROLLOUT_BASELINE_PERCENTAGE}`,
    `${candidateGatewayVersionId}@${PRE_RELEASE_ROLLOUT_CANDIDATE_PERCENTAGE}`,
  ]);
}

function buildSingleVersionSpecs(workerVersionId) {
  if (!isNonEmptyString(workerVersionId)) {
    throw new TypeError('workerVersionId must be non-empty');
  }
  return Object.freeze([`${workerVersionId}@100`]);
}

function buildProdGatewayGradualVersionSpecs(baselineGatewayVersionId, candidateGatewayVersionId, percentage) {
  if (!PROD_GATEWAY_GRADUAL_PERCENTAGES.includes(percentage)) {
    throw new RangeError(`Unsupported production gradual rollout percentage ${percentage}`);
  }
  if (percentage === 100) {
    return buildSingleVersionSpecs(candidateGatewayVersionId);
  }
  return Object.freeze([
    `${baselineGatewayVersionId}@${100 - percentage}`,
    `${candidateGatewayVersionId}@${percentage}`,
  ]);
}

function validateProductionBaselineRecord(record, {
  expectedGitHubRepository = null,
  expectedOriginRunIdentity = null,
} = {}) {
  if (!isPlainObject(record)) {
    throw new TypeError('baselineRecord must be an object');
  }
  const validation = record.artifact_id === 'prod_install_record'
    ? validateProdInstallRecord(record, {
      expectedGitHubRepository,
      expectedOriginRunIdentity,
    })
    : record.artifact_id === 'prod_promotion_record'
      ? validateProdPromotionRecord(record, {
        expectedGitHubRepository,
        expectedOriginRunIdentity,
      })
      : record.artifact_id === 'prod_current_state_snapshot'
        ? validateProdCurrentStateSnapshot(record, {
          expectedOriginRunIdentity,
          requireUsableBaseline: true,
        })
      : {
        valid: false,
        error: 'baselineRecord must be a prod_install_record, prod_promotion_record, or typed prod_current_state_snapshot',
      };
  if (!validation.valid) {
    throw new TypeError(`baselineRecord is invalid: ${validation.error}`);
  }
  return record;
}

function extractBaselineDeploymentIdentity(record) {
  return record.artifact_id === 'prod_install_record'
    ? record.deployment_identity
    : record.artifact_id === 'prod_promotion_record'
      ? record.current_deployment_identity
      : record.current_deployment_observation?.current_deployment_identity ?? null;
}

function extractBaselineWorkersSubdomain(record) {
  if (record.artifact_id === 'prod_install_record') {
    return record.workers_subdomain;
  }
  if (record.artifact_id === 'prod_current_state_snapshot') {
    return isNonEmptyString(record.workers_subdomain) ? record.workers_subdomain : null;
  }
  return record.rollback_handle?.workers_subdomain ?? null;
}

function isLegacyProdCurrentStateSnapshot(record) {
  return isPlainObject(record)
    && record.artifact_id == null
    && isPlainObject(record.baseline_record)
    && isPlainObject(record.current_deployment_observation);
}

function summarizeProductionBaselineIdentityMatch(baselineIdentity, currentIdentity) {
  const mismatchedFields = [];
  if (JSON.stringify(baselineIdentity?.deployment_ids ?? []) !== JSON.stringify(currentIdentity?.deployment_ids ?? [])) {
    mismatchedFields.push('deployment_ids');
  }
  if (JSON.stringify(baselineIdentity?.worker_version_ids ?? []) !== JSON.stringify(currentIdentity?.worker_version_ids ?? [])) {
    mismatchedFields.push('worker_version_ids');
  }
  return Object.freeze({
    matches: mismatchedFields.length === 0,
    mismatched_fields: Object.freeze(mismatchedFields),
  });
}

function assertProductionBaselineMatchesCurrentIdentity(record, currentIdentity, {
  observedStatePath = null,
} = {}) {
  const baselineIdentity = extractBaselineDeploymentIdentity(record);
  const comparison = summarizeProductionBaselineIdentityMatch(baselineIdentity, currentIdentity);
  if (!comparison.matches) {
    const qualifier = observedStatePath == null
      ? ''
      : `; observed current production state retained at ${observedStatePath}`;
    throw new Error(
      `baselineRecord ${comparison.mismatched_fields.join(' and ')} do not match the current Cloudflare production deployment state${qualifier}`,
    );
  }
}

function buildSerializableErrorDetail(error) {
  const responseStatus = Number(error?.response_status ?? Number.NaN);
  return Object.freeze({
    message: error instanceof Error ? error.message : String(error),
    response_status: Number.isFinite(responseStatus) ? responseStatus : null,
    partial_raw_payloads: error?.partial_raw_payloads == null
      ? null
      : Object.freeze({
        deployments: structuredCloneJson(error.partial_raw_payloads.deployments),
        versions: structuredCloneJson(error.partial_raw_payloads.versions),
      }),
  });
}

function buildProductionCurrentStateWorkerObservation(workerName, scriptName, state, {
  error = null,
  rawPayloads = state?.raw_payloads ?? error?.partial_raw_payloads ?? null,
} = {}) {
  const summarizedState = state ?? summarizeWorkerDeploymentRawPayloads(rawPayloads);
  return Object.freeze({
    worker_name: workerName,
    script_name: scriptName,
    latest_active_deployment_id: summarizedState?.latest_active_deployment_id ?? null,
    deployment_ids: Object.freeze(Array.isArray(summarizedState?.deployment_ids) ? [...summarizedState.deployment_ids] : []),
    active_worker_version_ids: Object.freeze(Array.isArray(summarizedState?.active_worker_version_ids) ? [...summarizedState.active_worker_version_ids] : []),
    worker_version_ids: Object.freeze(Array.isArray(summarizedState?.worker_version_ids) ? [...summarizedState.worker_version_ids] : []),
    raw_cloudflare_api_results: rawPayloads == null
      ? null
      : Object.freeze({
        deployments: structuredCloneJson(rawPayloads.deployments),
        versions: structuredCloneJson(rawPayloads.versions),
      }),
    error,
  });
}

function resolveProductionCurrentStateWorkerVersionTag(workerObservation, workerVersionId) {
  if (!isPlainObject(workerObservation) || !isNonEmptyString(workerVersionId)) {
    return 'unknown';
  }
  const versionItems = Array.isArray(workerObservation.raw_cloudflare_api_results?.versions?.items)
    ? workerObservation.raw_cloudflare_api_results.versions.items
    : [];
  const matchedVersion = versionItems.find((entry) => entry?.id === workerVersionId);
  const annotations = matchedVersion?.annotations;
  const tag = stableString(
    annotations?.['workers/tag']
      ?? annotations?.workers_tag
      ?? annotations?.workersTag,
  );
  return isNonEmptyString(tag) ? tag : 'unknown';
}

function buildProductionCurrentStateWorkerRecord(workerName, workerObservation, workersSubdomain) {
  const scriptName = isNonEmptyString(workerObservation?.script_name)
    ? workerObservation.script_name
    : buildProductionWorkerScriptName(workerName);
  const activeWorkerVersionIds = Array.isArray(workerObservation?.active_worker_version_ids)
    ? workerObservation.active_worker_version_ids.filter((entry) => isNonEmptyString(entry))
    : [];
  const workerVersionId = activeWorkerVersionIds.length === 1 ? activeWorkerVersionIds[0] : null;
  return Object.freeze({
    worker_name: workerName,
    script_name: scriptName,
    url: `https://${scriptName}.${workersSubdomain}.workers.dev`,
    deployment_id: isNonEmptyString(workerObservation?.latest_active_deployment_id)
      ? workerObservation.latest_active_deployment_id
      : null,
    worker_version_id: workerVersionId,
    worker_version_tag: resolveProductionCurrentStateWorkerVersionTag(workerObservation, workerVersionId),
  });
}

function buildProductionCurrentStateWorkerRecordSet(currentObservation, workersSubdomain) {
  const workers = {};
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    workers[workerName] = buildProductionCurrentStateWorkerRecord(
      workerName,
      currentObservation?.workers?.[workerName],
      workersSubdomain,
    );
  }
  return Object.freeze(workers);
}

function buildProductionInstallTopologyStateSnapshot(currentObservation) {
  if (!isPlainObject(currentObservation) || currentObservation.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new TypeError('currentObservation must be a production install-topology observation');
  }
  return Object.freeze({
    observed_at: currentObservation.observed_at ?? new Date().toISOString(),
    expected_state: 'unbootstrapped',
    problems: Object.freeze(Array.isArray(currentObservation.problems) ? [...currentObservation.problems] : []),
    active_workers: Object.freeze(
      Array.isArray(currentObservation.active_workers)
        ? currentObservation.active_workers.map((entry) => structuredCloneJson(entry))
        : [],
    ),
    workers: structuredCloneJson(currentObservation.workers ?? {}),
  });
}

async function writeProductionInstallTopologyStateSnapshot({
  currentObservation,
  outputPath,
}) {
  const snapshot = buildProductionInstallTopologyStateSnapshot(currentObservation);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(snapshot));
  return snapshot;
}

function cloneProductionDeploymentSummary(baselineRecord, provisionedEnvironment = null) {
  return structuredCloneJson({
    environment_name: PRODUCTION_ENVIRONMENT_NAME,
    workers_subdomain: baselineRecord?.workers_subdomain
      ?? provisionedEnvironment?.workers_subdomain
      ?? '',
    access: {
      protected_ops_url: baselineRecord?.access?.protected_ops_url
        ?? provisionedEnvironment?.access?.protected_ops_url
        ?? '',
    },
    workers: baselineRecord?.workers ?? {},
  });
}

function updateProductionDeploymentSummaryWorker(summary, plan, workerName, {
  deploymentId,
  workerVersionId,
  workerVersionTag = null,
} = {}) {
  summary.workers[workerName] = {
    worker_name: workerName,
    script_name: plan.worker_scripts[workerName],
    url: plan.worker_urls[workerName],
    deployment_id: deploymentId,
    worker_version_id: workerVersionId,
    worker_version_tag: workerVersionTag ?? summary.workers?.[workerName]?.worker_version_tag ?? 'unknown',
  };
  return summary;
}

function buildProductionRollbackHandle(installRecord) {
  const workerVersions = {};
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const worker = installRecord.workers[workerName];
    workerVersions[workerName] = {
      script_name: worker.script_name,
      previous_deployment_id: worker.deployment_id,
      previous_worker_version_id: worker.worker_version_id,
      restore_version_specs: buildSingleVersionSpecs(worker.worker_version_id),
    };
  }
  return Object.freeze({
    workers_subdomain: installRecord.workers_subdomain,
    worker_versions: Object.freeze(workerVersions),
  });
}

async function deployProductionWorkerVersion(workerName, configPath, versionSpecs, {
  repoRoot,
  accountId,
  apiToken,
  deploymentMessage,
  scriptName,
}) {
  const beforeState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
  });
  await runWrangler(buildWranglerVersionsDeployArguments({
    environmentName: PRODUCTION_ENVIRONMENT_NAME,
    configPath,
    versionSpecs,
    message: deploymentMessage,
  }), {
    repoRoot,
    accountId,
  });
  const afterState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
  });
  return {
    deployment_id: resolveFreshCloudflareIdentity(
      beforeState.latest_active_deployment_id == null ? [] : [beforeState.latest_active_deployment_id],
      [afterState.latest_active_deployment_id],
      `${workerName} deployment id`,
    ),
    active_worker_version_ids: afterState.active_worker_version_ids,
  };
}

export async function observeProductionCurrentCloudflareState(baselineRecord, {
  accountId,
  apiToken,
} = {}) {
  const workerObservations = {};
  const deploymentIds = [];
  const workerVersionIds = [];
  const problems = [];
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const scriptName = baselineRecord.workers?.[workerName]?.script_name ?? buildProductionWorkerScriptName(workerName);
    try {
      const state = await fetchWorkerDeploymentState({
        accountId,
        apiToken,
        scriptName,
        allowMissingScript: false,
        includeRawPayload: true,
      });
      workerObservations[workerName] = buildProductionCurrentStateWorkerObservation(workerName, scriptName, state);
      if (!isNonEmptyString(state.latest_active_deployment_id)) {
        problems.push(`Cloudflare did not expose an active deployment id for ${scriptName}`);
        continue;
      }
      if (!Array.isArray(state.active_worker_version_ids) || state.active_worker_version_ids.length !== 1) {
        problems.push(`Cloudflare must expose exactly one active worker version id for ${scriptName} before production promotion`);
        continue;
      }
      deploymentIds.push(state.latest_active_deployment_id);
      workerVersionIds.push(state.active_worker_version_ids[0]);
    } catch (error) {
      const errorDetail = buildSerializableErrorDetail(error);
      workerObservations[workerName] = buildProductionCurrentStateWorkerObservation(workerName, scriptName, null, {
        error: errorDetail,
        rawPayloads: errorDetail.partial_raw_payloads,
      });
      problems.push(`Failed to observe current Cloudflare state for ${scriptName}: ${error.message}`);
    }
  }
  const currentDeploymentIdentity = problems.length === 0
    ? Object.freeze({
      environment_id: PRODUCTION_ENVIRONMENT_NAME,
      deployment_ids: Object.freeze(deploymentIds),
      worker_version_ids: Object.freeze(workerVersionIds),
    })
    : null;
  return Object.freeze({
    observed_at: new Date().toISOString(),
    environment_id: PRODUCTION_ENVIRONMENT_NAME,
    current_deployment_identity: currentDeploymentIdentity,
    problems: Object.freeze(problems),
    workers: Object.freeze(workerObservations),
  });
}

export async function observeProductionInstallTopologyState({
  accountId,
  apiToken,
} = {}) {
  const workerObservations = {};
  const activeWorkers = [];
  const problems = [];
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const scriptName = buildProductionWorkerScriptName(workerName);
    try {
      const state = await fetchWorkerDeploymentState({
        accountId,
        apiToken,
        scriptName,
        allowMissingScript: true,
        includeRawPayload: true,
      });
      workerObservations[workerName] = buildProductionCurrentStateWorkerObservation(workerName, scriptName, state);
      if (!isNonEmptyString(state.latest_active_deployment_id)) {
        continue;
      }
      activeWorkers.push(Object.freeze({
        worker_name: workerName,
        script_name: scriptName,
        latest_active_deployment_id: state.latest_active_deployment_id,
        active_worker_version_ids: Object.freeze(
          Array.isArray(state.active_worker_version_ids) ? [...state.active_worker_version_ids] : [],
        ),
      }));
    } catch (error) {
      const errorDetail = buildSerializableErrorDetail(error);
      workerObservations[workerName] = buildProductionCurrentStateWorkerObservation(workerName, scriptName, null, {
        error: errorDetail,
        rawPayloads: errorDetail.partial_raw_payloads,
      });
      problems.push(`Failed to observe current Cloudflare state for ${scriptName}: ${error.message}`);
    }
  }
  return Object.freeze({
    observed_at: new Date().toISOString(),
    environment_id: PRODUCTION_ENVIRONMENT_NAME,
    problems: Object.freeze(problems),
    active_workers: Object.freeze(activeWorkers),
    workers: Object.freeze(workerObservations),
  });
}

export function buildProductionCurrentStateSnapshot({
  baselineRecord,
  currentObservation,
  originRunIdentity,
}) {
  const resolvedBaselineRecord = validateProductionBaselineRecord(baselineRecord);
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new Error(`ProdCurrentStateSnapshot is invalid: ${originRunValidation.error}`);
  }
  if (!isPlainObject(currentObservation) || currentObservation.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new TypeError('currentObservation must be a production current-state observation');
  }
  const workersSubdomain = extractBaselineWorkersSubdomain(resolvedBaselineRecord);
  const baselineIdentity = extractBaselineDeploymentIdentity(resolvedBaselineRecord);
  const comparison = currentObservation.current_deployment_identity == null
    ? {
      matches: false,
      mismatched_fields: Object.freeze(['current_deployment_identity_unavailable']),
    }
    : summarizeProductionBaselineIdentityMatch(baselineIdentity, currentObservation.current_deployment_identity);
  return Object.freeze({
    schema_version: 1,
    artifact_id: 'prod_current_state_snapshot',
    source_environment: PRODUCTION_ENVIRONMENT_NAME,
    origin_repository: originRunIdentity.origin_repository,
    origin_run_id: originRunIdentity.origin_run_id,
    origin_run_attempt: originRunIdentity.origin_run_attempt,
    origin_run_uri: originRunIdentity.origin_run_uri,
    workers_subdomain: workersSubdomain,
    access: Object.freeze({
      protected_ops_url: resolvedBaselineRecord.access?.protected_ops_url ?? '',
    }),
    observed_at: currentObservation.observed_at ?? new Date().toISOString(),
    baseline_record: Object.freeze({
      artifact_id: resolvedBaselineRecord.artifact_id ?? 'prod_current_state_snapshot',
      origin_run_uri: resolvedBaselineRecord.origin_run_uri ?? resolvedBaselineRecord.baseline_record?.origin_run_uri ?? '',
      deployment_identity: structuredCloneJson(baselineIdentity),
    }),
    baseline_match: Object.freeze({
      matches: comparison.matches,
      mismatched_fields: Object.freeze([...comparison.mismatched_fields]),
      problems: Object.freeze(Array.isArray(currentObservation.problems) ? [...currentObservation.problems] : []),
    }),
    workers: workersSubdomain == null
      ? {}
      : buildProductionCurrentStateWorkerRecordSet(currentObservation, workersSubdomain),
    current_deployment_observation: structuredCloneJson(currentObservation),
  });
}

async function writeProductionCurrentStateSnapshot({
  baselineRecord,
  currentObservation,
  originRunIdentity,
  outputPath,
}) {
  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord,
    currentObservation,
    originRunIdentity,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryOutputPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    await fs.writeFile(temporaryOutputPath, stableJson(snapshot));
    await fs.rename(temporaryOutputPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryOutputPath, { force: true });
    throw error;
  }
  return snapshot;
}

function productionCurrentStateDispositionPath(currentStateSnapshotPath) {
  return path.join(
    path.dirname(currentStateSnapshotPath),
    'current-production-state-disposition.json',
  );
}

const PRE_FAILURE_CURRENT_STATE_REFRESH_PENDING_MESSAGE = 'pre-failure current-production-state snapshot may be stale until the post-failure refresh completes';

async function writeProductionCurrentStateDisposition({
  currentStateSnapshotPath,
  refreshed = false,
  staleSnapshotPath = null,
  canonicalSnapshotRemoved = false,
  refreshError = null,
}) {
  const dispositionPath = productionCurrentStateDispositionPath(currentStateSnapshotPath);
  await fs.writeFile(dispositionPath, stableJson({
    schema_version: 1,
    artifact_id: 'prod_current_state_disposition',
    observed_at: new Date().toISOString(),
    current_state_path: path.basename(currentStateSnapshotPath),
    disposition: refreshed
      ? 'refreshed'
      : staleSnapshotPath != null
        ? 'quarantined'
        : canonicalSnapshotRemoved
          ? 'removed'
          : 'refresh_failed',
    pre_failure_snapshot_path: staleSnapshotPath == null ? null : path.basename(staleSnapshotPath),
    canonical_snapshot_removed: canonicalSnapshotRemoved,
    refresh_error: refreshError == null ? null : String(refreshError),
  }));
  return dispositionPath;
}

async function markProductionCurrentStateSnapshotPotentiallyStale(currentStateSnapshotPath) {
  return writeProductionCurrentStateDisposition({
    currentStateSnapshotPath,
    refreshError: PRE_FAILURE_CURRENT_STATE_REFRESH_PENDING_MESSAGE,
  });
}

async function quarantinePotentiallyStaleProductionCurrentStateSnapshot(currentStateSnapshotPath) {
  try {
    await fs.access(currentStateSnapshotPath);
  } catch {
    return null;
  }
  const staleSnapshotPath = path.join(
    path.dirname(currentStateSnapshotPath),
    'pre-failure-current-production-state.json',
  );
  await fs.rm(staleSnapshotPath, { force: true });
  await fs.rename(currentStateSnapshotPath, staleSnapshotPath);
  return staleSnapshotPath;
}

async function refreshProductionCurrentStateSnapshotAfterFailure({
  baselineRecord,
  currentStateSnapshotPath,
  originRunIdentity,
  accountId,
  apiToken,
  error,
}) {
  let provisionalDispositionPath = null;
  let preemptivelyQuarantinedSnapshotPath = null;
  let preemptivelyRemovedCanonicalSnapshot = false;
  try {
    provisionalDispositionPath = await markProductionCurrentStateSnapshotPotentiallyStale(currentStateSnapshotPath);
  } catch (initialDispositionError) {
    if (error instanceof Error) {
      error.message = `${error.message}; additionally failed to mark the pre-failure current-production-state snapshot as potentially stale before attempting a post-failure refresh: ${initialDispositionError.message}`;
    }
    try {
      preemptivelyQuarantinedSnapshotPath = await quarantinePotentiallyStaleProductionCurrentStateSnapshot(currentStateSnapshotPath);
    } catch (quarantineError) {
      try {
        await fs.rm(currentStateSnapshotPath, { force: true });
        preemptivelyRemovedCanonicalSnapshot = true;
      } catch (removeError) {
        if (error instanceof Error) {
          error.message = `${error.message}; additionally failed to quarantine the potentially stale current-production-state snapshot before attempting a post-failure refresh: ${quarantineError.message}; additionally failed to delete the canonical current-production-state snapshot before attempting a post-failure refresh: ${removeError.message}`;
        }
      }
      if (error instanceof Error) {
        error.message = `${error.message}; additionally failed to quarantine the potentially stale current-production-state snapshot before attempting a post-failure refresh: ${quarantineError.message}${preemptivelyRemovedCanonicalSnapshot ? '; removed the canonical current-production-state snapshot instead' : ''}`;
      }
    }
  }
  try {
    const refreshedObservation = await observeProductionCurrentCloudflareState(baselineRecord, {
      accountId,
      apiToken,
    });
    await writeProductionCurrentStateSnapshot({
      baselineRecord,
      currentObservation: refreshedObservation,
      originRunIdentity,
      outputPath: currentStateSnapshotPath,
    });
    await writeProductionCurrentStateDisposition({
      currentStateSnapshotPath,
      refreshed: true,
    });
  } catch (snapshotError) {
    let staleSnapshotPath = preemptivelyQuarantinedSnapshotPath;
    let canonicalSnapshotRemoved = preemptivelyRemovedCanonicalSnapshot;
    if (staleSnapshotPath == null && !canonicalSnapshotRemoved) {
      try {
        staleSnapshotPath = await quarantinePotentiallyStaleProductionCurrentStateSnapshot(currentStateSnapshotPath);
      } catch (quarantineError) {
        try {
          await fs.rm(currentStateSnapshotPath, { force: true });
          canonicalSnapshotRemoved = true;
        } catch (removeError) {
          if (error instanceof Error) {
            error.message = `${error.message}; additionally failed to quarantine the potentially stale current-production-state snapshot: ${quarantineError.message}; additionally failed to delete the canonical current-production-state snapshot: ${removeError.message}`;
          }
        }
        if (error instanceof Error) {
          error.message = `${error.message}; additionally failed to quarantine the potentially stale current-production-state snapshot: ${quarantineError.message}${canonicalSnapshotRemoved ? '; removed the canonical current-production-state snapshot instead' : ''}`;
        }
      }
    }
    let dispositionPath = provisionalDispositionPath;
    try {
      dispositionPath = await writeProductionCurrentStateDisposition({
        currentStateSnapshotPath,
        staleSnapshotPath,
        canonicalSnapshotRemoved,
        refreshError: snapshotError.message,
      });
    } catch (dispositionError) {
      if (error instanceof Error) {
        error.message = `${error.message}; additionally failed to write current-production-state disposition artifact: ${dispositionError.message}`;
      }
    }
    if (error instanceof Error) {
      const staleSnapshotDisposition = staleSnapshotPath != null
        ? `removed current-production-state snapshot because it may be stale; preserved the pre-failure snapshot at ${staleSnapshotPath}`
        : canonicalSnapshotRemoved
          ? 'removed current-production-state snapshot because it may be stale'
          : 'current-production-state snapshot may still be stale because quarantine and deletion both failed';
      error.message = `${error.message}; additionally failed to refresh current-production-state snapshot after failure: ${snapshotError.message}; ${staleSnapshotDisposition}${dispositionPath == null ? '' : `; wrote current-production-state disposition artifact to ${dispositionPath}`}`;
    }
  }
  return error;
}

export async function startPreReleaseGatewayRollout(environmentName, {
  repoRoot = process.cwd(),
  provisionedEnvironment,
  deploymentSummary,
  workingRoot,
  outputPath = null,
  deploymentId = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecution('startPreReleaseGatewayRollout', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  if (normalizedEnvironmentName !== 'pre-release') {
    throw new RangeError('startPreReleaseGatewayRollout only supports pre-release');
  }
  if (!isPlainObject(provisionedEnvironment) || provisionedEnvironment.environment_name !== normalizedEnvironmentName) {
    throw new TypeError('provisionedEnvironment must be the pre-release provisioning payload');
  }
  if (!isPlainObject(deploymentSummary) || deploymentSummary.environment_name !== normalizedEnvironmentName) {
    throw new TypeError('deploymentSummary must be the pre-release deployment payload');
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const validation = await validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
    accountId,
    apiToken,
  });
  const gatewayWorker = deploymentSummary.workers?.['gateway-worker'];
  if (!isPlainObject(gatewayWorker) || !isNonEmptyString(gatewayWorker.script_name)) {
    throw new TypeError('deployment summary workers.gateway-worker must be present');
  }
  const currentGatewayState = validation.workers?.['gateway-worker'];
  if (!isPlainObject(currentGatewayState)) {
    throw new TypeError('validated deployment state must include gateway-worker');
  }
  if (!Array.isArray(currentGatewayState.active_worker_version_ids) || currentGatewayState.active_worker_version_ids.length !== 1) {
    throw new Error('pre-release rollout start requires a single-version baseline gateway deployment');
  }
  const baselineGatewayVersionId = gatewayWorker.worker_version_id;
  const baselineGatewayVersionTag = stableString(gatewayWorker.worker_version_tag);
  const baselineGatewayDeploymentId = gatewayWorker.deployment_id;
  if (baselineGatewayVersionTag.length === 0) {
    throw new TypeError('deployment summary workers.gateway-worker.worker_version_tag must be present for rollout probing');
  }
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'nonlocal-rollout', normalizedEnvironmentName));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const resolvedDeploymentId = deploymentId ?? `gha-${normalizedEnvironmentName}-rollout-${Date.now().toString(36)}`;
  const probeRunId = slugifyLabel(`rollout-${resolvedDeploymentId}`);
  const seedPrefix = slugifyLabel(`probe-${resolvedDeploymentId}`).slice(0, 48);
  const candidate = await uploadWorkerVersion('gateway-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'gateway-worker'),
    deploymentId: resolvedDeploymentId,
    accountId,
    apiToken,
  });
  const preDeployState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName: gatewayWorker.script_name,
  });
  await runWrangler(buildWranglerVersionsDeployArguments({
    environmentName: normalizedEnvironmentName,
    configPath: candidate.config_path,
    versionSpecs: buildPreReleaseRolloutVersionSpecs(
      baselineGatewayVersionId,
      candidate.worker_version_id,
    ),
    message: `${resolvedDeploymentId}:gateway-rollout-start`,
  }), {
    repoRoot,
    accountId,
  });
  const currentState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName: gatewayWorker.script_name,
  });
  const dualVersionDeploymentId = resolveFreshCloudflareIdentity(
    preDeployState.latest_active_deployment_id == null ? [] : [preDeployState.latest_active_deployment_id],
    [currentState.latest_active_deployment_id],
    'gateway dual-version deployment id',
  );
  const activeVersionSet = new Set(currentState.active_worker_version_ids);
  if (!activeVersionSet.has(baselineGatewayVersionId) || !activeVersionSet.has(candidate.worker_version_id)) {
    throw new Error('gateway dual-version deployment did not expose both baseline and candidate worker versions');
  }
  const result = {
    environment_name: normalizedEnvironmentName,
    worker_name: 'gateway-worker',
    script_name: gatewayWorker.script_name,
    working_root: resolvedWorkingRoot,
    config_path: candidate.config_path,
    baseline_gateway_version_id: baselineGatewayVersionId,
    baseline_gateway_version_tag: baselineGatewayVersionTag,
    baseline_gateway_deployment_id: baselineGatewayDeploymentId,
    candidate_gateway_version_id: candidate.worker_version_id,
    candidate_gateway_version_tag: candidate.worker_version_tag,
    dual_version_deployment_id: dualVersionDeploymentId,
    probe_run_id: probeRunId,
    seed_prefix: seedPrefix,
    restore_version_specs: [`${baselineGatewayVersionId}@100`],
    started_at: new Date().toISOString(),
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function restorePreReleaseGatewayRollout(environmentName, {
  repoRoot = process.cwd(),
  rolloutState,
  outputPath = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecution('restorePreReleaseGatewayRollout', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  if (normalizedEnvironmentName !== 'pre-release') {
    throw new RangeError('restorePreReleaseGatewayRollout only supports pre-release');
  }
  if (!isPlainObject(rolloutState) || rolloutState.environment_name !== normalizedEnvironmentName) {
    throw new TypeError('rolloutState must be the pre-release rollout payload');
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const beforeState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName: rolloutState.script_name,
  });
  await runWrangler(buildWranglerVersionsDeployArguments({
    environmentName: normalizedEnvironmentName,
    configPath: rolloutState.config_path,
    versionSpecs: rolloutState.restore_version_specs,
    message: `${rolloutState.dual_version_deployment_id}:gateway-rollout-restore`,
  }), {
    repoRoot,
    accountId,
  });
  const afterState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName: rolloutState.script_name,
  });
  const restoredDeploymentId = resolveFreshCloudflareIdentity(
    beforeState.latest_active_deployment_id == null ? [] : [beforeState.latest_active_deployment_id],
    [afterState.latest_active_deployment_id],
    'restored gateway deployment id',
  );
  if (afterState.active_worker_version_ids.length !== 1 || afterState.active_worker_version_ids[0] !== rolloutState.baseline_gateway_version_id) {
    throw new Error('gateway rollout restore did not return to a single baseline worker version');
  }
  const result = {
    environment_name: normalizedEnvironmentName,
    worker_name: rolloutState.worker_name,
    script_name: rolloutState.script_name,
    restored_at: new Date().toISOString(),
    restored_deployment_id: restoredDeploymentId,
    baseline_gateway_version_id: rolloutState.baseline_gateway_version_id,
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function installProductionTopology({
  repoRoot = process.cwd(),
  releaseCommitSha,
  installId = null,
  workingRoot = null,
  outputPath = null,
  preferredWorkersSubdomain = null,
  deploymentId = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
  productionSecretSeed = null,
} = {}) {
  const claims = await requireGitHubActionsExecution('installProductionTopology', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  if (!isLowercaseGitSha(releaseCommitSha)) {
    throw new TypeError('releaseCommitSha must be a 40-character lowercase git sha');
  }
  const currentRepository = await resolveCurrentGitHubRepository(repoRoot, claims);
  const currentHeadSha = await resolveCurrentGitCommitSha(repoRoot);
  assertReleaseCommitMatchesCurrentHead('releaseCommitSha', releaseCommitSha, currentHeadSha);
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'prod-install'));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const provisionedEnvironment = await ensureProductionEnvironmentResources({
    repoRoot,
    preferredWorkersSubdomain,
    accountId,
    apiToken,
  });
  const currentStateSnapshotPath = path.join(resolvedWorkingRoot, 'current-production-state.json');
  await assertProductionTopologyInstallAllowed({
    accountId,
    apiToken,
    observedStatePath: currentStateSnapshotPath,
  });
  const deploymentSummary = await deployProductionEnvironment({
    repoRoot,
    provisionedEnvironment,
    workingRoot: path.join(resolvedWorkingRoot, 'deploy'),
    deploymentId: deploymentId ?? `gha-prod-install-${Date.now().toString(36)}`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  const accessSession = await prepareProductionOpsAccessSession({
    repoRoot,
    provisionedEnvironment,
    deploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'ops-access'),
    accountId,
    apiToken,
  });
  const readinessProbe = await waitForProductionDeploymentReadiness(
    buildRemoteHarnessEnvironmentVariablesWithAccessSession(
      deploymentSummary.remote_harness_env,
      accessSession,
    ),
  );
  if (!readinessProbe.ready) {
    throw new Error(`Production install readiness probe failed: ${readinessProbe.last_error}`);
  }
  const record = buildProdInstallRecord({
    releaseCommitSha,
    provisionedEnvironment,
    deploymentSummary,
    installId: installId ?? deploymentSummary.deployment_id,
    originRunIdentity: buildGitHubActionsProducerRunIdentity(claims),
  });
  assertArtifactRepositoryMatchesCurrent('prodInstallRecord', record, currentRepository);
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(record));
  }
  return {
    provisioned_environment: provisionedEnvironment,
    deployment_summary: deploymentSummary,
    access_session: accessSession,
    readiness_probe: readinessProbe,
    record,
    output_path: outputPath,
  };
}

export async function promoteProductionEnvironment({
  repoRoot = process.cwd(),
  candidateManifest,
  baselineRecord = null,
  baselineCurrentState = null,
  installRecord,
  promotionId = null,
  workingRoot = null,
  outputPath = null,
  deploymentId = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
  productionSecretSeed = null,
} = {}) {
  const claims = await requireGitHubActionsExecution('promoteProductionEnvironment', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const currentRepository = await resolveCurrentGitHubRepository(repoRoot, claims);
  const currentHeadSha = await resolveCurrentGitCommitSha(repoRoot);
  const originRunIdentity = buildGitHubActionsProducerRunIdentity(claims);
  const manifestValidation = validateReleaseCandidateManifest(candidateManifest, {
    expectedGitHubRepository: currentRepository,
  });
  if (!manifestValidation.valid) {
    throw new TypeError(`candidateManifest is invalid: ${manifestValidation.error}`);
  }
  assertArtifactRepositoryMatchesCurrent('candidateManifest', candidateManifest, currentRepository);
  assertReleaseCommitMatchesCurrentHead('candidateManifest.release_commit_sha', candidateManifest.release_commit_sha, currentHeadSha);
  const resolvedBaselineRecord = validateProductionBaselineRecord(
    baselineCurrentState ?? baselineRecord ?? installRecord,
  );
  assertArtifactRepositoryMatchesCurrent('baselineRecord', resolvedBaselineRecord, currentRepository);
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'prod-promote'));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const currentStateSnapshotPath = path.join(resolvedWorkingRoot, 'current-production-state.json');
  const currentObservation = await observeProductionCurrentCloudflareState(resolvedBaselineRecord, {
    accountId,
    apiToken,
  });
  await writeProductionCurrentStateSnapshot({
    baselineRecord: resolvedBaselineRecord,
    currentObservation,
    originRunIdentity,
    outputPath: currentStateSnapshotPath,
  });
  if (currentObservation.current_deployment_identity == null) {
    throw new Error(
      `current Cloudflare production deployment state could not be normalized; observed current production state retained at ${currentStateSnapshotPath}: ${currentObservation.problems.join('; ')}`,
    );
  }
  const currentIdentity = currentObservation.current_deployment_identity;
  assertProductionBaselineMatchesCurrentIdentity(resolvedBaselineRecord, currentIdentity, {
    observedStatePath: currentStateSnapshotPath,
  });
  const provisionedEnvironment = await ensureProductionEnvironmentResources({
    repoRoot,
    preferredWorkersSubdomain: extractBaselineWorkersSubdomain(resolvedBaselineRecord),
    accountId,
    apiToken,
  });
  const currentDeploymentSummary = cloneProductionDeploymentSummary(resolvedBaselineRecord, provisionedEnvironment);
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, workerName, {
      deploymentId: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf(workerName)],
      workerVersionId: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf(workerName)],
      workerVersionTag: resolvedBaselineRecord.workers?.[workerName]?.worker_version_tag ?? null,
    });
  }
  const accessSession = await prepareProductionOpsAccessSession({
    repoRoot,
    provisionedEnvironment,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'ops-access'),
    accountId,
    apiToken,
  });

  const resolvedPromotionId = promotionId ?? deploymentId ?? `gha-prod-promote-${Date.now().toString(36)}`;
  const sourceCandidate = {
    candidate_id: candidateManifest.candidate_id,
    source_run_uri: candidateManifest.source_run_uri,
  };
  try {
    if (candidateManifest.requires_do_migration) {
    await markProductionCurrentStateSnapshotPotentiallyStale(currentStateSnapshotPath);
    const migrationWorkingRoot = path.join(resolvedWorkingRoot, 'deploy');
    await fs.mkdir(migrationWorkingRoot, { recursive: true });
    const migrationRuntimeComposition = buildDeploymentCompositionFromSummary(currentDeploymentSummary);
    const migrationWorkers = {};
    const migrationReadinessChecks = {};
    const migrationReadinessFieldNames = Object.freeze({
      'jobs-worker': 'jobs_promoted',
      'ops-worker': 'ops_promoted',
      'gateway-worker': 'gateway_promoted',
    });
    for (const workerName of WORKER_DEPLOYMENT_ORDER) {
      const deployedWorker = await deployWorker(workerName, provisionedEnvironment, {
        repoRoot,
        deploymentId: resolvedPromotionId,
        runtimeComposition: migrationRuntimeComposition,
        workingRoot: path.join(migrationWorkingRoot, workerName),
        gatewayBootstrapMode: false,
        accountId,
        apiToken,
        productionSecretSeed,
      });
      migrationWorkers[workerName] = deployedWorker;
      const runtimeEntry = {
        worker_name: workerName,
        deployment_id: deployedWorker.deployment_id,
        worker_version_id: deployedWorker.worker_version_id,
      };
      const existingIndex = migrationRuntimeComposition.findIndex((entry) => entry.worker_name === workerName);
      if (existingIndex === -1) {
        migrationRuntimeComposition.push(runtimeEntry);
      } else {
        migrationRuntimeComposition[existingIndex] = runtimeEntry;
      }
      updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, workerName, {
        deploymentId: deployedWorker.deployment_id,
        workerVersionId: deployedWorker.worker_version_id,
        workerVersionTag: deployedWorker.worker_version_tag,
      });
      const readinessProbe = await waitForProductionDeploymentReadiness(
        buildRemoteHarnessEnvironmentVariablesWithAccessSession(
          buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
          accessSession,
        ),
        buildProductionWorkerPromotionReadinessOptions(workerName),
      );
      migrationReadinessChecks[migrationReadinessFieldNames[workerName]] = readinessProbe;
      if (!readinessProbe.ready) {
        throw new Error(`Production migration-safe promote readiness probe failed after ${workerName}: ${readinessProbe.last_error}`);
      }
    }
    const migrationDeploymentIdentity = {
      environment_id: PRODUCTION_ENVIRONMENT_NAME,
      deployment_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => migrationWorkers[workerName].deployment_id),
      worker_version_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => migrationWorkers[workerName].worker_version_id),
    };
    const migrationDeployment = {
      environment_name: PRODUCTION_ENVIRONMENT_NAME,
      account_id: accountId,
      deployment_id: resolvedPromotionId,
      working_root: migrationWorkingRoot,
      workers_subdomain: provisionedEnvironment.workers_subdomain,
      access: {
        auth_domain: provisionedEnvironment.access.auth_domain,
        application_id: provisionedEnvironment.access.application_id,
        application_audience: provisionedEnvironment.access.application_audience,
        application_domain: provisionedEnvironment.access.application_domain,
        protected_ops_url: provisionedEnvironment.access.protected_ops_url,
      },
      remote_harness_env: buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
      cloudflare_resources: {
        ...provisionedEnvironment.plan.cloudflare_resources,
        r2_buckets: [
          ...provisionedEnvironment.plan.cloudflare_resources.r2_buckets,
          provisionedEnvironment.plan.artifact_bucket_name,
        ],
      },
      deployment_identity: migrationDeploymentIdentity,
      workers: migrationWorkers,
    };
    const record = buildProdPromotionRecord({
      releaseCommitSha: candidateManifest.release_commit_sha,
      sourceCandidate,
      promotionMode: 'deploy_with_migration',
      previousDeploymentIdentity: extractBaselineDeploymentIdentity(resolvedBaselineRecord),
      currentDeploymentIdentity: migrationDeploymentIdentity,
      gatewayRolloutSteps: [],
      readinessChecks: migrationReadinessChecks,
      rollbackHandle: null,
      promotionId: resolvedPromotionId,
      originRunIdentity,
    });
    assertArtifactRepositoryMatchesCurrent('prodPromotionRecord', record, currentRepository);
    if (outputPath != null) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, stableJson(record));
    }
    return {
      provisioned_environment: provisionedEnvironment,
      access_session: accessSession,
      readiness_probe: migrationReadinessChecks.gateway_promoted,
      promotion_mode: 'deploy_with_migration',
      record,
      deployment_summary: migrationDeployment,
      output_path: outputPath,
    };
  }

  const jobsUpload = await uploadWorkerVersion('jobs-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'jobs-worker'),
    deploymentId: `${resolvedPromotionId}-jobs`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  await markProductionCurrentStateSnapshotPotentiallyStale(currentStateSnapshotPath);
  const jobsDeploy = await deployProductionWorkerVersion(
    'jobs-worker',
    jobsUpload.config_path,
    buildSingleVersionSpecs(jobsUpload.worker_version_id),
    {
      repoRoot,
      accountId,
      apiToken,
      deploymentMessage: `${resolvedPromotionId}:jobs-promote`,
      scriptName: jobsUpload.script_name,
    },
  );
  updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, 'jobs-worker', {
    deploymentId: jobsDeploy.deployment_id,
    workerVersionId: jobsUpload.worker_version_id,
    workerVersionTag: jobsUpload.worker_version_tag,
  });
  const jobsReadiness = await waitForProductionDeploymentReadiness(
    buildRemoteHarnessEnvironmentVariablesWithAccessSession(
      buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
      accessSession,
    ),
    buildProductionWorkerPromotionReadinessOptions('jobs-worker'),
  );
  if (!jobsReadiness.ready) {
    throw new Error(`Production jobs-worker readiness probe failed: ${jobsReadiness.last_error}`);
  }

  const opsUpload = await uploadWorkerVersion('ops-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'ops-worker'),
    deploymentId: `${resolvedPromotionId}-ops`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  const opsDeploy = await deployProductionWorkerVersion(
    'ops-worker',
    opsUpload.config_path,
    buildSingleVersionSpecs(opsUpload.worker_version_id),
    {
      repoRoot,
      accountId,
      apiToken,
      deploymentMessage: `${resolvedPromotionId}:ops-promote`,
      scriptName: opsUpload.script_name,
    },
  );
  updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, 'ops-worker', {
    deploymentId: opsDeploy.deployment_id,
    workerVersionId: opsUpload.worker_version_id,
    workerVersionTag: opsUpload.worker_version_tag,
  });
  const opsReadiness = await waitForProductionDeploymentReadiness(
    buildRemoteHarnessEnvironmentVariablesWithAccessSession(
      buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
      accessSession,
    ),
    buildProductionWorkerPromotionReadinessOptions('ops-worker'),
  );
  if (!opsReadiness.ready) {
    throw new Error(`Production ops-worker readiness probe failed: ${opsReadiness.last_error}`);
  }

  const gatewayBaselineVersionId = currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')];
  const gatewayUpload = await uploadWorkerVersion('gateway-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'gateway-worker'),
    deploymentId: `${resolvedPromotionId}-gateway`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  const gatewayRolloutSteps = [];
  let latestGatewayDeploymentId = currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')];
  for (const percentage of PROD_GATEWAY_GRADUAL_PERCENTAGES) {
    const gatewayDeploy = await deployProductionWorkerVersion(
      'gateway-worker',
      gatewayUpload.config_path,
      buildProdGatewayGradualVersionSpecs(
        gatewayBaselineVersionId,
        gatewayUpload.worker_version_id,
        percentage,
      ),
      {
        repoRoot,
        accountId,
        apiToken,
        deploymentMessage: `${resolvedPromotionId}:gateway-${percentage}`,
        scriptName: gatewayUpload.script_name,
      },
    );
    latestGatewayDeploymentId = gatewayDeploy.deployment_id;
    updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, 'gateway-worker', {
      deploymentId: gatewayDeploy.deployment_id,
      workerVersionId: percentage === 100 ? gatewayUpload.worker_version_id : gatewayBaselineVersionId,
      workerVersionTag: percentage === 100
        ? gatewayUpload.worker_version_tag
        : resolvedBaselineRecord.workers?.['gateway-worker']?.worker_version_tag ?? null,
    });
    const readinessProbe = await waitForProductionDeploymentReadiness(
      buildRemoteHarnessEnvironmentVariablesWithAccessSession(
        buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
        accessSession,
      ),
      buildProductionGatewayRolloutReadinessOptions(percentage),
    );
    gatewayRolloutSteps.push({
      percentage,
      deployment_id: gatewayDeploy.deployment_id,
      ready: readinessProbe.ready,
      attempt_count: readinessProbe.attempt_count,
      last_error: readinessProbe.last_error,
    });
    if (!readinessProbe.ready) {
      throw new Error(`Production gateway rollout readiness probe failed at ${percentage}%: ${readinessProbe.last_error}`);
    }
  }

  const record = buildProdPromotionRecord({
    releaseCommitSha: candidateManifest.release_commit_sha,
    sourceCandidate,
    promotionMode: 'gradual',
    previousDeploymentIdentity: extractBaselineDeploymentIdentity(resolvedBaselineRecord),
    currentDeploymentIdentity: {
      environment_id: PRODUCTION_ENVIRONMENT_NAME,
      deployment_ids: [
        jobsDeploy.deployment_id,
        opsDeploy.deployment_id,
        latestGatewayDeploymentId,
      ],
      worker_version_ids: [
        jobsUpload.worker_version_id,
        opsUpload.worker_version_id,
        gatewayUpload.worker_version_id,
      ],
    },
    gatewayRolloutSteps,
    readinessChecks: {
      jobs_promoted: jobsReadiness,
      ops_promoted: opsReadiness,
    },
    rollbackHandle: buildProductionRollbackHandle({
      workers_subdomain: extractBaselineWorkersSubdomain(resolvedBaselineRecord) ?? provisionedEnvironment.workers_subdomain,
      workers: {
        ...resolvedBaselineRecord.workers,
        'jobs-worker': {
          ...resolvedBaselineRecord.workers?.['jobs-worker'],
          script_name: resolvedBaselineRecord.workers?.['jobs-worker']?.script_name ?? provisionedEnvironment.plan.worker_scripts['jobs-worker'],
          deployment_id: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
          worker_version_id: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
        },
        'ops-worker': {
          ...resolvedBaselineRecord.workers?.['ops-worker'],
          script_name: resolvedBaselineRecord.workers?.['ops-worker']?.script_name ?? provisionedEnvironment.plan.worker_scripts['ops-worker'],
          deployment_id: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('ops-worker')],
          worker_version_id: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('ops-worker')],
        },
        'gateway-worker': {
          ...resolvedBaselineRecord.workers?.['gateway-worker'],
          script_name: resolvedBaselineRecord.workers?.['gateway-worker']?.script_name ?? provisionedEnvironment.plan.worker_scripts['gateway-worker'],
          deployment_id: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
          worker_version_id: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
        },
      },
    }),
    promotionId: resolvedPromotionId,
    originRunIdentity,
  });
  assertArtifactRepositoryMatchesCurrent('prodPromotionRecord', record, currentRepository);
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(record));
  }
    return {
      provisioned_environment: provisionedEnvironment,
      access_session: accessSession,
      promotion_mode: 'gradual',
      record,
      output_path: outputPath,
    };
  } catch (error) {
    throw await refreshProductionCurrentStateSnapshotAfterFailure({
      baselineRecord: resolvedBaselineRecord,
      currentStateSnapshotPath,
      originRunIdentity,
      accountId,
      apiToken,
      error,
    });
  }
}

export async function rollbackProductionEnvironment({
  repoRoot = process.cwd(),
  promotionRecord,
  workingRoot = null,
  outputPath = null,
  rollbackId = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}) {
  const claims = await requireGitHubActionsExecution('rollbackProductionEnvironment', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const currentRepository = await resolveCurrentGitHubRepository(repoRoot, claims);
  const promotionValidation = validateProdPromotionRecord(promotionRecord, {
    expectedGitHubRepository: currentRepository,
  });
  if (!promotionValidation.valid) {
    throw new TypeError(`promotionRecord is invalid: ${promotionValidation.error}`);
  }
  assertArtifactRepositoryMatchesCurrent('promotionRecord', promotionRecord, currentRepository);
  if (promotionRecord.promotion_mode !== 'gradual' || promotionRecord.rollback_handle == null) {
    throw new Error('rollbackProductionEnvironment only supports gradual promotions with a recorded rollback_handle');
  }
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'prod-rollback'));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const rollbackHandleValidation = validateProdRollbackHandle(promotionRecord.rollback_handle);
  if (!rollbackHandleValidation.valid) {
    throw new TypeError(`promotionRecord.rollback_handle is invalid: ${rollbackHandleValidation.error}`);
  }
  const provisionedEnvironment = await ensureProductionEnvironmentResources({
    repoRoot,
    preferredWorkersSubdomain: promotionRecord.rollback_handle.workers_subdomain,
    accountId,
    apiToken,
  });
  const accessSession = await prepareProductionOpsAccessSession({
    repoRoot,
    provisionedEnvironment,
    deploymentSummary: {
      environment_name: PRODUCTION_ENVIRONMENT_NAME,
      workers: {
        'ops-worker': {
          url: provisionedEnvironment.plan.worker_urls['ops-worker'],
        },
      },
    },
    workingRoot: path.join(resolvedWorkingRoot, 'ops-access'),
    accountId,
    apiToken,
  });
  const currentStateSnapshotPath = path.join(resolvedWorkingRoot, 'current-production-state.json');
  const currentObservation = await observeProductionCurrentCloudflareState(promotionRecord, {
    accountId,
    apiToken,
  });
  await writeProductionCurrentStateSnapshot({
    baselineRecord: promotionRecord,
    currentObservation,
    originRunIdentity: buildGitHubActionsProducerRunIdentity(claims),
    outputPath: currentStateSnapshotPath,
  });
  if (currentObservation.current_deployment_identity == null) {
    throw new Error(
      `current Cloudflare production deployment state could not be normalized; observed current production state retained at ${currentStateSnapshotPath}: ${currentObservation.problems.join('; ')}`,
    );
  }
  const currentDeploymentSummary = {
    environment_name: PRODUCTION_ENVIRONMENT_NAME,
    workers: {},
  };
  const currentIdentity = currentObservation.current_deployment_identity;
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const currentState = currentObservation.workers[workerName];
    updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, workerName, {
      deploymentId: currentState.latest_active_deployment_id,
      workerVersionId: currentState.active_worker_version_ids[0],
      workerVersionTag: null,
    });
  }
  assertProductionRecordedIdentityMatchesCurrent(
    promotionRecord.current_deployment_identity,
    currentIdentity,
    'promotionRecord.current_deployment_identity',
    {
      observedStatePath: currentStateSnapshotPath,
    },
  );
  const workerResults = {};
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const handle = promotionRecord.rollback_handle.worker_versions[workerName];
    const configWrite = await writeEnvironmentWranglerConfig(workerName, provisionedEnvironment.plan, {
      outputPath: path.join(resolvedWorkingRoot, workerName, `${workerName}.wrangler.json`),
      repoRoot,
      d1DatabaseId: provisionedEnvironment.resources.d1_database.id,
      kvNamespaceId: provisionedEnvironment.resources.kv_namespace.id,
      deploymentId: `${promotionRecord.promotion_id}-rollback`,
      workerVersionId: handle.previous_worker_version_id,
      activeDeploymentComposition: buildDeploymentCompositionFromSummary(currentDeploymentSummary),
      access: provisionedEnvironment.access,
      cloudflareAccountId: accountId,
      cloudflareResourceIds: buildOpsWorkerCloudflareResourceIds(provisionedEnvironment),
    });
    const deployResult = await deployProductionWorkerVersion(
      workerName,
      configWrite.output_path,
      handle.restore_version_specs,
      {
        repoRoot,
        accountId,
        apiToken,
        deploymentMessage: `${promotionRecord.promotion_id}:${workerName}:rollback`,
        scriptName: handle.script_name,
      },
    );
    const restoredVersionId = handle.previous_worker_version_id;
    workerResults[workerName] = {
      restored: true,
      deployment_id: deployResult.deployment_id,
      worker_version_id: restoredVersionId,
    };
    updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, workerName, {
      deploymentId: deployResult.deployment_id,
      workerVersionId: restoredVersionId,
      workerVersionTag: null,
    });
  }
  const readinessProbe = await waitForProductionDeploymentReadiness(
    buildRemoteHarnessEnvironmentVariablesWithAccessSession(
      buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
      accessSession,
    ),
  );
  const record = buildProdRollbackRecord({
    sourcePromotionId: promotionRecord.promotion_id,
    releaseCommitSha: promotionRecord.release_commit_sha,
    requestedRollbackHandle: promotionRecord.rollback_handle,
    restoredDeploymentIdentity: {
      environment_id: PRODUCTION_ENVIRONMENT_NAME,
      deployment_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => workerResults[workerName].deployment_id),
      worker_version_ids: WORKER_DEPLOYMENT_ORDER.map((workerName) => workerResults[workerName].worker_version_id),
    },
    workerResults,
    readinessProbe,
    rollbackId,
    originRunIdentity: buildGitHubActionsProducerRunIdentity(claims),
  });
  assertArtifactRepositoryMatchesCurrent('prodRollbackRecord', record, currentRepository);
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(record));
  }
  if (!readinessProbe.ready) {
    throw new Error(`Production rollback readiness probe failed: ${readinessProbe.last_error}`);
  }
  return {
    provisioned_environment: provisionedEnvironment,
    access_session: accessSession,
    readiness_probe: readinessProbe,
    record,
    output_path: outputPath,
  };
}

export async function uploadImmutableArtifactToR2({
  repoRoot = process.cwd(),
  bucketName,
  objectKey,
  filePath,
  contentType = 'application/octet-stream',
  outputPath = null,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
  requireCloudflareCredentialsImpl = requireCloudflareCredentials,
  ensureR2BucketImpl = ensureR2Bucket,
  sha256FileHexImpl = sha256FileHex,
  runWranglerImpl = runWrangler,
} = {}) {
  await requireGitHubActionsExecutionImpl('uploadImmutableArtifactToR2');
  const { accountId, apiToken } = requireCloudflareCredentialsImpl({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedFilePath = path.resolve(filePath);
  const sha256 = await sha256FileHexImpl(resolvedFilePath);
  await ensureR2BucketImpl({
    accountId,
    apiToken,
    bucketName,
  });
  await runWranglerImpl([
    'r2',
    'object',
    'put',
    `${bucketName}/${objectKey}`,
    '--remote',
    '--file',
    resolvedFilePath,
    '--content-type',
    contentType,
  ], {
    repoRoot,
    accountId,
  });
  const result = {
    bucket_name: bucketName,
    object_key: objectKey,
    object_uri: `r2://${bucketName}/${objectKey}`,
    file_path: resolvedFilePath,
    file_sha256: sha256,
    content_type: contentType,
  };
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(result));
  }
  return result;
}

export async function downloadImmutableArtifactFromR2({
  repoRoot = process.cwd(),
  bucketName,
  objectKey,
  outputPath,
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
} = {}, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
  requireCloudflareCredentialsImpl = requireCloudflareCredentials,
  runWranglerImpl = runWrangler,
  sha256FileHexImpl = sha256FileHex,
} = {}) {
  await requireGitHubActionsExecutionImpl('downloadImmutableArtifactFromR2');
  const { accountId } = requireCloudflareCredentialsImpl({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await runWranglerImpl([
    'r2',
    'object',
    'get',
    `${bucketName}/${objectKey}`,
    '--remote',
    '--file',
    resolvedOutputPath,
  ], {
    repoRoot,
    accountId,
  });
  return {
    bucket_name: bucketName,
    object_key: objectKey,
    object_uri: `r2://${bucketName}/${objectKey}`,
    output_path: resolvedOutputPath,
    file_sha256: await sha256FileHexImpl(resolvedOutputPath),
  };
}

export function buildGitHubRunUrl(repository, runId) {
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new RangeError('repository must be non-empty');
  }
  if (typeof runId !== 'string' && typeof runId !== 'number') {
    throw new RangeError('runId must be a string or number');
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function extractGitHubActionsRunRepository(runUrl) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/\d+$/u.exec(String(runUrl ?? ''));
  return match?.[1] ?? null;
}

function extractGitHubActionsRunId(runUrl) {
  const match = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/(\d+)$/u.exec(String(runUrl ?? ''));
  return match?.[1] ?? null;
}

function buildGitHubActionsProducerRunIdentity(claims) {
  const originRepository = String(claims?.repository ?? '');
  const originRunId = String(claims?.run_id ?? '');
  const originRunAttempt = Number.parseInt(String(claims?.run_attempt ?? ''), 10);
  return Object.freeze({
    origin_repository: originRepository,
    origin_run_id: originRunId,
    origin_run_attempt: originRunAttempt,
    origin_run_uri: buildGitHubRunUrl(originRepository, originRunId),
  });
}

function isRfc3339UtcTimestamp(value) {
  return isNonEmptyString(value)
    && RFC3339_UTC_TIMESTAMP_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

function isGitHubRepositorySlug(value) {
  return isNonEmptyString(value) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function parseGitHubRepositoryFromRemoteUrl(remoteUrl) {
  if (!isNonEmptyString(remoteUrl)) {
    return null;
  }
  const normalized = remoteUrl.trim();
  const patterns = [
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function isGitHubActionsRunUrl(value) {
  return isNonEmptyString(value) && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/u.test(value);
}

function isLowercaseGitSha(value) {
  return isNonEmptyString(value) && GIT_SHA1_RE.test(value);
}

async function resolveCurrentGitHubRepository(repoRoot, claims = null) {
  const candidateValues = [
    stableString(claims?.repository),
    stableString(process.env.GITHUB_REPOSITORY),
  ];
  for (const candidate of candidateValues) {
    if (isGitHubRepositorySlug(candidate)) {
      return candidate;
    }
  }
  const result = await runCommand('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    allowFailure: true,
  });
  const repository = parseGitHubRepositoryFromRemoteUrl(result.stdout);
  if (!isGitHubRepositorySlug(repository)) {
    throw new Error('Unable to resolve the current GitHub repository slug');
  }
  return repository;
}

async function resolveCurrentGitCommitSha(repoRoot) {
  const result = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  });
  const headSha = stableString(result.stdout);
  if (!isLowercaseGitSha(headSha)) {
    throw new Error('Unable to resolve the current git HEAD sha');
  }
  return headSha;
}

function assertArtifactRepositoryMatchesCurrent(label, payload, currentRepository) {
  if (!isPlainObject(payload)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (payload.origin_repository !== currentRepository) {
    throw new Error(`${label}.origin_repository must match the current repository ${currentRepository}`);
  }
}

function assertReleaseCommitMatchesCurrentHead(label, releaseCommitSha, currentHeadSha) {
  if (releaseCommitSha !== currentHeadSha) {
    throw new Error(`${label} must match the current checked-out git HEAD ${currentHeadSha}`);
  }
}

function validateProducerRunIdentity(originRunIdentity, label = 'origin run identity') {
  if (!isPlainObject(originRunIdentity)) {
    return {
      valid: false,
      error: `${label} must be an object`,
    };
  }
  if (!isGitHubRepositorySlug(originRunIdentity.origin_repository)) {
    return {
      valid: false,
      error: `${label}.origin_repository must be a GitHub owner/repo slug`,
    };
  }
  if (!isNonEmptyString(originRunIdentity.origin_run_id)) {
    return {
      valid: false,
      error: `${label}.origin_run_id must be non-empty`,
    };
  }
  if (!Number.isInteger(originRunIdentity.origin_run_attempt) || originRunIdentity.origin_run_attempt <= 0) {
    return {
      valid: false,
      error: `${label}.origin_run_attempt must be a positive integer`,
    };
  }
  if (!isGitHubActionsRunUrl(originRunIdentity.origin_run_uri)) {
    return {
      valid: false,
      error: `${label}.origin_run_uri must be a GitHub Actions run URL`,
    };
  }
  if (extractGitHubActionsRunRepository(originRunIdentity.origin_run_uri) !== originRunIdentity.origin_repository) {
    return {
      valid: false,
      error: `${label}.origin_run_uri must match origin_repository`,
    };
  }
  if (extractGitHubActionsRunId(originRunIdentity.origin_run_uri) !== originRunIdentity.origin_run_id) {
    return {
      valid: false,
      error: `${label}.origin_run_uri must match origin_run_id`,
    };
  }
  return {
    valid: true,
    error: null,
  };
}

function validateExpectedProducerRunIdentity(actualRunIdentity, expectedOriginRunIdentity, {
  label = 'producer run identity',
  expectedLabel = 'expectedOriginRunIdentity',
} = {}) {
  if (expectedOriginRunIdentity == null) {
    return {
      valid: true,
      error: null,
    };
  }
  const expectedValidation = validateProducerRunIdentity(expectedOriginRunIdentity, expectedLabel);
  if (!expectedValidation.valid) {
    return expectedValidation;
  }
  for (const field of ['origin_repository', 'origin_run_id', 'origin_run_attempt', 'origin_run_uri']) {
    if (actualRunIdentity[field] !== expectedOriginRunIdentity[field]) {
      return {
        valid: false,
        error: `${label}.${field} must match ${expectedLabel}.${field}`,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

function looksLikeTypedProdCurrentStateSnapshot(payload) {
  return isPlainObject(payload) && (
    'schema_version' in payload
    || 'artifact_id' in payload
    || 'source_environment' in payload
    || 'origin_repository' in payload
    || 'origin_run_id' in payload
    || 'origin_run_attempt' in payload
    || 'origin_run_uri' in payload
    || 'workers_subdomain' in payload
    || 'access' in payload
    || 'workers' in payload
  );
}

function assertProductionRecordedIdentityMatchesCurrent(expectedIdentity, currentIdentity, label, {
  observedStatePath = null,
} = {}) {
  const qualifier = observedStatePath == null
    ? ''
    : `; observed current production state retained at ${observedStatePath}`;
  if (JSON.stringify(expectedIdentity?.deployment_ids ?? []) !== JSON.stringify(currentIdentity?.deployment_ids ?? [])) {
    throw new Error(`${label} deployment_ids do not match the current Cloudflare production deployment state${qualifier}`);
  }
  if (JSON.stringify(expectedIdentity?.worker_version_ids ?? []) !== JSON.stringify(currentIdentity?.worker_version_ids ?? [])) {
    throw new Error(`${label} worker_version_ids do not match the current Cloudflare production deployment state${qualifier}`);
  }
}

async function assertProductionTopologyInstallAllowed({
  accountId,
  apiToken,
  observedStatePath = null,
} = {}) {
  const currentObservation = await observeProductionInstallTopologyState({
    accountId,
    apiToken,
  });
  if (observedStatePath != null) {
    await writeProductionInstallTopologyStateSnapshot({
      currentObservation,
      outputPath: observedStatePath,
    });
  }
  const qualifier = observedStatePath == null
    ? ''
    : `; observed current production state retained at ${observedStatePath}`;
  if (currentObservation.problems.length > 0) {
    throw new Error(
      `current Cloudflare production deployment state could not be normalized${qualifier}: ${currentObservation.problems.join('; ')}`,
    );
  }
  if (currentObservation.active_workers.length > 0) {
    throw new Error(
      `prod-install only supports an unbootstrapped production topology; current Cloudflare production workers already expose active deployments (${currentObservation.active_workers.map((entry) => entry.script_name).join(', ')}), use promote-prod instead${qualifier}`,
    );
  }
}

function validateProdRecordCloudflareResources(resources) {
  if (!isPlainObject(resources)) {
    return {
      valid: false,
      error: 'cloudflare_resources must be an object',
    };
  }
  const expectedResources = buildExpectedProductionCloudflareResources();
  for (const key of Object.keys(expectedResources)) {
    if (!Array.isArray(resources[key]) || !resources[key].every((entry) => isNonEmptyString(entry))) {
      return {
        valid: false,
        error: `cloudflare_resources.${key} must be a non-empty string array`,
      };
    }
    const actualValues = sortUniqueStringArray(resources[key]);
    const expectedValues = sortUniqueStringArray(expectedResources[key]);
    if (
      actualValues.length !== expectedValues.length
      || actualValues.some((entry, index) => entry !== expectedValues[index])
    ) {
      return {
        valid: false,
        error: `cloudflare_resources.${key} must match the fixed production topology`,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

function validateProductionDeploymentIdentity(deploymentIdentity, label = 'deployment_identity') {
  if (!isPlainObject(deploymentIdentity)) {
    return {
      valid: false,
      error: `${label} must be an object`,
    };
  }
  if (deploymentIdentity.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    return {
      valid: false,
      error: `${label}.environment_id must be prod`,
    };
  }
  if (!isNonEmptyStringArray(deploymentIdentity.deployment_ids)) {
    return {
      valid: false,
      error: `${label}.deployment_ids must be a non-empty string array`,
    };
  }
  if (!isNonEmptyStringArray(deploymentIdentity.worker_version_ids)) {
    return {
      valid: false,
      error: `${label}.worker_version_ids must be a non-empty string array`,
    };
  }
  return {
    valid: true,
    error: null,
  };
}

function validateProdWorkerRecordSet(workers, deploymentIdentity, {
  workersSubdomain = null,
} = {}) {
  if (!isPlainObject(workers)) {
    return {
      valid: false,
      error: 'workers must be an object',
    };
  }
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    try {
      const normalized = validateDeploymentWorker(workerName, PRODUCTION_ENVIRONMENT_NAME, workers[workerName], {
        workersSubdomain,
        expectedDeploymentId: deploymentIdentity?.deployment_ids?.[WORKER_DEPLOYMENT_ORDER.indexOf(workerName)] ?? null,
        expectedWorkerVersionId: deploymentIdentity?.worker_version_ids?.[WORKER_DEPLOYMENT_ORDER.indexOf(workerName)] ?? null,
      });
      if (!isNonEmptyString(workers[workerName]?.worker_version_tag)) {
        return {
          valid: false,
          error: `workers.${workerName}.worker_version_tag must be non-empty`,
        };
      }
      if (normalized.script_name !== buildProductionWorkerScriptName(workerName)) {
        return {
          valid: false,
          error: `workers.${workerName}.script_name must equal ${buildProductionWorkerScriptName(workerName)}`,
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

function validateProdCurrentStateBaselineMatch(baselineMatch, label) {
  if (!isPlainObject(baselineMatch)) {
    return {
      valid: false,
      error: `${label} must be an object`,
    };
  }
  if (typeof baselineMatch.matches !== 'boolean') {
    return {
      valid: false,
      error: `${label}.matches must be a boolean`,
    };
  }
  if (!Array.isArray(baselineMatch.mismatched_fields) || !baselineMatch.mismatched_fields.every((entry) => isNonEmptyString(entry))) {
    return {
      valid: false,
      error: `${label}.mismatched_fields must be an array of non-empty strings`,
    };
  }
  if (!Array.isArray(baselineMatch.problems) || !baselineMatch.problems.every((entry) => isNonEmptyString(entry))) {
    return {
      valid: false,
      error: `${label}.problems must be an array of non-empty strings`,
    };
  }
  return {
    valid: true,
    error: null,
  };
}

function validateProdCurrentStateObservationWorkers(workers, label) {
  if (!isPlainObject(workers)) {
    return {
      valid: false,
      error: `${label} must be an object`,
    };
  }
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const observation = workers[workerName];
    if (!isPlainObject(observation)) {
      return {
        valid: false,
        error: `${label}.${workerName} must be an object`,
      };
    }
    if (observation.worker_name !== workerName) {
      return {
        valid: false,
        error: `${label}.${workerName}.worker_name must equal ${workerName}`,
      };
    }
    const expectedScriptName = buildProductionWorkerScriptName(workerName);
    if (observation.script_name !== expectedScriptName) {
      return {
        valid: false,
        error: `${label}.${workerName}.script_name must equal ${expectedScriptName}`,
      };
    }
    if (observation.latest_active_deployment_id != null && !isNonEmptyString(observation.latest_active_deployment_id)) {
      return {
        valid: false,
        error: `${label}.${workerName}.latest_active_deployment_id must be a non-empty string or null`,
      };
    }
    for (const field of ['deployment_ids', 'active_worker_version_ids', 'worker_version_ids']) {
      if (!Array.isArray(observation[field]) || !observation[field].every((entry) => isNonEmptyString(entry))) {
        return {
          valid: false,
          error: `${label}.${workerName}.${field} must be an array of non-empty strings`,
        };
      }
    }
    if (observation.raw_cloudflare_api_results != null && !isPlainObject(observation.raw_cloudflare_api_results)) {
      return {
        valid: false,
        error: `${label}.${workerName}.raw_cloudflare_api_results must be an object or null`,
      };
    }
    if (observation.error != null && !isPlainObject(observation.error)) {
      return {
        valid: false,
        error: `${label}.${workerName}.error must be an object or null`,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

export function validateReleaseCandidateManifest(payload, {
  expectedGitHubRepository = null,
} = {}) {
  const validation = validateManualArtifactPayload('prod_release_candidate', payload);
  if (!validation.valid) {
    return validation;
  }
  if (isNonEmptyString(expectedGitHubRepository) && payload.source_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'release candidate manifest source_repository must match the current repository',
    };
  }
  if (isNonEmptyString(expectedGitHubRepository) && payload.origin_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'release candidate manifest origin_repository must match the current repository',
    };
  }
  return validation;
}

export function buildReleaseCandidateManifest({
  releaseRef,
  releaseCommitSha,
  requiresDoMigration,
  sourceRepository,
  sourceRunUri,
  originRunIdentity,
  ciIntegrationAttestation,
  stagingAttestation,
  preReleaseAttestation,
  candidateId = null,
  createdAt = new Date().toISOString(),
}) {
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new Error(`ReleaseCandidateManifest is invalid: ${originRunValidation.error}`);
  }
  const resolvedCandidateId = candidateId ?? `candidate-${sha256Hex(`${releaseCommitSha}:${sourceRunUri}`).slice(0, 16)}`;
  const manifest = {
    schema_version: 1,
    artifact_id: 'prod_release_candidate',
    candidate_id: resolvedCandidateId,
    created_at: createdAt,
    release_ref: String(releaseRef ?? ''),
    release_commit_sha: String(releaseCommitSha ?? ''),
    requires_do_migration: requiresDoMigration === true,
    source_repository: String(sourceRepository ?? ''),
    source_run_uri: String(sourceRunUri ?? ''),
    origin_repository: originRunIdentity.origin_repository,
    origin_run_id: originRunIdentity.origin_run_id,
    origin_run_attempt: originRunIdentity.origin_run_attempt,
    origin_run_uri: originRunIdentity.origin_run_uri,
    topology_kind: 'cloudflare-prod',
    ci_integration_attestation: structuredCloneJson(ciIntegrationAttestation),
    staging_attestation: structuredCloneJson(stagingAttestation),
    pre_release_attestation: structuredCloneJson(preReleaseAttestation),
  };
  const validation = validateReleaseCandidateManifest(manifest, {
    expectedGitHubRepository: manifest.source_repository,
  });
  if (!validation.valid) {
    throw new Error(`ReleaseCandidateManifest is invalid: ${validation.error}`);
  }
  return Object.freeze(manifest);
}

export async function writeReleaseCandidateManifest(outputPath, options) {
  const claims = await requireGitHubActionsExecution('writeReleaseCandidateManifest', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const manifest = buildReleaseCandidateManifest({
    ...options,
    originRunIdentity: options.originRunIdentity ?? buildGitHubActionsProducerRunIdentity(claims),
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(manifest));
  return {
    output_path: outputPath,
    manifest,
  };
}

export function validateProdInstallRecord(payload, {
  expectedGitHubRepository = null,
  expectedOriginRunIdentity = null,
} = {}) {
  const validation = validateManualArtifactPayload('prod_install_record', payload);
  if (!validation.valid) {
    return validation;
  }
  const expectedOriginRunValidation = validateExpectedProducerRunIdentity(payload, expectedOriginRunIdentity, {
    label: 'prod install record',
  });
  if (!expectedOriginRunValidation.valid) {
    return expectedOriginRunValidation;
  }
  if (isNonEmptyString(expectedGitHubRepository) && payload.origin_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'prod install record origin_repository must match the current repository',
    };
  }
  return validation;
}

export function buildProdInstallRecord({
  releaseCommitSha,
  provisionedEnvironment,
  deploymentSummary,
  originRunIdentity,
  installId = null,
  installedAt = new Date().toISOString(),
}) {
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new Error(`ProdInstallRecord is invalid: ${originRunValidation.error}`);
  }
  const record = {
    schema_version: 1,
    artifact_id: 'prod_install_record',
    source_environment: PRODUCTION_ENVIRONMENT_NAME,
    install_id: installId ?? `install-${sha256Hex(`${releaseCommitSha}:${installedAt}`).slice(0, 16)}`,
    installed_at: installedAt,
    origin_repository: originRunIdentity.origin_repository,
    origin_run_id: originRunIdentity.origin_run_id,
    origin_run_attempt: originRunIdentity.origin_run_attempt,
    origin_run_uri: originRunIdentity.origin_run_uri,
    release_commit_sha: String(releaseCommitSha ?? ''),
    topology_kind: 'cloudflare-prod',
    workers_subdomain: String(provisionedEnvironment?.workers_subdomain ?? ''),
    cloudflare_resources: structuredCloneJson({
      ...deploymentSummary?.cloudflare_resources,
      r2_buckets: sortUniqueStringArray(deploymentSummary?.cloudflare_resources?.r2_buckets ?? []),
    }),
    access: {
      auth_domain: String(provisionedEnvironment?.access?.auth_domain ?? ''),
      application_id: String(provisionedEnvironment?.access?.application_id ?? ''),
      application_audience: String(provisionedEnvironment?.access?.application_audience ?? ''),
      application_domain: String(provisionedEnvironment?.access?.application_domain ?? ''),
      protected_ops_url: String(provisionedEnvironment?.access?.protected_ops_url ?? deploymentSummary?.access?.protected_ops_url ?? ''),
    },
    deployment_identity: structuredCloneJson(deploymentSummary?.deployment_identity ?? {}),
    workers: structuredCloneJson(deploymentSummary?.workers ?? {}),
  };
  const validation = validateProdInstallRecord(record);
  if (!validation.valid) {
    throw new Error(`ProdInstallRecord is invalid: ${validation.error}`);
  }
  return Object.freeze(record);
}

export async function writeProdInstallRecord(outputPath, options) {
  const record = buildProdInstallRecord(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(record));
  return {
    output_path: outputPath,
    record,
  };
}

function validateLegacyProdCurrentStateSnapshot(payload, {
  requireUsableBaseline = false,
} = {}) {
  if (!isPlainObject(payload.baseline_record)) {
    return {
      valid: false,
      error: 'legacy prod current state snapshot baseline_record must be an object',
    };
  }
  if (
    payload.baseline_record.artifact_id !== 'prod_install_record'
    && payload.baseline_record.artifact_id !== 'prod_promotion_record'
  ) {
    return {
      valid: false,
      error: 'legacy prod current state snapshot baseline_record.artifact_id must be prod_install_record or prod_promotion_record',
    };
  }
  if (!isGitHubActionsRunUrl(payload.baseline_record.origin_run_uri)) {
    return {
      valid: false,
      error: 'legacy prod current state snapshot baseline_record.origin_run_uri must be a GitHub Actions run URL',
    };
  }
  const baselineIdentityValidation = validateProductionDeploymentIdentity(
    payload.baseline_record.deployment_identity,
    'legacy prod current state snapshot baseline_record.deployment_identity',
  );
  if (!baselineIdentityValidation.valid) {
    return baselineIdentityValidation;
  }
  if (!isPlainObject(payload.baseline_match)) {
    return {
      valid: false,
      error: 'legacy prod current state snapshot baseline_match must be an object',
    };
  }
  if (!isPlainObject(payload.current_deployment_observation)) {
    return {
      valid: false,
      error: 'legacy prod current state snapshot current_deployment_observation must be an object',
    };
  }
  if (payload.current_deployment_observation.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    return {
      valid: false,
      error: 'legacy prod current state snapshot current_deployment_observation.environment_id must equal prod',
    };
  }
  if (!requireUsableBaseline) {
    return {
      valid: true,
      error: null,
    };
  }
  return validateProductionDeploymentIdentity(
    payload.current_deployment_observation.current_deployment_identity,
    'legacy prod current state snapshot current_deployment_observation.current_deployment_identity',
  );
}

function validateProdCurrentStateDisposition(payload) {
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      error: 'prod current state disposition must be an object',
    };
  }
  if (payload.schema_version !== 1) {
    return {
      valid: false,
      error: 'prod current state disposition schema_version must equal 1',
    };
  }
  if (payload.artifact_id !== 'prod_current_state_disposition') {
    return {
      valid: false,
      error: 'prod current state disposition artifact_id must equal prod_current_state_disposition',
    };
  }
  if (!isRfc3339UtcTimestamp(payload.observed_at)) {
    return {
      valid: false,
      error: 'prod current state disposition observed_at must be an RFC 3339 UTC timestamp',
    };
  }
  if (payload.current_state_path !== 'current-production-state.json') {
    return {
      valid: false,
      error: 'prod current state disposition current_state_path must equal current-production-state.json',
    };
  }
  if (!['refreshed', 'quarantined', 'removed', 'refresh_failed'].includes(payload.disposition)) {
    return {
      valid: false,
      error: 'prod current state disposition disposition must be refreshed, quarantined, removed, or refresh_failed',
    };
  }
  if (payload.disposition === 'quarantined') {
    if (payload.pre_failure_snapshot_path !== 'pre-failure-current-production-state.json') {
      return {
        valid: false,
        error: 'prod current state disposition pre_failure_snapshot_path must equal pre-failure-current-production-state.json when disposition is quarantined',
      };
    }
  } else if (payload.pre_failure_snapshot_path != null) {
    return {
      valid: false,
      error: 'prod current state disposition pre_failure_snapshot_path must be null unless disposition is quarantined',
    };
  }
  if (typeof payload.canonical_snapshot_removed !== 'boolean') {
    return {
      valid: false,
      error: 'prod current state disposition canonical_snapshot_removed must be a boolean',
    };
  }
  if (payload.canonical_snapshot_removed !== (payload.disposition === 'removed')) {
    return {
      valid: false,
      error: 'prod current state disposition canonical_snapshot_removed must be true only when disposition is removed',
    };
  }
  if (payload.disposition === 'refreshed') {
    if (payload.refresh_error != null) {
      return {
        valid: false,
        error: 'prod current state disposition refresh_error must be null when disposition is refreshed',
      };
    }
  } else if (!isNonEmptyString(payload.refresh_error)) {
    return {
      valid: false,
      error: 'prod current state disposition refresh_error must be non-empty when disposition is not refreshed',
    };
  }
  return {
    valid: true,
    error: null,
  };
}

export function validateProdCurrentStateSnapshot(payload, {
  expectedGitHubRepository = null,
  expectedOriginRunIdentity = null,
  requireUsableBaseline = false,
} = {}) {
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      error: 'prod current state snapshot must be an object',
    };
  }
  if (payload.schema_version !== 1) {
    return {
      valid: false,
      error: 'prod current state snapshot schema_version must equal 1',
    };
  }
  if (payload.artifact_id !== 'prod_current_state_snapshot') {
    return {
      valid: false,
      error: 'prod current state snapshot artifact_id must equal prod_current_state_snapshot',
    };
  }
  if (payload.source_environment !== PRODUCTION_ENVIRONMENT_NAME) {
    return {
      valid: false,
      error: 'prod current state snapshot source_environment must equal prod',
    };
  }
  const originRunValidation = validateProducerRunIdentity(payload, 'prod current state snapshot');
  if (!originRunValidation.valid) {
    return originRunValidation;
  }
  const expectedOriginRunValidation = validateExpectedProducerRunIdentity(payload, expectedOriginRunIdentity, {
    label: 'prod current state snapshot',
  });
  if (!expectedOriginRunValidation.valid) {
    return expectedOriginRunValidation;
  }
  if (isNonEmptyString(expectedGitHubRepository) && payload.origin_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'prod current state snapshot origin_repository must match the current repository',
    };
  }
  if (!isNonEmptyString(payload.workers_subdomain)) {
    return {
      valid: false,
      error: 'prod current state snapshot workers_subdomain must be non-empty',
    };
  }
  try {
    if (!isRfc3339UtcTimestamp(payload.observed_at)) {
      throw new TypeError('prod current state snapshot observed_at must be an RFC 3339 UTC timestamp');
    }
    if (!isPlainObject(payload.access)) {
      throw new TypeError('prod current state snapshot access must be an object');
    }
    if (!isNonEmptyString(payload.access.protected_ops_url)) {
      throw new TypeError('prod current state snapshot access.protected_ops_url must be non-empty');
    }
    const protectedOpsUrl = parseAbsoluteHttpsUrl(payload.access.protected_ops_url, 'prod current state snapshot access.protected_ops_url');
    if (protectedOpsUrl.host !== buildWorkersDevHost(buildProductionWorkerScriptName('ops-worker'), payload.workers_subdomain)) {
      throw new TypeError('prod current state snapshot access.protected_ops_url must match the current prod ops-worker host');
    }
  } catch (error) {
    return {
      valid: false,
      error: error.message,
    };
  }
  if (!isPlainObject(payload.baseline_record)) {
    return {
      valid: false,
      error: 'prod current state snapshot baseline_record must be an object',
    };
  }
  if (
    payload.baseline_record.artifact_id !== 'prod_install_record'
    && payload.baseline_record.artifact_id !== 'prod_promotion_record'
    && payload.baseline_record.artifact_id !== 'prod_current_state_snapshot'
  ) {
    return {
      valid: false,
      error: 'prod current state snapshot baseline_record.artifact_id must be prod_install_record, prod_promotion_record, or prod_current_state_snapshot',
    };
  }
  if (!isGitHubActionsRunUrl(payload.baseline_record.origin_run_uri)) {
    return {
      valid: false,
      error: 'prod current state snapshot baseline_record.origin_run_uri must be a GitHub Actions run URL',
    };
  }
  const baselineIdentityValidation = validateProductionDeploymentIdentity(
    payload.baseline_record.deployment_identity,
    'prod current state snapshot baseline_record.deployment_identity',
  );
  if (!baselineIdentityValidation.valid) {
    return baselineIdentityValidation;
  }
  const baselineMatchValidation = validateProdCurrentStateBaselineMatch(
    payload.baseline_match,
    'prod current state snapshot baseline_match',
  );
  if (!baselineMatchValidation.valid) {
    return baselineMatchValidation;
  }
  if (!isPlainObject(payload.current_deployment_observation)) {
    return {
      valid: false,
      error: 'prod current state snapshot current_deployment_observation must be an object',
    };
  }
  if (payload.current_deployment_observation.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    return {
      valid: false,
      error: 'prod current state snapshot current_deployment_observation.environment_id must equal prod',
    };
  }
  const currentObservationWorkersValidation = validateProdCurrentStateObservationWorkers(
    payload.current_deployment_observation.workers,
    'prod current state snapshot current_deployment_observation.workers',
  );
  if (!currentObservationWorkersValidation.valid) {
    return currentObservationWorkersValidation;
  }
  if (!requireUsableBaseline) {
    return {
      valid: true,
      error: null,
    };
  }
  const currentIdentityValidation = validateProductionDeploymentIdentity(
    payload.current_deployment_observation.current_deployment_identity,
    'prod current state snapshot current_deployment_observation.current_deployment_identity',
  );
  if (!currentIdentityValidation.valid) {
    return currentIdentityValidation;
  }
  if (!isPlainObject(payload.workers)) {
    return {
      valid: false,
      error: 'prod current state snapshot workers must be an object',
    };
  }
  const workerValidation = validateProdWorkerRecordSet(
    payload.workers,
    payload.current_deployment_observation.current_deployment_identity,
    {
      workersSubdomain: isNonEmptyString(payload.workers_subdomain) ? payload.workers_subdomain : null,
    },
  );
  if (!workerValidation.valid) {
    return workerValidation;
  }
  return {
    valid: true,
    error: null,
  };
}

export function normalizeProdCurrentStateSnapshot(snapshot, {
  baselineRecord = null,
  originRunIdentity = null,
} = {}) {
  const currentValidation = validateProdCurrentStateSnapshot(snapshot, {
    expectedOriginRunIdentity: originRunIdentity,
    requireUsableBaseline: true,
  });
  if (currentValidation.valid) {
    return structuredCloneJson(snapshot);
  }
  if (looksLikeTypedProdCurrentStateSnapshot(snapshot)) {
    throw new TypeError(`typed prod current state snapshot is invalid: ${currentValidation.error}`);
  }
  if (!isPlainObject(snapshot)) {
    throw new TypeError('prod current state snapshot must be an object');
  }
  if (!isPlainObject(snapshot.current_deployment_observation) || snapshot.current_deployment_observation.environment_id !== PRODUCTION_ENVIRONMENT_NAME) {
    throw new TypeError('legacy prod current state snapshot current_deployment_observation must target prod');
  }
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new TypeError(`legacy prod current state snapshot normalization requires a valid originRunIdentity: ${originRunValidation.error}`);
  }
  const resolvedBaselineRecord = validateProductionBaselineRecord(baselineRecord, {
    expectedOriginRunIdentity: originRunIdentity,
  });
  return buildProductionCurrentStateSnapshot({
    baselineRecord: resolvedBaselineRecord,
    currentObservation: snapshot.current_deployment_observation,
    originRunIdentity,
  });
}

function resolveArtifactRelativePath(artifactRoot, artifactRelativePath, label) {
  if (!isNonEmptyString(artifactRelativePath)) {
    throw new TypeError(`${label} must be non-empty`);
  }
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedPath = path.resolve(resolvedArtifactRoot, artifactRelativePath);
  const relativePath = path.relative(resolvedArtifactRoot, resolvedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new RangeError(`${label} must stay within downloadRoot`);
  }
  return resolvedPath;
}

async function collectArtifactFilesNamed(rootDirectory, targetBasename) {
  const pendingDirectories = [path.resolve(rootDirectory)];
  const matches = [];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    const entries = await fs.readdir(currentDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === targetBasename) {
        matches.push(entryPath);
      }
    }
  }
  matches.sort((left, right) => left.localeCompare(right));
  return matches;
}

async function readProdCurrentStateDisposition(rawBaselineInputPath) {
  const dispositionPath = productionCurrentStateDispositionPath(rawBaselineInputPath);
  try {
    await fs.access(dispositionPath);
  } catch {
    return null;
  }
  const disposition = JSON.parse(await fs.readFile(dispositionPath, 'utf8'));
  const validation = validateProdCurrentStateDisposition(disposition);
  if (!validation.valid) {
    throw new TypeError(`prod current state disposition is invalid: ${validation.error}`);
  }
  return Object.freeze({
    dispositionPath,
    disposition,
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function validateProductionCurrentStateFailureArtifacts({
  currentStateSnapshotPath,
  requireDisposition = true,
} = {}) {
  if (!isNonEmptyString(currentStateSnapshotPath)) {
    throw new TypeError('currentStateSnapshotPath must be non-empty');
  }
  const resolvedCurrentStateSnapshotPath = path.resolve(currentStateSnapshotPath);
  const preFailureSnapshotPath = path.join(
    path.dirname(resolvedCurrentStateSnapshotPath),
    'pre-failure-current-production-state.json',
  );
  const dispositionRecord = await readProdCurrentStateDisposition(resolvedCurrentStateSnapshotPath);
  const currentStateExists = await fileExists(resolvedCurrentStateSnapshotPath);
  const preFailureSnapshotExists = await fileExists(preFailureSnapshotPath);
  if (requireDisposition && dispositionRecord == null) {
    return {
      valid: false,
      error: 'prod current state failure artifacts must include current-production-state-disposition.json',
    };
  }
  if (dispositionRecord == null) {
    return {
      valid: true,
      error: null,
    };
  }
  const { disposition } = dispositionRecord;
  if (disposition.current_state_path !== path.basename(resolvedCurrentStateSnapshotPath)) {
    return {
      valid: false,
      error: 'prod current state disposition current_state_path must match the canonical snapshot basename',
    };
  }
  if (disposition.disposition === 'refreshed') {
    if (!currentStateExists) {
      return {
        valid: false,
        error: 'prod current state disposition refreshed requires canonical current-production-state.json',
      };
    }
    return {
      valid: true,
      error: null,
    };
  }
  if (currentStateExists) {
    return {
      valid: false,
      error: `prod current state disposition ${disposition.disposition} requires canonical current-production-state.json to be absent`,
    };
  }
  if (disposition.disposition === 'quarantined' && !preFailureSnapshotExists) {
    return {
      valid: false,
      error: 'prod current state disposition quarantined requires pre-failure-current-production-state.json',
    };
  }
  if (
    disposition.disposition === 'refresh_failed'
    && !preFailureSnapshotExists
    && disposition.canonical_snapshot_removed !== true
  ) {
    return {
      valid: false,
      error: 'prod current state disposition refresh_failed requires quarantine evidence or canonical_snapshot_removed=true',
    };
  }
  return {
    valid: true,
    error: null,
  };
}

async function copyDirectoryIfPresent(sourceRoot, outputRoot) {
  if (!await fileExists(sourceRoot)) {
    return false;
  }
  await fs.cp(sourceRoot, outputRoot, {
    recursive: true,
    force: true,
  });
  return true;
}

export async function stageProductionRawStateArtifactForUpload({
  stateRoot,
  downloadRoot,
  artifactRoot,
  outputRoot,
} = {}) {
  for (const [name, value] of [
    ['stateRoot', stateRoot],
    ['downloadRoot', downloadRoot],
    ['artifactRoot', artifactRoot],
    ['outputRoot', outputRoot],
  ]) {
    if (!isNonEmptyString(value)) {
      throw new TypeError(`${name} must be non-empty`);
    }
  }
  const resolvedStateRoot = path.resolve(stateRoot);
  const resolvedDownloadRoot = path.resolve(downloadRoot);
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedOutputRoot = path.resolve(outputRoot);
  const stagedStateRoot = path.join(resolvedOutputRoot, 'state');
  const stagedDownloadRoot = path.join(resolvedOutputRoot, 'downloaded');
  const stagedArtifactRoot = path.join(resolvedOutputRoot, 'artifacts');
  await fs.rm(resolvedOutputRoot, {
    recursive: true,
    force: true,
  });
  await fs.mkdir(resolvedOutputRoot, { recursive: true });
  await Promise.all([
    copyDirectoryIfPresent(resolvedStateRoot, stagedStateRoot),
    copyDirectoryIfPresent(resolvedDownloadRoot, stagedDownloadRoot),
    copyDirectoryIfPresent(resolvedArtifactRoot, stagedArtifactRoot),
  ]);
  return {
    output_root: resolvedOutputRoot,
    staged_state_root: stagedStateRoot,
    staged_download_root: stagedDownloadRoot,
    staged_artifact_root: stagedArtifactRoot,
  };
}

export async function resolveProductionBaselineInputArtifact({
  downloadRoot,
  baselineInputKind,
  baselineInputPath,
  baselineRecordName,
  normalizedOutputPath = null,
  originRunIdentity = null,
} = {}) {
  if (!isNonEmptyString(downloadRoot)) {
    throw new TypeError('downloadRoot must be non-empty');
  }
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new TypeError(`originRunIdentity is invalid: ${originRunValidation.error}`);
  }
  const resolvedDownloadRoot = path.resolve(downloadRoot);
  const rawBaselineInputPath = resolveArtifactRelativePath(
    resolvedDownloadRoot,
    baselineInputPath,
    'baselineInputPath',
  );
  if (baselineInputKind === 'record') {
    await fs.access(rawBaselineInputPath);
    const record = JSON.parse(await fs.readFile(rawBaselineInputPath, 'utf8'));
    const validation = record?.artifact_id === 'prod_install_record'
      ? validateProdInstallRecord(record, {
        expectedOriginRunIdentity: originRunIdentity,
      })
      : record?.artifact_id === 'prod_promotion_record'
        ? validateProdPromotionRecord(record, {
          expectedOriginRunIdentity: originRunIdentity,
        })
        : {
          valid: false,
          error: 'record baseline input must be a prod_install_record or prod_promotion_record',
        };
    if (!validation.valid) {
      throw new TypeError(`record baseline input is invalid: ${validation.error}`);
    }
    return Object.freeze({
      baseline_input_kind: baselineInputKind,
      raw_baseline_input_path: rawBaselineInputPath,
      baseline_record_path: rawBaselineInputPath,
      resolved_baseline_input_path: rawBaselineInputPath,
    });
  }
  if (baselineInputKind !== 'current_state') {
    throw new RangeError(`Unsupported baselineInputKind ${baselineInputKind}`);
  }
  if (!isNonEmptyString(baselineRecordName)) {
    throw new TypeError('baselineRecordName must be non-empty');
  }
  if (!isNonEmptyString(normalizedOutputPath)) {
    throw new TypeError('normalizedOutputPath must be non-empty when baselineInputKind is current_state');
  }
  const currentStateDisposition = await readProdCurrentStateDisposition(rawBaselineInputPath);
  try {
    await fs.access(rawBaselineInputPath);
  } catch (error) {
    if (currentStateDisposition != null && currentStateDisposition.disposition.disposition !== 'refreshed') {
      throw new Error(
        `current-state baseline input is unavailable because prod current state disposition marked the canonical snapshot as ${currentStateDisposition.disposition.disposition}`,
      );
    }
    throw error;
  }
  if (currentStateDisposition != null && currentStateDisposition.disposition.disposition !== 'refreshed') {
    throw new Error(
      `current-state baseline input is unavailable because prod current state disposition marked the canonical snapshot as ${currentStateDisposition.disposition.disposition}`,
    );
  }
  const rawSnapshot = JSON.parse(await fs.readFile(rawBaselineInputPath, 'utf8'));
  const typedSnapshotValidation = validateProdCurrentStateSnapshot(rawSnapshot, {
    expectedOriginRunIdentity: originRunIdentity,
    requireUsableBaseline: true,
  });
  let baselineRecordPath = null;
  let normalizedSnapshot = null;
  if (typedSnapshotValidation.valid) {
    normalizedSnapshot = structuredCloneJson(rawSnapshot);
  } else if (looksLikeTypedProdCurrentStateSnapshot(rawSnapshot)) {
    throw new TypeError(`typed prod current state snapshot is invalid: ${typedSnapshotValidation.error}`);
  } else {
    const baselineRecordCandidates = await collectArtifactFilesNamed(resolvedDownloadRoot, baselineRecordName);
    if (baselineRecordCandidates.length !== 1) {
      throw new Error(`expected exactly one embedded ${baselineRecordName} under ${resolvedDownloadRoot}, found ${baselineRecordCandidates.length}`);
    }
    [baselineRecordPath] = baselineRecordCandidates;
    normalizedSnapshot = normalizeProdCurrentStateSnapshot(rawSnapshot, {
      baselineRecord: JSON.parse(await fs.readFile(baselineRecordPath, 'utf8')),
      originRunIdentity,
    });
  }
  const resolvedNormalizedOutputPath = path.resolve(normalizedOutputPath);
  await fs.mkdir(path.dirname(resolvedNormalizedOutputPath), { recursive: true });
  await fs.writeFile(resolvedNormalizedOutputPath, `${JSON.stringify(normalizedSnapshot, null, 2)}\n`);
  return Object.freeze({
    baseline_input_kind: baselineInputKind,
    raw_baseline_input_path: rawBaselineInputPath,
    baseline_record_path: baselineRecordPath,
    resolved_baseline_input_path: resolvedNormalizedOutputPath,
  });
}

function validateProdRollbackHandle(value) {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      error: 'rollback_handle must be an object',
    };
  }
  if (!isNonEmptyString(value.workers_subdomain)) {
    return {
      valid: false,
      error: 'rollback_handle.workers_subdomain must be non-empty',
    };
  }
  if (!isPlainObject(value.worker_versions)) {
    return {
      valid: false,
      error: 'rollback_handle.worker_versions must be an object',
    };
  }
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const entry = value.worker_versions[workerName];
    if (!isPlainObject(entry)) {
      return {
        valid: false,
        error: `rollback_handle.worker_versions.${workerName} must be an object`,
      };
    }
    if (!isNonEmptyString(entry.script_name)) {
      return {
        valid: false,
        error: `rollback_handle.worker_versions.${workerName}.script_name must be non-empty`,
      };
    }
    if (!isNonEmptyString(entry.previous_deployment_id)) {
      return {
        valid: false,
        error: `rollback_handle.worker_versions.${workerName}.previous_deployment_id must be non-empty`,
      };
    }
    if (!isNonEmptyString(entry.previous_worker_version_id)) {
      return {
        valid: false,
        error: `rollback_handle.worker_versions.${workerName}.previous_worker_version_id must be non-empty`,
      };
    }
    if (!Array.isArray(entry.restore_version_specs) || entry.restore_version_specs.length === 0 || !entry.restore_version_specs.every((spec) => isNonEmptyString(spec))) {
      return {
        valid: false,
        error: `rollback_handle.worker_versions.${workerName}.restore_version_specs must be a non-empty string array`,
      };
    }
  }
  return {
    valid: true,
    error: null,
  };
}

export function validateProdPromotionRecord(payload, {
  expectedGitHubRepository = null,
  expectedOriginRunIdentity = null,
} = {}) {
  const validation = validateManualArtifactPayload('prod_promotion_record', payload);
  if (!validation.valid) {
    return validation;
  }
  const expectedOriginRunValidation = validateExpectedProducerRunIdentity(payload, expectedOriginRunIdentity, {
    label: 'prod promotion record',
  });
  if (!expectedOriginRunValidation.valid) {
    return expectedOriginRunValidation;
  }
  if (isNonEmptyString(expectedGitHubRepository) && payload.origin_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'prod promotion record origin_repository must match the current repository',
    };
  }
  return validation;
}

export function buildProdPromotionRecord({
  releaseCommitSha,
  promotionAuthority = 'reviewed_candidate',
  sourceCandidate,
  operationalUnblock = null,
  promotionMode,
  previousDeploymentIdentity,
  currentDeploymentIdentity,
  originRunIdentity,
  gatewayRolloutSteps = [],
  readinessChecks = null,
  rollbackHandle = null,
  promotionId = null,
  promotedAt = new Date().toISOString(),
}) {
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new Error(`ProdPromotionRecord is invalid: ${originRunValidation.error}`);
  }
  const record = {
    schema_version: 1,
    artifact_id: 'prod_promotion_record',
    source_environment: PRODUCTION_ENVIRONMENT_NAME,
    promotion_id: promotionId ?? `promotion-${sha256Hex(`${releaseCommitSha}:${promotedAt}`).slice(0, 16)}`,
    promoted_at: promotedAt,
    origin_repository: originRunIdentity.origin_repository,
    origin_run_id: originRunIdentity.origin_run_id,
    origin_run_attempt: originRunIdentity.origin_run_attempt,
    origin_run_uri: originRunIdentity.origin_run_uri,
    release_commit_sha: String(releaseCommitSha ?? ''),
    promotion_authority: String(promotionAuthority ?? ''),
    promotion_mode: String(promotionMode ?? ''),
    source_candidate: sourceCandidate == null ? null : structuredCloneJson(sourceCandidate),
    operational_unblock: operationalUnblock == null ? null : structuredCloneJson(operationalUnblock),
    previous_deployment_identity: structuredCloneJson(previousDeploymentIdentity ?? {}),
    current_deployment_identity: structuredCloneJson(currentDeploymentIdentity ?? {}),
    gateway_rollout_steps: structuredCloneJson(gatewayRolloutSteps),
    rollback_handle: rollbackHandle == null ? null : structuredCloneJson(rollbackHandle),
  };
  if (readinessChecks != null) {
    record.readiness_checks = structuredCloneJson(readinessChecks);
  }
  const validation = validateProdPromotionRecord(record);
  if (!validation.valid) {
    throw new Error(`ProdPromotionRecord is invalid: ${validation.error}`);
  }
  return Object.freeze(record);
}

export async function writeProdPromotionRecord(outputPath, options) {
  const record = buildProdPromotionRecord(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(record));
  return {
    output_path: outputPath,
    record,
  };
}

export async function operationalRefreshProductionEnvironment({
  repoRoot = process.cwd(),
  baselineRecord,
  baselineCurrentState = null,
  promotionId = null,
  workingRoot = null,
  outputPath = null,
  deploymentId = null,
  blockedByOpenQuestions = ['OQ-0002', 'OQ-0006'],
  reason = 'Operational prod refresh to unblock Phase 08 cost closure',
  accountId: explicitAccountId = null,
  apiToken: explicitApiToken = null,
  productionSecretSeed = null,
} = {}) {
  const claims = await requireGitHubActionsExecution('operationalRefreshProductionEnvironment', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  const currentRepository = await resolveCurrentGitHubRepository(repoRoot, claims);
  const currentHeadSha = await resolveCurrentGitCommitSha(repoRoot);
  const originRunIdentity = buildGitHubActionsProducerRunIdentity(claims);
  const resolvedBaselineRecord = validateProductionBaselineRecord(baselineCurrentState ?? baselineRecord);
  assertArtifactRepositoryMatchesCurrent('baselineRecord', resolvedBaselineRecord, currentRepository);
  const { accountId, apiToken } = requireCloudflareCredentials({
    accountId: explicitAccountId,
    apiToken: explicitApiToken,
  });
  const resolvedWorkingRoot = path.resolve(workingRoot ?? path.join(repoRoot, '.tmp', 'prod-operational-refresh'));
  await fs.mkdir(resolvedWorkingRoot, { recursive: true });
  const currentStateSnapshotPath = path.join(resolvedWorkingRoot, 'current-production-state.json');
  const currentObservation = await observeProductionCurrentCloudflareState(resolvedBaselineRecord, {
    accountId,
    apiToken,
  });
  await writeProductionCurrentStateSnapshot({
    baselineRecord: resolvedBaselineRecord,
    currentObservation,
    originRunIdentity,
    outputPath: currentStateSnapshotPath,
  });
  if (currentObservation.current_deployment_identity == null) {
    throw new Error(
      `current Cloudflare production deployment state could not be normalized; observed current production state retained at ${currentStateSnapshotPath}: ${currentObservation.problems.join('; ')}`,
    );
  }
  const currentIdentity = currentObservation.current_deployment_identity;
  assertProductionBaselineMatchesCurrentIdentity(resolvedBaselineRecord, currentIdentity, {
    observedStatePath: currentStateSnapshotPath,
  });
  const provisionedEnvironment = await ensureProductionEnvironmentResources({
    repoRoot,
    preferredWorkersSubdomain: extractBaselineWorkersSubdomain(resolvedBaselineRecord),
    accountId,
    apiToken,
  });
  const currentDeploymentSummary = cloneProductionDeploymentSummary(resolvedBaselineRecord, provisionedEnvironment);
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, workerName, {
      deploymentId: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf(workerName)],
      workerVersionId: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf(workerName)],
      workerVersionTag: resolvedBaselineRecord.workers?.[workerName]?.worker_version_tag ?? null,
    });
  }
  const accessSession = await prepareProductionOpsAccessSession({
    repoRoot,
    provisionedEnvironment,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'ops-access'),
    accountId,
    apiToken,
  });

  const resolvedPromotionId = promotionId ?? deploymentId ?? `gha-prod-operational-refresh-${Date.now().toString(36)}`;
  try {
    const jobsUpload = await uploadWorkerVersion('jobs-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'jobs-worker'),
    deploymentId: `${resolvedPromotionId}-jobs`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  await markProductionCurrentStateSnapshotPotentiallyStale(currentStateSnapshotPath);
  const jobsDeploy = await deployProductionWorkerVersion(
    'jobs-worker',
    jobsUpload.config_path,
    buildSingleVersionSpecs(jobsUpload.worker_version_id),
    {
      repoRoot,
      accountId,
      apiToken,
      deploymentMessage: `${resolvedPromotionId}:jobs-operational`,
      scriptName: jobsUpload.script_name,
    },
  );
  updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, 'jobs-worker', {
    deploymentId: jobsDeploy.deployment_id,
    workerVersionId: jobsUpload.worker_version_id,
    workerVersionTag: jobsUpload.worker_version_tag,
  });
  const jobsReadiness = await waitForProductionDeploymentReadiness(
    buildRemoteHarnessEnvironmentVariablesWithAccessSession(
      buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
      accessSession,
    ),
    buildProductionWorkerPromotionReadinessOptions('jobs-worker'),
  );
  if (!jobsReadiness.ready) {
    throw new Error(`Operational prod refresh jobs-worker readiness probe failed: ${jobsReadiness.last_error}`);
  }

  const opsUpload = await uploadWorkerVersion('ops-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'ops-worker'),
    deploymentId: `${resolvedPromotionId}-ops`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  const opsDeploy = await deployProductionWorkerVersion(
    'ops-worker',
    opsUpload.config_path,
    buildSingleVersionSpecs(opsUpload.worker_version_id),
    {
      repoRoot,
      accountId,
      apiToken,
      deploymentMessage: `${resolvedPromotionId}:ops-operational`,
      scriptName: opsUpload.script_name,
    },
  );
  updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, 'ops-worker', {
    deploymentId: opsDeploy.deployment_id,
    workerVersionId: opsUpload.worker_version_id,
    workerVersionTag: opsUpload.worker_version_tag,
  });
  const opsReadiness = await waitForProductionDeploymentReadiness(
    buildRemoteHarnessEnvironmentVariablesWithAccessSession(
      buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
      accessSession,
    ),
    buildProductionWorkerPromotionReadinessOptions('ops-worker'),
  );
  if (!opsReadiness.ready) {
    throw new Error(`Operational prod refresh ops-worker readiness probe failed: ${opsReadiness.last_error}`);
  }

  const gatewayBaselineVersionId = currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')];
  const gatewayUpload = await uploadWorkerVersion('gateway-worker', provisionedEnvironment, {
    repoRoot,
    deploymentSummary: currentDeploymentSummary,
    workingRoot: path.join(resolvedWorkingRoot, 'gateway-worker'),
    deploymentId: `${resolvedPromotionId}-gateway`,
    accountId,
    apiToken,
    productionSecretSeed,
  });
  const gatewayRolloutSteps = [];
  let latestGatewayDeploymentId = currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')];
  for (const percentage of PROD_GATEWAY_GRADUAL_PERCENTAGES) {
    const gatewayDeploy = await deployProductionWorkerVersion(
      'gateway-worker',
      gatewayUpload.config_path,
      buildProdGatewayGradualVersionSpecs(
        gatewayBaselineVersionId,
        gatewayUpload.worker_version_id,
        percentage,
      ),
      {
        repoRoot,
        accountId,
        apiToken,
        deploymentMessage: `${resolvedPromotionId}:gateway-operational-${percentage}`,
        scriptName: gatewayUpload.script_name,
      },
    );
    latestGatewayDeploymentId = gatewayDeploy.deployment_id;
    updateProductionDeploymentSummaryWorker(currentDeploymentSummary, provisionedEnvironment.plan, 'gateway-worker', {
      deploymentId: gatewayDeploy.deployment_id,
      workerVersionId: percentage === 100 ? gatewayUpload.worker_version_id : gatewayBaselineVersionId,
      workerVersionTag: percentage === 100
        ? gatewayUpload.worker_version_tag
        : resolvedBaselineRecord.workers?.['gateway-worker']?.worker_version_tag ?? null,
    });
    const readinessProbe = await waitForProductionDeploymentReadiness(
      buildRemoteHarnessEnvironmentVariablesWithAccessSession(
        buildRemoteHarnessEnvironmentVariables(provisionedEnvironment.plan),
        accessSession,
      ),
      buildProductionGatewayRolloutReadinessOptions(percentage),
    );
    gatewayRolloutSteps.push({
      percentage,
      deployment_id: gatewayDeploy.deployment_id,
      ready: readinessProbe.ready,
      attempt_count: readinessProbe.attempt_count,
      last_error: readinessProbe.last_error,
    });
    if (!readinessProbe.ready) {
      throw new Error(`Operational prod refresh gateway rollout readiness probe failed at ${percentage}%: ${readinessProbe.last_error}`);
    }
  }

  const record = buildProdPromotionRecord({
    releaseCommitSha: currentHeadSha,
    promotionAuthority: 'operational_unblock',
    sourceCandidate: null,
    operationalUnblock: {
      reason,
      blocked_by_open_questions: blockedByOpenQuestions,
    },
    promotionMode: 'gradual',
    previousDeploymentIdentity: extractBaselineDeploymentIdentity(resolvedBaselineRecord),
    currentDeploymentIdentity: {
      environment_id: PRODUCTION_ENVIRONMENT_NAME,
      deployment_ids: [
        jobsDeploy.deployment_id,
        opsDeploy.deployment_id,
        latestGatewayDeploymentId,
      ],
      worker_version_ids: [
        jobsUpload.worker_version_id,
        opsUpload.worker_version_id,
        gatewayUpload.worker_version_id,
      ],
    },
    gatewayRolloutSteps,
    readinessChecks: {
      jobs_promoted: jobsReadiness,
      ops_promoted: opsReadiness,
    },
    rollbackHandle: buildProductionRollbackHandle({
      workers_subdomain: extractBaselineWorkersSubdomain(resolvedBaselineRecord) ?? provisionedEnvironment.workers_subdomain,
      workers: {
        ...resolvedBaselineRecord.workers,
        'jobs-worker': {
          ...resolvedBaselineRecord.workers?.['jobs-worker'],
          script_name: resolvedBaselineRecord.workers?.['jobs-worker']?.script_name ?? provisionedEnvironment.plan.worker_scripts['jobs-worker'],
          deployment_id: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
          worker_version_id: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
        },
        'ops-worker': {
          ...resolvedBaselineRecord.workers?.['ops-worker'],
          script_name: resolvedBaselineRecord.workers?.['ops-worker']?.script_name ?? provisionedEnvironment.plan.worker_scripts['ops-worker'],
          deployment_id: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('ops-worker')],
          worker_version_id: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('ops-worker')],
        },
        'gateway-worker': {
          ...resolvedBaselineRecord.workers?.['gateway-worker'],
          script_name: resolvedBaselineRecord.workers?.['gateway-worker']?.script_name ?? provisionedEnvironment.plan.worker_scripts['gateway-worker'],
          deployment_id: currentIdentity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
          worker_version_id: currentIdentity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
        },
      },
    }),
    promotionId: resolvedPromotionId,
    originRunIdentity,
  });
  assertArtifactRepositoryMatchesCurrent('prodPromotionRecord', record, currentRepository);
  if (outputPath != null) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, stableJson(record));
  }
    return {
      provisioned_environment: provisionedEnvironment,
      access_session: accessSession,
      promotion_mode: 'gradual',
      record,
      output_path: outputPath,
    };
  } catch (error) {
    throw await refreshProductionCurrentStateSnapshotAfterFailure({
      baselineRecord: resolvedBaselineRecord,
      currentStateSnapshotPath,
      originRunIdentity,
      accountId,
      apiToken,
      error,
    });
  }
}

export function validateProdRollbackRecord(payload, {
  expectedGitHubRepository = null,
} = {}) {
  const validation = validateManualArtifactPayload('prod_rollback_record', payload);
  if (!validation.valid) {
    return validation;
  }
  if (isNonEmptyString(expectedGitHubRepository) && payload.origin_repository !== expectedGitHubRepository) {
    return {
      valid: false,
      error: 'prod rollback record origin_repository must match the current repository',
    };
  }
  return validation;
}

export function buildProdRollbackRecord({
  sourcePromotionId,
  releaseCommitSha,
  originRunIdentity,
  requestedRollbackHandle,
  restoredDeploymentIdentity,
  workerResults,
  readinessProbe,
  rollbackId = null,
  rolledBackAt = new Date().toISOString(),
}) {
  const originRunValidation = validateProducerRunIdentity(originRunIdentity, 'originRunIdentity');
  if (!originRunValidation.valid) {
    throw new Error(`ProdRollbackRecord is invalid: ${originRunValidation.error}`);
  }
  const record = {
    schema_version: 1,
    artifact_id: 'prod_rollback_record',
    source_environment: PRODUCTION_ENVIRONMENT_NAME,
    rollback_id: rollbackId ?? `rollback-${sha256Hex(`${sourcePromotionId}:${rolledBackAt}`).slice(0, 16)}`,
    rolled_back_at: rolledBackAt,
    origin_repository: originRunIdentity.origin_repository,
    origin_run_id: originRunIdentity.origin_run_id,
    origin_run_attempt: originRunIdentity.origin_run_attempt,
    origin_run_uri: originRunIdentity.origin_run_uri,
    source_promotion_id: String(sourcePromotionId ?? ''),
    release_commit_sha: String(releaseCommitSha ?? ''),
    requested_rollback_handle: structuredCloneJson(requestedRollbackHandle ?? {}),
    restored_deployment_identity: structuredCloneJson(restoredDeploymentIdentity ?? {}),
    worker_results: structuredCloneJson(workerResults ?? {}),
    readiness_probe: structuredCloneJson(readinessProbe ?? {}),
  };
  const validation = validateProdRollbackRecord(record);
  if (!validation.valid) {
    throw new Error(`ProdRollbackRecord is invalid: ${validation.error}`);
  }
  return Object.freeze(record);
}

export async function writeProdRollbackRecord(outputPath, options) {
  const record = buildProdRollbackRecord(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(record));
  return {
    output_path: outputPath,
    record,
  };
}

export function buildEnvironmentRunProvenance({
  environmentName,
  githubRepository,
  githubRunId,
  githubRunAttempt,
  oidcClaims = null,
  deploymentSummary,
  artifactUpload,
  githubArtifact = null,
  reviewRecordUri = null,
}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  if (oidcClaims != null) {
    if (String(oidcClaims.repository ?? '') !== String(githubRepository ?? '')) {
      throw new Error('GitHub Actions OIDC repository claim must match provenance repository');
    }
    if (String(oidcClaims.run_id ?? '') !== String(githubRunId ?? '')) {
      throw new Error('GitHub Actions OIDC run_id claim must match provenance run id');
    }
    if (String(oidcClaims.run_attempt ?? '') !== String(githubRunAttempt ?? '')) {
      throw new Error('GitHub Actions OIDC run_attempt claim must match provenance run attempt');
    }
  }
  if (deploymentSummary?.deployment_identity?.environment_id !== normalizedEnvironmentName) {
    throw new Error(`deployment identity environment_id must equal ${normalizedEnvironmentName}`);
  }
  if (artifactUpload?.object_uri !== `r2://${artifactUpload?.bucket_name}/${artifactUpload?.object_key}`) {
    throw new Error('artifact upload must provide a canonical immutable R2 object_uri');
  }
  const originRunUri = buildGitHubRunUrl(githubRepository, githubRunId);
  const provenance = {
    origin_system: 'github-actions',
    origin_repository: String(githubRepository),
    origin_run_id: String(githubRunId),
    origin_run_attempt: Number(githubRunAttempt),
    origin_run_uri: originRunUri,
    artifact_store_uri: artifactUpload.object_uri,
    artifact_store_key: artifactUpload.object_key,
    artifact_sha256: artifactUpload.file_sha256,
    review_record_uri: reviewRecordUri ?? originRunUri,
    topology_kind: `cloudflare-${normalizedEnvironmentName}`,
    deployment_identity: structuredCloneJson(deploymentSummary.deployment_identity),
  };
  if (githubArtifact != null) {
    provenance.origin_artifact = structuredCloneJson(githubArtifact);
  }
  return provenance;
}

export async function writeEnvironmentRunProvenance(outputPath, options) {
  const claims = await requireGitHubActionsExecution('writeEnvironmentRunProvenance', {
    expectedEnvironmentName: assertNonLocalEnvironmentName(options.environmentName),
  });
  const provenance = buildEnvironmentRunProvenance({
    ...options,
    githubRepository: String(claims.repository),
    githubRunId: String(claims.run_id),
    githubRunAttempt: String(claims.run_attempt),
    oidcClaims: claims,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(provenance));
  return {
    output_path: outputPath,
    provenance,
  };
}

function buildSuiteRunArtifactPaths(outputRoot, environmentName) {
  const outputDirectory = path.resolve(outputRoot);
  return {
    output_directory: outputDirectory,
    log_path: path.join(outputDirectory, `${environmentName}.log`),
    report_path: path.join(outputDirectory, `${environmentName}.json`),
    rollout_skew_probe_path: path.join(outputDirectory, 'rollout-skew-probe.json'),
    pre_release_cost_observation_path: path.join(outputDirectory, 'pre-release-cost-observation.json'),
  };
}

async function clearSuiteSidecarArtifacts(suiteArtifacts) {
  await Promise.all([
    fs.rm(suiteArtifacts.rollout_skew_probe_path, { force: true }),
    fs.rm(suiteArtifacts.pre_release_cost_observation_path, { force: true }),
  ]);
}

function buildSuiteRolloutEnvironmentVariables(rolloutState) {
  if (!isPlainObject(rolloutState)) {
    return {};
  }
  return {
    MATRIX_ROLLOUT_PROBE_RUN_ID: rolloutState.probe_run_id,
    MATRIX_ROLLOUT_SEED_PREFIX: rolloutState.seed_prefix,
    MATRIX_ROLLOUT_BASELINE_GATEWAY_VERSION_ID: rolloutState.baseline_gateway_version_id,
    MATRIX_ROLLOUT_BASELINE_GATEWAY_VERSION_TAG: rolloutState.baseline_gateway_version_tag,
    MATRIX_ROLLOUT_CANDIDATE_GATEWAY_VERSION_ID: rolloutState.candidate_gateway_version_id,
    MATRIX_ROLLOUT_CANDIDATE_GATEWAY_VERSION_TAG: rolloutState.candidate_gateway_version_tag,
    MATRIX_ROLLOUT_DUAL_VERSION_DEPLOYMENT_ID: rolloutState.dual_version_deployment_id,
  };
}

function buildSuiteDeploymentSummaryForValidation(deploymentSummary, rolloutState) {
  if (rolloutState == null) {
    return deploymentSummary;
  }
  const suiteDeploymentSummary = structuredCloneJson(deploymentSummary);
  if (!isPlainObject(suiteDeploymentSummary.workers?.['gateway-worker'])) {
    throw new TypeError('deployment summary workers.gateway-worker must be present');
  }
  suiteDeploymentSummary.workers['gateway-worker'] = {
    ...suiteDeploymentSummary.workers['gateway-worker'],
    deployment_id: rolloutState.dual_version_deployment_id,
    expected_active_worker_version_ids: [
      rolloutState.baseline_gateway_version_id,
      rolloutState.candidate_gateway_version_id,
    ],
  };
  return suiteDeploymentSummary;
}

async function readOptionalJsonArtifact(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function runEnvironmentBackedSuite(environmentName, repoRoot, {
  runTimestamp,
  outputRoot,
  sourceRunUri,
  logArtifact,
  executedBy,
  reviewedBy,
  topologyKind,
  deploymentSummary,
  accessSession = null,
  rolloutState = null,
} = {}, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
  assessNonLocalEnvironmentHarnessReadinessImpl = assessNonLocalEnvironmentHarnessReadiness,
  requireCloudflareCredentialsImpl = requireCloudflareCredentials,
  readWorkersSubdomainImpl = readWorkersSubdomain,
  validateDeploymentSummaryAgainstCurrentCloudflareStateImpl = validateDeploymentSummaryAgainstCurrentCloudflareState,
  getRequiredTestFilesImpl = getReleaseGateTestFiles,
  waitForNonLocalDeploymentReadinessImpl = waitForNonLocalDeploymentReadiness,
  spawnImpl = spawn,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecutionImpl('runEnvironmentBackedSuite', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  const currentRepository = await resolveCurrentGitHubRepository(repoRoot);
  const currentHeadSha = await resolveCurrentGitCommitSha(repoRoot);
  const readiness = await assessNonLocalEnvironmentHarnessReadinessImpl(normalizedEnvironmentName, repoRoot, {
    getRequiredTestFilesImpl,
  });
  if (readiness.ready !== true) {
    throw new Error(`${normalizedEnvironmentName} harness is not environment-backed: ${readiness.reason}`);
  }
  const { accountId, apiToken } = requireCloudflareCredentialsImpl();
  const workersSubdomain = await readWorkersSubdomainImpl({
    accountId,
    apiToken,
  });
  if (workersSubdomain == null) {
    throw new Error('Cloudflare account must have an enabled workers.dev subdomain before running non-local suites');
  }
  if (isNonEmptyString(deploymentSummary?.account_id) && deploymentSummary.account_id !== accountId) {
    throw new TypeError('deployment summary account_id must match CLOUDFLARE_ACCOUNT_ID');
  }
  if (isNonEmptyString(deploymentSummary?.workers_subdomain)) {
    const deploymentWorkersSubdomain = normalizeWorkersSubdomain(
      deploymentSummary.workers_subdomain,
      'deployment summary workers_subdomain',
    );
    if (deploymentWorkersSubdomain !== workersSubdomain) {
      throw new TypeError(`deployment summary workers_subdomain must match Cloudflare account workers.dev subdomain ${workersSubdomain}`);
    }
  }
  const remoteHarnessEnv = buildRemoteHarnessEnvironmentVariablesWithAccessSession(
    buildRemoteHarnessEnvironmentVariablesFromDeployment(normalizedEnvironmentName, deploymentSummary, {
      workersSubdomain,
    }),
    accessSession,
  );
  assertRequiredOpsAccessRemoteHarnessEnv(normalizedEnvironmentName, remoteHarnessEnv);
  if (rolloutState != null) {
    if (normalizedEnvironmentName !== 'pre-release') {
      throw new TypeError('rolloutState is only supported for pre-release suites');
    }
    if (!isPlainObject(rolloutState) || rolloutState.environment_name !== normalizedEnvironmentName) {
      throw new TypeError('rolloutState must be the pre-release rollout payload');
    }
    if (!isNonEmptyString(rolloutState.baseline_gateway_version_tag) || !isNonEmptyString(rolloutState.candidate_gateway_version_tag)) {
      throw new TypeError('rolloutState must include baseline_gateway_version_tag and candidate_gateway_version_tag');
    }
  }
  const validationDeploymentSummary = buildSuiteDeploymentSummaryForValidation(deploymentSummary, rolloutState);
  const suiteArtifacts = buildSuiteRunArtifactPaths(outputRoot, normalizedEnvironmentName);
  await fs.mkdir(suiteArtifacts.output_directory, { recursive: true });
  const deploymentIdentityValidation = {
    before_readiness: await validateDeploymentSummaryAgainstCurrentCloudflareStateImpl(validationDeploymentSummary, {
      accountId,
      apiToken,
    }),
    before_suite: null,
  };
  const cloudflareResources = deploymentSummary?.cloudflare_resources ?? null;
  if (!isPlainObject(cloudflareResources)) {
    throw new TypeError('deployment summary cloudflare_resources must be an object');
  }
  const validatedCloudflareResources = structuredCloneJson(
    deploymentIdentityValidation.before_readiness.cloudflare_resources,
  );
  const files = readiness.test_files.map((file) => path.join(repoRoot, file));
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const commandArgs = ['--test', '--test-concurrency=1', ...files];
  const coversPreReleaseOps = normalizedEnvironmentName === 'pre-release'
    && files.some((file) => {
      const basename = path.basename(file).toLowerCase();
      return basename.startsWith('test-ops-001') && basename.endsWith('.test.mjs');
    });
  const coversPreReleaseCost = normalizedEnvironmentName === 'pre-release'
    && files.some((file) => {
      const basename = path.basename(file).toLowerCase();
      return basename.startsWith('test-cost-001') && basename.endsWith('.test.mjs');
    });
  if (coversPreReleaseOps && rolloutState == null) {
    throw new TypeError('pre-release suite covering TEST-OPS-001 requires rolloutState');
  }
  await clearSuiteSidecarArtifacts(suiteArtifacts);
  const readinessProbe = await waitForNonLocalDeploymentReadinessImpl(
    normalizedEnvironmentName,
    remoteHarnessEnv,
  );
  const readinessLogText = formatDeploymentReadinessProbeLog(readinessProbe);
  const combinedChunks = [Buffer.from(`${readinessLogText}\n`, 'utf8')];
  let exitCode = 1;
  if (readinessProbe.ready) {
    deploymentIdentityValidation.before_suite = await validateDeploymentSummaryAgainstCurrentCloudflareStateImpl(validationDeploymentSummary, {
      accountId,
      apiToken,
    });
    Object.assign(validatedCloudflareResources, structuredCloneJson(
      deploymentIdentityValidation.before_suite.cloudflare_resources,
    ));
    exitCode = await new Promise((resolve) => {
      const child = spawnImpl(process.execPath, commandArgs, {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...remoteHarnessEnv,
          MATRIX_TEST_ENVIRONMENT: normalizedEnvironmentName,
          MATRIX_TEST_RUN_ROLLOUT_SKEW_PROBE_PATH: suiteArtifacts.rollout_skew_probe_path,
          MATRIX_TEST_RUN_PRE_RELEASE_COST_OBSERVATION_PATH: suiteArtifacts.pre_release_cost_observation_path,
          ...buildSuiteRolloutEnvironmentVariables(rolloutState),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => combinedChunks.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => combinedChunks.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        combinedChunks.push(Buffer.from(`${error.message}\n`, 'utf8'));
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
  }
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  let rolloutSkewProbe = null;
  let preReleaseCostObservation = null;
  let artifactFailureMessage = null;
  try {
    const rolloutProbeArtifact = await readOptionalJsonArtifact(suiteArtifacts.rollout_skew_probe_path);
    if (rolloutProbeArtifact != null) {
      if (!coversPreReleaseOps) {
        throw new Error('rollout_skew_probe sidecar must be absent unless TEST-OPS-001 is covered');
      }
      rolloutSkewProbe = normalizeRolloutSkewProbeResponse(rolloutProbeArtifact);
      if (
        rolloutSkewProbe.assertions.new_worker_old_authority !== true
        || rolloutSkewProbe.assertions.old_worker_new_authority !== true
      ) {
        throw new Error('rollout_skew_probe assertions must both be true');
      }
      if (rolloutState != null) {
        const rolloutValidation = validateRolloutSkewProbeSemantics(
          'rollout_skew_probe',
          rolloutSkewProbe,
          {
            expectedEnvironmentName: normalizedEnvironmentName,
            expectedProbeRunId: rolloutState.probe_run_id,
            expectedDualVersionDeploymentId: rolloutState.dual_version_deployment_id,
            expectedBaselineGatewayVersionId: rolloutState.baseline_gateway_version_id,
            expectedBaselineGatewayVersionTag: rolloutState.baseline_gateway_version_tag,
            expectedCandidateGatewayVersionId: rolloutState.candidate_gateway_version_id,
            expectedCandidateGatewayVersionTag: rolloutState.candidate_gateway_version_tag,
          },
        );
        if (!rolloutValidation.valid) {
          throw new Error(rolloutValidation.error);
        }
      }
    } else if (coversPreReleaseOps || rolloutState != null) {
      throw new Error('rollout_skew_probe sidecar is required when TEST-OPS-001 is covered');
    }
    preReleaseCostObservation = await readOptionalJsonArtifact(suiteArtifacts.pre_release_cost_observation_path);
    if (preReleaseCostObservation != null) {
      preReleaseCostObservation = normalizePreReleaseCostObservation(preReleaseCostObservation);
      if (!coversPreReleaseCost) {
        throw new Error('pre_release_cost_observation sidecar must be absent unless TEST-COST-001 is covered');
      }
    } else if (coversPreReleaseCost) {
      throw new Error('pre_release_cost_observation sidecar is required when TEST-COST-001 is covered');
    }
  } catch (error) {
    artifactFailureMessage = `Suite artifact parsing failed: ${error.message}`;
    exitCode = 1;
  }
  const report = {
    environment_name: normalizedEnvironmentName,
    status: exitCode === 0 ? 'pass' : 'fail',
    exit_code: exitCode,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    command: quoteCommand([process.execPath, ...commandArgs]),
    test_directory: normalizePathForMarkdown(
      path.relative(repoRoot, getTestEnvironmentDirectory(normalizedEnvironmentName, repoRoot)),
    ),
    test_file_count: files.length,
    test_files: files.map((file) => normalizePathForMarkdown(path.relative(repoRoot, file))),
    expanded_test_file_count: readiness.expanded_test_files.length,
    expanded_test_files: readiness.expanded_test_files,
    readiness_probe: readinessProbe,
    output_sha256: null,
    error_message: exitCode === 0
      ? null
      : (readinessProbe.ready
        ? `Environment suite exited with ${exitCode}`
        : `Environment readiness probe failed: ${readinessProbe.last_error}`),
    log_artifact: logArtifact,
    executed_by: executedBy,
    reviewed_by: reviewedBy,
    source_repository: currentRepository,
    source_run_uri: sourceRunUri,
    git_commit: currentHeadSha,
    topology_kind: topologyKind,
    cloudflare_resources: validatedCloudflareResources,
    rollout_skew_probe: rolloutSkewProbe,
    pre_release_cost_observation: preReleaseCostObservation,
    deployment_identity_validation: deploymentIdentityValidation,
    run_timestamp: runTimestamp,
  };
  if (artifactFailureMessage != null) {
    combinedChunks.push(Buffer.from(`${artifactFailureMessage}\n`, 'utf8'));
    report.status = 'fail';
    report.exit_code = 1;
  }
  const logText = Buffer.concat(combinedChunks).toString('utf8');
  report.output_sha256 = sha256Hex(logText);
  report.error_message = report.exit_code === 0
    ? null
    : (artifactFailureMessage
      ?? (readinessProbe.ready
        ? `Environment suite exited with ${report.exit_code}`
        : `Environment readiness probe failed: ${readinessProbe.last_error}`));
  await Promise.all([
    fs.writeFile(suiteArtifacts.log_path, logText),
    fs.writeFile(suiteArtifacts.report_path, stableJson(report)),
  ]);
  const artifactId = normalizedEnvironmentName === 'ci-integration'
    ? 'ci_integration_run_report'
    : normalizedEnvironmentName === 'pre-release'
      ? 'pre_release_run_report'
      : 'staging_run_report';
  const payloadValidation = validateManualArtifactPayload(artifactId, report, {
    runTimestamp,
  });
  const executionProofValidation = await validateEnvironmentRunExecutionProof(artifactId, report, repoRoot);
  return {
    ok: exitCode === 0 && payloadValidation.valid && executionProofValidation.valid,
    validation_error: payloadValidation.valid
      ? executionProofValidation.error
      : payloadValidation.error,
    report,
    log_path: suiteArtifacts.log_path,
    report_path: suiteArtifacts.report_path,
  };
}

function resolveEnvironmentArtifactId(environmentName) {
  if (environmentName === 'ci-integration') {
    return 'ci_integration_run_report';
  }
  if (environmentName === 'staging') {
    return 'staging_run_report';
  }
  if (environmentName === 'pre-release') {
    return 'pre_release_run_report';
  }
  throw new RangeError(`No environment artifact id for ${environmentName}`);
}

export async function writeEnvironmentRunAttestation(environmentName, {
  runTimestamp,
  reportPath,
  outputPath,
  provenance,
}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecution('writeEnvironmentRunAttestation', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  const artifactId = resolveEnvironmentArtifactId(normalizedEnvironmentName);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const payloadValidation = validateManualArtifactPayload(artifactId, report, {
    runTimestamp,
  });
  if (!payloadValidation.valid) {
    throw new Error(`Generated ${artifactId} report is invalid: ${payloadValidation.error}`);
  }
  const executionProofValidation = await validateEnvironmentRunExecutionProof(artifactId, report, process.cwd());
  if (!executionProofValidation.valid) {
    throw new Error(`Generated ${artifactId} report execution proof is invalid: ${executionProofValidation.error}`);
  }
  const bundle = {
    schema_version: 1,
    artifact_id: artifactId,
    attestation_kind: 'environment_run',
    source_environment: normalizedEnvironmentName,
    run_timestamp: runTimestamp,
    attested_at: new Date().toISOString(),
    provenance,
    payload: report,
  };
  const validation = validateEvidenceAttestationBundle(artifactId, bundle, {
    runTimestamp,
  });
  if (!validation.valid) {
    throw new Error(`Generated ${artifactId} attestation is invalid: ${validation.error}`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(bundle));
  return {
    attestation_path: outputPath,
    bundle,
  };
}

export async function writeProdCostSnapshotAttestation({
  runTimestamp,
  payloadPath,
  outputPath,
  provenance,
}, {
  requireGitHubActionsExecutionImpl = requireGitHubActionsExecution,
} = {}) {
  await requireGitHubActionsExecutionImpl('writeProdCostSnapshotAttestation', {
    expectedEnvironmentName: 'prod',
  });
  const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8'));
  const bundle = {
    schema_version: 1,
    artifact_id: 'prod_cost_snapshot',
    attestation_kind: 'prod_cost_snapshot',
    source_environment: 'prod',
    run_timestamp: runTimestamp,
    attested_at: new Date().toISOString(),
    provenance,
    payload,
  };
  const validation = validateEvidenceAttestationBundle('prod_cost_snapshot', bundle, {
    runTimestamp,
  });
  if (!validation.valid) {
    throw new Error(`Generated prod_cost_snapshot attestation is invalid: ${validation.error}`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stableJson(bundle));
  return {
    attestation_path: outputPath,
    bundle,
  };
}

export {
  NON_LOCAL_ENVIRONMENT_NAMES,
  WORKER_BOOTSTRAP_ORDER,
  WORKER_DEPLOYMENT_ORDER,
};
