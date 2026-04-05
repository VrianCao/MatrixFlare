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

const NON_LOCAL_ENVIRONMENT_NAMES = Object.freeze([
  'ci-integration',
  'staging',
  'pre-release',
]);
const PRODUCTION_ENVIRONMENT_NAME = 'prod';

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
const BILLING_PERIOD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let githubActionsOidcIdentityPromise = null;
let githubActionsJwksPromise = null;

function assertNonLocalEnvironmentName(environmentName) {
  if (!NON_LOCAL_ENVIRONMENT_NAMES.includes(environmentName)) {
    throw new RangeError(`Unsupported non-local environment "${environmentName}"`);
  }
  return environmentName;
}

function nonLocalEnvironmentRequiresOpsAccess(environmentName) {
  return environmentName === 'staging' || environmentName === 'pre-release';
}

function assertRequiredOpsAccessRemoteHarnessEnv(environmentName, remoteHarnessEnv) {
  if (!nonLocalEnvironmentRequiresOpsAccess(environmentName)) {
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

function buildProductionWorkerScriptName(workerName) {
  return `${buildWorkerScriptBaseName(workerName)}-${PRODUCTION_ENVIRONMENT_NAME}`;
}

function buildResourceSuffix(environmentName) {
  return assertNonLocalEnvironmentName(environmentName);
}

function buildAccessApplicationName(environmentName) {
  return `matrix-phase08-${assertNonLocalEnvironmentName(environmentName)}-ops`;
}

function buildAccessPolicyName(environmentName) {
  return `matrix-phase08-${assertNonLocalEnvironmentName(environmentName)}-gha-service-auth`;
}

function buildAccessServiceTokenName(environmentName) {
  return `matrix-phase08-${assertNonLocalEnvironmentName(environmentName)}-gha-service-token`;
}

function buildOperatorPolicyPrincipalId(environmentName) {
  return `matrix-phase08-${assertNonLocalEnvironmentName(environmentName)}-gha-ops`;
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

export function buildNonLocalEnvironmentPlan(environmentName, {
  workersSubdomain = null,
  releaseProfile = DEFAULT_RELEASE_PROFILE,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  const normalizedWorkersSubdomain = workersSubdomain == null
    ? null
    : normalizeWorkersSubdomain(workersSubdomain, 'workersSubdomain');
  const workerScripts = Object.freeze(Object.fromEntries(
    listWorkerNames().map((workerName) => [workerName, buildWorkerScriptName(workerName, normalizedEnvironmentName)]),
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
      ratelimit_namespaces: listEnvironmentRateLimitNamespaces(normalizedEnvironmentName),
      queues: Object.freeze(Object.values(resourceBindingNames.queues)),
    }),
    deployment_order: WORKER_DEPLOYMENT_ORDER,
    bootstrap_order: WORKER_BOOTSTRAP_ORDER,
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
  apiToken,
  accountId,
  environmentName,
  label,
}) {
  return createHmac('sha256', String(apiToken))
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

export function buildNonProductionSecretBundle({
  environmentName,
  accountId,
  apiToken,
  observabilityApiToken = apiToken,
}) {
  const resolvedObservabilityApiToken = typeof observabilityApiToken === 'string' && observabilityApiToken.trim().length > 0
    ? observabilityApiToken
    : apiToken;
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  const signingKeyBytes = deriveStableSecretBytes({
    apiToken,
    accountId,
    environmentName: normalizedEnvironmentName,
    label: 'export-signing-key',
  });
  const encryptionKeyBytes = deriveStableSecretBytes({
    apiToken,
    accountId,
    environmentName: normalizedEnvironmentName,
    label: 'export-encryption-key',
  });
  const exportPemPair = buildDeterministicEd25519PemPair(signingKeyBytes);
  const rolloutProbeSharedSecret = createHash('sha256')
    .update(deriveStableSecretBytes({
      apiToken,
      accountId,
      environmentName: normalizedEnvironmentName,
      label: 'rollout-probe-shared-secret',
    }))
    .digest('hex');
  return Object.freeze({
    gateway: Object.freeze({
      HOMESERVER_SIGNING_KEY_RING: buildOpaqueKeyRing(deriveStableSecretBytes({
        apiToken,
        accountId,
        environmentName: normalizedEnvironmentName,
        label: 'homeserver-signing-key-ring',
      })),
      SESSION_ROOT_KEY_RING: buildOpaqueKeyRing(deriveStableSecretBytes({
        apiToken,
        accountId,
        environmentName: normalizedEnvironmentName,
        label: 'session-root-key-ring',
      })),
      UIA_ROOT_KEY_RING: buildOpaqueKeyRing(deriveStableSecretBytes({
        apiToken,
        accountId,
        environmentName: normalizedEnvironmentName,
        label: 'uia-root-key-ring',
      })),
      APPSERVICE_TOKEN_SET: createHash('sha256')
        .update(deriveStableSecretBytes({
          apiToken,
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

function structuredCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
      namespace_id: buildEnvironmentRateLimitNamespaceId(envName, binding.namespace_id),
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
      return resolvePreDeployWorkerDeploymentState(scriptName, fetchResults);
    }
    throw failures[0].reason;
  }
  const [deploymentsPayload, versionsPayload] = fetchResults.map((result) => result.value);
  return summarizeWorkerDeploymentState({
    deployments: extractArrayResult(deploymentsPayload.result, ['deployments']),
    versions: extractArrayResult(versionsPayload.result, ['items', 'versions']),
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
    || serviceKey.includes('pagesfunctions')
  ) {
    if (unitKey.includes('request')) {
      return { surface_name: 'workers', metric_name: 'request_count' };
    }
    if (unitKey.includes('cpu') && (unitKey.includes('ms') || unitKey.includes('millisecond'))) {
      return { surface_name: 'workers', metric_name: 'cpu_ms' };
    }
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

async function listProdCloudflareResourceNames({
  accountId,
  apiToken,
}, {
  callCloudflareApiImpl = callCloudflareApi,
} = {}) {
  const [databasesPayload, kvNamespacesPayload, bucketsPayload, queuesPayload] = await Promise.all([
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
    d1_databases: Object.freeze(extractArrayResult(databasesPayload.result).map((entry) => extractStringField(entry, ['name', 'database_name'])).filter(Boolean).sort()),
    kv_namespaces: Object.freeze(extractArrayResult(kvNamespacesPayload.result).map((entry) => extractStringField(entry, ['title', 'namespace'])).filter(Boolean).sort()),
    r2_buckets: Object.freeze(extractArrayResult(bucketsPayload.result, ['buckets']).map((entry) => extractStringField(entry, ['name'])).filter(Boolean).sort()),
    queues: Object.freeze(extractArrayResult(queuesPayload.result).map((entry) => extractStringField(entry, ['queue_name', 'name'])).filter(Boolean).sort()),
  });
}

function assertProdResourcesPresent(actualResourceNames, expectedResources) {
  const mismatches = [];
  const requiredKeys = ['d1_databases', 'kv_namespaces', 'r2_buckets', 'queues'];
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

export async function captureProdCostSnapshot({
  runTimestamp,
  outputPath,
  artifactRoot,
  fromDate = null,
  toDate = null,
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
} = {}) {
  const claims = await requireGitHubActionsExecutionImpl('captureProdCostSnapshot', {
    expectedEnvironmentName: PRODUCTION_ENVIRONMENT_NAME,
  });
  if (!isNonEmptyString(runTimestamp)) {
    throw new RangeError('runTimestamp is required');
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
    fromDate,
    toDate,
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
  const billingCurrencies = sortUniqueStringArray(billingUsageRecords.map((record) => record.billing_currency));
  if (billingCurrencies.length !== 1) {
    throw new Error(`Cloudflare billing usage API returned multiple billing currencies: ${billingCurrencies.join(', ')}`);
  }
  assertProdResourcesPresent(actualResourceNames, expectedResources);
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
      const activeVersionId = entry.state.active_worker_version_ids?.[0] ?? null;
      if (!isNonEmptyString(activeVersionId)) {
        throw new Error(`Cloudflare did not expose an active worker version id for ${entry.script_name}`);
      }
      return activeVersionId;
    }),
  };
  await fs.writeFile(deploymentIdentityPath, stableJson(deploymentIdentity));

  const aggregated = aggregateProdCostSurfaces(billingUsageRecords);
  const snapshot = {
    artifact_id: 'prod_cost_snapshot',
    source_environment: PRODUCTION_ENVIRONMENT_NAME,
    run_timestamp: runTimestamp,
    captured_at: new Date().toISOString(),
    captured_by: capturedBy ?? `github-actions:${process.env.GITHUB_ACTOR ?? 'unknown'}`,
    reviewed_by: reviewedBy ?? `github-actions-run:${claims.run_id}`,
    source_dashboard_uri: `https://api.cloudflare.com/client/v4/accounts/${accountId}${billingUsagePathname}`,
    topology_kind: 'cloudflare-prod',
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
  if (nextIds.length === 1) {
    return nextIds[0];
  }
  if (nextIds.length === 0) {
    throw new Error(`Unable to resolve a fresh ${label} from Cloudflare; rerun refused to reuse an existing identity`);
  }
  throw new Error(`Unable to resolve a unique fresh ${label} from Cloudflare`);
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
  if (!currentDeploymentState.active_worker_version_ids.includes(workerSummary.worker_version_id)) {
    throw new TypeError(`deployment workers.${workerName}.worker_version_id is not part of the latest active Cloudflare deployment for ${workerSummary.script_name}`);
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
  if (!isNonEmptyStringArray(deploymentSummary.cloudflare_resources.ratelimit_namespaces)) {
    throw new TypeError('deployment summary cloudflare_resources.ratelimit_namespaces must be a non-empty string array');
  }

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
  const declaredRateLimitNamespaces = [...deploymentSummary.cloudflare_resources.ratelimit_namespaces];
  const normalizedDeclaredRateLimitNamespaces = sortUniqueStringArray(declaredRateLimitNamespaces);
  if (normalizedDeclaredRateLimitNamespaces.length !== declaredRateLimitNamespaces.length) {
    throw new TypeError('deployment summary cloudflare_resources.ratelimit_namespaces must not contain duplicates');
  }
  const observedGatewayRateLimitNamespaces = Object.freeze(sortUniqueStringArray(
    workers['gateway-worker']?.ratelimit_namespace_ids ?? [],
  ));
  if (
    normalizedDeclaredRateLimitNamespaces.length !== observedGatewayRateLimitNamespaces.length
    || normalizedDeclaredRateLimitNamespaces.some((namespaceId, index) => namespaceId !== observedGatewayRateLimitNamespaces[index])
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
    assertNonLocalEnvironmentName(environmentName),
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

function validateNonLocalDeploymentWorker(workerName, environmentName, workerSummary, {
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
  const expectedScriptName = buildWorkerScriptName(workerName, environmentName);
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
    return {
      versions_count: Array.isArray(payload?.versions) ? payload.versions.length : 0,
    };
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
      fetchImpl,
    });
    if (versions.response.status !== 200 || !Array.isArray(versions.payload?.versions)) {
      return {
        ok: false,
        steps,
        failure: recordFailure('versions', versions.response, versions.payload),
      };
    }
    recordSuccess('versions', versions.payload);

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

export async function waitForNonLocalDeploymentReadiness(environmentName, remoteHarnessEnv, {
  fetchImpl = globalThis.fetch,
  maxAttempts = NON_LOCAL_READINESS_MAX_ATTEMPTS,
  initialDelayMs = NON_LOCAL_READINESS_INITIAL_DELAY_MS,
  maxDelayMs = NON_LOCAL_READINESS_MAX_DELAY_MS,
  sleepImpl = null,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
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

function formatNonLocalReadinessProbeLog(readinessProbe) {
  return [
    '# Non-local deployment readiness probe',
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
  const gatewayWorker = validateNonLocalDeploymentWorker(
    'gateway-worker',
    normalizedEnvironmentName,
    deploymentSummary.workers['gateway-worker'],
    {
      workersSubdomain: expectedWorkersSubdomain,
      expectedDeploymentId: deploymentSummary.deployment_identity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
      expectedWorkerVersionId: deploymentSummary.deployment_identity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('gateway-worker')],
    },
  );
  validateNonLocalDeploymentWorker(
    'jobs-worker',
    normalizedEnvironmentName,
    deploymentSummary.workers['jobs-worker'],
    {
      workersSubdomain: expectedWorkersSubdomain,
      expectedDeploymentId: deploymentSummary.deployment_identity.deployment_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
      expectedWorkerVersionId: deploymentSummary.deployment_identity.worker_version_ids[WORKER_DEPLOYMENT_ORDER.indexOf('jobs-worker')],
    },
  );
  const opsWorker = validateNonLocalDeploymentWorker(
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
  const secretBundle = buildNonProductionSecretBundle({
    environmentName: provisionedEnvironment.environment_name,
    accountId,
    apiToken,
    observabilityApiToken: process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN,
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
  const secretBundle = buildNonProductionSecretBundle({
    environmentName: provisionedEnvironment.environment_name,
    accountId,
    apiToken,
    observabilityApiToken: process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN,
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
    assertNonLocalEnvironmentName(environmentName),
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

export async function uploadImmutableArtifactToR2({
  repoRoot = process.cwd(),
  bucketName,
  objectKey,
  filePath,
  contentType = 'application/octet-stream',
  outputPath = null,
  accountId: explicitAccountId = null,
} = {}) {
  await requireGitHubActionsExecution('uploadImmutableArtifactToR2');
  const { accountId } = requireCloudflareCredentials({
    accountId: explicitAccountId,
  });
  const resolvedFilePath = path.resolve(filePath);
  const sha256 = await sha256FileHex(resolvedFilePath);
  await runWrangler([
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

export function buildGitHubRunUrl(repository, runId) {
  if (typeof repository !== 'string' || repository.length === 0) {
    throw new RangeError('repository must be non-empty');
  }
  if (typeof runId !== 'string' && typeof runId !== 'number') {
    throw new RangeError('runId must be a string or number');
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
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
  const validatedCloudflareResources = structuredCloneJson(cloudflareResources);
  validatedCloudflareResources.ratelimit_namespaces = [
    ...deploymentIdentityValidation.before_readiness.cloudflare_resources.ratelimit_namespaces,
  ];
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
  const readinessLogText = formatNonLocalReadinessProbeLog(readinessProbe);
  const combinedChunks = [Buffer.from(`${readinessLogText}\n`, 'utf8')];
  let exitCode = 1;
  if (readinessProbe.ready) {
    deploymentIdentityValidation.before_suite = await validateDeploymentSummaryAgainstCurrentCloudflareStateImpl(validationDeploymentSummary, {
      accountId,
      apiToken,
    });
    validatedCloudflareResources.ratelimit_namespaces = [
      ...deploymentIdentityValidation.before_suite.cloudflare_resources.ratelimit_namespaces,
    ];
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
    source_run_uri: sourceRunUri,
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
