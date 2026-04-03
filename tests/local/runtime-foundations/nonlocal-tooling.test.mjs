import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildEnvironmentRunProvenance,
  buildGitHubRunUrl,
  buildNonLocalEnvironmentPlan,
  buildNonProductionSecretBundle,
  buildRemoteHarnessEnvironmentVariables,
  buildRemoteHarnessEnvironmentVariablesFromDeployment,
  buildWranglerDeployArguments,
  buildRuntimeWorkerVersionTag,
  buildWorkerScriptName,
  createEnvironmentWranglerConfig,
  fetchWorkerDeploymentState,
  resolveFreshCloudflareIdentity,
  resolvePreDeployWorkerDeploymentState,
  runEnvironmentBackedSuite,
  summarizeWorkerDeploymentState,
  validateDeploymentSummaryAgainstCurrentCloudflareState,
  validateLatestActiveCloudflareWorkerIdentity,
  validateRemoteHarnessEnvironmentVariables,
  waitForNonLocalDeploymentReadiness,
  writeProdCostSnapshotAttestation,
  writeEnvironmentWranglerConfig,
  writeEnvironmentRunProvenance,
} from '../../../packages/testing/src/nonlocal.mjs';
import {
  buildEnvironmentRateLimitNamespaceId,
} from '../../../packages/testing/src/cloudflare-resources.mjs';
import {
  GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS,
} from '../../../packages/runtime-core/src/abuse-guard.mjs';

function buildDeploymentSummaryFixture(environmentName) {
  const plan = buildNonLocalEnvironmentPlan(environmentName, {
    workersSubdomain: 'matrixflare',
  });
  return {
    environment_name: environmentName,
    account_id: 'cf-account',
    workers_subdomain: 'matrixflare',
    cloudflare_resources: {
      ...plan.cloudflare_resources,
      r2_buckets: [...plan.cloudflare_resources.r2_buckets, plan.artifact_bucket_name].sort(),
    },
    deployment_identity: {
      environment_id: environmentName,
      deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
      worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
    },
    workers: {
      'gateway-worker': {
        worker_name: 'gateway-worker',
        deployment_id: 'dep-gateway',
        worker_version_id: 'ver-gateway',
        script_name: plan.worker_scripts['gateway-worker'],
        url: plan.worker_urls['gateway-worker'],
      },
      'jobs-worker': {
        worker_name: 'jobs-worker',
        deployment_id: 'dep-jobs',
        worker_version_id: 'ver-jobs',
        script_name: plan.worker_scripts['jobs-worker'],
        url: plan.worker_urls['jobs-worker'],
      },
      'ops-worker': {
        worker_name: 'ops-worker',
        deployment_id: 'dep-ops',
        worker_version_id: 'ver-ops',
        script_name: plan.worker_scripts['ops-worker'],
        url: plan.worker_urls['ops-worker'],
      },
    },
  };
}

function buildDeploymentIdentityValidationFixture(environmentName) {
  const plan = buildNonLocalEnvironmentPlan(environmentName, {
    workersSubdomain: 'matrixflare',
  });
  return {
    validated_at: '2026-04-01T16:00:00.000Z',
    cloudflare_resources: {
      ratelimit_namespaces: plan.cloudflare_resources.ratelimit_namespaces,
    },
    workers: {
      'jobs-worker': {
        script_name: buildWorkerScriptName('jobs-worker', environmentName),
        latest_active_deployment_id: 'dep-jobs',
        active_worker_version_ids: ['ver-jobs'],
      },
      'ops-worker': {
        script_name: buildWorkerScriptName('ops-worker', environmentName),
        latest_active_deployment_id: 'dep-ops',
        active_worker_version_ids: ['ver-ops'],
      },
      'gateway-worker': {
        script_name: buildWorkerScriptName('gateway-worker', environmentName),
        latest_active_deployment_id: 'dep-gateway',
        active_worker_version_ids: ['ver-gateway'],
      },
    },
  };
}

function buildReadinessProbeFixture(environmentName, {
  ready = true,
  lastError = null,
  failureStepName = 'register_complete',
  failureDetail = { status: 500, error: 'transient deploy window' },
} = {}) {
  const successSteps = [
    { step: 'versions', ok: true, detail: { versions_count: 1 } },
    { step: 'public_rooms', ok: true, detail: { chunk_length: 0 } },
    { step: 'register_challenge', ok: true, detail: { session_present: true, flows_count: 1 } },
    { step: 'register_complete', ok: true, detail: { user_id_present: true, access_token_present: true } },
    { step: 'sync', ok: true, detail: { next_batch_present: true } },
    { step: 'media_create', ok: true, detail: { content_uri_present: true } },
  ];
  if (environmentName !== 'ci-integration') {
    successSteps.push(
      { step: 'ops_healthz', ok: true, detail: { service: 'ops-worker', status: 'ok' } },
      { step: 'ops_rebuild_start', ok: true, detail: { job_id_present: true, job_type: 'rebuild', state: 'accepted' } },
    );
  }
  const attempts = ready
    ? [{
      attempt: 1,
      started_at: '2026-04-01T16:00:00.000Z',
      completed_at: '2026-04-01T16:00:03.000Z',
      duration_ms: 3000,
      ok: true,
      steps: successSteps,
      failure: null,
      delay_before_next_attempt_ms: null,
    }]
    : [{
      attempt: 1,
      started_at: '2026-04-01T16:00:00.000Z',
      completed_at: '2026-04-01T16:00:02.000Z',
      duration_ms: 2000,
      ok: false,
      steps: [
        { step: 'versions', ok: true, detail: { versions_count: 1 } },
        { step: 'public_rooms', ok: true, detail: { chunk_length: 0 } },
        { step: failureStepName, ok: false, detail: failureDetail },
      ],
      failure: {
        step_name: failureStepName,
        detail: failureDetail,
      },
      delay_before_next_attempt_ms: null,
    }];
  return {
    ready,
    environment_name: environmentName,
    started_at: '2026-04-01T16:00:00.000Z',
    completed_at: '2026-04-01T16:00:03.000Z',
    duration_ms: ready ? 3000 : 2000,
    attempt_count: attempts.length,
    last_error: ready ? null : lastError,
    attempts,
  };
}

function buildRolloutSkewProbeFixture(overrides = {}) {
  return {
    environment_name: 'pre-release',
    probe_run_id: 'rollout-probe-1',
    dual_version_deployment_id: 'dual-deployment-1',
    baseline_gateway_version_id: 'gateway-baseline-v1',
    candidate_gateway_version_id: 'gateway-candidate-v2',
    override_strategy: 'cloudflare-version-overrides',
    observations: [
      {
        probe_name: 'new-worker-old-authority',
        request_gateway_version_id: 'gateway-candidate-v2',
        observed_gateway_version_id: 'gateway-candidate-v2',
        observed_authority_version_id: 'gateway-baseline-v1',
        authority_kind: 'UserDO',
        authority_key: '@baseline:test',
        request_path: '/_matrix/client/v3/account/whoami',
        observed_at: '2026-04-02T00:00:00.000Z',
      },
      {
        probe_name: 'new-worker-old-authority',
        request_gateway_version_id: 'gateway-candidate-v2',
        observed_gateway_version_id: 'gateway-candidate-v2',
        observed_authority_version_id: 'gateway-baseline-v1',
        authority_kind: 'RoomDO',
        authority_key: '!baseline:test',
        request_path: '/_matrix/client/v3/rooms/%21baseline%3Atest/state',
        observed_at: '2026-04-02T00:00:01.000Z',
      },
      {
        probe_name: 'old-worker-new-authority',
        request_gateway_version_id: 'gateway-baseline-v1',
        observed_gateway_version_id: 'gateway-baseline-v1',
        observed_authority_version_id: 'gateway-candidate-v2',
        authority_kind: 'UserDO',
        authority_key: '@candidate:test',
        request_path: '/_matrix/client/v3/account/whoami',
        observed_at: '2026-04-02T00:00:02.000Z',
      },
      {
        probe_name: 'old-worker-new-authority',
        request_gateway_version_id: 'gateway-baseline-v1',
        observed_gateway_version_id: 'gateway-baseline-v1',
        observed_authority_version_id: 'gateway-candidate-v2',
        authority_kind: 'RoomDO',
        authority_key: '!candidate:test',
        request_path: '/_matrix/client/v3/rooms/%21candidate%3Atest/state',
        observed_at: '2026-04-02T00:00:03.000Z',
      },
    ],
    assertions: {
      new_worker_old_authority: true,
      old_worker_new_authority: true,
    },
    ...overrides,
  };
}

