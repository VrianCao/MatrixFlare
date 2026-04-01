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
  assessNonLocalEnvironmentHarnessReadiness,
  validateEvidenceAttestationBundle,
  validateManualArtifactPayload,
} from './evidence.mjs';
import {
  getTestEnvironmentDirectory,
  getRequiredTestFiles,
} from './bootstrap.mjs';

const NON_LOCAL_ENVIRONMENT_NAMES = Object.freeze([
  'ci-integration',
  'staging',
  'pre-release',
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

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DEFAULT_RELEASE_PROFILE = 'L1';
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_ACTIONS_OIDC_JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const GITHUB_ACTIONS_OIDC_AUDIENCE = 'matrix-phase08-nonlocal';

let githubActionsOidcIdentityPromise = null;
let githubActionsJwksPromise = null;

function assertNonLocalEnvironmentName(environmentName) {
  if (!NON_LOCAL_ENVIRONMENT_NAMES.includes(environmentName)) {
    throw new RangeError(`Unsupported non-local environment "${environmentName}"`);
  }
  return environmentName;
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
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

function buildResourceSuffix(environmentName) {
  return assertNonLocalEnvironmentName(environmentName);
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
      queues: Object.freeze(Object.values(resourceBindingNames.queues)),
    }),
    deployment_order: WORKER_DEPLOYMENT_ORDER,
    bootstrap_order: WORKER_BOOTSTRAP_ORDER,
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
}) {
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
    vars.ACCESS_TEAM_DOMAIN = `${slugifyLabel(plan.environment_name)}.cloudflareaccess.invalid`;
    vars.ACCESS_AUDIENCE = `matrixflare-${slugifyLabel(plan.environment_name)}-ops`;
  }
  return vars;
}

export function createEnvironmentWranglerConfig(workerName, plan, {
  d1DatabaseId,
  kvNamespaceId,
  gatewayBootstrapMode = false,
  deploymentId = `gha-${plan.environment_name}`,
  workerVersionId = 'pending-runtime-version',
  activeDeploymentComposition = [],
} = {}) {
  const baseConfig = structuredCloneJson(createWranglerConfigSnapshot(workerName));
  const envName = plan.environment_name;
  const workerVars = {
    ...baseConfig.vars,
    ...buildWorkerVars(workerName, plan, {
      deploymentId,
      workerVersionId,
      activeDeploymentComposition,
    }),
  };
  const envConfig = {
    vars: workerVars,
    workers_dev: true,
  };

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
    throw new Error(`Cloudflare API ${method} ${pathname} failed: ${errorMessage}`);
  }
  return payload;
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

