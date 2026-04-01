import assert from 'node:assert/strict';
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
  buildWorkerScriptName,
  createEnvironmentWranglerConfig,
  resolveFreshCloudflareIdentity,
  summarizeWorkerDeploymentState,
  validateLatestActiveCloudflareWorkerIdentity,
  validateRemoteHarnessEnvironmentVariables,
  writeEnvironmentRunProvenance,
} from '../../../packages/testing/src/nonlocal.mjs';

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
  assert.equal(
    JSON.parse(config.env['pre-release'].vars.RESOURCE_BINDING_NAMES_JSON).queues.RESTORE_SHARD_QUEUE,
    'matrix-restore-shard-job-pre-release',
  );
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