test('non-local environment plan derives deterministic workers.dev scripts and resource names', () => {
  const plan = buildNonLocalEnvironmentPlan('staging', {
    workersSubdomain: 'matrixflare',
  });

  assert.equal(buildWorkerScriptName('gateway-worker', 'staging'), 'matrix-gateway-worker-staging');
  assert.equal(plan.worker_scripts['jobs-worker'], 'matrix-jobs-worker-staging');
  assert.equal(plan.worker_urls['ops-worker'], 'https://matrix-ops-worker-staging.matrixflare.workers.dev');
  assert.equal(plan.runtime_resource_binding_names.d1_databases.MATRIX_CONTROL_D1, 'matrix-control-and-derived-staging');
  assert.equal(plan.runtime_resource_binding_names.r2_buckets.MATRIX_MEDIA_BUCKET, 'matrix-media-staging');
  assert.equal(plan.runtime_resource_binding_names.queues.SEARCH_INDEX_QUEUE, 'matrix-search-index-job-staging');
  assert.equal(plan.kv_namespace_title, 'matrix-edge-cache-staging');
  assert.equal(plan.artifact_bucket_name, 'matrix-evidence-staging');
  assert.deepEqual(plan.cloudflare_resources.ratelimit_namespaces, [
    '84281001',
    '84281002',
    '84281003',
    '84281004',
    '84281005',
    '84281006',
    '84281007',
  ]);
});

test('non-production secret bundle stays stable for the same inputs and diverges across environments', () => {
  const baseline = buildNonProductionSecretBundle({
    environmentName: 'ci-integration',
    accountId: 'cf-account-1',
    apiToken: 'cf-token-1',
  });
  const repeat = buildNonProductionSecretBundle({
    environmentName: 'ci-integration',
    accountId: 'cf-account-1',
    apiToken: 'cf-token-1',
  });
  const staging = buildNonProductionSecretBundle({
    environmentName: 'staging',
    accountId: 'cf-account-1',
    apiToken: 'cf-token-1',
  });

  assert.deepEqual(repeat, baseline);
  assert.notEqual(staging.gateway.SESSION_ROOT_KEY_RING, baseline.gateway.SESSION_ROOT_KEY_RING);
  assert.notEqual(staging.jobs.EXPORT_BUNDLE_KEY_RING, baseline.jobs.EXPORT_BUNDLE_KEY_RING);
});

test('environment wrangler config rewrites bindings for a specific non-local environment without mutating committed snapshots', () => {
  const plan = buildNonLocalEnvironmentPlan('pre-release', {
    workersSubdomain: 'matrixflare',
  });
  const config = createEnvironmentWranglerConfig('gateway-worker', plan, {
    d1DatabaseId: 'db-pre-release',
    kvNamespaceId: 'kv-pre-release',
    deploymentId: 'gha-pre-release',
    workerVersionId: 'worker-version-pre-release',
    activeDeploymentComposition: [
      {
        worker_name: 'gateway-worker',
        worker_version_id: 'worker-version-pre-release',
        deployment_id: 'gha-pre-release',
      },
    ],
  });

  assert.equal(config.name, 'matrix-gateway-worker');
  assert.ok(config.env);
  assert.equal(config.env['pre-release'].workers_dev, true);
  assert.equal(config.env['pre-release'].vars.ENVIRONMENT_NAME, 'pre-release');
  assert.equal(config.env['pre-release'].vars.WORKER_VERSION_ID, 'worker-version-pre-release');
  assert.equal(config.env['pre-release'].services[0].service, 'matrix-jobs-worker-pre-release');
  assert.equal(config.env['pre-release'].queues.producers[0].queue, 'matrix-search-index-job-pre-release');
  assert.equal(config.env['pre-release'].d1_databases[0].database_name, 'matrix-control-and-derived-pre-release');
  assert.equal(config.env['pre-release'].d1_databases[0].database_id, 'db-pre-release');
  assert.equal(config.env['pre-release'].r2_buckets[0].bucket_name, 'matrix-media-pre-release');
  assert.equal(config.env['pre-release'].kv_namespaces[0].id, 'kv-pre-release');
  assert.equal(config.env['pre-release'].ratelimits[0].name, 'GATEWAY_PUBLIC_ENTRY_RATE_LIMITER');
  assert.equal(config.env['pre-release'].ratelimits[0].namespace_id, '84381001');
  assert.equal(config.env['pre-release'].ratelimits[0].simple.limit, 120);
  assert.equal(
    JSON.parse(config.env['pre-release'].vars.RESOURCE_BINDING_NAMES_JSON).queues.RESTORE_SHARD_QUEUE,
    'matrix-restore-shard-job-pre-release',
  );
});

test('ops-worker non-local wrangler config requires real Access metadata and wires it into worker vars', () => {
  const plan = buildNonLocalEnvironmentPlan('staging', {
    workersSubdomain: 'matrixflare',
  });

  assert.throws(
    () => createEnvironmentWranglerConfig('ops-worker', plan, {
      d1DatabaseId: 'db-staging',
      kvNamespaceId: 'kv-staging',
    }),
    /ops-worker non-local deploy requires access metadata/,
  );

  const config = createEnvironmentWranglerConfig('ops-worker', plan, {
    d1DatabaseId: 'db-staging',
    kvNamespaceId: 'kv-staging',
    access: {
      auth_domain: 'matrixflare.cloudflareaccess.com',
      application_audience: 'aud-staging-ops',
    },
  });

  assert.equal(config.env.staging.vars.ACCESS_TEAM_DOMAIN, 'matrixflare.cloudflareaccess.com');
  assert.equal(config.env.staging.vars.ACCESS_AUDIENCE, 'aud-staging-ops');
  assert.equal(config.env.staging.vars.GATEWAY_WORKER_SCRIPT_NAME, 'matrix-gateway-worker-staging');
});

test('jobs-worker non-local wrangler config preserves derived queue producers needed by remote search and media flows', () => {
  const plan = buildNonLocalEnvironmentPlan('pre-release', {
    workersSubdomain: 'matrixflare',
  });
  const config = createEnvironmentWranglerConfig('jobs-worker', plan, {
    d1DatabaseId: 'db-pre-release',
    kvNamespaceId: 'kv-pre-release',
  });

  assert.deepEqual(
    config.env['pre-release'].queues.producers.map((entry) => `${entry.binding}:${entry.queue}`),
    [
      'SEARCH_INDEX_QUEUE:matrix-search-index-job-pre-release',
      'MEDIA_THUMBNAIL_QUEUE:matrix-media-thumbnail-job-pre-release',
      'REBUILD_SHARD_QUEUE:matrix-rebuild-shard-job-pre-release',
      'EXPORT_SHARD_QUEUE:matrix-export-shard-job-pre-release',
      'RESTORE_SHARD_QUEUE:matrix-restore-shard-job-pre-release',
      'REPAIR_SHARD_QUEUE:matrix-repair-shard-job-pre-release',
    ],
  );
});

test('non-local gateway deployment contract keeps the default shared search limiter baseline when no abuse override is configured', () => {
  const plan = buildNonLocalEnvironmentPlan('staging', {
    workersSubdomain: 'matrixflare',
  });
  const config = createEnvironmentWranglerConfig('gateway-worker', plan, {
    d1DatabaseId: 'db-staging',
    kvNamespaceId: 'kv-staging',
  });

  assert.equal(config.env.staging.vars.ABUSE_GUARD_POLICY_JSON, '');
  assert.equal(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS.gateway_search.limit, 60);
  assert.equal(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS.gateway_search.period_seconds, 60);
});