async function fetchWorkerDeploymentState({
  accountId,
  apiToken,
  scriptName,
}) {
  const [deploymentsPayload, versionsPayload] = await Promise.all([
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
  return summarizeWorkerDeploymentState({
    deployments: extractArrayResult(deploymentsPayload.result, ['deployments']),
    versions: extractArrayResult(versionsPayload.result, ['items', 'versions']),
  });
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
  const [d1Database, kvNamespace, mediaBucket, archiveBucket, artifactBucket, ...queues] = await Promise.all([
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
  return Object.freeze({
    MATRIX_REMOTE_BASE_URL: gatewayWorker.url,
    MATRIX_REMOTE_SERVER_NAME: new URL(gatewayWorker.url).host,
    MATRIX_REMOTE_OPS_BASE_URL: opsWorker.url,
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
  return Object.freeze({
    MATRIX_REMOTE_BASE_URL: parsedRemoteBaseUrl.toString().replace(/\/$/, ''),
    MATRIX_REMOTE_SERVER_NAME: remoteServerName,
    MATRIX_REMOTE_OPS_BASE_URL: opsBaseUrl.length === 0
      ? ''
      : parseAbsoluteHttpsUrl(opsBaseUrl, 'MATRIX_REMOTE_OPS_BASE_URL').toString().replace(/\/$/, ''),
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
  const previousState = await fetchWorkerDeploymentState({
    accountId,
    apiToken,
    scriptName,
  });
  const configPath = path.join(workingRoot, `${workerName}.wrangler.json`);
  const secretsPath = path.join(workingRoot, `${workerName}.secrets.json`);
  await writeEnvironmentWranglerConfig(workerName, provisionedEnvironment.plan, {
    outputPath: configPath,
    d1DatabaseId: provisionedEnvironment.resources.d1_database.id,
    kvNamespaceId: provisionedEnvironment.resources.kv_namespace.id,
    gatewayBootstrapMode,
    deploymentId,
    workerVersionId: buildRuntimeWorkerVersionId(deploymentId, workerName),
    activeDeploymentComposition: runtimeComposition,
  });
  const secretBundle = buildNonProductionSecretBundle({
    environmentName: provisionedEnvironment.environment_name,
    accountId,
    apiToken,
  });
  await writeWorkerSecretsFile(workerName, secretBundle, secretsPath);
  await runWrangler([
    'deploy',
    '--config',
    configPath,
    '--env',
    provisionedEnvironment.environment_name,
    '--name',
    buildWorkerScriptBaseName(workerName),
    '--message',
    `${deploymentId}:${workerName}${gatewayBootstrapMode ? ':bootstrap' : ':deploy'}`,
    '--tag',
    `${deploymentId}-${slugifyLabel(workerName)}${gatewayBootstrapMode ? '-bootstrap' : ''}`,
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

export async function runEnvironmentBackedSuite(environmentName, repoRoot, {
  runTimestamp,
  outputRoot,
  sourceRunUri,
  logArtifact,
  executedBy,
  reviewedBy,
  topologyKind,
  deploymentSummary,
} = {}) {
  const normalizedEnvironmentName = assertNonLocalEnvironmentName(environmentName);
  await requireGitHubActionsExecution('runEnvironmentBackedSuite', {
    expectedEnvironmentName: normalizedEnvironmentName,
  });
  const readiness = await assessNonLocalEnvironmentHarnessReadiness(normalizedEnvironmentName, repoRoot);
  if (readiness.ready !== true) {
    throw new Error(`${normalizedEnvironmentName} harness is not environment-backed: ${readiness.reason}`);
  }
  const { accountId, apiToken } = requireCloudflareCredentials();
  const workersSubdomain = await readWorkersSubdomain({
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
  const remoteHarnessEnv = validateRemoteHarnessEnvironmentVariables(
    buildRemoteHarnessEnvironmentVariablesFromDeployment(normalizedEnvironmentName, deploymentSummary, {
      workersSubdomain,
    }),
  );
  for (const workerName of WORKER_DEPLOYMENT_ORDER) {
    const workerSummary = deploymentSummary.workers?.[workerName];
    const currentDeploymentState = await fetchWorkerDeploymentState({
      accountId,
      apiToken,
      scriptName: workerSummary?.script_name,
    });
    validateLatestActiveCloudflareWorkerIdentity(workerName, workerSummary, currentDeploymentState);
  }
  const cloudflareResources = deploymentSummary?.cloudflare_resources ?? null;
  if (!isPlainObject(cloudflareResources)) {
    throw new TypeError('deployment summary cloudflare_resources must be an object');
  }
  const files = await getRequiredTestFiles(normalizedEnvironmentName, repoRoot);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const commandArgs = ['--test', ...files];
  const combinedChunks = [];
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...remoteHarnessEnv,
        MATRIX_TEST_ENVIRONMENT: normalizedEnvironmentName,
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
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const logText = Buffer.concat(combinedChunks).toString('utf8');
  const outputDirectory = path.resolve(outputRoot);
  const logPath = path.join(outputDirectory, `${normalizedEnvironmentName}.log`);
  const reportPath = path.join(outputDirectory, `${normalizedEnvironmentName}.json`);
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
    output_sha256: sha256Hex(logText),
    error_message: exitCode === 0 ? null : `Environment suite exited with ${exitCode}`,
    log_artifact: logArtifact,
    executed_by: executedBy,
    reviewed_by: reviewedBy,
    source_run_uri: sourceRunUri,
    topology_kind: topologyKind,
    cloudflare_resources: cloudflareResources,
    run_timestamp: runTimestamp,
  };
  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(logPath, logText),
    fs.writeFile(reportPath, stableJson(report)),
  ]);
  const artifactId = normalizedEnvironmentName === 'ci-integration'
    ? 'ci_integration_run_report'
    : normalizedEnvironmentName === 'pre-release'
      ? 'pre_release_run_report'
      : 'staging_run_report';
  const payloadValidation = validateManualArtifactPayload(artifactId, report, {
    runTimestamp,
  });
  return {
    ok: exitCode === 0 && payloadValidation.valid,
    validation_error: payloadValidation.valid ? null : payloadValidation.error,
    report,
    log_path: logPath,
    report_path: reportPath,
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
}) {
  await requireGitHubActionsExecution('writeProdCostSnapshotAttestation');
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