test('written non-local wrangler config rewrites main to a real worker entrypoint relative to the generated config', async () => {
  const repoRoot = path.resolve('.');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-wrangler-main-'));
  const plan = buildNonLocalEnvironmentPlan('staging', {
    workersSubdomain: 'matrixflare',
  });

  try {
    for (const workerName of ['gateway-worker', 'jobs-worker', 'ops-worker']) {
      const outputPath = path.join(tempRoot, workerName, 'wrangler.json');
      const written = await writeEnvironmentWranglerConfig(workerName, plan, {
        outputPath,
        repoRoot,
        d1DatabaseId: 'db-staging',
        kvNamespaceId: 'kv-staging',
        deploymentId: 'gha-staging-test',
        workerVersionId: `gha-staging-test-${workerName}`,
        activeDeploymentComposition: [],
        access: workerName === 'ops-worker'
          ? {
            auth_domain: 'matrixflare.cloudflareaccess.com',
            application_audience: 'aud-staging-ops',
          }
          : null,
      });
      const resolvedMainPath = path.resolve(path.dirname(outputPath), written.config.main);
      assert.equal(
        resolvedMainPath,
        path.join(repoRoot, 'apps', workerName, 'src', 'index.mjs'),
      );
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('wrangler deploy version tags stay deterministic, worker-specific, and within Cloudflare limits', () => {
  const deploymentId = 'gha-ci-integration-20260401T131924Z-23850666522-1';
  const gatewayDeployTag = buildRuntimeWorkerVersionTag(deploymentId, 'gateway-worker');
  const gatewayBootstrapTag = buildRuntimeWorkerVersionTag(deploymentId, 'gateway-worker', {
    gatewayBootstrapMode: true,
  });
  const jobsDeployTag = buildRuntimeWorkerVersionTag(deploymentId, 'jobs-worker');

  assert.equal(gatewayDeployTag, buildRuntimeWorkerVersionTag(deploymentId, 'gateway-worker'));
  assert.equal(gatewayDeployTag.length <= 25, true);
  assert.equal(gatewayBootstrapTag.length <= 25, true);
  assert.equal(jobsDeployTag.length <= 25, true);
  assert.notEqual(gatewayDeployTag, gatewayBootstrapTag);
  assert.notEqual(gatewayDeployTag, jobsDeployTag);
});

test('wrangler deploy arguments rely on --env without overriding the environment-specific worker name', () => {
  const args = buildWranglerDeployArguments({
    workerName: 'gateway-worker',
    environmentName: 'ci-integration',
    configPath: '/tmp/gateway-worker.wrangler.json',
    secretsPath: '/tmp/gateway-worker.secrets.json',
    deploymentId: 'gha-ci-integration-20260401T132930Z-23851114355-1',
    gatewayBootstrapMode: true,
  });

  assert.equal(args.includes('--name'), false);
  assert.equal(args.includes('--env'), true);
  assert.equal(args[args.indexOf('--env') + 1], 'ci-integration');
  assert.equal(args[args.indexOf('--message') + 1], 'gha-ci-integration-20260401T132930Z-23851114355-1:gateway-worker:bootstrap');
  assert.equal(args[args.indexOf('--tag') + 1].length <= 25, true);
});

test('remote harness env vars and GitHub run URLs derive deterministically from the environment plan', () => {
  const plan = buildNonLocalEnvironmentPlan('ci-integration', {
    workersSubdomain: 'matrixflare',
  });
  const remoteEnv = buildRemoteHarnessEnvironmentVariables(plan);

  assert.equal(buildGitHubRunUrl('example/matrix', '12345'), 'https://github.com/example/matrix/actions/runs/12345');
  assert.equal(remoteEnv.MATRIX_REMOTE_BASE_URL, 'https://matrix-gateway-worker-ci-integration.matrixflare.workers.dev');
  assert.equal(remoteEnv.MATRIX_REMOTE_SERVER_NAME, 'matrix-gateway-worker-ci-integration.matrixflare.workers.dev');
  assert.equal(remoteEnv.MATRIX_REMOTE_OPS_BASE_URL, 'https://matrix-ops-worker-ci-integration.matrixflare.workers.dev');
});

test('remote harness env vars derive from a validated deployment summary instead of caller-supplied hosts', () => {
  const plan = buildNonLocalEnvironmentPlan('staging', {
    workersSubdomain: 'matrixflare',
  });
  const deploymentSummary = {
    environment_name: 'staging',
    workers_subdomain: 'matrixflare',
    deployment_identity: {
      environment_id: 'staging',
      deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
      worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
    },
    workers: {
      'gateway-worker': {
        worker_name: 'gateway-worker',
        deployment_id: 'dep-gateway',
        worker_version_id: 'ver-gateway',
        script_name: plan.worker_scripts['gateway-worker'],
        url: plan.worker_urls['gateway-worker'],
      },
      'jobs-worker': {
        worker_name: 'jobs-worker',
        deployment_id: 'dep-jobs',
        worker_version_id: 'ver-jobs',
        script_name: plan.worker_scripts['jobs-worker'],
        url: plan.worker_urls['jobs-worker'],
      },
      'ops-worker': {
        worker_name: 'ops-worker',
        deployment_id: 'dep-ops',
        worker_version_id: 'ver-ops',
        script_name: plan.worker_scripts['ops-worker'],
        url: plan.worker_urls['ops-worker'],
      },
    },
  };

  assert.deepEqual(
    buildRemoteHarnessEnvironmentVariablesFromDeployment('staging', deploymentSummary, {
      workersSubdomain: 'matrixflare',
    }),
    {
      MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
      MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
      MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
    },
  );

  assert.throws(
    () => buildRemoteHarnessEnvironmentVariablesFromDeployment('staging', {
      ...deploymentSummary,
      workers: {
        ...deploymentSummary.workers,
        'gateway-worker': {
          ...deploymentSummary.workers['gateway-worker'],
          script_name: 'matrix-gateway-worker-ci-integration',
        },
      },
    }, {
      workersSubdomain: 'matrixflare',
    }),
    /deployment workers\.gateway-worker\.script_name must equal matrix-gateway-worker-staging/,
  );

  assert.throws(
    () => buildRemoteHarnessEnvironmentVariablesFromDeployment('staging', {
      ...deploymentSummary,
      workers: {
        ...deploymentSummary.workers,
        'gateway-worker': {
          ...deploymentSummary.workers['gateway-worker'],
          url: 'https://matrix-gateway-worker-staging.example.com',
        },
      },
    }, {
      workersSubdomain: 'matrixflare',
    }),
    /deployment workers\.gateway-worker\.url must match the workers\.dev URL for matrix-gateway-worker-staging/,
  );

  assert.throws(
    () => buildRemoteHarnessEnvironmentVariablesFromDeployment('staging', {
      ...deploymentSummary,
      workers: {
        ...deploymentSummary.workers,
        'gateway-worker': {
          ...deploymentSummary.workers['gateway-worker'],
          deployment_id: 'dep-forged',
        },
      },
    }, {
      workersSubdomain: 'matrixflare',
    }),
    /deployment workers\.gateway-worker\.deployment_id must equal deployment_identity for gateway-worker/,
  );

  assert.throws(
    () => buildRemoteHarnessEnvironmentVariablesFromDeployment('staging', {
      ...deploymentSummary,
      workers_subdomain: 'other-subdomain',
    }, {
      workersSubdomain: 'matrixflare',
    }),
    /deployment summary workers_subdomain must equal matrixflare/,
  );
});

test('remote harness env vars prefer the declared protected ops URL when deployment summary exposes Access metadata', () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');
  deploymentSummary.workers['ops-worker'] = {
    ...deploymentSummary.workers['ops-worker'],
    url: 'https://matrix-ops-worker-staging.matrixflare.workers.dev/origin-only',
  };
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
  };

  assert.deepEqual(
    buildRemoteHarnessEnvironmentVariablesFromDeployment('staging', deploymentSummary, {
      workersSubdomain: 'matrixflare',
    }),
    {
      MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
      MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
      MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
    },
  );
});

test('fresh Cloudflare identities must be newly observed and unique', () => {
  assert.equal(
    resolveFreshCloudflareIdentity(['dep-old'], ['dep-new', 'dep-old'], 'deployment id'),
    'dep-new',
  );
  assert.throws(
    () => resolveFreshCloudflareIdentity(['dep-old'], ['dep-old'], 'deployment id'),
    /rerun refused to reuse an existing identity/,
  );
  assert.throws(
    () => resolveFreshCloudflareIdentity(['dep-old'], ['dep-new-a', 'dep-new-b', 'dep-old'], 'deployment id'),
    /unique fresh deployment id/,
  );
});

test('worker deployment state summary keeps only the latest active deployment version set', () => {
  const summary = summarizeWorkerDeploymentState({
    deployments: [
      {
        id: 'dep-current',
        versions: [
          { version_id: 'ver-current' },
        ],
      },
      {
        id: 'dep-old',
        versions: [
          { version_id: 'ver-old' },
        ],
      },
    ],
    versions: [
      { id: 'ver-current' },
      { id: 'ver-old' },
      { id: 'ver-archived' },
    ],
  });

  assert.deepEqual(summary.deployment_ids, ['dep-current', 'dep-old']);
  assert.equal(summary.latest_active_deployment_id, 'dep-current');
  assert.deepEqual(summary.active_worker_version_ids, ['ver-current']);
  assert.deepEqual(summary.worker_version_ids, ['ver-current', 'ver-old', 'ver-archived']);
});

test('deployment summary Cloudflare revalidation checks every worker against the latest active identity', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');
  const observedScripts = [];

  const validation = await validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
    accountId: 'cf-account',
    apiToken: 'cf-token',
    fetchWorkerDeploymentStateImpl: async ({ accountId, apiToken, scriptName }) => {
      observedScripts.push({ accountId, apiToken, scriptName });
      const workerAlias = scriptName.split('-')[1];
      return {
        latest_active_deployment_id: `dep-${workerAlias}`,
        active_worker_version_ids: [`ver-${workerAlias}`, 'ver-older'],
      };
    },
    fetchWorkerBindingStateImpl: async ({ scriptName }) => ({
      ratelimit_namespace_ids: scriptName === deploymentSummary.workers['gateway-worker'].script_name
        ? deploymentSummary.cloudflare_resources.ratelimit_namespaces
        : [],
    }),
  });

  assert.deepEqual(observedScripts, [
    { accountId: 'cf-account', apiToken: 'cf-token', scriptName: 'matrix-jobs-worker-staging' },
    { accountId: 'cf-account', apiToken: 'cf-token', scriptName: 'matrix-ops-worker-staging' },
    { accountId: 'cf-account', apiToken: 'cf-token', scriptName: 'matrix-gateway-worker-staging' },
  ]);
  assert.equal(validation.workers['jobs-worker'].latest_active_deployment_id, 'dep-jobs');
  assert.deepEqual(validation.workers['gateway-worker'].active_worker_version_ids, ['ver-gateway', 'ver-older']);
  assert.deepEqual(
    validation.workers['gateway-worker'].ratelimit_namespace_ids,
    deploymentSummary.cloudflare_resources.ratelimit_namespaces,
  );
  assert.deepEqual(
    validation.cloudflare_resources.ratelimit_namespaces,
    deploymentSummary.cloudflare_resources.ratelimit_namespaces,
  );
  assert.match(validation.validated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('deployment summary Cloudflare revalidation rejects ratelimit namespace drift from the deployed worker bindings', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');

  await assert.rejects(
    () => validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
        const workerAlias = scriptName.split('-')[1];
        return {
          latest_active_deployment_id: `dep-${workerAlias}`,
          active_worker_version_ids: [`ver-${workerAlias}`],
        };
      },
      fetchWorkerBindingStateImpl: async ({ scriptName }) => ({
        ratelimit_namespace_ids: scriptName === deploymentSummary.workers['gateway-worker'].script_name
          ? ['99999999']
          : [],
      }),
    }),
    /cloudflare_resources\.ratelimit_namespaces must match currently deployed Cloudflare ratelimit namespace bindings on gateway-worker/,
  );
});

test('deployment summary Cloudflare revalidation rejects malformed declared ratelimit namespace snapshots', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');
  deploymentSummary.cloudflare_resources = {
    ...deploymentSummary.cloudflare_resources,
    ratelimit_namespaces: [
      deploymentSummary.cloudflare_resources.ratelimit_namespaces[0],
      '',
      null,
      123,
    ],
  };

  await assert.rejects(
    () => validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
        const workerAlias = scriptName.split('-')[1];
        return {
          latest_active_deployment_id: `dep-${workerAlias}`,
          active_worker_version_ids: [`ver-${workerAlias}`],
        };
      },
      fetchWorkerBindingStateImpl: async ({ scriptName }) => ({
        ratelimit_namespace_ids: scriptName === deploymentSummary.workers['gateway-worker'].script_name
          ? buildDeploymentSummaryFixture('staging').cloudflare_resources.ratelimit_namespaces
          : [],
      }),
    }),
    /cloudflare_resources\.ratelimit_namespaces must be a non-empty string array/,
  );
});

test('environment ratelimit namespace builder rejects partially numeric namespace ids', () => {
  assert.throws(
    () => buildEnvironmentRateLimitNamespaceId('staging', '84081001junk'),
    /namespaceId must be a positive integer string/,
  );
  assert.throws(
    () => buildEnvironmentRateLimitNamespaceId('staging', '84 081001'),
    /namespaceId must be a positive integer string/,
  );
});

test('deployment summary Cloudflare revalidation rejects ratelimit namespaces reported by non-gateway workers', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');

  await assert.rejects(
    () => validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
        const workerAlias = scriptName.split('-')[1];
        return {
          latest_active_deployment_id: `dep-${workerAlias}`,
          active_worker_version_ids: [`ver-${workerAlias}`],
        };
      },
      fetchWorkerBindingStateImpl: async ({ scriptName }) => {
        if (scriptName === deploymentSummary.workers['gateway-worker'].script_name) {
          return {
            ratelimit_namespace_ids: deploymentSummary.cloudflare_resources.ratelimit_namespaces,
          };
        }
        if (scriptName === deploymentSummary.workers['jobs-worker'].script_name) {
          return {
            ratelimit_namespace_ids: [
              deploymentSummary.cloudflare_resources.ratelimit_namespaces[0],
            ],
          };
        }
        return {
          ratelimit_namespace_ids: [],
        };
      },
    }),
    /jobs-worker must not expose ratelimit namespace bindings/,
  );
});

test('deployment summary Cloudflare revalidation rejects duplicate declared ratelimit namespaces', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');
  deploymentSummary.cloudflare_resources = {
    ...deploymentSummary.cloudflare_resources,
    ratelimit_namespaces: [
      deploymentSummary.cloudflare_resources.ratelimit_namespaces[0],
      deploymentSummary.cloudflare_resources.ratelimit_namespaces[0],
    ],
  };

  await assert.rejects(
    () => validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
        const workerAlias = scriptName.split('-')[1];
        return {
          latest_active_deployment_id: `dep-${workerAlias}`,
          active_worker_version_ids: [`ver-${workerAlias}`],
        };
      },
      fetchWorkerBindingStateImpl: async ({ scriptName }) => ({
        ratelimit_namespace_ids: scriptName === deploymentSummary.workers['gateway-worker'].script_name
          ? buildDeploymentSummaryFixture('staging').cloudflare_resources.ratelimit_namespaces
          : [],
      }),
    }),
    /cloudflare_resources\.ratelimit_namespaces must not contain duplicates/,
  );
});

test('pre-deploy worker deployment state only treats fully missing script observations as an empty bootstrap state', () => {
  const scriptName = 'matrix-gateway-worker-staging';

  const missingScriptState = resolvePreDeployWorkerDeploymentState(
    scriptName,
    [
      {
        status: 'rejected',
        reason: Object.assign(
          new Error(`Cloudflare API GET /workers/scripts/${scriptName}/deployments failed: This Worker does not exist on your account.`),
          { response_status: 404 },
        ),
      },
      {
        status: 'rejected',
        reason: Object.assign(
          new Error(`Cloudflare API GET /workers/scripts/${scriptName}/versions failed: This Worker does not exist on your account.`),
          { response_status: 404 },
        ),
      },
    ],
  );
  assert.equal(missingScriptState.latest_active_deployment_id, null);
  assert.deepEqual(missingScriptState.deployment_ids, []);
  assert.deepEqual(missingScriptState.active_worker_version_ids, []);
  assert.deepEqual(missingScriptState.worker_version_ids, []);

  assert.throws(
    () => resolvePreDeployWorkerDeploymentState(
      scriptName,
      [
        {
          status: 'rejected',
          reason: Object.assign(
            new Error('Cloudflare API GET /workers/scripts/matrix-gateway-worker-pre-release/deployments failed: This Worker does not exist on your account.'),
            { response_status: 404 },
          ),
        },
        {
          status: 'rejected',
          reason: Object.assign(
            new Error(`Cloudflare API GET /workers/scripts/${scriptName}/versions failed: This Worker does not exist on your account.`),
            { response_status: 404 },
          ),
        },
      ],
    ),
    /matrix-gateway-worker-pre-release/,
  );

  assert.throws(
    () => resolvePreDeployWorkerDeploymentState(
      scriptName,
      [
        {
          status: 'rejected',
          reason: Object.assign(
            new Error(`Cloudflare API GET /workers/scripts/${scriptName}/deployments failed: Unauthorized`),
            { response_status: 403 },
          ),
        },
        {
          status: 'rejected',
          reason: Object.assign(
            new Error(`Cloudflare API GET /workers/scripts/${scriptName}/versions failed: This Worker does not exist on your account.`),
            { response_status: 404 },
          ),
        },
      ],
    ),
    /Unauthorized/,
  );

  assert.throws(
    () => resolvePreDeployWorkerDeploymentState(
      scriptName,
      [
        { status: 'fulfilled', value: { success: true, result: { deployments: [] } } },
        {
          status: 'rejected',
          reason: Object.assign(
            new Error(`Cloudflare API GET /workers/scripts/${scriptName}/versions failed: This Worker does not exist on your account.`),
            { response_status: 404 },
          ),
        },
      ],
    ),
    /partially fulfilled before bootstrap/,
  );
});

test('fetchWorkerDeploymentState only allows bootstrap fallback when both observation endpoints report a missing worker', async () => {
  const originalFetch = globalThis.fetch;
  const scriptName = 'matrix-gateway-worker-staging';

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: 'This Worker does not exist on your account.' }],
    }), {
      status: 404,
      headers: {
        'content-type': 'application/json',
      },
    });

    const missingScriptState = await fetchWorkerDeploymentState({
      accountId: 'cf-account',
      apiToken: 'cf-token',
      scriptName,
      allowMissingScript: true,
    });
    assert.equal(missingScriptState.latest_active_deployment_id, null);
    assert.deepEqual(missingScriptState.deployment_ids, []);
    assert.deepEqual(missingScriptState.active_worker_version_ids, []);
    assert.deepEqual(missingScriptState.worker_version_ids, []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/deployments')) {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'This Worker does not exist on your account.' }],
        }), {
          status: 404,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response(JSON.stringify({
        success: true,
        result: {
          items: [],
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    };

    await assert.rejects(
      () => fetchWorkerDeploymentState({
        accountId: 'cf-account',
        apiToken: 'cf-token',
        scriptName,
        allowMissingScript: true,
      }),
      /partially fulfilled before bootstrap/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('latest active Cloudflare deployment identity validation rejects stale or mixed deployment/version pairs', () => {
  const workerSummary = {
    deployment_id: 'dep-current',
    worker_version_id: 'ver-current',
    script_name: 'matrix-gateway-worker-staging',
  };
  const currentDeploymentState = {
    latest_active_deployment_id: 'dep-current',
    active_worker_version_ids: ['ver-current'],
  };

  assert.doesNotThrow(() => validateLatestActiveCloudflareWorkerIdentity(
    'gateway-worker',
    workerSummary,
    currentDeploymentState,
  ));

  assert.throws(
    () => validateLatestActiveCloudflareWorkerIdentity('gateway-worker', {
      ...workerSummary,
      deployment_id: 'dep-stale',
    }, currentDeploymentState),
    /deployment workers\.gateway-worker\.deployment_id is not the latest active Cloudflare deployment/,
  );

  assert.throws(
    () => validateLatestActiveCloudflareWorkerIdentity('gateway-worker', {
      ...workerSummary,
      worker_version_id: 'ver-old',
    }, currentDeploymentState),
    /deployment workers\.gateway-worker\.worker_version_id is not part of the latest active Cloudflare deployment/,
  );
});

test('non-local deployment readiness retries with fresh per-attempt registration identities', async () => {
  const remoteHarnessEnv = {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
  };
  const expectedPaths = [
    '/_matrix/client/versions',
    '/_matrix/client/v3/publicRooms?limit=1',
    '/_matrix/client/v3/register',
    '/_matrix/client/v3/register',
    '/_matrix/client/versions',
    '/_matrix/client/v3/publicRooms?limit=1',
    '/_matrix/client/v3/register',
    '/_matrix/client/v3/register',
    '/_matrix/client/v3/sync?timeout=0&set_presence=offline',
    '/_matrix/media/v3/create',
  ];
  const responses = [
    new Response(JSON.stringify({ versions: ['v1.17'] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ chunk: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ flows: [{ stages: ['m.login.dummy'] }], session: 'uia-1' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ errcode: 'M_UNKNOWN', error: 'transient deploy window' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ versions: ['v1.17'] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ chunk: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ flows: [{ stages: ['m.login.dummy'] }], session: 'uia-2' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ user_id: '@ready:example.test', access_token: 'atk.ready' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ next_batch: 's1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ content_uri: 'mxc://example.test/media' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  const delayCalls = [];
  const observedCredentials = [];
  let responseIndex = 0;

  const readiness = await waitForNonLocalDeploymentReadiness('ci-integration', remoteHarnessEnv, {
    maxAttempts: 2,
    initialDelayMs: 250,
    maxDelayMs: 250,
    sleepImpl: async (delayMs) => {
      delayCalls.push(delayMs);
    },
    fetchImpl: async (url, options = {}) => {
      const expectedPath = expectedPaths[responseIndex];
      assert.ok(expectedPath, `unexpected fetch #${responseIndex + 1}`);
      const requestUrl = new URL(String(url));
      assert.equal(`${requestUrl.pathname}${requestUrl.search}`, expectedPath);
      if (expectedPath === '/_matrix/client/v3/register') {
        assert.equal(options.method, 'POST');
        const body = JSON.parse(String(options.body));
        observedCredentials.push({
          step: body.auth == null ? 'register_challenge' : 'register_complete',
          username: body.username,
          password: body.password,
          deviceId: body.device_id,
        });
      }
      const response = responses[responseIndex];
      responseIndex += 1;
      return response;
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.attempt_count, 2);
  assert.equal(delayCalls.length, 1);
  assert.deepEqual(delayCalls, [250]);
  assert.equal(readiness.attempts[0].ok, false);
  assert.equal(readiness.attempts[0].failure.step_name, 'register_complete');
  assert.equal(readiness.attempts[1].ok, true);
  assert.equal(readiness.attempts[0].steps[2].step, 'register_challenge');
  assert.equal(readiness.attempts[1].steps[2].step, 'register_challenge');
  assert.deepEqual(
    observedCredentials.map(({ step }) => step),
    ['register_challenge', 'register_complete', 'register_challenge', 'register_complete'],
  );
  assert.equal(observedCredentials[0].username, observedCredentials[1].username);
  assert.equal(observedCredentials[0].password, observedCredentials[1].password);
  assert.equal(observedCredentials[0].deviceId, observedCredentials[1].deviceId);
  assert.equal(observedCredentials[2].username, observedCredentials[3].username);
  assert.equal(observedCredentials[2].password, observedCredentials[3].password);
  assert.equal(observedCredentials[2].deviceId, observedCredentials[3].deviceId);
  assert.notEqual(observedCredentials[0].username, observedCredentials[2].username);
  assert.notEqual(observedCredentials[0].password, observedCredentials[2].password);
  assert.notEqual(observedCredentials[0].deviceId, observedCredentials[2].deviceId);
});

test('non-local deployment readiness fails closed when representative HTTP paths stay unhealthy', async () => {
  const remoteHarnessEnv = {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
  };
  const delayCalls = [];

  const readiness = await waitForNonLocalDeploymentReadiness('ci-integration', remoteHarnessEnv, {
    maxAttempts: 1,
    sleepImpl: async (delayMs) => {
      delayCalls.push(delayMs);
    },
    fetchImpl: async (url) => {
      const requestUrl = new URL(String(url));
      assert.equal(`${requestUrl.pathname}${requestUrl.search}`, '/_matrix/client/versions');
      return new Response(JSON.stringify({
        errcode: 'M_UNKNOWN',
        error: 'gateway not ready',
      }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.attempt_count, 1);
  assert.equal(readiness.attempts[0].failure.step_name, 'versions');
  assert.match(readiness.last_error, /versions/);
  assert.deepEqual(delayCalls, []);
});

test('non-local deployment readiness refuses to probe staging without an Access session payload', async () => {
  await assert.rejects(
    () => waitForNonLocalDeploymentReadiness('staging', {
      MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
      MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
      MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
    }),
    /Remote staging harness must provide MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID/,
  );
});

test('non-local deployment readiness probes authenticated ops health when Access credentials are available', async () => {
  const requestLog = [];
  let registerRequestCount = 0;
  const readiness = await waitForNonLocalDeploymentReadiness('staging', {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: 'service-token-id.access',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET: 'service-token-secret',
  }, {
    maxAttempts: 1,
    fetchImpl: async (url, init = {}) => {
      const requestUrl = new URL(String(url));
      const headers = new Headers(init.headers ?? {});
      requestLog.push({
        url: requestUrl.toString(),
        pathname: requestUrl.pathname,
        host: requestUrl.host,
        method: init.method ?? 'GET',
        headers: {
          'cf-access-client-id': headers.get('cf-access-client-id'),
          'cf-access-client-secret': headers.get('cf-access-client-secret'),
          authorization: headers.get('authorization'),
        },
      });
      if (requestUrl.pathname === '/_matrix/client/versions') {
        return new Response(JSON.stringify({ versions: ['v1.17'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/publicRooms') {
        return new Response(JSON.stringify({ chunk: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/register') {
        registerRequestCount += 1;
        if (registerRequestCount === 1) {
          return new Response(JSON.stringify({
            session: 'readiness-session',
            flows: [{ stages: ['m.login.dummy'] }],
          }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          user_id: '@readiness:test',
          access_token: 'readiness-access-token',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/sync') {
        return new Response(JSON.stringify({ next_batch: 's123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/media/v3/create') {
        return new Response(JSON.stringify({ content_uri: 'mxc://matrix.example.test/readiness' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_ops/v1/healthz') {
        return new Response(JSON.stringify({ service: 'ops-worker', status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_ops/v1/rebuilds') {
        const body = JSON.parse(String(init.body));
        const idempotencyKey = String(headers.get('idempotency-key') ?? '');
        assert.equal(init.method, 'POST');
        assert.equal(body.rebuild_target, 'user_directory');
        assert.deepEqual(body.scope, {
          scope_kind: 'global',
          scope_id: null,
        });
        assert.equal(body.force_full_scan, false);
        assert.match(idempotencyKey, /^readiness-ops-staging-[a-f0-9]{24}$/);
        return new Response(JSON.stringify({
          job_id: 'rebuild_readiness_1',
          job_type: 'rebuild',
          state: 'accepted',
          idempotency_key_echo: idempotencyKey,
        }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected readiness probe URL ${requestUrl}`);
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.attempt_count, 1);
  assert.deepEqual(
    readiness.attempts[0].steps.map((step) => step.step),
    ['versions', 'public_rooms', 'register_challenge', 'register_complete', 'sync', 'media_create', 'ops_healthz', 'ops_rebuild_start'],
  );
  const opsRequest = requestLog.find((entry) => entry.pathname === '/_ops/v1/healthz');
  assert.ok(opsRequest);
  assert.equal(opsRequest.host, 'matrix-ops-worker-staging.matrixflare.workers.dev');
  assert.equal(opsRequest.headers['cf-access-client-id'], 'service-token-id.access');
  assert.equal(opsRequest.headers['cf-access-client-secret'], 'service-token-secret');
  const rebuildRequest = requestLog.find((entry) => entry.pathname === '/_ops/v1/rebuilds');
  assert.ok(rebuildRequest);
  assert.equal(rebuildRequest.host, 'matrix-ops-worker-staging.matrixflare.workers.dev');
  assert.equal(rebuildRequest.headers['cf-access-client-id'], 'service-token-id.access');
  assert.equal(rebuildRequest.headers['cf-access-client-secret'], 'service-token-secret');
});

test('non-local deployment readiness reuses the same ops rebuild idempotency key across retries', async () => {
  const observedCredentials = [];
  const rebuildIdempotencyKeys = [];
  let registerRequestCount = 0;
  let rebuildAttemptCount = 0;

  const readiness = await waitForNonLocalDeploymentReadiness('staging', {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: 'service-token-id.access',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET: 'service-token-secret',
  }, {
    maxAttempts: 2,
    initialDelayMs: 10,
    maxDelayMs: 10,
    sleepImpl: async () => {},
    fetchImpl: async (url, init = {}) => {
      const requestUrl = new URL(String(url));
      const headers = new Headers(init.headers ?? {});
      if (requestUrl.pathname === '/_matrix/client/versions') {
        return new Response(JSON.stringify({ versions: ['v1.17'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/publicRooms') {
        return new Response(JSON.stringify({ chunk: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/register') {
        registerRequestCount += 1;
        const body = JSON.parse(String(init.body));
        observedCredentials.push({
          username: body.username,
          password: body.password,
          deviceId: body.device_id,
          step: body.auth == null ? 'register_challenge' : 'register_complete',
        });
        if (registerRequestCount % 2 === 1) {
          return new Response(JSON.stringify({
            session: `readiness-session-${registerRequestCount}`,
            flows: [{ stages: ['m.login.dummy'] }],
          }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          user_id: `@readiness-${registerRequestCount}:test`,
          access_token: `readiness-access-token-${registerRequestCount}`,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/sync') {
        return new Response(JSON.stringify({ next_batch: 's123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/media/v3/create') {
        return new Response(JSON.stringify({ content_uri: 'mxc://matrix.example.test/readiness' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_ops/v1/healthz') {
        return new Response(JSON.stringify({ service: 'ops-worker', status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_ops/v1/rebuilds') {
        rebuildAttemptCount += 1;
        const idempotencyKey = String(headers.get('idempotency-key') ?? '');
        rebuildIdempotencyKeys.push(idempotencyKey);
        if (rebuildAttemptCount === 1) {
          return new Response(JSON.stringify({
            code: 'internal',
            message: 'transient deploy window',
            retryable: true,
          }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          job_id: 'rebuild_readiness_2',
          job_type: 'rebuild',
          state: 'accepted',
          idempotency_key_echo: idempotencyKey,
        }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected readiness probe URL ${requestUrl}`);
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.attempt_count, 2);
  assert.equal(readiness.attempts[0].ok, false);
  assert.equal(readiness.attempts[0].failure.step_name, 'ops_rebuild_start');
  assert.equal(readiness.attempts[1].ok, true);
  assert.deepEqual(
    observedCredentials.map(({ step }) => step),
    ['register_challenge', 'register_complete', 'register_challenge', 'register_complete'],
  );
  assert.notEqual(observedCredentials[0].username, observedCredentials[2].username);
  assert.notEqual(observedCredentials[0].password, observedCredentials[2].password);
  assert.notEqual(observedCredentials[0].deviceId, observedCredentials[2].deviceId);
  assert.equal(rebuildIdempotencyKeys.length, 2);
  assert.equal(rebuildIdempotencyKeys[0], rebuildIdempotencyKeys[1]);
  assert.match(rebuildIdempotencyKeys[0], /^readiness-ops-staging-[a-f0-9]{24}$/);
});

test('runEnvironmentBackedSuite does not spawn the suite when readiness fails', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-readiness-fail-'));
  const deploymentSummary = buildDeploymentSummaryFixture('ci-integration');
  let spawnCalls = 0;

  try {
    const result = await runEnvironmentBackedSuite('ci-integration', repoRoot, {
      runTimestamp: '20260401T163500Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/ci-integration',
      reviewedBy: 'gha://example/matrix/nonlocal/ci-integration',
      topologyKind: 'cloudflare-ci-integration',
      deploymentSummary,
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'ci-integration' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
        ready: true,
        reason: null,
        expanded_test_files: ['tests/integration/l1-mandatory.test.mjs'],
      }),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('ci-integration')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/integration/l1-mandatory.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('ci-integration', {
        ready: false,
        lastError: 'register_complete: {"status":500,"error":"transient deploy window"}',
      }),
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('suite must not spawn when readiness fails');
      },
    });

    assert.equal(spawnCalls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.validation_error, 'environment run report must have status "pass"');
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.error_message, 'Environment readiness probe failed: register_complete: {"status":500,"error":"transient deploy window"}');
    assert.equal(result.report.deployment_identity_validation.before_suite, null);
    assert.equal(result.report.readiness_probe.ready, false);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite revalidates deployment identity after readiness before spawning the suite', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-identity-'));
  const deploymentSummary = buildDeploymentSummaryFixture('ci-integration');
  let spawnCalls = 0;
  let validationCalls = 0;

  try {
    await assert.rejects(
      () => runEnvironmentBackedSuite('ci-integration', repoRoot, {
        runTimestamp: '20260401T163600Z',
        outputRoot,
        sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
        logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
        executedBy: 'gha://example/matrix/nonlocal/ci-integration',
        reviewedBy: 'gha://example/matrix/nonlocal/ci-integration',
        topologyKind: 'cloudflare-ci-integration',
        deploymentSummary,
      }, {
        requireGitHubActionsExecutionImpl: async () => ({ environment: 'ci-integration' }),
        assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
          ready: true,
          reason: null,
          expanded_test_files: ['tests/integration/l1-mandatory.test.mjs'],
        }),
        requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
        readWorkersSubdomainImpl: async () => 'matrixflare',
        validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => {
          validationCalls += 1;
          if (validationCalls === 1) {
            return buildDeploymentIdentityValidationFixture('ci-integration');
          }
          throw new Error('stale gateway deployment identity');
        },
        getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/integration/l1-mandatory.test.mjs')],
        waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('ci-integration'),
        spawnImpl: () => {
          spawnCalls += 1;
          throw new Error('suite must not spawn after stale deployment identity');
        },
      }),
      /stale gateway deployment identity/,
    );

    assert.equal(validationCalls, 2);
    assert.equal(spawnCalls, 0);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite refuses to run staging without a prepared Access session', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-missing-access-'));
  const deploymentSummary = buildDeploymentSummaryFixture('staging');

  try {
    await assert.rejects(
      () => runEnvironmentBackedSuite('staging', repoRoot, {
        runTimestamp: '20260402T163000Z',
        outputRoot,
        sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
        logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
        executedBy: 'gha://example/matrix/nonlocal/staging',
        reviewedBy: 'gha://example/matrix/nonlocal/staging',
        topologyKind: 'cloudflare-staging',
        deploymentSummary,
      }, {
        requireGitHubActionsExecutionImpl: async () => ({ environment: 'staging' }),
        assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
          ready: true,
          reason: null,
          expanded_test_files: ['tests/staging/test-der-001.test.mjs'],
        }),
        requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
        readWorkersSubdomainImpl: async () => 'matrixflare',
        validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
          buildDeploymentIdentityValidationFixture('staging')
        ),
        getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/staging/test-der-001.test.mjs')],
      }),
      /Remote staging harness must provide MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID/,
    );
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite injects the prepared Access session into the child test environment', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-access-session-'));
  const deploymentSummary = buildDeploymentSummaryFixture('staging');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
  };
  let capturedEnv = null;

  try {
    const result = await runEnvironmentBackedSuite('staging', repoRoot, {
      runTimestamp: '20260402T160000Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/staging',
      reviewedBy: 'gha://example/matrix/nonlocal/staging',
      topologyKind: 'cloudflare-staging',
      deploymentSummary,
      accessSession: {
        access: {
          service_token_client_id: 'service-token-id.access',
          service_token_client_secret: 'service-token-secret',
        },
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'staging' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
        ready: true,
        reason: null,
        expanded_test_files: ['tests/staging/test-der-001.test.mjs'],
      }),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('staging')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/staging/test-der-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('staging'),
      spawnImpl: (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        capturedEnv = options?.env ?? null;
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(result.report.status, 'pass');
    assert.equal(result.report.exit_code, 0);
    assert.ok(capturedEnv);
    assert.equal(capturedEnv.MATRIX_TEST_ENVIRONMENT, 'staging');
    assert.equal(capturedEnv.MATRIX_REMOTE_OPS_BASE_URL, 'https://matrix-ops-worker-staging.matrixflare.workers.dev');
    assert.equal(capturedEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID, 'service-token-id.access');
    assert.equal(capturedEnv.MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET, 'service-token-secret');
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite serializes pre-release node tests, validates rollout-scoped deployment identity before readiness and before suite, and captures the attested sidecar', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-rollout-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };
  let capturedEnv = null;
  let capturedArgs = null;
  const validatedGatewayDeploymentIds = [];

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260402T220000Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/pre-release',
      reviewedBy: 'gha://example/matrix/nonlocal/pre-release',
      topologyKind: 'cloudflare-pre-release',
      deploymentSummary,
      accessSession: {
        access: {
          service_token_client_id: 'service-token-id.access',
          service_token_client_secret: 'service-token-secret',
        },
      },
      rolloutState: {
        environment_name: 'pre-release',
        probe_run_id: 'rollout-probe-1',
        seed_prefix: 'seed-pre',
        baseline_gateway_version_id: 'gateway-baseline-v1',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        dual_version_deployment_id: 'dual-deployment-1',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
        ready: true,
        reason: null,
        expanded_test_files: ['tests/pre-release/test-ops-001.test.mjs'],
      }),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async (summary) => {
        validatedGatewayDeploymentIds.push(summary.workers['gateway-worker'].deployment_id);
        return buildDeploymentIdentityValidationFixture('pre-release');
      },
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-ops-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: (_command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        capturedArgs = args;
        capturedEnv = options?.env ?? null;
        queueMicrotask(async () => {
          await fs.writeFile(
            capturedEnv.MATRIX_TEST_RUN_ROLLOUT_SKEW_PROBE_PATH,
            JSON.stringify(buildRolloutSkewProbeFixture(), null, 2),
          );
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.ok(capturedEnv);
    assert.equal(capturedEnv.MATRIX_ROLLOUT_PROBE_RUN_ID, 'rollout-probe-1');
    assert.equal(capturedEnv.MATRIX_ROLLOUT_SEED_PREFIX, 'seed-pre');
    assert.equal(capturedEnv.MATRIX_ROLLOUT_BASELINE_GATEWAY_VERSION_ID, 'gateway-baseline-v1');
    assert.equal(capturedEnv.MATRIX_ROLLOUT_CANDIDATE_GATEWAY_VERSION_ID, 'gateway-candidate-v2');
    assert.equal(capturedEnv.MATRIX_ROLLOUT_DUAL_VERSION_DEPLOYMENT_ID, 'dual-deployment-1');
    assert.deepEqual(capturedArgs, [
      '--test',
      '--test-concurrency=1',
      path.join(repoRoot, 'tests/pre-release/test-ops-001.test.mjs'),
    ]);
    assert.deepEqual(validatedGatewayDeploymentIds, ['dual-deployment-1', 'dual-deployment-1']);
    assert.equal(result.ok, true);
    assert.equal(result.report.status, 'pass');
    assert.equal(result.report.exit_code, 0);
    assert.equal(result.report.rollout_skew_probe?.dual_version_deployment_id, 'dual-deployment-1');
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite fails closed when the rollout skew sidecar is malformed', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-rollout-malformed-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260402T220500Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/pre-release',
      reviewedBy: 'gha://example/matrix/nonlocal/pre-release',
      topologyKind: 'cloudflare-pre-release',
      deploymentSummary,
      accessSession: {
        access: {
          service_token_client_id: 'service-token-id.access',
          service_token_client_secret: 'service-token-secret',
        },
      },
      rolloutState: {
        environment_name: 'pre-release',
        probe_run_id: 'rollout-probe-2',
        seed_prefix: 'seed-pre',
        baseline_gateway_version_id: 'gateway-baseline-v1',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        dual_version_deployment_id: 'dual-deployment-2',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
        ready: true,
        reason: null,
        expanded_test_files: ['tests/pre-release/test-ops-001.test.mjs'],
      }),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-ops-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(async () => {
          await fs.writeFile(options.env.MATRIX_TEST_RUN_ROLLOUT_SKEW_PROBE_PATH, '{bad-json');
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.exit_code, 1);
    assert.match(result.report.error_message ?? '', /Suite artifact parsing failed/);
    const writtenLog = await fs.readFile(result.log_path, 'utf8');
    assert.match(writtenLog, /Suite artifact parsing failed/);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite fails closed when the rollout skew sidecar is semantically inconsistent with rollout state', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-rollout-mismatch-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260402T220700Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/pre-release',
      reviewedBy: 'gha://example/matrix/nonlocal/pre-release',
      topologyKind: 'cloudflare-pre-release',
      deploymentSummary,
      accessSession: {
        access: {
          service_token_client_id: 'service-token-id.access',
          service_token_client_secret: 'service-token-secret',
        },
      },
      rolloutState: {
        environment_name: 'pre-release',
        probe_run_id: 'rollout-probe-3',
        seed_prefix: 'seed-pre',
        baseline_gateway_version_id: 'gateway-baseline-v1',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        dual_version_deployment_id: 'dual-deployment-3',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => ({
        ready: true,
        reason: null,
        expanded_test_files: ['tests/pre-release/test-ops-001.test.mjs'],
      }),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-ops-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(async () => {
          await fs.writeFile(
            options.env.MATRIX_TEST_RUN_ROLLOUT_SKEW_PROBE_PATH,
            JSON.stringify(buildRolloutSkewProbeFixture({
              probe_run_id: 'forged-probe-id',
              dual_version_deployment_id: 'forged-deployment',
              observations: [],
            }), null, 2),
          );
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.exit_code, 1);
    assert.match(result.report.error_message ?? '', /Suite artifact parsing failed/);
    assert.match(result.report.error_message ?? '', /must match rollout state|must include new-worker-old-authority\/UserDO observation/);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('remote harness env vars must target an external HTTPS deployment and match the remote server host', () => {
  const validated = validateRemoteHarnessEnvironmentVariables({
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev/',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev/',
  });

  assert.deepEqual(validated, {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: '',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET: '',
  });

  assert.throws(() => validateRemoteHarnessEnvironmentVariables({
    MATRIX_REMOTE_BASE_URL: '',
    MATRIX_REMOTE_SERVER_NAME: '',
  }), /MATRIX_REMOTE_BASE_URL must be non-empty/);

  assert.throws(() => validateRemoteHarnessEnvironmentVariables({
    MATRIX_REMOTE_BASE_URL: 'http://localhost:8787',
    MATRIX_REMOTE_SERVER_NAME: 'localhost:8787',
  }), /MATRIX_REMOTE_BASE_URL must be an absolute https URL/);

  assert.throws(() => validateRemoteHarnessEnvironmentVariables({
    MATRIX_REMOTE_BASE_URL: 'https://[::ffff:127.0.0.1]',
    MATRIX_REMOTE_SERVER_NAME: '[::ffff:7f00:1]',
  }), /MATRIX_REMOTE_BASE_URL must not target a local or loopback host/);

  assert.throws(() => validateRemoteHarnessEnvironmentVariables({
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix.example.test',
  }), /MATRIX_REMOTE_SERVER_NAME must match the host of MATRIX_REMOTE_BASE_URL/);

  assert.throws(() => validateRemoteHarnessEnvironmentVariables({
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-staging.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: 'client-id-only',
  }), /MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID and MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET must be provided together/);
});

test('environment attestation provenance links GitHub run identity to immutable R2 objects and deployment identity', () => {
  const provenance = buildEnvironmentRunProvenance({
    environmentName: 'staging',
    githubRepository: 'example/matrix',
    githubRunId: '81234',
    githubRunAttempt: '2',
    deploymentSummary: {
      deployment_identity: {
        environment_id: 'staging',
        deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
        worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
      },
    },
    artifactUpload: {
      bucket_name: 'matrix-evidence-staging',
      object_uri: 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      object_key: 'gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    githubArtifact: {
      artifact_name: 'phase08-staging-run',
      artifact_url: 'https://github.com/example/matrix/actions/runs/81234/artifacts/99',
      artifact_digest: 'sha256:deadbeef',
    },
  });

  assert.equal(provenance.origin_system, 'github-actions');
  assert.equal(provenance.origin_run_uri, 'https://github.com/example/matrix/actions/runs/81234');
  assert.equal(provenance.artifact_store_uri, 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz');
  assert.equal(provenance.review_record_uri, 'https://github.com/example/matrix/actions/runs/81234');
  assert.deepEqual(provenance.deployment_identity.deployment_ids, ['dep-jobs', 'dep-ops', 'dep-gateway']);
  assert.equal(provenance.origin_artifact.artifact_name, 'phase08-staging-run');
});

test('environment provenance builder rejects run identity inputs that do not match verified OIDC claims', () => {
  assert.throws(() => buildEnvironmentRunProvenance({
    environmentName: 'staging',
    githubRepository: 'example/other-repo',
    githubRunId: '81234',
    githubRunAttempt: '2',
    oidcClaims: {
      repository: 'example/matrix',
      run_id: '81234',
      run_attempt: '2',
    },
    deploymentSummary: {
      deployment_identity: {
        environment_id: 'staging',
        deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
        worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
      },
    },
    artifactUpload: {
      bucket_name: 'matrix-evidence-staging',
      object_uri: 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      object_key: 'gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  }), /repository claim must match provenance repository/);

  assert.throws(() => buildEnvironmentRunProvenance({
    environmentName: 'staging',
    githubRepository: 'example/matrix',
    githubRunId: '99999',
    githubRunAttempt: '2',
    oidcClaims: {
      repository: 'example/matrix',
      run_id: '81234',
      run_attempt: '2',
    },
    deploymentSummary: {
      deployment_identity: {
        environment_id: 'staging',
        deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
        worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
      },
    },
    artifactUpload: {
      bucket_name: 'matrix-evidence-staging',
      object_uri: 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      object_key: 'gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  }), /run_id claim must match provenance run id/);
});

test('environment provenance builder rejects deployment identities that do not match the target environment', () => {
  assert.throws(() => buildEnvironmentRunProvenance({
    environmentName: 'staging',
    githubRepository: 'example/matrix',
    githubRunId: '81234',
    githubRunAttempt: '2',
    deploymentSummary: {
      deployment_identity: {
        environment_id: 'pre-release',
        deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
        worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
      },
    },
    artifactUpload: {
      bucket_name: 'matrix-evidence-staging',
      object_uri: 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      object_key: 'gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
      file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  }), /environment_id must equal staging/);
});

test('non-local provenance writing is blocked outside GitHub Actions', async () => {
  const originalEnvironment = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-provenance-'));
  const outputPath = path.join(tempRoot, 'provenance.json');

  delete process.env.GITHUB_ACTIONS;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
  try {
    await assert.rejects(
      () => writeEnvironmentRunProvenance(outputPath, {
        environmentName: 'staging',
        githubRepository: 'example/matrix',
        githubRunId: '81234',
        githubRunAttempt: '2',
        deploymentSummary: {
          deployment_identity: {
            environment_id: 'staging',
            deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
            worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
          },
        },
        artifactUpload: {
          bucket_name: 'matrix-evidence-staging',
          object_uri: 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
          object_key: 'gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
          file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      }),
      /GitHub Actions job identity is required/,
    );
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('non-local provenance writing rejects spoofed local GitHub Actions env without a valid GitHub-signed OIDC identity', async () => {
  const originalEnvironment = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-provenance-spoof-'));
  const outputPath = path.join(tempRoot, 'provenance.json');
  const fakeJwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'matrix-phase08-nonlocal',
      repository: 'example/matrix',
      run_id: '81234',
      run_attempt: '2',
      runner_environment: 'self-hosted',
      environment: 'staging',
      exp: Math.floor(Date.now() / 1000) + 300,
    })).toString('base64url'),
    Buffer.from('bogus-signature').toString('base64url'),
  ].join('.');
  const server = createServer((request, response) => {
    assert.match(request.url ?? '', /audience=matrix-phase08-nonlocal/);
    assert.equal(request.headers.authorization, 'Bearer fake-request-token');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: fakeJwt }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  process.env.GITHUB_ACTIONS = 'true';
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${port}/token`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'fake-request-token';
  process.env.GITHUB_REPOSITORY = 'example/matrix';
  process.env.GITHUB_RUN_ID = '81234';
  process.env.GITHUB_RUN_ATTEMPT = '2';

  try {
    await assert.rejects(
      () => writeEnvironmentRunProvenance(outputPath, {
        environmentName: 'staging',
        githubRepository: 'example/matrix',
        githubRunId: '81234',
        githubRunAttempt: '2',
        deploymentSummary: {
          deployment_identity: {
            environment_id: 'staging',
            deployment_ids: ['dep-jobs', 'dep-ops', 'dep-gateway'],
            worker_version_ids: ['ver-jobs', 'ver-ops', 'ver-gateway'],
          },
        },
        artifactUpload: {
          bucket_name: 'matrix-evidence-staging',
          object_uri: 'r2://matrix-evidence-staging/gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
          object_key: 'gha/81234/2/staging/20260331T140000Z/run-bundle.tgz',
          file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      }),
      /GitHub Actions OIDC token must include a key id/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost attestation writing requires the GitHub Actions prod environment claim', async () => {
  await assert.rejects(
    () => writeProdCostSnapshotAttestation({
      runTimestamp: '20260402T050000Z',
      payloadPath: '/tmp/unused-prod-cost-snapshot.json',
      outputPath: '/tmp/unused-prod-cost-attestation.json',
      provenance: {},
    }, {
      requireGitHubActionsExecutionImpl: async (operationName, {
        expectedEnvironmentName = null,
      } = {}) => {
        assert.equal(operationName, 'writeProdCostSnapshotAttestation');
        assert.equal(expectedEnvironmentName, 'prod');
        throw new Error('stop after verifying expected prod environment');
      },
    }),
    /stop after verifying expected prod environment/,
  );
});

test('nonlocal workflow keeps pre-release restore failures from generating or uploading attestations', async () => {
  const workflowPath = new URL('../../../.github/workflows/nonlocal-phase08.yml', import.meta.url);
  const workflow = await fs.readFile(workflowPath, 'utf8');

  const environmentGateStep = "      - name: Enforce pre-attestation environment gate\n";
  const attestStep = "      - name: Write environment attestation\n";
  const uploadStep = "      - name: Upload attestation artifact\n";
  const finalGateStep = "      - name: Enforce environment gate\n";

  const environmentGateIndex = workflow.indexOf(environmentGateStep);
  const attestIndex = workflow.indexOf(attestStep);
  const uploadIndex = workflow.indexOf(uploadStep);
  const finalGateIndex = workflow.indexOf(finalGateStep);

  assert.notEqual(environmentGateIndex, -1, 'workflow must define a pre-attestation environment gate');
  assert.notEqual(attestIndex, -1, 'workflow must define an attestation step');
  assert.notEqual(uploadIndex, -1, 'workflow must define an attestation upload step');
  assert.notEqual(finalGateIndex, -1, 'workflow must define the final environment gate');
  assert.ok(environmentGateIndex < attestIndex, 'pre-attestation environment gate must run before attestation generation');
  assert.ok(attestIndex < uploadIndex, 'attestation upload must remain downstream of attestation generation');
  assert.ok(uploadIndex < finalGateIndex, 'final gate must still verify attestation after upload gating');
  assert.match(
    workflow,
    /- name: Enforce pre-attestation environment gate[\s\S]*?\n\s+id: environment_gate\n\s+continue-on-error: true\n/s,
    'workflow must preserve a pre-attestation environment gate outcome for downstream gating',
  );
  assert.match(
    workflow,
    /- name: Write environment attestation[\s\S]*?\n\s+if: steps\.environment_gate\.outcome == 'success'\n/s,
    'attestation generation must require a successful pre-attestation environment gate',
  );
  assert.match(
    workflow,
    /- name: Upload attestation artifact[\s\S]*?\n\s+if: steps\.environment_gate\.outcome == 'success' && steps\.attest\.outcome == 'success'\n/s,
    'attestation upload must require both environment gate success and attestation success',
  );
  assert.match(
    workflow,
    /if \[ "\$\{\{ steps\.environment_gate\.outcome \}\}" != "success" \]; then\n\s+echo "Pre-attestation environment gate did not pass for \$\{\{ matrix\.environment \}\}" >&2\n\s+exit 1\n/s,
    'final gate must fail closed when the pre-attestation environment gate fails',
  );
  assert.match(
    workflow,
    /bundle_tmp="\$\{\{ steps\.paths\.outputs\.state_root \}\}\/run-bundle\.tgz"\n[\s\S]*?tar -czf "\$bundle_tmp"\s+\\\n[\s\S]*?mv "\$bundle_tmp" "\$\{\{ steps\.paths\.outputs\.artifact_root \}\}\/run-bundle\.tgz"/s,
    'workflow must build raw bundles outside the source directory before moving them into artifact storage',
  );
  assert.match(
    workflow,
    /if \[ ! -f "\$log_path" \]; then\n\s+if \[ "\$\{\{ steps\.suite\.outcome \}\}" = "success" \]; then\n\s+echo "Missing suite log for successful suite in \$\{\{ matrix\.environment \}\}" >&2\n\s+exit 1\n\s+fi\n\s+echo "Suite log missing because suite did not complete; skipping R2 log upload for \$\{\{ matrix\.environment \}\}" >&2\n\s+exit 0\n\s+fi/s,
    'workflow must only tolerate missing suite logs when the environment-backed suite did not complete',
  );
});

test('pre-release rollout start uses the in-module slug helper instead of an undefined filename sanitizer', async () => {
  const nonlocalModulePath = new URL('../../../packages/testing/src/nonlocal.mjs', import.meta.url);
  const source = await fs.readFile(nonlocalModulePath, 'utf8');

  assert.match(
    source,
    /const probeRunId = slugifyLabel\(`rollout-\$\{resolvedDeploymentId\}`\);\n\s+const seedPrefix = slugifyLabel\(`probe-\$\{resolvedDeploymentId\}`\)\.slice\(0, 48\);/,
    'rollout start must derive probe identifiers from the defined slugifyLabel helper',
  );
  assert.doesNotMatch(
    source,
    /sanitizeFileName\(/,
    'nonlocal rollout code must not reference an undefined filename sanitizer helper',
  );
});
