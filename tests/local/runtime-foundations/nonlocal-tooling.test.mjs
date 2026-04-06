import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildProdCostSnapshotProvenance,
  buildProdInstallRecord,
  buildProdPromotionRecord,
  buildProductionCurrentStateSnapshot,
  buildProdRollbackRecord,
  buildPreReleaseRolloutVersionSpecs,
  buildProductionGatewayRolloutReadinessOptions,
  buildProductionWorkerPromotionReadinessOptions,
  buildEnvironmentRunProvenance,
  buildGitHubRunUrl,
  buildNonLocalEnvironmentPlan,
  buildNonProductionSecretBundle,
  buildProductionEnvironmentPlan,
  buildReleaseCandidateManifest,
  buildRemoteHarnessEnvironmentVariables,
  buildRemoteHarnessEnvironmentVariablesFromDeployment,
  buildWranglerDeployArguments,
  buildRuntimeWorkerVersionTag,
  buildWorkerScriptName,
  captureProdCostSnapshot,
  createEnvironmentWranglerConfig,
  fetchWorkerDeploymentState,
  normalizeProdCurrentStateSnapshot,
  observeProductionCurrentCloudflareState,
  observeProductionInstallTopologyState,
  resolveProductionBaselineInputArtifact,
  resolveClosedProdBillingWindow,
  resolveFreshCloudflareIdentity,
  resolvePreDeployWorkerDeploymentState,
  runEnvironmentBackedSuite,
  stageProductionRawStateArtifactForUpload,
  summarizeWorkerDeploymentState,
  uploadImmutableArtifactToR2,
  validateDeploymentSummaryAgainstCurrentCloudflareState,
  validateLatestActiveCloudflareWorkerIdentity,
  validateProductionCurrentStateFailureArtifacts,
  validateProdCurrentStateSnapshot,
  validateProdInstallRecord,
  validateProdPromotionRecord,
  validateProdRollbackRecord,
  validateReleaseCandidateManifest,
  validateRemoteHarnessEnvironmentVariables,
  waitForNonLocalDeploymentReadiness,
  waitForProductionDeploymentReadiness,
  writeProdCostSnapshotProvenance,
  writeProdCostSnapshotAttestation,
  writeEnvironmentWranglerConfig,
  writeEnvironmentRunProvenance,
} from '../../../packages/testing/src/nonlocal.mjs';
import {
  buildEnvironmentRateLimitNamespaceId,
} from '../../../packages/testing/src/cloudflare-resources.mjs';
import {
  validateManualArtifactPayload,
} from '../../../packages/testing/src/evidence.mjs';
import {
  CLIENT_DISCOVERY_VERSIONS,
  summarizeClientDiscoveryVersionPayload,
} from '../../../packages/testing/src/client-discovery.mjs';
import {
  GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS,
} from '../../../packages/runtime-core/src/abuse-guard.mjs';

const CLIENT_DISCOVERY_VERSION_STEP_DETAIL = Object.freeze(
  {
    ...summarizeClientDiscoveryVersionPayload({ versions: CLIENT_DISCOVERY_VERSIONS }),
    browser_compatible_cors: true,
  },
);
const DEFAULT_TEST_GIT_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function normalizeCloudflareResourceSnapshot(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, values]) => [key, [...values].sort()]),
  );
}

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
        worker_version_tag: 'mx-gw-d-gateway',
        script_name: plan.worker_scripts['gateway-worker'],
        url: plan.worker_urls['gateway-worker'],
      },
      'jobs-worker': {
        worker_name: 'jobs-worker',
        deployment_id: 'dep-jobs',
        worker_version_id: 'ver-jobs',
        worker_version_tag: 'mx-jw-d-jobs',
        script_name: plan.worker_scripts['jobs-worker'],
        url: plan.worker_urls['jobs-worker'],
      },
      'ops-worker': {
        worker_name: 'ops-worker',
        deployment_id: 'dep-ops',
        worker_version_id: 'ver-ops',
        worker_version_tag: 'mx-ow-d-ops',
        script_name: plan.worker_scripts['ops-worker'],
        url: plan.worker_urls['ops-worker'],
      },
    },
  };
}

function buildProductionProvisioningFixture() {
  const plan = buildProductionEnvironmentPlan({
    workersSubdomain: 'matrixflare',
  });
  return {
    environment_name: 'prod',
    account_id: 'cf-account',
    workers_subdomain: 'matrixflare',
    plan,
    access: {
      auth_domain: 'matrixflare.cloudflareaccess.com',
      application_id: 'cf-access-app-prod',
      application_audience: 'prod-aud',
      application_domain: 'matrix-ops-worker-prod.matrixflare.workers.dev',
      protected_ops_url: 'https://matrix-ops-worker-prod.matrixflare.workers.dev',
    },
    resources: {
      d1_database: {
        id: 'd1-prod',
        name: plan.d1_database_name,
      },
      kv_namespace: {
        id: 'kv-prod',
        title: plan.kv_namespace_title,
      },
    },
  };
}

function buildProductionDeploymentSummaryFixture() {
  const provisionedEnvironment = buildProductionProvisioningFixture();
  const { plan } = provisionedEnvironment;
  return {
    environment_name: 'prod',
    account_id: 'cf-account',
    workers_subdomain: 'matrixflare',
    cloudflare_resources: {
      ...plan.cloudflare_resources,
      r2_buckets: [...plan.cloudflare_resources.r2_buckets, plan.artifact_bucket_name].sort(),
    },
    access: {
      protected_ops_url: provisionedEnvironment.access.protected_ops_url,
    },
    deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v1', 'ops-prod-deployment-v1', 'gateway-prod-deployment-v1'],
      worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
    },
    workers: {
      'gateway-worker': {
        worker_name: 'gateway-worker',
        deployment_id: 'gateway-prod-deployment-v1',
        worker_version_id: 'gateway@prod-v1',
        worker_version_tag: 'mx-gw-d-prod1',
        script_name: plan.worker_scripts['gateway-worker'],
        url: plan.worker_urls['gateway-worker'],
      },
      'jobs-worker': {
        worker_name: 'jobs-worker',
        deployment_id: 'jobs-prod-deployment-v1',
        worker_version_id: 'jobs@prod-v1',
        worker_version_tag: 'mx-jw-d-prod1',
        script_name: plan.worker_scripts['jobs-worker'],
        url: plan.worker_urls['jobs-worker'],
      },
      'ops-worker': {
        worker_name: 'ops-worker',
        deployment_id: 'ops-prod-deployment-v1',
        worker_version_id: 'ops@prod-v1',
        worker_version_tag: 'mx-ow-d-prod1',
        script_name: plan.worker_scripts['ops-worker'],
        url: plan.worker_urls['ops-worker'],
      },
    },
  };
}

function buildProducerRunIdentityFixture({
  repository = 'VrianCao/MatrixFlare',
  runId = '912345',
  runAttempt = 1,
} = {}) {
  return {
    origin_repository: repository,
    origin_run_id: runId,
    origin_run_attempt: runAttempt,
    origin_run_uri: buildGitHubRunUrl(repository, runId),
  };
}

function buildEnvironmentAttestationFixture(environmentName, runTimestamp, {
  sourceRepository = 'VrianCao/MatrixFlare',
  sourceRunId = '81234',
  sourceRunAttempt = 1,
  sourceRunUri = null,
} = {}) {
  const resolvedSourceRunUri = sourceRunUri ?? buildGitHubRunUrl(sourceRepository, sourceRunId);
  const canonicalTestFile = environmentName === 'ci-integration'
    ? 'tests/integration/test-cs-001.test.mjs'
    : `tests/${environmentName}/test-cs-001.test.mjs`;
  const readinessSteps = [
    { step: 'versions', ok: true, detail: CLIENT_DISCOVERY_VERSION_STEP_DETAIL },
    { step: 'public_rooms', ok: true, detail: { chunk_length: 0 } },
    { step: 'register_challenge', ok: true, detail: { session_present: true, flows_count: 1 } },
    { step: 'register_complete', ok: true, detail: { user_id_present: true, access_token_present: true } },
    { step: 'sync', ok: true, detail: { next_batch_present: true } },
    { step: 'media_create', ok: true, detail: { content_uri_present: true } },
  ];
  if (environmentName !== 'ci-integration') {
    readinessSteps.push(
      { step: 'ops_healthz', ok: true, detail: { service: 'ops-worker', status: 'ok' } },
      { step: 'ops_rebuild_start', ok: true, detail: { job_id_present: true, job_type: 'rebuild', state: 'accepted' } },
    );
  }
  const artifactId = environmentName === 'ci-integration'
    ? 'ci_integration_run_report'
    : environmentName === 'staging'
      ? 'staging_run_report'
      : 'pre_release_run_report';
  return {
    schema_version: 1,
    artifact_id: artifactId,
    attestation_kind: 'environment_run',
    source_environment: environmentName,
    run_timestamp: runTimestamp,
    attested_at: '2026-03-31T14:06:00.000Z',
    provenance: {
      origin_system: 'github-actions',
      origin_repository: sourceRepository,
      origin_run_id: sourceRunId,
      origin_run_attempt: sourceRunAttempt,
      origin_run_uri: resolvedSourceRunUri,
      artifact_store_uri: `r2://matrix-evidence-${environmentName}/gha/${sourceRunId}/${sourceRunAttempt}/${environmentName}/${runTimestamp}/run-bundle.tgz`,
      artifact_store_key: `gha/${sourceRunId}/${sourceRunAttempt}/${environmentName}/${runTimestamp}/run-bundle.tgz`,
      artifact_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      review_record_uri: resolvedSourceRunUri,
      topology_kind: `cloudflare-${environmentName}`,
      deployment_identity: {
        environment_id: environmentName,
        deployment_ids: [`${environmentName}-deployment-001`],
        worker_version_ids: [`gateway@${environmentName}-v1`, `jobs@${environmentName}-v1`, `ops@${environmentName}-v1`],
      },
    },
    payload: {
      artifact_id: artifactId,
      environment_name: environmentName,
      source_environment: environmentName,
      run_timestamp: runTimestamp,
      status: 'pass',
      exit_code: 0,
      started_at: '2026-03-31T14:00:00.000Z',
      completed_at: '2026-03-31T14:05:00.000Z',
      duration_ms: 300000,
      command: `/usr/bin/node --test ${canonicalTestFile}`,
      test_directory: `tests/${environmentName === 'ci-integration' ? 'integration' : environmentName}`,
      test_file_count: 1,
      test_files: [canonicalTestFile],
      expanded_test_file_count: 1,
      expanded_test_files: [canonicalTestFile],
      output_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      error_message: null,
      log_artifact: `https://example.invalid/logs/${environmentName}/${runTimestamp}.txt`,
      executed_by: 'ci-runner',
      reviewed_by: 'release-reviewer',
      git_commit: DEFAULT_TEST_GIT_COMMIT,
      source_run_uri: resolvedSourceRunUri,
      topology_kind: `cloudflare-${environmentName}`,
      cloudflare_resources: environmentName === 'ci-integration'
        ? {
          ...buildNonLocalEnvironmentPlan('ci-integration', { workersSubdomain: 'matrixflare' }).cloudflare_resources,
          r2_buckets: [
            ...buildNonLocalEnvironmentPlan('ci-integration', { workersSubdomain: 'matrixflare' }).cloudflare_resources.r2_buckets,
            buildNonLocalEnvironmentPlan('ci-integration', { workersSubdomain: 'matrixflare' }).artifact_bucket_name,
          ].sort(),
        }
        : {
          ...buildNonLocalEnvironmentPlan(environmentName, { workersSubdomain: 'matrixflare' }).cloudflare_resources,
          r2_buckets: [
            ...buildNonLocalEnvironmentPlan(environmentName, { workersSubdomain: 'matrixflare' }).cloudflare_resources.r2_buckets,
            buildNonLocalEnvironmentPlan(environmentName, { workersSubdomain: 'matrixflare' }).artifact_bucket_name,
          ].sort(),
        },
      rollout_skew_probe: null,
      pre_release_cost_observation: null,
      readiness_probe: {
        ready: true,
        environment_name: environmentName,
        started_at: '2026-03-31T13:59:00.000Z',
        completed_at: '2026-03-31T13:59:30.000Z',
        duration_ms: 30000,
        attempt_count: 1,
        last_error: null,
        attempts: [
          {
            attempt: 1,
            started_at: '2026-03-31T13:59:00.000Z',
            completed_at: '2026-03-31T13:59:30.000Z',
            duration_ms: 30000,
            ok: true,
            steps: readinessSteps,
            failure: null,
            delay_before_next_attempt_ms: null,
          },
        ],
      },
      deployment_identity_validation: {
        before_readiness: {
          validated_at: '2026-03-31T13:58:30.000Z',
          workers: {},
        },
        before_suite: {
          validated_at: '2026-03-31T13:59:31.000Z',
          workers: {},
        },
      },
    },
  };
}

function buildProductionReadinessProbeFixture(overrides = {}) {
  return {
    environment_name: 'prod',
    ready: true,
    started_at: '2026-03-31T14:10:00.000Z',
    completed_at: '2026-03-31T14:10:30.000Z',
    duration_ms: 30000,
    attempt_count: 1,
    last_error: null,
    attempts: [
      {
        attempt: 1,
        started_at: '2026-03-31T14:10:00.000Z',
        completed_at: '2026-03-31T14:10:30.000Z',
        duration_ms: 30000,
        ok: true,
        steps: [
          { step: 'versions', ok: true, detail: CLIENT_DISCOVERY_VERSION_STEP_DETAIL },
          { step: 'public_rooms', ok: true, detail: { chunk_length: 0 } },
          { step: 'register_complete', ok: true, detail: { user_id_present: true, access_token_present: true } },
          { step: 'media_create', ok: true, detail: { content_uri_present: true } },
          { step: 'ops_healthz', ok: true, detail: { service: 'ops-worker', status: 'ok' } },
          { step: 'ops_rebuild_start', ok: true, detail: { job_id_present: true, job_type: 'rebuild', state: 'accepted' } },
        ],
        failure: null,
        delay_before_next_attempt_ms: null,
      },
    ],
    ...overrides,
  };
}

function buildDeploymentIdentityValidationFixture(environmentName, rolloutSkewProbe = null) {
  const plan = buildNonLocalEnvironmentPlan(environmentName, {
    workersSubdomain: 'matrixflare',
  });
  const gatewayDeploymentId = rolloutSkewProbe?.dual_version_deployment_id ?? 'dep-gateway';
  const gatewayWorkerVersionIds = rolloutSkewProbe == null
    ? ['ver-gateway']
    : [
      rolloutSkewProbe.baseline_gateway_version_id,
      rolloutSkewProbe.candidate_gateway_version_id,
    ];
  return {
    validated_at: '2026-04-01T16:00:00.000Z',
    cloudflare_resources: {
      ...plan.cloudflare_resources,
      r2_buckets: [...plan.cloudflare_resources.r2_buckets, plan.artifact_bucket_name].sort(),
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
        latest_active_deployment_id: gatewayDeploymentId,
        active_worker_version_ids: gatewayWorkerVersionIds,
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
    { step: 'versions', ok: true, detail: CLIENT_DISCOVERY_VERSION_STEP_DETAIL },
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
        { step: 'versions', ok: true, detail: CLIENT_DISCOVERY_VERSION_STEP_DETAIL },
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

function buildHarnessReadinessFixture(testFiles, overrides = {}) {
  const expandedTestFiles = new Set(testFiles);
  for (const file of testFiles) {
    const match = /^tests\/(integration|staging|pre-release)\//.exec(file);
    if (match) {
      expandedTestFiles.add(`tests/${match[1]}/support.mjs`);
    }
  }
  return {
    ready: true,
    reason: null,
    test_files: [...testFiles],
    expanded_test_files: [...expandedTestFiles].sort(),
    local_test_expansions: [],
    environment_boundary_escapes: [],
    generic_entrypoints: [],
    repo_boundary_escapes: [],
    unresolved_dynamic_imports: [],
    ...overrides,
  };
}

function buildRolloutSkewProbeFixture(overrides = {}) {
  const baselineGatewayVersionTag = 'mx-gw-d-baseline';
  const candidateGatewayVersionTag = 'mx-gw-d-candidate';
  return {
    environment_name: 'pre-release',
    probe_run_id: 'rollout-probe-1',
    dual_version_deployment_id: 'dual-deployment-1',
    baseline_gateway_version_id: 'gateway-baseline-v1',
    baseline_gateway_version_tag: baselineGatewayVersionTag,
    candidate_gateway_version_id: 'gateway-candidate-v2',
    candidate_gateway_version_tag: candidateGatewayVersionTag,
    override_strategy: 'cloudflare-version-overrides',
    observations: [
      {
        probe_name: 'new-worker-old-authority',
        request_gateway_version_id: 'gateway-candidate-v2',
        observed_gateway_version_id: 'gateway-candidate-v2',
        observed_gateway_version_tag: candidateGatewayVersionTag,
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
        observed_gateway_version_tag: candidateGatewayVersionTag,
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
        observed_gateway_version_tag: baselineGatewayVersionTag,
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
        observed_gateway_version_tag: baselineGatewayVersionTag,
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

function buildPreReleaseCostObservationFixture(overrides = {}) {
  return {
    observation_id: 'pre-release-cost-1',
    source_environment: 'pre-release',
    captured_at: '2026-04-03T06:00:00.000Z',
    capture_window: {
      start: '2026-04-03T00:00:00.000Z',
      end: '2026-04-03T06:00:00.000Z',
    },
    capture_method: 'cloudflare-official-metrics',
    source_query_uris: [
      'https://developers.cloudflare.com/workers/platform/pricing',
      'https://developers.cloudflare.com/durable-objects/platform/pricing',
      'https://api.cloudflare.com/client/v4/graphql#workersInvocationsAdaptive',
    ],
    topology_kind: 'cloudflare-pre-release',
    cloudflare_resources: buildDeploymentSummaryFixture('pre-release').cloudflare_resources,
    cost_surfaces: {
      workers: { total_cost_usd: 0.1 },
      durable_objects: { total_cost_usd: 0.2 },
      d1: { total_cost_usd: 0.3 },
      r2: { total_cost_usd: 0.4 },
      kv: { total_cost_usd: 0.5 },
      queues: { total_cost_usd: 0.6 },
    },
    model_comparison: {
      status: 'within_expected',
      summary: 'Official Cloudflare metrics matched the modeled bounded workload envelope.',
      actual_total_usd: 2.1,
      modeled_total_usd: 2.1,
      drift_ratio: 0,
    },
    ...overrides,
  };
}

function buildMinimalProdBillingUsageRecords({
  billingPeriodStart = '2026-02-16T00:00:00Z',
  chargePeriodEnd = '2026-03-15T00:00:00Z',
} = {}) {
  return [
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: billingPeriodStart,
      ChargePeriodStart: billingPeriodStart,
      ChargePeriodEnd: chargePeriodEnd,
      ConsumedQuantity: 1,
      ConsumedUnit: 'Month',
      ContractedCost: 5,
      PricingQuantity: 1,
      ServiceName: 'Workers Paid Plan',
    },
  ];
}

function buildResolvedProdBillingWindowFixture({
  resolutionMethod = 'cloudflare-account-billing-profile-next-bill-date',
  nextBillDate = '2026-04-15T12:21:59.345Z',
  fromDate = '2026-02-16',
  toDate = '2026-03-15',
} = {}) {
  return {
    resolution_method: resolutionMethod,
    next_bill_date: nextBillDate,
    from_date: fromDate,
    to_date: toDate,
  };
}

function buildProdInstallRecordFixture({
  installedAt = '2026-02-01T00:00:00.000Z',
  repository = 'VrianCao/MatrixFlare',
  runId = '24000789563',
  runAttempt = 1,
} = {}) {
  return buildProdInstallRecord({
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    provisionedEnvironment: buildProductionProvisioningFixture(),
    deploymentSummary: buildProductionDeploymentSummaryFixture(),
    originRunIdentity: buildProducerRunIdentityFixture({
      repository,
      runId,
      runAttempt,
    }),
    installId: 'install-prod-topology-v1',
    installedAt,
  });
}

function buildProdPromotionRecordFixture({
  repository = 'VrianCao/MatrixFlare',
  runId = '24033537033',
  runAttempt = 1,
  promotedAt = '2026-04-06T13:35:00.000Z',
} = {}) {
  const installRecord = buildProdInstallRecordFixture({
    repository,
  });
  return buildProdPromotionRecord({
    releaseCommitSha: '89abcdef0123456789abcdef0123456789abcdef',
    sourceCandidate: {
      candidate_id: 'candidate-phase08-prod-v2',
      source_run_uri: buildGitHubRunUrl(repository, '24033537030'),
    },
    originRunIdentity: buildProducerRunIdentityFixture({
      repository,
      runId,
      runAttempt,
    }),
    promotionMode: 'gradual',
    previousDeploymentIdentity: installRecord.deployment_identity,
    currentDeploymentIdentity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gatewayRolloutSteps: [
      { percentage: 10, deployment_id: 'gateway-prod-rollout-10', ready: true, attempt_count: 1, last_error: null },
      { percentage: 50, deployment_id: 'gateway-prod-rollout-50', ready: true, attempt_count: 1, last_error: null },
      { percentage: 100, deployment_id: 'gateway-prod-rollout-100', ready: true, attempt_count: 1, last_error: null },
    ],
    readinessChecks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
    },
    rollbackHandle: {
      workers_subdomain: installRecord.workers_subdomain,
      worker_versions: {
        'gateway-worker': {
          script_name: installRecord.workers['gateway-worker'].script_name,
          previous_deployment_id: installRecord.workers['gateway-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['gateway-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['gateway-worker'].worker_version_id}@100`],
        },
        'jobs-worker': {
          script_name: installRecord.workers['jobs-worker'].script_name,
          previous_deployment_id: installRecord.workers['jobs-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['jobs-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['jobs-worker'].worker_version_id}@100`],
        },
        'ops-worker': {
          script_name: installRecord.workers['ops-worker'].script_name,
          previous_deployment_id: installRecord.workers['ops-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['ops-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['ops-worker'].worker_version_id}@100`],
        },
      },
    },
    promotionId: 'promotion-prod-v2',
    promotedAt,
  });
}

function buildProdCurrentStateSnapshotFixture({
  repository = 'VrianCao/MatrixFlare',
  runId = '24033537026',
  runAttempt = 1,
} = {}) {
  const deploymentSummary = buildProductionDeploymentSummaryFixture();
  const currentObservation = {
    observed_at: '2026-04-06T13:25:12.818Z',
    environment_id: 'prod',
    current_deployment_identity: deploymentSummary.deployment_identity,
    problems: [],
    workers: Object.fromEntries(
      Object.entries(deploymentSummary.workers).map(([workerName, worker]) => [
        workerName,
        {
          worker_name: workerName,
          script_name: worker.script_name,
          latest_active_deployment_id: worker.deployment_id,
          deployment_ids: [worker.deployment_id],
          active_worker_version_ids: [worker.worker_version_id],
          worker_version_ids: [worker.worker_version_id],
          raw_cloudflare_api_results: {
            deployments: {
              deployments: [],
            },
            versions: {
              items: [
                {
                  id: worker.worker_version_id,
                  annotations: {
                    'workers/tag': worker.worker_version_tag,
                  },
                },
              ],
            },
          },
          error: null,
        },
      ]),
    ),
  };
  return buildProductionCurrentStateSnapshot({
    baselineRecord: buildProdInstallRecordFixture({
      repository,
    }),
    currentObservation,
    originRunIdentity: buildProducerRunIdentityFixture({
      repository,
      runId,
      runAttempt,
    }),
  });
}

function buildProdCurrentStateDispositionFixture({
  disposition = 'refreshed',
  observedAt = '2026-04-06T13:40:00.000Z',
  refreshError = disposition === 'refreshed' ? null : 'post-mutation refresh failed',
} = {}) {
  return {
    schema_version: 1,
    artifact_id: 'prod_current_state_disposition',
    observed_at: observedAt,
    current_state_path: 'current-production-state.json',
    disposition,
    pre_failure_snapshot_path: disposition === 'quarantined'
      ? 'pre-failure-current-production-state.json'
      : null,
    canonical_snapshot_removed: disposition === 'removed',
    refresh_error: refreshError,
  };
}

function buildProdCurrentStateObservationFixture({
  jobsDeploymentId = 'jobs-prod-deployment-v2',
  jobsWorkerVersionId = 'jobs@prod-v2',
} = {}) {
  return {
    observed_at: '2026-04-06T08:28:40.000Z',
    environment_id: 'prod',
    current_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: [jobsDeploymentId, 'ops-prod-deployment-v1', 'gateway-prod-deployment-v1'],
      worker_version_ids: [jobsWorkerVersionId, 'ops@prod-v1', 'gateway@prod-v1'],
    },
    problems: [],
    workers: {
      'jobs-worker': {
        worker_name: 'jobs-worker',
        script_name: 'matrix-jobs-worker-prod',
        latest_active_deployment_id: jobsDeploymentId,
        deployment_ids: [jobsDeploymentId, 'jobs-prod-deployment-v1'],
        active_worker_version_ids: [jobsWorkerVersionId],
        worker_version_ids: [jobsWorkerVersionId, 'jobs@prod-v1'],
        raw_cloudflare_api_results: {
          deployments: {
            deployments: [
              { id: jobsDeploymentId, versions: [{ version_id: jobsWorkerVersionId }] },
            ],
          },
          versions: {
            items: [
              { id: jobsWorkerVersionId, annotations: { workers_tag: 'mx-jw-d-prod2' } },
            ],
          },
        },
        error: null,
      },
      'ops-worker': {
        worker_name: 'ops-worker',
        script_name: 'matrix-ops-worker-prod',
        latest_active_deployment_id: 'ops-prod-deployment-v1',
        deployment_ids: ['ops-prod-deployment-v1'],
        active_worker_version_ids: ['ops@prod-v1'],
        worker_version_ids: ['ops@prod-v1'],
        raw_cloudflare_api_results: null,
        error: null,
      },
      'gateway-worker': {
        worker_name: 'gateway-worker',
        script_name: 'matrix-gateway-worker-prod',
        latest_active_deployment_id: 'gateway-prod-deployment-v1',
        deployment_ids: ['gateway-prod-deployment-v1'],
        active_worker_version_ids: ['gateway@prod-v1'],
        worker_version_ids: ['gateway@prod-v1'],
        raw_cloudflare_api_results: null,
        error: null,
      },
    },
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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

test('non-production secret bundle falls back to the main Cloudflare API token when the observability token is blank', () => {
  const bundle = buildNonProductionSecretBundle({
    environmentName: 'pre-release',
    accountId: 'cf-account-1',
    apiToken: 'cf-token-1',
    observabilityApiToken: '   ',
  });

  assert.equal(bundle.ops.CLOUDFLARE_OBSERVABILITY_API_TOKEN, 'cf-token-1');
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
  assert.equal(config.version_metadata, undefined);
  assert.deepEqual(config.env['pre-release'].version_metadata, {
    binding: 'CF_VERSION_METADATA',
  });
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
  assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
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
      assert.equal(written.config.version_metadata, undefined);
      assert.deepEqual(written.config.env.staging.version_metadata, {
        binding: 'CF_VERSION_METADATA',
      });
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

test('fresh Cloudflare identity resolution deduplicates repeated new observations before checking uniqueness', () => {
  assert.equal(
    resolveFreshCloudflareIdentity(['dep-old'], ['dep-new', 'dep-new', 'dep-old'], 'deployment id'),
    'dep-new',
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

test('fetchWorkerDeploymentState can retain raw Cloudflare payloads for blocker artifacts', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              {
                id: 'dep-current',
                versions: [
                  { version_id: 'ver-current' },
                ],
              },
            ],
          },
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response(JSON.stringify({
        success: true,
        result: {
          items: [
            { id: 'ver-current', annotations: { workers_tag: 'mx-gw-d-prod2' } },
            { id: 'ver-old', annotations: { workers_tag: 'mx-gw-d-prod1' } },
          ],
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    };

    const state = await fetchWorkerDeploymentState({
      accountId: 'cf-account',
      apiToken: 'cf-token',
      scriptName: 'matrix-gateway-worker-prod',
      includeRawPayload: true,
    });
    assert.equal(state.latest_active_deployment_id, 'dep-current');
    assert.deepEqual(state.active_worker_version_ids, ['ver-current']);
    assert.deepEqual(state.raw_payloads, {
      deployments: {
        deployments: [
          {
            id: 'dep-current',
            versions: [
              { version_id: 'ver-current' },
            ],
          },
        ],
      },
      versions: {
        items: [
          { id: 'ver-current', annotations: { workers_tag: 'mx-gw-d-prod2' } },
          { id: 'ver-old', annotations: { workers_tag: 'mx-gw-d-prod1' } },
        ],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchWorkerDeploymentState preserves successful raw Cloudflare payloads when the sibling endpoint fails', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              {
                id: 'dep-current',
                versions: [
                  { version_id: 'ver-current' },
                ],
              },
            ],
          },
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response(JSON.stringify({
        success: false,
        errors: [
          { message: 'versions API temporarily unavailable' },
        ],
      }), {
        status: 500,
        headers: {
          'content-type': 'application/json',
        },
      });
    };

    await assert.rejects(
      () => fetchWorkerDeploymentState({
        accountId: 'cf-account',
        apiToken: 'cf-token',
        scriptName: 'matrix-gateway-worker-prod',
        includeRawPayload: true,
      }),
      (error) => {
        assert.match(error.message, /versions API temporarily unavailable/u);
        assert.deepEqual(error.partial_raw_payloads, {
          deployments: {
            deployments: [
              {
                id: 'dep-current',
                versions: [
                  { version_id: 'ver-current' },
                ],
              },
            ],
          },
          versions: null,
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('observeProductionCurrentCloudflareState retains partial raw backreads on mixed-success worker failures', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.includes('/workers/scripts/matrix-jobs-worker-prod/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              { id: 'jobs-prod-deployment-v1', versions: [{ version_id: 'jobs@prod-v1' }] },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-jobs-worker-prod/versions')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            items: [
              { id: 'jobs@prod-v1', annotations: { workers_tag: 'mx-jw-d-prod1' } },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-ops-worker-prod/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              { id: 'ops-prod-deployment-v2', versions: [{ version_id: 'ops@prod-v2' }] },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-ops-worker-prod/versions')) {
        return new Response(JSON.stringify({
          success: false,
          errors: [
            { message: 'versions API temporarily unavailable' },
          ],
        }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-gateway-worker-prod/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              { id: 'gateway-prod-deployment-v1', versions: [{ version_id: 'gateway@prod-v1' }] },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-gateway-worker-prod/versions')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            items: [
              { id: 'gateway@prod-v1', annotations: { workers_tag: 'mx-gw-d-prod1' } },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected Cloudflare API request in test: ${pathname}`);
    };

    const baselineRecord = buildProdInstallRecord({
      releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      provisionedEnvironment: buildProductionProvisioningFixture(),
      deploymentSummary: buildProductionDeploymentSummaryFixture(),
      originRunIdentity: buildProducerRunIdentityFixture(),
      installId: 'install-prod-topology-v1',
      installedAt: '2026-04-05T04:55:43.000Z',
    });

    const observation = await observeProductionCurrentCloudflareState(baselineRecord, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
    });

    assert.equal(observation.current_deployment_identity, null);
    assert.match(observation.problems[0], /matrix-ops-worker-prod/u);
    assert.equal(observation.workers['ops-worker'].latest_active_deployment_id, 'ops-prod-deployment-v2');
    assert.deepEqual(observation.workers['ops-worker'].deployment_ids, ['ops-prod-deployment-v2']);
    assert.deepEqual(observation.workers['ops-worker'].active_worker_version_ids, ['ops@prod-v2']);
    assert.deepEqual(observation.workers['ops-worker'].worker_version_ids, []);
    assert.deepEqual(observation.workers['ops-worker'].raw_cloudflare_api_results, {
      deployments: {
        deployments: [
          { id: 'ops-prod-deployment-v2', versions: [{ version_id: 'ops@prod-v2' }] },
        ],
      },
      versions: null,
    });
    assert.match(
      observation.workers['ops-worker'].error.message,
      /versions API temporarily unavailable/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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
        active_worker_version_ids: [`ver-${workerAlias}`],
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
  assert.deepEqual(validation.workers['gateway-worker'].active_worker_version_ids, ['ver-gateway']);
  assert.deepEqual(
    validation.workers['gateway-worker'].ratelimit_namespace_ids,
    deploymentSummary.cloudflare_resources.ratelimit_namespaces,
  );
  assert.deepEqual(
    validation.cloudflare_resources,
    normalizeCloudflareResourceSnapshot(deploymentSummary.cloudflare_resources),
  );
  assert.match(validation.validated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('deployment summary Cloudflare revalidation rejects unexpected extra active worker versions outside rollout validation', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');

  await assert.rejects(
    () => validateDeploymentSummaryAgainstCurrentCloudflareState(deploymentSummary, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
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
    }),
    /active_worker_version_ids must exactly match the latest active Cloudflare deployment/,
  );
});

test('deployment summary Cloudflare revalidation allows the pre-release rollout gateway to expose exactly the baseline and candidate versions', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  const rolloutScopedSummary = structuredClone(deploymentSummary);
  rolloutScopedSummary.workers['gateway-worker'] = {
    ...rolloutScopedSummary.workers['gateway-worker'],
    deployment_id: 'dual-deployment-1',
    expected_active_worker_version_ids: ['gateway-candidate-v2', 'gateway-baseline-v1'],
  };

  const validation = await validateDeploymentSummaryAgainstCurrentCloudflareState(rolloutScopedSummary, {
    accountId: 'cf-account',
    apiToken: 'cf-token',
    fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
      const workerAlias = scriptName.split('-')[1];
      if (scriptName === rolloutScopedSummary.workers['gateway-worker'].script_name) {
        return {
          latest_active_deployment_id: 'dual-deployment-1',
          active_worker_version_ids: ['gateway-baseline-v1', 'gateway-candidate-v2'],
        };
      }
      return {
        latest_active_deployment_id: `dep-${workerAlias}`,
        active_worker_version_ids: [`ver-${workerAlias}`],
      };
    },
    fetchWorkerBindingStateImpl: async ({ scriptName }) => ({
      ratelimit_namespace_ids: scriptName === rolloutScopedSummary.workers['gateway-worker'].script_name
        ? rolloutScopedSummary.cloudflare_resources.ratelimit_namespaces
        : [],
    }),
  });

  assert.deepEqual(
    validation.workers['gateway-worker'].active_worker_version_ids,
    ['gateway-baseline-v1', 'gateway-candidate-v2'],
  );
});

test('deployment summary Cloudflare revalidation rejects duplicate active worker version ids during pre-release rollout validation', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  const rolloutScopedSummary = structuredClone(deploymentSummary);
  rolloutScopedSummary.workers['gateway-worker'] = {
    ...rolloutScopedSummary.workers['gateway-worker'],
    deployment_id: 'dual-deployment-1',
    expected_active_worker_version_ids: ['gateway-candidate-v2', 'gateway-baseline-v1'],
  };

  await assert.rejects(
    () => validateDeploymentSummaryAgainstCurrentCloudflareState(rolloutScopedSummary, {
      accountId: 'cf-account',
      apiToken: 'cf-token',
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => {
        const workerAlias = scriptName.split('-')[1];
        if (scriptName === rolloutScopedSummary.workers['gateway-worker'].script_name) {
          return {
            latest_active_deployment_id: 'dual-deployment-1',
            active_worker_version_ids: ['gateway-baseline-v1', 'gateway-candidate-v2', 'gateway-candidate-v2'],
          };
        }
        return {
          latest_active_deployment_id: `dep-${workerAlias}`,
          active_worker_version_ids: [`ver-${workerAlias}`],
        };
      },
      fetchWorkerBindingStateImpl: async ({ scriptName }) => ({
        ratelimit_namespace_ids: scriptName === rolloutScopedSummary.workers['gateway-worker'].script_name
          ? rolloutScopedSummary.cloudflare_resources.ratelimit_namespaces
          : [],
      }),
    }),
    /must not expose duplicate active_worker_version_ids/,
  );
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

test('deployment summary Cloudflare revalidation rejects resource snapshots that drift from the fixed environment topology', async () => {
  const deploymentSummary = buildDeploymentSummaryFixture('staging');
  deploymentSummary.cloudflare_resources = {
    ...deploymentSummary.cloudflare_resources,
    queues: [
      ...deploymentSummary.cloudflare_resources.queues,
      'matrix-unexpected-queue-staging',
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
    /cloudflare_resources\.queues must match the fixed environment topology/,
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
    /deployment workers\.gateway-worker\.active_worker_version_ids must exactly match the latest active Cloudflare deployment/,
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
    new Response(JSON.stringify({ versions: [...CLIENT_DISCOVERY_VERSIONS] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://app.element.io',
        vary: 'Origin',
      },
    }),
    new Response(JSON.stringify({ chunk: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ flows: [{ stages: ['m.login.dummy'] }], session: 'uia-1' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ errcode: 'M_UNKNOWN', error: 'transient deploy window' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ versions: [...CLIENT_DISCOVERY_VERSIONS] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://app.element.io',
        vary: 'Origin',
      },
    }),
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

test('non-local deployment readiness fails closed when /versions lacks the browser-compatible ladder', async () => {
  const remoteHarnessEnv = {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
  };

  const readiness = await waitForNonLocalDeploymentReadiness('ci-integration', remoteHarnessEnv, {
    maxAttempts: 1,
    fetchImpl: async (url) => {
      const requestUrl = new URL(String(url));
      assert.equal(`${requestUrl.pathname}${requestUrl.search}`, '/_matrix/client/versions');
      return new Response(JSON.stringify({
        versions: ['v1.17'],
        unstable_features: {},
      }), {
        status: 200,
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
});

test('non-local deployment readiness fails closed when /versions lacks browser CORS headers', async () => {
  const remoteHarnessEnv = {
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-ci-integration.matrixflare.workers.dev',
  };

  const readiness = await waitForNonLocalDeploymentReadiness('ci-integration', remoteHarnessEnv, {
    maxAttempts: 1,
    fetchImpl: async (url) => {
      const requestUrl = new URL(String(url));
      assert.equal(`${requestUrl.pathname}${requestUrl.search}`, '/_matrix/client/versions');
      assert.equal(requestUrl.search, '');
      return new Response(JSON.stringify({
        versions: CLIENT_DISCOVERY_VERSIONS,
        unstable_features: {},
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    },
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.attempt_count, 1);
  assert.equal(readiness.attempts[0].failure.step_name, 'versions');
  assert.deepEqual(readiness.attempts[0].failure.detail, {
    status: 200,
    versions_count: CLIENT_DISCOVERY_VERSIONS.length,
    browser_compatible_version_ladder: true,
    browser_compatible_cors: false,
  });
});

test('production readiness can defer the browser-compatible version ladder until gateway rollout', async () => {
  const requestLog = [];
  const readiness = await waitForProductionDeploymentReadiness({
    MATRIX_REMOTE_BASE_URL: 'https://matrix-gateway-worker-prod.matrixflare.workers.dev',
    MATRIX_REMOTE_SERVER_NAME: 'matrix-gateway-worker-prod.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_BASE_URL: 'https://matrix-ops-worker-prod.matrixflare.workers.dev',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID: 'service-token-id.access',
    MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET: 'service-token-secret',
  }, {
    maxAttempts: 1,
    requireBrowserCompatibleVersionLadder: false,
    fetchImpl: async (url, init = {}) => {
      const requestUrl = new URL(String(url));
      requestLog.push({
        pathname: requestUrl.pathname,
        search: requestUrl.search,
        headers: new Headers(init.headers),
      });
      if (requestUrl.pathname === '/_matrix/client/versions') {
        return new Response(JSON.stringify({
          versions: ['v1.17'],
          unstable_features: {},
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': 'https://app.element.io',
            vary: 'Origin',
          },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/publicRooms') {
        return new Response(JSON.stringify({ chunk: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/register') {
        const body = JSON.parse(init.body);
        if (body.auth == null) {
          return new Response(JSON.stringify({
            session: 'session-1',
            flows: [{ stages: ['m.login.dummy'] }],
          }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          user_id: '@probe:matrixflare.test',
          access_token: 'probe-access-token',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/client/v3/sync') {
        return new Response(JSON.stringify({ next_batch: 'batch-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.pathname === '/_matrix/media/v3/create') {
        return new Response(JSON.stringify({ content_uri: 'mxc://matrixflare.test/media' }), {
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
        const idempotencyKey = new Headers(init.headers).get('Idempotency-Key');
        return new Response(JSON.stringify({
          job_id: 'job-1',
          job_type: 'rebuild',
          state: 'accepted',
          idempotency_key_echo: idempotencyKey,
        }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request ${requestUrl.pathname}${requestUrl.search}`);
    },
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.attempts[0].steps[0].step, 'versions');
  assert.deepEqual(readiness.attempts[0].steps[0].detail, {
    versions_count: 1,
    browser_compatible_version_ladder: false,
    browser_compatible_cors: true,
  });
  assert.equal(requestLog[0].headers.get('origin'), 'https://app.element.io');
});

test('production worker promotion readiness only requires the browser-compatible ladder for gateway-worker', () => {
  assert.deepEqual(buildProductionWorkerPromotionReadinessOptions('jobs-worker'), {
    requireBrowserCompatibleVersionLadder: false,
  });
  assert.deepEqual(buildProductionWorkerPromotionReadinessOptions('ops-worker'), {
    requireBrowserCompatibleVersionLadder: false,
  });
  assert.deepEqual(buildProductionWorkerPromotionReadinessOptions('gateway-worker'), {
    requireBrowserCompatibleVersionLadder: true,
  });
});

test('production gateway rollout readiness only requires the browser-compatible ladder at 100 percent', () => {
  assert.deepEqual(buildProductionGatewayRolloutReadinessOptions(10), {
    requireBrowserCompatibleVersionLadder: false,
  });
  assert.deepEqual(buildProductionGatewayRolloutReadinessOptions(50), {
    requireBrowserCompatibleVersionLadder: false,
  });
  assert.deepEqual(buildProductionGatewayRolloutReadinessOptions(100), {
    requireBrowserCompatibleVersionLadder: true,
  });
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
        assert.equal(headers.get('origin'), 'https://app.element.io');
        return new Response(JSON.stringify({ versions: [...CLIENT_DISCOVERY_VERSIONS] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': 'https://app.element.io',
            vary: 'Origin',
          },
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
        assert.equal(headers.get('origin'), 'https://app.element.io');
        return new Response(JSON.stringify({ versions: [...CLIENT_DISCOVERY_VERSIONS] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': 'https://app.element.io',
            vary: 'Origin',
          },
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
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/integration/l1-mandatory.test.mjs',
      ]),
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

test('runEnvironmentBackedSuite passes release-gate file selection into harness assessment', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-release-gate-assess-'));
  const deploymentSummary = buildDeploymentSummaryFixture('ci-integration');
  let readinessSelectorCalls = 0;

  try {
    const result = await runEnvironmentBackedSuite('ci-integration', repoRoot, {
      runTimestamp: '20260404T162500Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/ci-integration',
      reviewedBy: 'gha://example/matrix/nonlocal/ci-integration',
      topologyKind: 'cloudflare-ci-integration',
      deploymentSummary,
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'ci-integration' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async (environmentName, root, options = {}) => {
        assert.equal(environmentName, 'ci-integration');
        assert.equal(root, repoRoot);
        assert.equal(typeof options.getRequiredTestFilesImpl, 'function');
        const files = await options.getRequiredTestFilesImpl(environmentName, root);
        readinessSelectorCalls += 1;
        assert.deepEqual(files, [path.join(repoRoot, 'tests/integration/test-cs-001.test.mjs')]);
        return buildHarnessReadinessFixture([
          'tests/integration/test-cs-001.test.mjs',
        ]);
      },
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('ci-integration')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/integration/test-cs-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('ci-integration'),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(readinessSelectorCalls, 1);
    assert.equal(result.ok, true);
    assert.deepEqual(result.report.expanded_test_files, [
      'tests/integration/support.mjs',
      'tests/integration/test-cs-001.test.mjs',
    ]);
    assert.equal(result.report.expanded_test_file_count, 2);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite keeps report test_files aligned with the readiness-selected release-gate slice', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-selector-alignment-'));
  const deploymentSummary = buildDeploymentSummaryFixture('ci-integration');
  let selectorCallCount = 0;
  let spawnedArgs = null;

  try {
    const result = await runEnvironmentBackedSuite('ci-integration', repoRoot, {
      runTimestamp: '20260404T162600Z',
      outputRoot,
      sourceRunUri: 'https://github.com/example/matrix/actions/runs/12345',
      logArtifact: 'https://github.com/example/matrix/actions/runs/12345/artifacts/1',
      executedBy: 'gha://example/matrix/nonlocal/ci-integration',
      reviewedBy: 'gha://example/matrix/nonlocal/ci-integration',
      topologyKind: 'cloudflare-ci-integration',
      deploymentSummary,
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'ci-integration' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async (environmentName, root, options = {}) => {
        const selectedFiles = await options.getRequiredTestFilesImpl(environmentName, root);
        assert.deepEqual(selectedFiles, [path.join(repoRoot, 'tests/integration/test-cs-001.test.mjs')]);
        return buildHarnessReadinessFixture(['tests/integration/test-cs-001.test.mjs']);
      },
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('ci-integration')
      ),
      getRequiredTestFilesImpl: async () => {
        selectorCallCount += 1;
        return selectorCallCount === 1
          ? [path.join(repoRoot, 'tests/integration/test-cs-001.test.mjs')]
          : [path.join(repoRoot, 'tests/integration/test-cs-004.test.mjs')];
      },
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('ci-integration'),
      spawnImpl: (_command, args) => {
        spawnedArgs = args;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(selectorCallCount, 1);
    assert.deepEqual(spawnedArgs, [
      '--test',
      '--test-concurrency=1',
      path.join(repoRoot, 'tests/integration/test-cs-001.test.mjs'),
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.report.test_files, ['tests/integration/test-cs-001.test.mjs']);
    assert.deepEqual(result.report.expanded_test_files, [
      'tests/integration/support.mjs',
      'tests/integration/test-cs-001.test.mjs',
    ]);
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
        assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
          'tests/integration/l1-mandatory.test.mjs',
        ]),
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
        assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
          'tests/staging/test-der-001.test.mjs',
        ]),
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
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/staging/test-der-001.test.mjs',
      ]),
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
        baseline_gateway_version_tag: 'mx-gw-d-baseline',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        candidate_gateway_version_tag: 'mx-gw-d-candidate',
        dual_version_deployment_id: 'dual-deployment-1',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-ops-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async (summary) => {
        validatedGatewayDeploymentIds.push(summary.workers['gateway-worker'].deployment_id);
        return buildDeploymentIdentityValidationFixture('pre-release', buildRolloutSkewProbeFixture());
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
    assert.equal(capturedEnv.MATRIX_ROLLOUT_BASELINE_GATEWAY_VERSION_TAG, 'mx-gw-d-baseline');
    assert.equal(capturedEnv.MATRIX_ROLLOUT_CANDIDATE_GATEWAY_VERSION_ID, 'gateway-candidate-v2');
    assert.equal(capturedEnv.MATRIX_ROLLOUT_CANDIDATE_GATEWAY_VERSION_TAG, 'mx-gw-d-candidate');
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
        baseline_gateway_version_tag: 'mx-gw-d-baseline',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        candidate_gateway_version_tag: 'mx-gw-d-candidate',
        dual_version_deployment_id: 'dual-deployment-2',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-ops-001.test.mjs',
      ]),
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
        baseline_gateway_version_tag: 'mx-gw-d-baseline',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        candidate_gateway_version_tag: 'mx-gw-d-candidate',
        dual_version_deployment_id: 'dual-deployment-3',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-ops-001.test.mjs',
      ]),
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

test('runEnvironmentBackedSuite fails closed when TEST-OPS-001 is covered without rolloutState', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-rollout-missing-state-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    await assert.rejects(
      () => runEnvironmentBackedSuite('pre-release', repoRoot, {
        runTimestamp: '20260403T055900Z',
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
      }, {
        requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
        assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
          'tests/pre-release/test-ops-001.test.mjs',
        ]),
        requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
        readWorkersSubdomainImpl: async () => 'matrixflare',
        validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
          buildDeploymentIdentityValidationFixture('pre-release')
        ),
        getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-ops-001.test.mjs')],
        waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      }),
      /requires rolloutState/,
    );
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite clears stale rollout skew sidecars before rerunning the suite', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-rollout-stale-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    await fs.writeFile(
      path.join(outputRoot, 'rollout-skew-probe.json'),
      JSON.stringify(buildRolloutSkewProbeFixture(), null, 2),
    );
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260403T060000Z',
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
        probe_run_id: 'rollout-probe-stale',
        seed_prefix: 'seed-pre',
        baseline_gateway_version_id: 'gateway-baseline-v1',
        baseline_gateway_version_tag: 'mx-gw-d-baseline',
        candidate_gateway_version_id: 'gateway-candidate-v2',
        candidate_gateway_version_tag: 'mx-gw-d-candidate',
        dual_version_deployment_id: 'dual-deployment-stale',
      },
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-ops-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-ops-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.exit_code, 1);
    assert.match(result.report.error_message ?? '', /rollout_skew_probe sidecar is required/);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite captures a normalized pre-release cost observation sidecar when TEST-COST-001 is covered', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-cost-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };
  let capturedEnv = null;

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260403T060000Z',
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
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-cost-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-cost-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        capturedEnv = options?.env ?? null;
        queueMicrotask(async () => {
          await fs.writeFile(
            options.env.MATRIX_TEST_RUN_PRE_RELEASE_COST_OBSERVATION_PATH,
            JSON.stringify(buildPreReleaseCostObservationFixture(), null, 2),
          );
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.ok(capturedEnv);
    assert.equal(typeof capturedEnv.MATRIX_TEST_RUN_PRE_RELEASE_COST_OBSERVATION_PATH, 'string');
    assert.ok(capturedEnv.MATRIX_TEST_RUN_PRE_RELEASE_COST_OBSERVATION_PATH.length > 0);
    assert.equal(result.ok, true);
    assert.equal(result.report.status, 'pass');
    assert.equal(result.report.exit_code, 0);
    assert.equal(result.report.pre_release_cost_observation?.observation_id, 'pre-release-cost-1');
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite fails closed when the pre-release cost observation sidecar is malformed', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-cost-malformed-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260403T060100Z',
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
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-cost-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-cost-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(async () => {
          await fs.writeFile(options.env.MATRIX_TEST_RUN_PRE_RELEASE_COST_OBSERVATION_PATH, '{bad-json');
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
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite fails closed when the pre-release cost observation locator is not an official Cloudflare surface', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-cost-unofficial-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260403T060150Z',
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
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-cost-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-cost-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(async () => {
          await fs.writeFile(
            options.env.MATRIX_TEST_RUN_PRE_RELEASE_COST_OBSERVATION_PATH,
            JSON.stringify(buildPreReleaseCostObservationFixture({
              source_query_uris: ['https://example.invalid/cloudflare/pre-release/cost'],
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
    assert.match(result.report.error_message ?? '', /official Cloudflare HTTPS locator/);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite fails closed when TEST-COST-001 is covered but the pre-release cost observation sidecar is missing', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-cost-missing-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260403T060200Z',
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
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-cost-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-cost-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.exit_code, 1);
    assert.match(result.report.error_message ?? '', /pre_release_cost_observation sidecar is required/);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runEnvironmentBackedSuite clears stale pre-release cost sidecars before rerunning the suite', async () => {
  const repoRoot = path.resolve('.');
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-nonlocal-suite-cost-stale-'));
  const deploymentSummary = buildDeploymentSummaryFixture('pre-release');
  deploymentSummary.access = {
    protected_ops_url: 'https://matrix-ops-worker-pre-release.matrixflare.workers.dev',
  };

  try {
    await fs.writeFile(
      path.join(outputRoot, 'pre-release-cost-observation.json'),
      JSON.stringify(buildPreReleaseCostObservationFixture(), null, 2),
    );
    const result = await runEnvironmentBackedSuite('pre-release', repoRoot, {
      runTimestamp: '20260403T060300Z',
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
    }, {
      requireGitHubActionsExecutionImpl: async () => ({ environment: 'pre-release' }),
      assessNonLocalEnvironmentHarnessReadinessImpl: async () => buildHarnessReadinessFixture([
        'tests/pre-release/test-cost-001.test.mjs',
      ]),
      requireCloudflareCredentialsImpl: () => ({ accountId: 'cf-account', apiToken: 'cf-token' }),
      readWorkersSubdomainImpl: async () => 'matrixflare',
      validateDeploymentSummaryAgainstCurrentCloudflareStateImpl: async () => (
        buildDeploymentIdentityValidationFixture('pre-release')
      ),
      getRequiredTestFilesImpl: async () => [path.join(repoRoot, 'tests/pre-release/test-cost-001.test.mjs')],
      waitForNonLocalDeploymentReadinessImpl: async () => buildReadinessProbeFixture('pre-release'),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('suite ok\n', 'utf8'));
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.exit_code, 1);
    assert.match(result.report.error_message ?? '', /pre_release_cost_observation sidecar is required/);
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
  assert.equal(provenance.origin_repository, 'example/matrix');
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

test('production automation builders emit records that satisfy the shared evidence contract', () => {
  const runTimestamp = '20260331T140000Z';
  const sourceRunUri = buildGitHubRunUrl('VrianCao/MatrixFlare', '81234');
  const releaseCandidate = buildReleaseCandidateManifest({
    releaseRef: 'refs/heads/phase08-nonlocal-closure',
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    requiresDoMigration: false,
    sourceRepository: 'VrianCao/MatrixFlare',
    sourceRunUri,
    originRunIdentity: buildProducerRunIdentityFixture(),
    ciIntegrationAttestation: buildEnvironmentAttestationFixture('ci-integration', runTimestamp, {
      sourceRunUri,
    }),
    stagingAttestation: buildEnvironmentAttestationFixture('staging', runTimestamp, {
      sourceRunUri,
    }),
    preReleaseAttestation: buildEnvironmentAttestationFixture('pre-release', runTimestamp, {
      sourceRunUri,
    }),
  });
  assert.deepEqual(validateReleaseCandidateManifest(releaseCandidate), {
    valid: true,
    error: null,
  });

  const provisionedEnvironment = buildProductionProvisioningFixture();
  const deploymentSummary = buildProductionDeploymentSummaryFixture();
  const installRecord = buildProdInstallRecord({
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    provisionedEnvironment,
    deploymentSummary,
    originRunIdentity: buildProducerRunIdentityFixture(),
    installId: 'install-prod-topology-v1',
    installedAt: '2026-03-31T14:08:00.000Z',
  });
  assert.deepEqual(validateProdInstallRecord(installRecord), {
    valid: true,
    error: null,
  });

  const promotionRecord = buildProdPromotionRecord({
    releaseCommitSha: '89abcdef0123456789abcdef0123456789abcdef',
    sourceCandidate: {
      candidate_id: releaseCandidate.candidate_id,
      source_run_uri: releaseCandidate.source_run_uri,
    },
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '912346' }),
    promotionMode: 'gradual',
    previousDeploymentIdentity: installRecord.deployment_identity,
    currentDeploymentIdentity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gatewayRolloutSteps: [
      { percentage: 10, deployment_id: 'gateway-prod-rollout-10', ready: true, attempt_count: 1, last_error: null },
      { percentage: 50, deployment_id: 'gateway-prod-rollout-50', ready: true, attempt_count: 1, last_error: null },
      { percentage: 100, deployment_id: 'gateway-prod-rollout-100', ready: true, attempt_count: 1, last_error: null },
    ],
    readinessChecks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
    },
    rollbackHandle: {
      workers_subdomain: installRecord.workers_subdomain,
      worker_versions: {
        'gateway-worker': {
          script_name: installRecord.workers['gateway-worker'].script_name,
          previous_deployment_id: installRecord.workers['gateway-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['gateway-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['gateway-worker'].worker_version_id}@100`],
        },
        'jobs-worker': {
          script_name: installRecord.workers['jobs-worker'].script_name,
          previous_deployment_id: installRecord.workers['jobs-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['jobs-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['jobs-worker'].worker_version_id}@100`],
        },
        'ops-worker': {
          script_name: installRecord.workers['ops-worker'].script_name,
          previous_deployment_id: installRecord.workers['ops-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['ops-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['ops-worker'].worker_version_id}@100`],
        },
      },
    },
    promotionId: 'promotion-prod-v2',
    promotedAt: '2026-03-31T14:09:00.000Z',
  });
  assert.deepEqual(validateProdPromotionRecord(promotionRecord), {
    valid: true,
    error: null,
  });

  const migrationPromotionRecord = buildProdPromotionRecord({
    releaseCommitSha: 'fedcba9876543210fedcba9876543210fedcba98',
    sourceCandidate: {
      candidate_id: releaseCandidate.candidate_id,
      source_run_uri: releaseCandidate.source_run_uri,
    },
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '912347' }),
    promotionMode: 'deploy_with_migration',
    previousDeploymentIdentity: installRecord.deployment_identity,
    currentDeploymentIdentity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v3', 'ops-prod-deployment-v3', 'gateway-prod-deployment-v3'],
      worker_version_ids: ['jobs@prod-v3', 'ops@prod-v3', 'gateway@prod-v3'],
    },
    gatewayRolloutSteps: [],
    readinessChecks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
      gateway_promoted: buildProductionReadinessProbeFixture(),
    },
    rollbackHandle: null,
    promotionId: 'promotion-prod-v3-migration',
    promotedAt: '2026-03-31T14:10:00.000Z',
  });
  assert.deepEqual(validateProdPromotionRecord(migrationPromotionRecord), {
    valid: true,
    error: null,
  });

  const rollbackRecord = buildProdRollbackRecord({
    sourcePromotionId: promotionRecord.promotion_id,
    releaseCommitSha: installRecord.release_commit_sha,
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '912348' }),
    requestedRollbackHandle: promotionRecord.rollback_handle,
    restoredDeploymentIdentity: installRecord.deployment_identity,
    workerResults: {
      'gateway-worker': {
        restored: true,
        deployment_id: installRecord.workers['gateway-worker'].deployment_id,
        worker_version_id: installRecord.workers['gateway-worker'].worker_version_id,
      },
      'jobs-worker': {
        restored: true,
        deployment_id: installRecord.workers['jobs-worker'].deployment_id,
        worker_version_id: installRecord.workers['jobs-worker'].worker_version_id,
      },
      'ops-worker': {
        restored: true,
        deployment_id: installRecord.workers['ops-worker'].deployment_id,
        worker_version_id: installRecord.workers['ops-worker'].worker_version_id,
      },
    },
    readinessProbe: buildProductionReadinessProbeFixture(),
    rollbackId: 'rollback-prod-v1',
    rolledBackAt: '2026-03-31T14:11:00.000Z',
  });
  assert.deepEqual(validateProdRollbackRecord(rollbackRecord), {
    valid: true,
    error: null,
  });
});

test('production automation validators can bind consumed artifacts to the current repository', () => {
  const runTimestamp = '20260331T140000Z';
  const sourceRunUri = buildGitHubRunUrl('VrianCao/MatrixFlare', '81234');
  const releaseCandidate = buildReleaseCandidateManifest({
    releaseRef: 'refs/heads/phase08-nonlocal-closure',
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    requiresDoMigration: false,
    sourceRepository: 'VrianCao/MatrixFlare',
    sourceRunUri,
    originRunIdentity: buildProducerRunIdentityFixture(),
    ciIntegrationAttestation: buildEnvironmentAttestationFixture('ci-integration', runTimestamp, {
      sourceRunUri,
    }),
    stagingAttestation: buildEnvironmentAttestationFixture('staging', runTimestamp, {
      sourceRunUri,
    }),
    preReleaseAttestation: buildEnvironmentAttestationFixture('pre-release', runTimestamp, {
      sourceRunUri,
    }),
  });
  assert.deepEqual(validateReleaseCandidateManifest({
    ...releaseCandidate,
    origin_repository: 'OtherOrg/OtherRepo',
    origin_run_uri: buildGitHubRunUrl('OtherOrg/OtherRepo', '912345'),
  }, {
    expectedGitHubRepository: 'VrianCao/MatrixFlare',
  }), {
    valid: false,
    error: 'release candidate manifest origin_repository must match the current repository',
  });

  const installRecord = buildProdInstallRecord({
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    provisionedEnvironment: buildProductionProvisioningFixture(),
    deploymentSummary: buildProductionDeploymentSummaryFixture(),
    originRunIdentity: buildProducerRunIdentityFixture(),
    installId: 'install-prod-topology-v1',
    installedAt: '2026-03-31T14:08:00.000Z',
  });
  assert.deepEqual(validateProdInstallRecord({
    ...installRecord,
    origin_repository: 'OtherOrg/OtherRepo',
    origin_run_uri: buildGitHubRunUrl('OtherOrg/OtherRepo', '912345'),
  }, {
    expectedGitHubRepository: 'VrianCao/MatrixFlare',
  }), {
    valid: false,
    error: 'prod install record origin_repository must match the current repository',
  });

  const promotionRecord = buildProdPromotionRecord({
    releaseCommitSha: '89abcdef0123456789abcdef0123456789abcdef',
    sourceCandidate: {
      candidate_id: releaseCandidate.candidate_id,
      source_run_uri: releaseCandidate.source_run_uri,
    },
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '912347' }),
    promotionMode: 'gradual',
    previousDeploymentIdentity: installRecord.deployment_identity,
    currentDeploymentIdentity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gatewayRolloutSteps: [
      { percentage: 10, deployment_id: 'gateway-prod-rollout-10', ready: true, attempt_count: 1, last_error: null },
      { percentage: 50, deployment_id: 'gateway-prod-rollout-50', ready: true, attempt_count: 1, last_error: null },
      { percentage: 100, deployment_id: 'gateway-prod-rollout-100', ready: true, attempt_count: 1, last_error: null },
    ],
    readinessChecks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
    },
    rollbackHandle: {
      workers_subdomain: installRecord.workers_subdomain,
      worker_versions: {
        'gateway-worker': {
          script_name: installRecord.workers['gateway-worker'].script_name,
          previous_deployment_id: installRecord.workers['gateway-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['gateway-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['gateway-worker'].worker_version_id}@100`],
        },
        'jobs-worker': {
          script_name: installRecord.workers['jobs-worker'].script_name,
          previous_deployment_id: installRecord.workers['jobs-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['jobs-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['jobs-worker'].worker_version_id}@100`],
        },
        'ops-worker': {
          script_name: installRecord.workers['ops-worker'].script_name,
          previous_deployment_id: installRecord.workers['ops-worker'].deployment_id,
          previous_worker_version_id: installRecord.workers['ops-worker'].worker_version_id,
          restore_version_specs: [`${installRecord.workers['ops-worker'].worker_version_id}@100`],
        },
      },
    },
    promotionId: 'promotion-prod-v2',
    promotedAt: '2026-03-31T14:09:00.000Z',
  });
  assert.deepEqual(validateProdPromotionRecord({
    ...promotionRecord,
    origin_repository: 'OtherOrg/OtherRepo',
    origin_run_uri: buildGitHubRunUrl('OtherOrg/OtherRepo', '912347'),
  }, {
    expectedGitHubRepository: 'VrianCao/MatrixFlare',
  }), {
    valid: false,
    error: 'prod promotion record origin_repository must match the current repository',
  });

  const rollbackRecord = buildProdRollbackRecord({
    sourcePromotionId: promotionRecord.promotion_id,
    releaseCommitSha: installRecord.release_commit_sha,
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '912348' }),
    requestedRollbackHandle: promotionRecord.rollback_handle,
    restoredDeploymentIdentity: installRecord.deployment_identity,
    workerResults: {
      'gateway-worker': {
        restored: true,
        deployment_id: installRecord.workers['gateway-worker'].deployment_id,
        worker_version_id: installRecord.workers['gateway-worker'].worker_version_id,
      },
      'jobs-worker': {
        restored: true,
        deployment_id: installRecord.workers['jobs-worker'].deployment_id,
        worker_version_id: installRecord.workers['jobs-worker'].worker_version_id,
      },
      'ops-worker': {
        restored: true,
        deployment_id: installRecord.workers['ops-worker'].deployment_id,
        worker_version_id: installRecord.workers['ops-worker'].worker_version_id,
      },
    },
    readinessProbe: buildProductionReadinessProbeFixture(),
    rollbackId: 'rollback-prod-v1',
    rolledBackAt: '2026-03-31T14:11:00.000Z',
  });
  assert.deepEqual(validateProdRollbackRecord({
    ...rollbackRecord,
    origin_repository: 'OtherOrg/OtherRepo',
    origin_run_uri: buildGitHubRunUrl('OtherOrg/OtherRepo', '912348'),
  }, {
    expectedGitHubRepository: 'VrianCao/MatrixFlare',
  }), {
    valid: false,
    error: 'prod rollback record origin_repository must match the current repository',
  });
});

test('prod current-state snapshots satisfy the shared automation contract and can be used as a recovery baseline', () => {
  const snapshot = buildProdCurrentStateSnapshotFixture();
  assert.deepEqual(validateProdCurrentStateSnapshot(snapshot), {
    valid: true,
    error: null,
  });

  const normalized = normalizeProdCurrentStateSnapshot(snapshot, {
    baselineRecord: buildProdInstallRecordFixture(),
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537026',
    }),
  });
  assert.equal(normalized.artifact_id, 'prod_current_state_snapshot');
  assert.equal(normalized.workers_subdomain, 'matrixflare');
  assert.deepEqual(
    normalized.current_deployment_observation.current_deployment_identity,
    buildProductionDeploymentSummaryFixture().deployment_identity,
  );
  assert.equal(
    normalized.workers['gateway-worker'].url,
    buildProductionDeploymentSummaryFixture().workers['gateway-worker'].url,
  );
});

test('typed prod current-state snapshots must match the supplied upstream producer run identity', () => {
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537026',
  });
  const mismatchedOriginRunIdentity = buildProducerRunIdentityFixture({
    runId: '24033537031',
  });

  assert.deepEqual(
    validateProdCurrentStateSnapshot(snapshot, {
      expectedOriginRunIdentity: mismatchedOriginRunIdentity,
      requireUsableBaseline: true,
    }),
    {
      valid: false,
      error: 'prod current state snapshot.origin_run_id must match expectedOriginRunIdentity.origin_run_id',
    },
  );

  assert.throws(
    () => normalizeProdCurrentStateSnapshot(snapshot, {
      baselineRecord: buildProdInstallRecordFixture(),
      originRunIdentity: mismatchedOriginRunIdentity,
    }),
    /typed prod current state snapshot is invalid: prod current state snapshot\.origin_run_id must match expectedOriginRunIdentity\.origin_run_id/u,
  );
});

test('typed prod current-state snapshots require RFC3339 observed_at, structured baseline_match, and raw observation workers before they can be reused as baselines', () => {
  const invalidObservedAt = structuredClone(buildProdCurrentStateSnapshotFixture());
  invalidObservedAt.observed_at = 'not-a-timestamp';
  assert.deepEqual(
    validateProdCurrentStateSnapshot(invalidObservedAt, {
      requireUsableBaseline: true,
    }),
    {
      valid: false,
      error: 'prod current state snapshot observed_at must be an RFC 3339 UTC timestamp',
    },
  );

  const invalidBaselineMatch = structuredClone(buildProdCurrentStateSnapshotFixture());
  invalidBaselineMatch.baseline_match = {};
  assert.deepEqual(
    validateProdCurrentStateSnapshot(invalidBaselineMatch, {
      requireUsableBaseline: true,
    }),
    {
      valid: false,
      error: 'prod current state snapshot baseline_match.matches must be a boolean',
    },
  );

  const invalidObservationWorkers = structuredClone(buildProdCurrentStateSnapshotFixture());
  invalidObservationWorkers.current_deployment_observation.workers = {};
  assert.deepEqual(
    validateProdCurrentStateSnapshot(invalidObservationWorkers, {
      requireUsableBaseline: true,
    }),
    {
      valid: false,
      error: 'prod current state snapshot current_deployment_observation.workers.jobs-worker must be an object',
    },
  );
});

test('typed prod current-state snapshots require protected_ops_url to match the current prod ops-worker host', () => {
  const snapshot = structuredClone(buildProdCurrentStateSnapshotFixture());
  snapshot.access.protected_ops_url = 'https://example.com/not-prod';

  assert.deepEqual(
    validateProdCurrentStateSnapshot(snapshot, {
      requireUsableBaseline: true,
    }),
    {
      valid: false,
      error: 'prod current state snapshot access.protected_ops_url must match the current prod ops-worker host',
    },
  );
});

test('production baseline input resolver finds the embedded baseline record before normalizing current-state blockers', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-resolve-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'recovered', 'upstream', 'prod-install-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const baselineRecord = buildProdInstallRecordFixture();
  const typedSnapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537026',
  });
  const snapshot = {
    observed_at: typedSnapshot.observed_at,
    access: {
      protected_ops_url: typedSnapshot.access.protected_ops_url,
    },
    baseline_record: typedSnapshot.baseline_record,
    baseline_match: typedSnapshot.baseline_match,
    current_deployment_observation: typedSnapshot.current_deployment_observation,
  };

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(baselineRecord, null, 2)}\n`);

  const resolved = await resolveProductionBaselineInputArtifact({
    downloadRoot,
    baselineInputKind: 'current_state',
    baselineInputPath: 'state/operational-refresh/current-production-state.json',
    baselineRecordName: 'prod-install-record.json',
    normalizedOutputPath,
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537026',
    }),
  });

  assert.equal(resolved.raw_baseline_input_path, rawSnapshotPath);
  assert.equal(resolved.baseline_record_path, embeddedBaselineRecordPath);
  assert.equal(resolved.resolved_baseline_input_path, normalizedOutputPath);
  assert.deepEqual(
    validateProdCurrentStateSnapshot(JSON.parse(await fs.readFile(normalizedOutputPath, 'utf8')), {
      requireUsableBaseline: true,
    }),
    { valid: true, error: null },
  );
});

test('production baseline input resolver derives protected prod ops ingress from an embedded install baseline when a legacy snapshot omits access metadata', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-missing-embedded-ops-url-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'recovered', 'upstream', 'prod-install-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const baselineRecord = buildProdInstallRecordFixture();
  const typedSnapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537026',
  });
  const snapshot = {
    observed_at: typedSnapshot.observed_at,
    baseline_record: typedSnapshot.baseline_record,
    baseline_match: typedSnapshot.baseline_match,
    current_deployment_observation: typedSnapshot.current_deployment_observation,
  };

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(baselineRecord, null, 2)}\n`);

  const resolved = await resolveProductionBaselineInputArtifact({
    downloadRoot,
    baselineInputKind: 'current_state',
    baselineInputPath: 'state/operational-refresh/current-production-state.json',
    baselineRecordName: 'prod-install-record.json',
    normalizedOutputPath,
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537026',
    }),
  });

  assert.equal(resolved.raw_baseline_input_path, rawSnapshotPath);
  assert.equal(resolved.baseline_record_path, embeddedBaselineRecordPath);
  const normalizedSnapshot = JSON.parse(await fs.readFile(normalizedOutputPath, 'utf8'));
  assert.deepEqual(
    validateProdCurrentStateSnapshot(normalizedSnapshot, {
      requireUsableBaseline: true,
    }),
    { valid: true, error: null },
  );
  assert.equal(
    normalizedSnapshot.access.protected_ops_url,
    baselineRecord.access.protected_ops_url,
  );
});

test('production baseline input resolver accepts typed current-state blockers without an embedded baseline record', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-direct-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const dispositionPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state-disposition.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537031',
  });

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(
    dispositionPath,
    `${JSON.stringify(buildProdCurrentStateDispositionFixture(), null, 2)}\n`,
  );

  const resolved = await resolveProductionBaselineInputArtifact({
    downloadRoot,
    baselineInputKind: 'current_state',
    baselineInputPath: 'state/operational-refresh/current-production-state.json',
    baselineRecordName: 'prod-promotion-record.json',
    normalizedOutputPath,
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537031',
    }),
  });

  assert.equal(resolved.raw_baseline_input_path, rawSnapshotPath);
  assert.equal(resolved.baseline_record_path, null);
  assert.equal(resolved.resolved_baseline_input_path, normalizedOutputPath);
  assert.deepEqual(
    JSON.parse(await fs.readFile(normalizedOutputPath, 'utf8')),
    snapshot,
  );
});

test('production baseline input resolver rejects typed current-state blockers when a disposition sidecar marks the canonical snapshot refresh_failed', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-disposition-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const dispositionPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state-disposition.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537035',
  });

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(
    dispositionPath,
    `${JSON.stringify(buildProdCurrentStateDispositionFixture({
      disposition: 'refresh_failed',
    }), null, 2)}\n`,
  );

  await assert.rejects(
    () => resolveProductionBaselineInputArtifact({
      downloadRoot,
      baselineInputKind: 'current_state',
      baselineInputPath: 'state/operational-refresh/current-production-state.json',
      baselineRecordName: 'prod-promotion-record.json',
      normalizedOutputPath,
      originRunIdentity: buildProducerRunIdentityFixture({
        runId: '24033537035',
      }),
    }),
    /current-state baseline input is unavailable because prod current state disposition marked the canonical snapshot as refresh_failed/u,
  );
});

test('production current-state failure artifact validator rejects missing disposition sidecars once only the quarantined pre-failure snapshot remains', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-current-state-failure-missing-disposition-'));
  const rawSnapshotPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const preFailureSnapshotPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'pre-failure-current-production-state.json');
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537036',
  });

  await fs.mkdir(path.dirname(preFailureSnapshotPath), { recursive: true });
  await fs.writeFile(preFailureSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  assert.deepEqual(
    await validateProductionCurrentStateFailureArtifacts({
      currentStateSnapshotPath: rawSnapshotPath,
    }),
    {
      valid: false,
      error: 'prod current state failure artifacts must include current-production-state-disposition.json',
    },
  );
});

test('production current-state failure artifact validator accepts a typed canonical snapshot without a disposition sidecar when no stale pre-failure quarantine exists', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-current-state-failure-canonical-only-'));
  const rawSnapshotPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24045788582',
  });

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  assert.deepEqual(
    await validateProductionCurrentStateFailureArtifacts({
      currentStateSnapshotPath: rawSnapshotPath,
    }),
    {
      valid: true,
      error: null,
    },
  );
});

test('production current-state failure artifact validator rejects refresh_failed sidecars that leave the canonical snapshot in place', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-current-state-failure-stale-canonical-'));
  const rawSnapshotPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const dispositionPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'current-production-state-disposition.json');
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537037',
  });

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(
    dispositionPath,
    `${JSON.stringify(buildProdCurrentStateDispositionFixture({
      disposition: 'refresh_failed',
    }), null, 2)}\n`,
  );

  assert.deepEqual(
    await validateProductionCurrentStateFailureArtifacts({
      currentStateSnapshotPath: rawSnapshotPath,
    }),
    {
      valid: false,
      error: 'prod current state disposition refresh_failed requires canonical current-production-state.json to be absent',
    },
  );
});

test('production current-state failure artifact validator accepts refresh_failed sidecars once the canonical snapshot is gone and quarantine evidence remains', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-current-state-failure-quarantined-'));
  const rawSnapshotPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const preFailureSnapshotPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'pre-failure-current-production-state.json');
  const dispositionPath = path.join(workspaceRoot, 'state', 'operational-refresh', 'current-production-state-disposition.json');
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537038',
  });

  await fs.mkdir(path.dirname(preFailureSnapshotPath), { recursive: true });
  await fs.writeFile(preFailureSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(
    dispositionPath,
    `${JSON.stringify(buildProdCurrentStateDispositionFixture({
      disposition: 'refresh_failed',
    }), null, 2)}\n`,
  );

  assert.deepEqual(
    await validateProductionCurrentStateFailureArtifacts({
      currentStateSnapshotPath: rawSnapshotPath,
    }),
    {
      valid: true,
      error: null,
    },
  );
});

test('production raw-state staging preserves stale canonical current-state snapshots as uploaded forensic evidence', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-raw-stage-stale-'));
  const stateRoot = path.join(workspaceRoot, 'state');
  const downloadRoot = path.join(workspaceRoot, 'downloaded');
  const artifactRoot = path.join(workspaceRoot, 'artifacts');
  const outputRoot = path.join(workspaceRoot, 'upload');
  const currentStatePath = path.join(stateRoot, 'operational-refresh', 'current-production-state.json');
  const dispositionPath = path.join(stateRoot, 'operational-refresh', 'current-production-state-disposition.json');
  const downloadMarker = path.join(downloadRoot, 'baseline', 'marker.txt');
  const artifactMarker = path.join(artifactRoot, 'prod-promotion-record.json');

  await fs.mkdir(path.dirname(currentStatePath), { recursive: true });
  await fs.mkdir(path.dirname(downloadMarker), { recursive: true });
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(currentStatePath, `${JSON.stringify(buildProdCurrentStateSnapshotFixture(), null, 2)}\n`);
  await fs.writeFile(
    dispositionPath,
    `${JSON.stringify(buildProdCurrentStateDispositionFixture({
      disposition: 'refresh_failed',
    }), null, 2)}\n`,
  );
  await fs.writeFile(downloadMarker, 'baseline-marker\n');
  await fs.writeFile(artifactMarker, '{}\n');

  const result = await stageProductionRawStateArtifactForUpload({
    stateRoot,
    downloadRoot,
    artifactRoot,
    outputRoot,
  });

  assert.equal(
    await pathExists(path.join(outputRoot, 'state', 'operational-refresh', 'current-production-state.json')),
    true,
  );
  assert.equal(
    await pathExists(path.join(outputRoot, 'state', 'operational-refresh', 'current-production-state-disposition.json')),
    true,
  );
  assert.equal(await pathExists(path.join(outputRoot, 'downloaded', 'baseline', 'marker.txt')), true);
  assert.equal(await pathExists(path.join(outputRoot, 'artifacts', 'prod-promotion-record.json')), true);
  assert.equal(result.staged_state_root, path.join(outputRoot, 'state'));
  assert.equal(result.staged_download_root, path.join(outputRoot, 'downloaded'));
  assert.equal(result.staged_artifact_root, path.join(outputRoot, 'artifacts'));
});

test('production raw-state staging preserves canonical current-state snapshots when disposition is refreshed', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-raw-stage-refreshed-'));
  const stateRoot = path.join(workspaceRoot, 'state');
  const downloadRoot = path.join(workspaceRoot, 'downloaded');
  const artifactRoot = path.join(workspaceRoot, 'artifacts');
  const outputRoot = path.join(workspaceRoot, 'upload');
  const currentStatePath = path.join(stateRoot, 'promote', 'current-production-state.json');
  const dispositionPath = path.join(stateRoot, 'promote', 'current-production-state-disposition.json');

  await fs.mkdir(path.dirname(currentStatePath), { recursive: true });
  await fs.mkdir(downloadRoot, { recursive: true });
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(currentStatePath, `${JSON.stringify(buildProdCurrentStateSnapshotFixture(), null, 2)}\n`);
  await fs.writeFile(
    dispositionPath,
    `${JSON.stringify(buildProdCurrentStateDispositionFixture({
      disposition: 'refreshed',
    }), null, 2)}\n`,
  );

  const result = await stageProductionRawStateArtifactForUpload({
    stateRoot,
    downloadRoot,
    artifactRoot,
    outputRoot,
  });

  assert.equal(
    await pathExists(path.join(outputRoot, 'state', 'promote', 'current-production-state.json')),
    true,
  );
  assert.equal(result.staged_state_root, path.join(outputRoot, 'state'));
});

test('production baseline input resolver rejects invalid typed current-state blockers instead of falling back to embedded baseline records', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-invalid-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'recovered', 'upstream', 'prod-install-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const snapshot = structuredClone(buildProdCurrentStateSnapshotFixture({
    runId: '24033537032',
  }));
  snapshot.access.protected_ops_url = '';

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(buildProdInstallRecordFixture(), null, 2)}\n`);

  await assert.rejects(
    () => resolveProductionBaselineInputArtifact({
      downloadRoot,
      baselineInputKind: 'current_state',
      baselineInputPath: 'state/operational-refresh/current-production-state.json',
      baselineRecordName: 'prod-install-record.json',
      normalizedOutputPath,
      originRunIdentity: buildProducerRunIdentityFixture({
        runId: '24033537032',
      }),
    }),
    /typed prod current state snapshot is invalid: prod current state snapshot access\.protected_ops_url must be non-empty/u,
  );
});

test('production baseline input resolver binds record baselines to the selected upstream run identity', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-record-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const baselineRecordPath = path.join(downloadRoot, 'prod-promotion-record.json');
  const record = buildProdPromotionRecordFixture({
    runId: '24033537033',
  });

  await fs.mkdir(path.dirname(baselineRecordPath), { recursive: true });
  await fs.writeFile(baselineRecordPath, `${JSON.stringify(record, null, 2)}\n`);

  const resolved = await resolveProductionBaselineInputArtifact({
    downloadRoot,
    baselineInputKind: 'record',
    baselineInputPath: 'prod-promotion-record.json',
    baselineRecordName: 'prod-promotion-record.json',
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537033',
    }),
  });

  assert.equal(resolved.raw_baseline_input_path, baselineRecordPath);
  assert.equal(resolved.baseline_record_path, baselineRecordPath);
  assert.equal(resolved.resolved_baseline_input_path, baselineRecordPath);

  await assert.rejects(
    () => resolveProductionBaselineInputArtifact({
      downloadRoot,
      baselineInputKind: 'record',
      baselineInputPath: 'prod-promotion-record.json',
      baselineRecordName: 'prod-promotion-record.json',
      originRunIdentity: buildProducerRunIdentityFixture({
        runId: '24033537034',
      }),
    }),
    /record baseline input is invalid: prod promotion record\.origin_run_id must match expectedOriginRunIdentity\.origin_run_id/u,
  );
});

test('production baseline input resolver accepts embedded baseline records that match the legacy snapshot baseline lineage even when the blocker run id differs', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-embedded-lineage-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'downloaded', 'baseline', 'prod-promotion-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const embeddedBaselineRecord = buildProdPromotionRecordFixture({
    runId: '24019281851',
    promotedAt: '2026-04-06T04:55:43.000Z',
  });
  const blockerRunIdentity = buildProducerRunIdentityFixture({
    runId: '24033551396',
  });
  const snapshot = {
    observed_at: '2026-04-06T13:25:40.017Z',
    access: {
      protected_ops_url: 'https://matrix-ops-worker-prod.matrixflare.workers.dev',
    },
    baseline_record: {
      artifact_id: embeddedBaselineRecord.artifact_id,
      origin_run_uri: embeddedBaselineRecord.origin_run_uri,
      deployment_identity: embeddedBaselineRecord.current_deployment_identity,
    },
    baseline_match: {
      matches: false,
      mismatched_fields: ['deployment_ids', 'worker_version_ids'],
      problems: [],
    },
    current_deployment_observation: buildProdCurrentStateSnapshotFixture({
      runId: blockerRunIdentity.origin_run_id,
    }).current_deployment_observation,
  };

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(embeddedBaselineRecord, null, 2)}\n`);

  const resolved = await resolveProductionBaselineInputArtifact({
    downloadRoot,
    baselineInputKind: 'current_state',
    baselineInputPath: 'state/operational-refresh/current-production-state.json',
    baselineRecordName: 'prod-promotion-record.json',
    normalizedOutputPath,
    originRunIdentity: blockerRunIdentity,
  });

  assert.equal(resolved.raw_baseline_input_path, rawSnapshotPath);
  assert.equal(resolved.baseline_record_path, embeddedBaselineRecordPath);
  const normalizedSnapshot = JSON.parse(await fs.readFile(normalizedOutputPath, 'utf8'));
  assert.deepEqual(
    validateProdCurrentStateSnapshot(normalizedSnapshot, {
      requireUsableBaseline: true,
    }),
    { valid: true, error: null },
  );
  assert.equal(normalizedSnapshot.origin_run_id, blockerRunIdentity.origin_run_id);
  assert.equal(normalizedSnapshot.origin_run_uri, blockerRunIdentity.origin_run_uri);
  assert.equal(normalizedSnapshot.access.protected_ops_url, 'https://matrix-ops-worker-prod.matrixflare.workers.dev');
  assert.equal(normalizedSnapshot.baseline_record.origin_run_uri, embeddedBaselineRecord.origin_run_uri);
  assert.deepEqual(normalizedSnapshot.baseline_record.deployment_identity, embeddedBaselineRecord.current_deployment_identity);
});

test('production baseline input resolver derives protected prod ops ingress from the embedded baseline when a legacy snapshot omits access metadata', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-missing-ops-url-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'downloaded', 'baseline', 'prod-promotion-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const embeddedBaselineRecord = buildProdPromotionRecordFixture({
    runId: '24019281851',
    promotedAt: '2026-04-06T04:55:43.000Z',
  });
  const blockerRunIdentity = buildProducerRunIdentityFixture({
    runId: '24033551396',
  });
  const snapshot = {
    observed_at: '2026-04-06T13:25:40.017Z',
    baseline_record: {
      artifact_id: embeddedBaselineRecord.artifact_id,
      origin_run_uri: embeddedBaselineRecord.origin_run_uri,
      deployment_identity: embeddedBaselineRecord.current_deployment_identity,
    },
    baseline_match: {
      matches: false,
      mismatched_fields: ['deployment_ids', 'worker_version_ids'],
      problems: [],
    },
    current_deployment_observation: buildProdCurrentStateSnapshotFixture({
      runId: blockerRunIdentity.origin_run_id,
    }).current_deployment_observation,
  };

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(embeddedBaselineRecord, null, 2)}\n`);

  const resolved = await resolveProductionBaselineInputArtifact({
    downloadRoot,
    baselineInputKind: 'current_state',
    baselineInputPath: 'state/operational-refresh/current-production-state.json',
    baselineRecordName: 'prod-promotion-record.json',
    normalizedOutputPath,
    originRunIdentity: blockerRunIdentity,
  });

  assert.equal(resolved.raw_baseline_input_path, rawSnapshotPath);
  assert.equal(resolved.baseline_record_path, embeddedBaselineRecordPath);
  const normalizedSnapshot = JSON.parse(await fs.readFile(normalizedOutputPath, 'utf8'));
  assert.deepEqual(
    validateProdCurrentStateSnapshot(normalizedSnapshot, {
      requireUsableBaseline: true,
    }),
    { valid: true, error: null },
  );
  assert.equal(
    normalizedSnapshot.access.protected_ops_url,
    'https://matrix-ops-worker-prod.matrixflare.workers.dev',
  );
});

test('production baseline input resolver still fails closed when a legacy snapshot omits access metadata and the embedded baseline cannot derive prod ops ingress', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-underivable-ops-url-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'downloaded', 'baseline', 'prod-promotion-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const embeddedBaselineRecord = structuredClone(buildProdPromotionRecordFixture({
    runId: '24019281851',
    promotedAt: '2026-04-06T04:55:43.000Z',
  }));
  embeddedBaselineRecord.rollback_handle.workers_subdomain = '';
  const blockerRunIdentity = buildProducerRunIdentityFixture({
    runId: '24033551396',
  });
  const snapshot = {
    observed_at: '2026-04-06T13:25:40.017Z',
    baseline_record: {
      artifact_id: embeddedBaselineRecord.artifact_id,
      origin_run_uri: embeddedBaselineRecord.origin_run_uri,
      deployment_identity: embeddedBaselineRecord.current_deployment_identity,
    },
    baseline_match: {
      matches: false,
      mismatched_fields: ['deployment_ids', 'worker_version_ids'],
      problems: [],
    },
    current_deployment_observation: buildProdCurrentStateSnapshotFixture({
      runId: blockerRunIdentity.origin_run_id,
    }).current_deployment_observation,
  };

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(embeddedBaselineRecord, null, 2)}\n`);

  await assert.rejects(
    () => resolveProductionBaselineInputArtifact({
      downloadRoot,
      baselineInputKind: 'current_state',
      baselineInputPath: 'state/operational-refresh/current-production-state.json',
      baselineRecordName: 'prod-promotion-record.json',
      normalizedOutputPath,
      originRunIdentity: blockerRunIdentity,
    }),
    /legacy prod current state snapshot missing access\.protected_ops_url and embedded baselineRecord cannot derive it: baselineRecord is invalid: prod_promotion_record rollback_handle\.workers_subdomain must be non-empty/u,
  );
});

test('production baseline input resolver rejects embedded baseline records that do not match the legacy snapshot baseline lineage', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-baseline-embedded-origin-'));
  const downloadRoot = path.join(workspaceRoot, 'downloaded', 'baseline');
  const rawSnapshotPath = path.join(downloadRoot, 'state', 'operational-refresh', 'current-production-state.json');
  const embeddedBaselineRecordPath = path.join(downloadRoot, 'recovered', 'upstream', 'prod-install-record.json');
  const normalizedOutputPath = path.join(workspaceRoot, 'state', 'normalized-baseline', 'current-production-state.json');
  const typedSnapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537035',
  });
  const snapshot = {
    observed_at: '2026-04-06T14:00:00.000Z',
    access: {
      protected_ops_url: typedSnapshot.access.protected_ops_url,
    },
    baseline_record: {
      artifact_id: 'prod_install_record',
      origin_run_uri: buildGitHubRunUrl('VrianCao/MatrixFlare', '24033537035'),
      deployment_identity: {
        environment_id: 'prod',
        deployment_ids: ['jobs-prod-deployment-v1', 'ops-prod-deployment-v1', 'gateway-prod-deployment-v1'],
        worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
      },
    },
    baseline_match: {
      matches: false,
      mismatched_fields: ['gateway-worker'],
      problems: [],
    },
    current_deployment_observation: typedSnapshot.current_deployment_observation,
  };
  const embeddedBaselineRecord = buildProdInstallRecordFixture({
    runId: '24033537036',
  });

  await fs.mkdir(path.dirname(rawSnapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(embeddedBaselineRecordPath), { recursive: true });
  await fs.writeFile(rawSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(embeddedBaselineRecordPath, `${JSON.stringify(embeddedBaselineRecord, null, 2)}\n`);

  await assert.rejects(
    () => resolveProductionBaselineInputArtifact({
      downloadRoot,
      baselineInputKind: 'current_state',
      baselineInputPath: 'state/operational-refresh/current-production-state.json',
      baselineRecordName: 'prod-install-record.json',
      normalizedOutputPath,
      originRunIdentity: buildProducerRunIdentityFixture({
        runId: '24033537035',
      }),
    }),
    /legacy prod current state snapshot baseline_record\.origin_run_uri must match embedded baselineRecord\.origin_run_uri/u,
  );
});

test('legacy prod current-state snapshots can be normalized into the current recovery baseline schema', () => {
  const snapshot = buildProdCurrentStateSnapshotFixture();
  const legacySnapshot = {
    observed_at: snapshot.observed_at,
    access: {
      protected_ops_url: snapshot.access.protected_ops_url,
    },
    baseline_record: snapshot.baseline_record,
    baseline_match: snapshot.baseline_match,
    current_deployment_observation: snapshot.current_deployment_observation,
  };

  assert.deepEqual(validateProdCurrentStateSnapshot(legacySnapshot), {
    valid: false,
    error: 'prod current state snapshot schema_version must equal 1',
  });

  const normalized = normalizeProdCurrentStateSnapshot(legacySnapshot, {
    baselineRecord: buildProdInstallRecordFixture({
      runId: '24000789563',
    }),
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537026',
    }),
  });
  assert.deepEqual(validateProdCurrentStateSnapshot(normalized), {
    valid: true,
    error: null,
  });
  assert.equal(normalized.origin_run_id, '24033537026');
  assert.equal(normalized.workers['ops-worker'].script_name, 'matrix-ops-worker-prod');
});

test('legacy prod current-state snapshot normalization derives protected prod ops ingress from the promotion baseline when access metadata is absent', () => {
  const baselineRecord = buildProdPromotionRecordFixture();
  const snapshot = buildProdCurrentStateSnapshotFixture({
    runId: '24033537031',
  });
  const legacySnapshot = {
    observed_at: snapshot.observed_at,
    baseline_record: {
      artifact_id: baselineRecord.artifact_id,
      origin_run_uri: baselineRecord.origin_run_uri,
      deployment_identity: baselineRecord.current_deployment_identity,
    },
    baseline_match: {
      matches: false,
      mismatched_fields: ['deployment_ids', 'worker_version_ids'],
      problems: [],
    },
    current_deployment_observation: snapshot.current_deployment_observation,
  };

  const normalized = normalizeProdCurrentStateSnapshot(legacySnapshot, {
    baselineRecord,
    originRunIdentity: buildProducerRunIdentityFixture({
      runId: '24033537032',
    }),
  });

  assert.deepEqual(validateProdCurrentStateSnapshot(normalized), {
    valid: true,
    error: null,
  });
  assert.equal(normalized.access.protected_ops_url, 'https://matrix-ops-worker-prod.matrixflare.workers.dev');
  assert.equal(normalized.origin_run_id, '24033537032');
});

test('legacy prod current-state snapshot normalization rejects explicit protected_ops_url values that do not match the current prod ops-worker host', () => {
  const snapshot = buildProdCurrentStateSnapshotFixture();
  const legacySnapshot = {
    observed_at: snapshot.observed_at,
    access: {
      protected_ops_url: 'https://example.com/not-prod',
    },
    baseline_record: snapshot.baseline_record,
    baseline_match: snapshot.baseline_match,
    current_deployment_observation: snapshot.current_deployment_observation,
  };

  assert.throws(
    () => normalizeProdCurrentStateSnapshot(legacySnapshot, {
      baselineRecord: buildProdInstallRecordFixture({
        runId: '24000789563',
      }),
      originRunIdentity: buildProducerRunIdentityFixture({
        runId: '24033537026',
      }),
    }),
    /prod current state snapshot access\.protected_ops_url must match the current prod ops-worker host/u,
  );
});

test('production automation validators fail closed on missing rollback data and wrong promotion shape', () => {
  assert.deepEqual(validateProdPromotionRecord({
    schema_version: 1,
    artifact_id: 'prod_promotion_record',
    source_environment: 'prod',
    promotion_id: 'promotion-prod-invalid',
    promoted_at: '2026-03-31T14:09:00.000Z',
    ...buildProducerRunIdentityFixture({ runId: '912349' }),
    release_commit_sha: '89abcdef0123456789abcdef0123456789abcdef',
    promotion_authority: 'reviewed_candidate',
    promotion_mode: 'gradual',
    source_candidate: {
      candidate_id: 'candidate-20260331t140000z',
      source_run_uri: buildGitHubRunUrl('VrianCao/MatrixFlare', '81234'),
    },
    operational_unblock: null,
    previous_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v1', 'ops-prod-deployment-v1', 'gateway-prod-deployment-v1'],
      worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
    },
    current_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gateway_rollout_steps: [],
    rollback_handle: null,
  }), {
    valid: false,
    error: 'prod_promotion_record gateway_rollout_steps must be non-empty for gradual promotion',
  });

  assert.deepEqual(validateProdPromotionRecord({
    schema_version: 1,
    artifact_id: 'prod_promotion_record',
    source_environment: 'prod',
    promotion_id: 'promotion-prod-invalid-migration',
    promoted_at: '2026-03-31T14:09:00.000Z',
    ...buildProducerRunIdentityFixture({ runId: '912350' }),
    release_commit_sha: '89abcdef0123456789abcdef0123456789abcdef',
    promotion_authority: 'reviewed_candidate',
    promotion_mode: 'deploy_with_migration',
    source_candidate: {
      candidate_id: 'candidate-20260331t140000z',
      source_run_uri: buildGitHubRunUrl('VrianCao/MatrixFlare', '81234'),
    },
    operational_unblock: null,
    previous_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v1', 'ops-prod-deployment-v1', 'gateway-prod-deployment-v1'],
      worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
    },
    current_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gateway_rollout_steps: [],
    readiness_checks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
      gateway_promoted: buildProductionReadinessProbeFixture(),
    },
    rollback_handle: {
      workers_subdomain: 'matrixflare',
      worker_versions: {},
    },
  }), {
    valid: false,
    error: 'prod_promotion_record rollback_handle must be null for deploy_with_migration promotions',
  });
});

test('production automation builders fail closed on missing reviewed candidate or baseline deployment identity', () => {
  const runTimestamp = '20260331T140000Z';
  const sourceRunUri = buildGitHubRunUrl('VrianCao/MatrixFlare', '81234');

  assert.throws(
    () => buildReleaseCandidateManifest({
      releaseRef: 'refs/heads/phase08-nonlocal-closure',
      releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      requiresDoMigration: false,
      sourceRepository: 'VrianCao/MatrixFlare',
      sourceRunUri,
      originRunIdentity: buildProducerRunIdentityFixture(),
      ciIntegrationAttestation: buildEnvironmentAttestationFixture('ci-integration', runTimestamp, {
        sourceRunUri,
      }),
      stagingAttestation: buildEnvironmentAttestationFixture('staging', runTimestamp, {
        sourceRunUri,
      }),
      preReleaseAttestation: null,
    }),
    /ReleaseCandidateManifest is invalid: prod_release_candidate pre_release_attestation invalid:/,
  );

  assert.throws(
    () => buildProdInstallRecord({
      releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      provisionedEnvironment: buildProductionProvisioningFixture(),
      originRunIdentity: buildProducerRunIdentityFixture(),
      deploymentSummary: {
        ...buildProductionDeploymentSummaryFixture(),
        deployment_identity: {
          environment_id: 'prod',
          deployment_ids: [],
          worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
        },
      },
      installId: 'install-prod-invalid',
      installedAt: '2026-03-31T14:08:00.000Z',
    }),
    /ProdInstallRecord is invalid: prod_install_record deployment_identity\.deployment_ids must be a non-empty string array/,
  );

  assert.deepEqual(validateProdPromotionRecord({
    schema_version: 1,
    artifact_id: 'prod_promotion_record',
    source_environment: 'prod',
    promotion_id: 'promotion-prod-missing-previous',
    promoted_at: '2026-03-31T14:09:00.000Z',
    ...buildProducerRunIdentityFixture({ runId: '912351' }),
    release_commit_sha: '89abcdef0123456789abcdef0123456789abcdef',
    promotion_authority: 'reviewed_candidate',
    promotion_mode: 'gradual',
    source_candidate: {
      candidate_id: 'candidate-20260331t140000z',
      source_run_uri: buildGitHubRunUrl('VrianCao/MatrixFlare', '81234'),
    },
    operational_unblock: null,
    previous_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: [],
      worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
    },
    current_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gateway_rollout_steps: [
      { percentage: 100, deployment_id: 'gateway-prod-rollout-100', ready: true, attempt_count: 1, last_error: null },
    ],
    readiness_checks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
    },
    rollback_handle: {
      workers_subdomain: 'matrixflare',
      worker_versions: {
        'gateway-worker': {
          script_name: 'matrix-gateway-worker-prod',
          previous_deployment_id: 'gateway-prod-deployment-v1',
          previous_worker_version_id: 'gateway@prod-v1',
          restore_version_specs: ['gateway@prod-v1@100'],
        },
        'jobs-worker': {
          script_name: 'matrix-jobs-worker-prod',
          previous_deployment_id: 'jobs-prod-deployment-v1',
          previous_worker_version_id: 'jobs@prod-v1',
          restore_version_specs: ['jobs@prod-v1@100'],
        },
        'ops-worker': {
          script_name: 'matrix-ops-worker-prod',
          previous_deployment_id: 'ops-prod-deployment-v1',
          previous_worker_version_id: 'ops@prod-v1',
          restore_version_specs: ['ops@prod-v1@100'],
        },
      },
    },
  }), {
    valid: false,
    error: 'prod_promotion_record previous_deployment_identity.deployment_ids must be a non-empty string array',
  });

  assert.deepEqual(validateProdPromotionRecord({
    schema_version: 1,
    artifact_id: 'prod_promotion_record',
    source_environment: 'prod',
    promotion_id: 'promotion-prod-operational-unblock',
    promoted_at: '2026-04-05T12:09:00.000Z',
    ...buildProducerRunIdentityFixture({ runId: '912352' }),
    release_commit_sha: '89abcdef0123456789abcdef0123456789abcdef',
    promotion_authority: 'operational_unblock',
    promotion_mode: 'gradual',
    source_candidate: null,
    operational_unblock: {
      reason: 'Operational prod refresh to unblock Phase 08 cost closure',
      blocked_by_open_questions: ['OQ-0002', 'OQ-0006'],
    },
    previous_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v1', 'ops-prod-deployment-v1', 'gateway-prod-deployment-v1'],
      worker_version_ids: ['jobs@prod-v1', 'ops@prod-v1', 'gateway@prod-v1'],
    },
    current_deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['jobs-prod-deployment-v2', 'ops-prod-deployment-v2', 'gateway-prod-deployment-v2'],
      worker_version_ids: ['jobs@prod-v2', 'ops@prod-v2', 'gateway@prod-v2'],
    },
    gateway_rollout_steps: [
      { percentage: 100, deployment_id: 'gateway-prod-rollout-100', ready: true, attempt_count: 1, last_error: null },
    ],
    readiness_checks: {
      jobs_promoted: buildProductionReadinessProbeFixture(),
      ops_promoted: buildProductionReadinessProbeFixture(),
    },
    rollback_handle: {
      workers_subdomain: 'matrixflare',
      worker_versions: {
        'gateway-worker': {
          script_name: 'matrix-gateway-worker-prod',
          previous_deployment_id: 'gateway-prod-deployment-v1',
          previous_worker_version_id: 'gateway@prod-v1',
          restore_version_specs: ['gateway@prod-v1@100'],
        },
        'jobs-worker': {
          script_name: 'matrix-jobs-worker-prod',
          previous_deployment_id: 'jobs-prod-deployment-v1',
          previous_worker_version_id: 'jobs@prod-v1',
          restore_version_specs: ['jobs@prod-v1@100'],
        },
        'ops-worker': {
          script_name: 'matrix-ops-worker-prod',
          previous_deployment_id: 'ops-prod-deployment-v1',
          previous_worker_version_id: 'ops@prod-v1',
          restore_version_specs: ['ops@prod-v1@100'],
        },
      },
    },
  }), {
    valid: true,
    error: null,
  });
});

test('production current state snapshot records baseline drift with observed Cloudflare worker state', () => {
  const baselineRecord = buildProdInstallRecord({
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    provisionedEnvironment: buildProductionProvisioningFixture(),
    deploymentSummary: buildProductionDeploymentSummaryFixture(),
    originRunIdentity: buildProducerRunIdentityFixture(),
    installId: 'install-prod-topology-v1',
    installedAt: '2026-04-05T04:55:43.000Z',
  });

  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord,
    currentObservation: buildProdCurrentStateObservationFixture(),
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '24033537026' }),
  });

  assert.equal(snapshot.artifact_id, 'prod_current_state_snapshot');
  assert.equal(snapshot.origin_repository, 'VrianCao/MatrixFlare');
  assert.equal(snapshot.source_environment, 'prod');
  assert.equal(snapshot.workers_subdomain, baselineRecord.workers_subdomain);
  assert.equal(snapshot.baseline_record.artifact_id, 'prod_install_record');
  assert.equal(snapshot.baseline_match.matches, false);
  assert.deepEqual(snapshot.baseline_match.mismatched_fields, ['deployment_ids', 'worker_version_ids']);
  assert.deepEqual(snapshot.baseline_match.problems, []);
  assert.equal(snapshot.workers['jobs-worker'].deployment_id, 'jobs-prod-deployment-v2');
  assert.equal(snapshot.workers['jobs-worker'].worker_version_id, 'jobs@prod-v2');
  assert.equal(snapshot.workers['jobs-worker'].worker_version_tag, 'mx-jw-d-prod2');
  assert.equal(
    snapshot.current_deployment_observation.workers['jobs-worker'].raw_cloudflare_api_results.deployments.deployments[0].id,
    'jobs-prod-deployment-v2',
  );
});

test('production current state snapshot stays fail-closed when current identity cannot be normalized', () => {
  const baselineRecord = buildProdInstallRecord({
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    provisionedEnvironment: buildProductionProvisioningFixture(),
    deploymentSummary: buildProductionDeploymentSummaryFixture(),
    originRunIdentity: buildProducerRunIdentityFixture(),
    installId: 'install-prod-topology-v1',
    installedAt: '2026-04-05T04:55:43.000Z',
  });

  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord,
    currentObservation: {
      observed_at: '2026-04-06T08:28:40.000Z',
      environment_id: 'prod',
      current_deployment_identity: null,
      problems: ['Cloudflare must expose exactly one active worker version id for matrix-gateway-worker-prod before production promotion'],
      workers: {
        'jobs-worker': {
          worker_name: 'jobs-worker',
          script_name: 'matrix-jobs-worker-prod',
          latest_active_deployment_id: 'jobs-prod-deployment-v2',
          deployment_ids: ['jobs-prod-deployment-v2'],
          active_worker_version_ids: ['jobs@prod-v2'],
          worker_version_ids: ['jobs@prod-v2'],
          raw_cloudflare_api_results: null,
          error: null,
        },
        'ops-worker': {
          worker_name: 'ops-worker',
          script_name: 'matrix-ops-worker-prod',
          latest_active_deployment_id: 'ops-prod-deployment-v2',
          deployment_ids: ['ops-prod-deployment-v2'],
          active_worker_version_ids: ['ops@prod-v2'],
          worker_version_ids: ['ops@prod-v2'],
          raw_cloudflare_api_results: null,
          error: null,
        },
        'gateway-worker': {
          worker_name: 'gateway-worker',
          script_name: 'matrix-gateway-worker-prod',
          latest_active_deployment_id: 'gateway-prod-deployment-v2',
          deployment_ids: ['gateway-prod-deployment-v2'],
          active_worker_version_ids: ['gateway@prod-v2', 'gateway@prod-v1'],
          worker_version_ids: ['gateway@prod-v2', 'gateway@prod-v1'],
          raw_cloudflare_api_results: null,
          error: null,
        },
      },
    },
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '24033537027' }),
  });

  assert.equal(snapshot.baseline_match.matches, false);
  assert.deepEqual(snapshot.baseline_match.mismatched_fields, ['current_deployment_identity_unavailable']);
  assert.deepEqual(snapshot.baseline_match.problems, [
    'Cloudflare must expose exactly one active worker version id for matrix-gateway-worker-prod before production promotion',
  ]);
});

test('production current state snapshot retains partially successful Cloudflare backreads on normalization failure', () => {
  const baselineRecord = buildProdInstallRecord({
    releaseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    provisionedEnvironment: buildProductionProvisioningFixture(),
    deploymentSummary: buildProductionDeploymentSummaryFixture(),
    originRunIdentity: buildProducerRunIdentityFixture(),
    installId: 'install-prod-topology-v1',
    installedAt: '2026-04-05T04:55:43.000Z',
  });

  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord,
    currentObservation: {
      observed_at: '2026-04-06T08:28:40.000Z',
      environment_id: 'prod',
      current_deployment_identity: null,
      problems: ['Failed to observe current Cloudflare state for matrix-ops-worker-prod: Cloudflare API GET /workers/scripts/matrix-ops-worker-prod/versions failed: versions API temporarily unavailable'],
      workers: {
        'jobs-worker': {
          worker_name: 'jobs-worker',
          script_name: 'matrix-jobs-worker-prod',
          latest_active_deployment_id: 'jobs-prod-deployment-v1',
          deployment_ids: ['jobs-prod-deployment-v1'],
          active_worker_version_ids: ['jobs@prod-v1'],
          worker_version_ids: ['jobs@prod-v1'],
          raw_cloudflare_api_results: null,
          error: null,
        },
        'ops-worker': {
          worker_name: 'ops-worker',
          script_name: 'matrix-ops-worker-prod',
          latest_active_deployment_id: 'ops-prod-deployment-v2',
          deployment_ids: ['ops-prod-deployment-v2'],
          active_worker_version_ids: ['ops@prod-v2'],
          worker_version_ids: [],
          raw_cloudflare_api_results: {
            deployments: {
              deployments: [
                { id: 'ops-prod-deployment-v2', versions: [{ version_id: 'ops@prod-v2' }] },
              ],
            },
            versions: null,
          },
          error: {
            message: 'Cloudflare API GET /workers/scripts/matrix-ops-worker-prod/versions failed: versions API temporarily unavailable',
            response_status: 500,
          },
        },
        'gateway-worker': {
          worker_name: 'gateway-worker',
          script_name: 'matrix-gateway-worker-prod',
          latest_active_deployment_id: 'gateway-prod-deployment-v1',
          deployment_ids: ['gateway-prod-deployment-v1'],
          active_worker_version_ids: ['gateway@prod-v1'],
          worker_version_ids: ['gateway@prod-v1'],
          raw_cloudflare_api_results: null,
          error: null,
        },
      },
    },
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '24033537028' }),
  });

  assert.equal(snapshot.baseline_match.matches, false);
  assert.deepEqual(snapshot.baseline_match.mismatched_fields, ['current_deployment_identity_unavailable']);
  assert.equal(
    snapshot.current_deployment_observation.workers['ops-worker'].raw_cloudflare_api_results.deployments.deployments[0].id,
    'ops-prod-deployment-v2',
  );
  assert.equal(
    snapshot.current_deployment_observation.workers['ops-worker'].latest_active_deployment_id,
    'ops-prod-deployment-v2',
  );
  assert.deepEqual(
    snapshot.current_deployment_observation.workers['ops-worker'].active_worker_version_ids,
    ['ops@prod-v2'],
  );
  assert.equal(
    snapshot.current_deployment_observation.workers['ops-worker'].raw_cloudflare_api_results.versions,
    null,
  );
});

test('usable production current state snapshots validate as baseline-capable artifacts', () => {
  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord: buildProdInstallRecordFixture(),
    currentObservation: buildProdCurrentStateObservationFixture(),
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '24033537029' }),
  });

  assert.deepEqual(
    validateProdCurrentStateSnapshot(snapshot, {
      expectedGitHubRepository: 'VrianCao/MatrixFlare',
      requireUsableBaseline: true,
    }),
    { valid: true, error: null },
  );
});

test('production current state snapshots built from promotion baselines require an explicit protected ops URL and validate once runtime supplies it', () => {
  const promotionRecord = buildProdPromotionRecordFixture();
  const currentObservation = buildProdCurrentStateObservationFixture();
  const originRunIdentity = buildProducerRunIdentityFixture({ runId: '24033537029' });

  assert.throws(
    () => buildProductionCurrentStateSnapshot({
      baselineRecord: promotionRecord,
      currentObservation,
      originRunIdentity,
    }),
    /prod current state snapshot access\.protected_ops_url must be non-empty/u,
  );

  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord: promotionRecord,
    currentObservation,
    originRunIdentity,
    protectedOpsUrl: buildProdInstallRecordFixture().access.protected_ops_url,
  });

  assert.deepEqual(
    validateProdCurrentStateSnapshot(snapshot, {
      expectedGitHubRepository: 'VrianCao/MatrixFlare',
      requireUsableBaseline: true,
    }),
    { valid: true, error: null },
  );
});

test('production current state snapshots cannot be consumed as baselines without full worker closure metadata', () => {
  const snapshot = structuredClone(buildProdCurrentStateSnapshotFixture());
  delete snapshot.workers['gateway-worker'];

  const validation = validateProdCurrentStateSnapshot(snapshot, {
    expectedGitHubRepository: 'VrianCao/MatrixFlare',
    requireUsableBaseline: true,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.error, /workers\.gateway-worker/);
});

test('production current state snapshots stay unusable as baselines when current identity cannot be normalized', () => {
  const snapshot = buildProductionCurrentStateSnapshot({
    baselineRecord: buildProdInstallRecordFixture(),
    currentObservation: {
      observed_at: '2026-04-06T08:28:40.000Z',
      environment_id: 'prod',
      current_deployment_identity: null,
      problems: ['Cloudflare must expose exactly one active worker version id for matrix-gateway-worker-prod before production promotion'],
      workers: {
        'jobs-worker': {
          worker_name: 'jobs-worker',
          script_name: 'matrix-jobs-worker-prod',
          latest_active_deployment_id: 'jobs-prod-deployment-v2',
          deployment_ids: ['jobs-prod-deployment-v2'],
          active_worker_version_ids: ['jobs@prod-v2'],
          worker_version_ids: ['jobs@prod-v2'],
          raw_cloudflare_api_results: null,
          error: null,
        },
        'ops-worker': {
          worker_name: 'ops-worker',
          script_name: 'matrix-ops-worker-prod',
          latest_active_deployment_id: 'ops-prod-deployment-v1',
          deployment_ids: ['ops-prod-deployment-v1'],
          active_worker_version_ids: ['ops@prod-v1'],
          worker_version_ids: ['ops@prod-v1'],
          raw_cloudflare_api_results: null,
          error: null,
        },
        'gateway-worker': {
          worker_name: 'gateway-worker',
          script_name: 'matrix-gateway-worker-prod',
          latest_active_deployment_id: 'gateway-prod-deployment-v1',
          deployment_ids: ['gateway-prod-deployment-v1'],
          active_worker_version_ids: ['gateway@prod-v2', 'gateway@prod-v1'],
          worker_version_ids: ['gateway@prod-v2', 'gateway@prod-v1'],
          raw_cloudflare_api_results: null,
          error: null,
        },
      },
    },
    originRunIdentity: buildProducerRunIdentityFixture({ runId: '24033537030' }),
  });

  const validation = validateProdCurrentStateSnapshot(snapshot, {
    expectedGitHubRepository: 'VrianCao/MatrixFlare',
    requireUsableBaseline: true,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.error, /current_deployment_observation\.current_deployment_identity/);
});

test('observeProductionInstallTopologyState retains raw Cloudflare worker state for active-topology install blockers', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.includes('/workers/scripts/matrix-jobs-worker-prod/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              { id: 'jobs-prod-deployment-v1', versions: [{ version_id: 'jobs@prod-v1' }] },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-jobs-worker-prod/versions')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            items: [
              { id: 'jobs@prod-v1', annotations: { workers_tag: 'mx-jw-d-prod1' } },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-ops-worker-prod/')) {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'This Worker does not exist on your account.' }],
        }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-gateway-worker-prod/deployments')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            deployments: [
              { id: 'gateway-prod-deployment-v1', versions: [{ version_id: 'gateway@prod-v1' }] },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname.includes('/workers/scripts/matrix-gateway-worker-prod/versions')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            items: [
              { id: 'gateway@prod-v1', annotations: { workers_tag: 'mx-gw-d-prod1' } },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected Cloudflare API request in test: ${pathname}`);
    };

    const observation = await observeProductionInstallTopologyState({
      accountId: 'cf-account',
      apiToken: 'cf-token',
    });

    assert.deepEqual(observation.problems, []);
    assert.deepEqual(
      observation.active_workers.map((entry) => entry.script_name),
      ['matrix-jobs-worker-prod', 'matrix-gateway-worker-prod'],
    );
    assert.equal(observation.workers['jobs-worker'].latest_active_deployment_id, 'jobs-prod-deployment-v1');
    assert.deepEqual(
      observation.workers['jobs-worker'].raw_cloudflare_api_results.deployments.deployments,
      [{ id: 'jobs-prod-deployment-v1', versions: [{ version_id: 'jobs@prod-v1' }] }],
    );
    assert.equal(observation.workers['ops-worker'].latest_active_deployment_id, null);
    assert.deepEqual(observation.workers['ops-worker'].deployment_ids, []);
    assert.equal(observation.workers['ops-worker'].raw_cloudflare_api_results, null);
    assert.equal(observation.workers['gateway-worker'].latest_active_deployment_id, 'gateway-prod-deployment-v1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('production automation runtime paths persist current-production-state blocker snapshots before guard failures', async () => {
  const source = await fs.readFile(new URL('../../../packages/testing/src/nonlocal.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /const currentStateSnapshotPath = path\.join\(resolvedWorkingRoot, 'current-production-state\.json'\);\s+await assertProductionTopologyInstallAllowed\(\{\s+accountId,\s+apiToken,\s+observedStatePath: currentStateSnapshotPath,/su,
    'prod-install must capture current-production-state.json before the active-topology guard can fail closed',
  );
  assert.match(
    source,
    /export async function promoteProductionEnvironment[\s\S]*?const currentStateSnapshotPath = path\.join\(resolvedWorkingRoot, 'current-production-state\.json'\);\s+const currentObservation = await observeProductionCurrentCloudflareState\(resolvedBaselineRecord,[\s\S]*?await writeProductionCurrentStateSnapshot\(\{\s+baselineRecord: resolvedBaselineRecord,\s+currentObservation,[\s\S]*?outputPath: currentStateSnapshotPath,[\s\S]*?assertProductionBaselineMatchesCurrentIdentity\(resolvedBaselineRecord, currentIdentity, \{\s+observedStatePath: currentStateSnapshotPath,/su,
    'promote-prod must persist current-production-state.json before failing closed on baseline/current drift',
  );
  assert.match(
    source,
    /export async function operationalRefreshProductionEnvironment[\s\S]*?const currentStateSnapshotPath = path\.join\(resolvedWorkingRoot, 'current-production-state\.json'\);\s+const currentObservation = await observeProductionCurrentCloudflareState\(resolvedBaselineRecord,[\s\S]*?await writeProductionCurrentStateSnapshot\(\{\s+baselineRecord: resolvedBaselineRecord,\s+currentObservation,[\s\S]*?outputPath: currentStateSnapshotPath,[\s\S]*?assertProductionBaselineMatchesCurrentIdentity\(resolvedBaselineRecord, currentIdentity, \{\s+observedStatePath: currentStateSnapshotPath,/su,
    'operational-prod-refresh must persist current-production-state.json before failing closed on baseline/current drift',
  );
  assert.match(
    source,
    /export async function promoteProductionEnvironment[\s\S]*?catch \(error\) \{\s+throw await refreshProductionCurrentStateSnapshotAfterFailure\(\{\s+baselineRecord: resolvedBaselineRecord,\s+currentStateSnapshotPath,\s+originRunIdentity,\s+accountId,\s+apiToken,\s+error,/su,
    'promote-prod must refresh current-production-state.json after partial prod mutation failures',
  );
  assert.match(
    source,
    /export async function operationalRefreshProductionEnvironment[\s\S]*?catch \(error\) \{\s+throw await refreshProductionCurrentStateSnapshotAfterFailure\(\{\s+baselineRecord: resolvedBaselineRecord,\s+currentStateSnapshotPath,\s+originRunIdentity,\s+accountId,\s+apiToken,\s+error,/su,
    'operational-prod-refresh must refresh current-production-state.json after partial prod mutation failures',
  );
  assert.match(
    source,
    /if \(candidateManifest\.requires_do_migration\) \{[\s\S]*?await markProductionCurrentStateSnapshotPotentiallyStale\(currentStateSnapshotPath\);[\s\S]*?const deployedWorker = await deployWorker\(/su,
    'promote-prod must mark the pre-mutation current-production-state snapshot as potentially stale before the first migration-safe prod mutation',
  );
  assert.match(
    source,
    /const jobsUpload = await uploadWorkerVersion\('jobs-worker'[\s\S]*?await markProductionCurrentStateSnapshotPotentiallyStale\(currentStateSnapshotPath\);[\s\S]*?const jobsDeploy = await deployProductionWorkerVersion\(\s+'jobs-worker'/su,
    'promote-prod must mark the pre-mutation current-production-state snapshot as potentially stale before the first gradual prod mutation',
  );
  assert.match(
    source,
    /export async function operationalRefreshProductionEnvironment[\s\S]*?const jobsUpload = await uploadWorkerVersion\('jobs-worker'[\s\S]*?await markProductionCurrentStateSnapshotPotentiallyStale\(currentStateSnapshotPath\);[\s\S]*?const jobsDeploy = await deployProductionWorkerVersion\(\s+'jobs-worker'/su,
    'operational-prod-refresh must mark the pre-mutation current-production-state snapshot as potentially stale before the first prod mutation',
  );
  assert.match(
    source,
    /async function writeProductionCurrentStateSnapshot\(\{[\s\S]*?const snapshot = buildProductionCurrentStateSnapshot\(\{\s+baselineRecord,\s+currentObservation,\s+originRunIdentity,\s+protectedOpsUrl: resolveRuntimeProductionCurrentStateProtectedOpsUrl\(baselineRecord\),[\s\S]*?const temporaryOutputPath = path\.join\([\s\S]*?await fs\.writeFile\(temporaryOutputPath, stableJson\(snapshot\)\);\s+await fs\.rename\(temporaryOutputPath, outputPath\);[\s\S]*?await fs\.rm\(temporaryOutputPath, \{ force: true \}\);/su,
    'prod recovery helpers must derive a truthful prod ops ingress before atomically persisting current-production-state.json so partial writes cannot masquerade as a valid blocker snapshot',
  );
  assert.match(
    source,
    /async function refreshProductionCurrentStateSnapshotAfterFailure[\s\S]*?await markProductionCurrentStateSnapshotPotentiallyStale\(currentStateSnapshotPath\);[\s\S]*?const refreshedObservation = await observeProductionCurrentCloudflareState/su,
    'prod recovery helpers must mark the pre-failure current-production-state snapshot as stale before attempting the post-failure refresh',
  );
  assert.match(
    source,
    /async function refreshProductionCurrentStateSnapshotAfterFailure[\s\S]*?catch \(initialDispositionError\) \{[\s\S]*?await quarantinePotentiallyStaleProductionCurrentStateSnapshot\(currentStateSnapshotPath\);[\s\S]*?await fs\.rm\(currentStateSnapshotPath, \{ force: true \}\);/su,
    'prod recovery helpers must quarantine or delete the stale canonical current-production-state snapshot if the provisional disposition marker cannot be written',
  );
  assert.match(
    source,
    /async function refreshProductionCurrentStateSnapshotAfterFailure[\s\S]*?await quarantinePotentiallyStaleProductionCurrentStateSnapshot\(currentStateSnapshotPath\);[\s\S]*?await fs\.rm\(currentStateSnapshotPath, \{ force: true \}\);/su,
    'prod recovery helpers must remove the canonical current-production-state.json when quarantine itself fails',
  );
  assert.match(
    source,
    /let dispositionPath = provisionalDispositionPath;[\s\S]*?await writeProductionCurrentStateDisposition\(\{/su,
    'prod recovery helpers must preserve the provisional stale-marker path unless a more specific refreshed or quarantined disposition can be written',
  );
  assert.match(
    source,
    /current-production-state-disposition\.json/su,
    'prod recovery helpers must retain an explicit disposition artifact for stale current-production-state handling',
  );
  assert.match(
    source,
    /async function quarantinePotentiallyStaleProductionCurrentStateSnapshot\(currentStateSnapshotPath\)[\s\S]*?pre-failure-current-production-state\.json[\s\S]*?await fs\.rename\(currentStateSnapshotPath, staleSnapshotPath\);/su,
    'prod recovery helpers must quarantine the pre-failure snapshot instead of leaving a stale current-production-state.json in place',
  );
  assert.match(
    source,
    /async function refreshProductionCurrentStateSnapshotAfterFailure[\s\S]*?removed current-production-state snapshot because it may be stale[\s\S]*?preserved the pre-failure snapshot at/su,
    'prod recovery helpers must explicitly mark the current-production-state snapshot unusable when the post-failure refresh cannot be completed',
  );
  assert.match(
    source,
    /const currentStateSnapshotPath = path\.join\(resolvedWorkingRoot, 'current-production-state\.json'\);\s+const currentObservation = await observeProductionCurrentCloudflareState\(promotionRecord,/su,
    'rollback-prod must observe current production state before checking promotionRecord drift',
  );
  assert.match(
    source,
    /await writeProductionCurrentStateSnapshot\(\{\s+baselineRecord: promotionRecord,\s+currentObservation,[\s\S]*?outputPath: currentStateSnapshotPath,/su,
    'rollback-prod must persist current-production-state.json before failing closed on current-state drift',
  );
  assert.match(
    source,
    /assertProductionRecordedIdentityMatchesCurrent\(\s+promotionRecord\.current_deployment_identity,\s+currentIdentity,\s+'promotionRecord\.current_deployment_identity',\s+\{\s+observedStatePath: currentStateSnapshotPath,/su,
    'rollback-prod drift guard must mention the retained current-production-state artifact',
  );
});

test('production workflow YAMLs stay aligned with the prod automation CLI contract', async () => {
  const prodInstallWorkflow = await fs.readFile(new URL('../../../.github/workflows/prod-install.yml', import.meta.url), 'utf8');
  const releaseCandidateWorkflow = await fs.readFile(new URL('../../../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const promoteProdWorkflow = await fs.readFile(new URL('../../../.github/workflows/promote-prod.yml', import.meta.url), 'utf8');
  const operationalRefreshWorkflow = await fs.readFile(new URL('../../../.github/workflows/operational-prod-refresh.yml', import.meta.url), 'utf8');
  const rollbackProdWorkflow = await fs.readFile(new URL('../../../.github/workflows/rollback-prod.yml', import.meta.url), 'utf8');
  const prodCostWorkflow = await fs.readFile(new URL('../../../.github/workflows/prod-cost-monthly.yml', import.meta.url), 'utf8');
  const assertStepOrder = (workflowSource, earlierStepId, laterSnippet, message) => {
    const earlierIndex = workflowSource.indexOf(`id: ${earlierStepId}`);
    const laterIndex = workflowSource.indexOf(laterSnippet);
    assert.ok(earlierIndex !== -1 && laterIndex !== -1 && earlierIndex < laterIndex, message);
  };

  assert.match(prodInstallWorkflow, /environment:\s+prod/u, 'prod-install must run in the protected GitHub prod environment');
  assert.match(prodInstallWorkflow, /node packages\/testing\/src\/cli\.mjs prod-install/u, 'prod-install workflow must invoke the prod-install CLI entry');
  assert.match(prodInstallWorkflow, /--install-id/u, 'prod-install workflow must pass an explicit install id');
  assertStepOrder(prodInstallWorkflow, 'paths', 'id: checkout_release', 'prod-install must define raw-artifact paths before checkout');
  assert.match(prodInstallWorkflow, /id:\s+require_secrets[\s\S]*?continue-on-error:\s+true/u, 'prod-install secret preflight must fail closed only after raw state can be preserved');
  assert.match(prodInstallWorkflow, /id:\s+resolve_release_commit[\s\S]*?continue-on-error:\s+true/u, 'prod-install must preserve raw state when release commit resolution fails');
  assert.match(prodInstallWorkflow, /--release-commit-sha "\$\{\{\s*steps\.resolve_release_commit\.outputs\.release_commit_sha\s*\}\}"/u, 'prod-install must pass the resolved release commit sha into the CLI contract');
  assert.doesNotMatch(prodInstallWorkflow, /--release-commit-sha "\$\{\{\s*steps\.paths\.outputs\.release_commit_sha\s*\}\}"/u, 'prod-install must not source release_commit_sha from unrelated path outputs');
  assert.match(prodInstallWorkflow, /RUNNER_TEMP/u, 'prod-install raw blocker artifacts must live outside the checkout-cleaned workspace');
  assert.match(prodInstallWorkflow, /secret-check\.json/u, 'prod-install must persist a machine-readable secret blocker artifact');
  assert.match(prodInstallWorkflow, /dispatch-request\.json/u, 'prod-install raw state must retain the requested release inputs');
  assert.match(prodInstallWorkflow, /id:\s+install_topology[\s\S]*?continue-on-error:\s+true/u, 'prod-install must preserve raw state before failing closed');
  assert.match(prodInstallWorkflow, /prod-install-raw-state-/u, 'prod-install must upload a dedicated raw-state artifact');

  assertStepOrder(releaseCandidateWorkflow, 'paths', 'id: checkout_release', 'release-candidate must define raw-artifact paths before checkout');
  assert.match(releaseCandidateWorkflow, /node packages\/testing\/src\/cli\.mjs prod-candidate-write/u, 'release-candidate workflow must write a reviewed candidate manifest');
  assert.match(releaseCandidateWorkflow, /\.github\/workflows\/nonlocal-phase08\.yml/u, 'release-candidate workflow must require the reviewed source run to come from nonlocal-phase08');
  assert.match(releaseCandidateWorkflow, /RUNNER_TEMP/u, 'release-candidate raw blocker artifacts must live outside the checkout-cleaned workspace');
  assert.match(releaseCandidateWorkflow, /dispatch-request\.json/u, 'release-candidate raw state must retain the requested source run and release inputs');
  assert.match(releaseCandidateWorkflow, /--ci-integration-attestation/u, 'release-candidate workflow must require ci-integration attestation input');
  assert.match(releaseCandidateWorkflow, /--staging-attestation/u, 'release-candidate workflow must require staging attestation input');
  assert.match(releaseCandidateWorkflow, /--pre-release-attestation/u, 'release-candidate workflow must require pre-release attestation input');
  assert.match(releaseCandidateWorkflow, /id:\s+source_run[\s\S]*?continue-on-error:\s+true/u, 'release-candidate must preserve raw state when source-run metadata resolution fails');
  assert.match(releaseCandidateWorkflow, /id:\s+require_source_match[\s\S]*?continue-on-error:\s+true/u, 'release-candidate must preserve raw state when source-run head validation fails');
  assert.match(releaseCandidateWorkflow, /id:\s+download_reviewed_attestations[\s\S]*?continue-on-error:\s+true/u, 'release-candidate must preserve raw state when attestation download fails');
  assert.match(releaseCandidateWorkflow, /id:\s+write_candidate[\s\S]*?continue-on-error:\s+true/u, 'release-candidate must preserve raw state before failing closed');
  assert.match(releaseCandidateWorkflow, /prod-release-candidate-raw-state-/u, 'release-candidate must upload a dedicated raw-state artifact');

  assert.match(promoteProdWorkflow, /node packages\/testing\/src\/cli\.mjs prod-promote/u, 'promote-prod workflow must invoke the prod-promote CLI entry');
  assert.match(promoteProdWorkflow, /\.github\/workflows\/release-candidate\.yml/u, 'promote-prod workflow must require candidate runs from release-candidate.yml');
  assert.match(promoteProdWorkflow, /\.github\/workflows\/operational-prod-refresh\.yml/u, 'promote-prod workflow must accept operational-prod-refresh as a baseline source');
  assert.match(promoteProdWorkflow, /listWorkflowRunArtifacts/u, 'promote-prod workflow must inspect upstream run artifacts through the GitHub Actions artifacts API');
  assert.match(promoteProdWorkflow, /baseline_artifact_name/u, 'promote-prod workflow must resolve the exact upstream baseline artifact name');
  assert.match(promoteProdWorkflow, /baseline_input_kind/u, 'promote-prod workflow must distinguish record baselines from current-state snapshot baselines');
  assert.match(promoteProdWorkflow, /baseline_input_path/u, 'promote-prod workflow must persist the baseline artifact payload path');
  assert.match(promoteProdWorkflow, /baseline_record_name/u, 'promote-prod workflow must retain the expected baseline record filename for raw current-state recovery');
  assert.match(promoteProdWorkflow, /--baseline-record/u, 'promote-prod workflow must consume a baseline record');
  assert.match(promoteProdWorkflow, /--candidate-manifest/u, 'promote-prod workflow must consume the reviewed candidate manifest');
  assert.match(promoteProdWorkflow, /--promotion-id/u, 'promote-prod workflow must persist an explicit promotion id');
  assert.doesNotMatch(promoteProdWorkflow, /--install-record/u, 'promote-prod workflow must not use the superseded install-record flag');
  assert.doesNotMatch(promoteProdWorkflow, /workers_subdomain:/u, 'promote-prod must not reintroduce manual workers_subdomain input friction');
  assertStepOrder(promoteProdWorkflow, 'paths', 'id: checkout_workflow_ref', 'promote-prod must define raw-artifact paths before checkout');
  assert.match(promoteProdWorkflow, /id:\s+require_secrets[\s\S]*?continue-on-error:\s+true/u, 'promote-prod secret preflight must fail closed only after raw state can be preserved');
  assert.match(promoteProdWorkflow, /RUNNER_TEMP/u, 'promote-prod raw blocker artifacts must live outside the checkout-cleaned workspace');
  assert.match(promoteProdWorkflow, /secret-check\.json/u, 'promote-prod must persist a machine-readable secret blocker artifact');
  assert.match(promoteProdWorkflow, /dispatch-request\.json/u, 'promote-prod raw state must retain the requested candidate and baseline inputs');
  assert.match(promoteProdWorkflow, /id:\s+runs[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when upstream run resolution fails');
  assert.match(promoteProdWorkflow, /id:\s+download_candidate[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when candidate download fails');
  assert.match(promoteProdWorkflow, /id:\s+download_candidate[\s\S]*?merge-multiple:\s+true/u, 'promote-prod must flatten the candidate artifact download so manifest paths resolve deterministically');
  assert.match(promoteProdWorkflow, /id:\s+download_baseline[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when baseline download fails');
  assert.match(promoteProdWorkflow, /id:\s+download_baseline[\s\S]*?merge-multiple:\s+true/u, 'promote-prod must flatten the baseline artifact download so record and current-state paths resolve deterministically');
  assert.match(promoteProdWorkflow, /id:\s+resolve_baseline_input[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when current-state baseline normalization fails');
  assert.match(promoteProdWorkflow, /baseline-resolution\.json/u, 'promote-prod must retain the resolved baseline input details in raw artifacts');
  assert.match(promoteProdWorkflow, /state\/promote\/current-production-state\.json/u, 'promote-prod must be able to recover from a prior promote-prod current-state blocker snapshot');
  assert.match(promoteProdWorkflow, /node packages\/testing\/src\/cli\.mjs prod-raw-state-stage/u, 'promote-prod must stage an exact raw-state upload bundle before artifact upload');
  assert.match(promoteProdWorkflow, /path:\s+\$\{\{\s*steps\.stage_raw_state\.outputs\.upload_root\s*\}\}/u, 'promote-prod must upload the staged raw-state root without mutating blocker evidence');
  assert.match(promoteProdWorkflow, /current-production-state-disposition\.json/u, 'promote-prod raw artifacts must retain an explicit disposition record for stale current-production-state handling');
  assert.match(promoteProdWorkflow, /state\/operational-refresh\/current-production-state\.json/u, 'promote-prod must be able to recover from a prior operational-prod-refresh current-state blocker snapshot');
  assert.match(promoteProdWorkflow, /prod-baseline-resolve/u, 'promote-prod must resolve embedded raw-artifact baseline paths before normalizing current-state blockers');
  assert.match(promoteProdWorkflow, /--baseline-record-name/u, 'promote-prod must pass the expected embedded baseline record filename into the resolver');
  assert.match(promoteProdWorkflow, /node packages\/testing\/src\/cli\.mjs prod-current-state-failure-validate/u, 'promote-prod final gate must validate failure-side current-state artifacts with the dedicated CLI contract');
  assert.match(promoteProdWorkflow, /elif \[ ! -f "\$\{\{\s*steps\.paths\.outputs\.state_root\s*\}\}\/promote\/current-production-state\.json" \]; then/u, 'promote-prod final gate must fail when neither a usable canonical snapshot nor a disposition sidecar survives');
  assert.match(promoteProdWorkflow, /id:\s+candidate[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when candidate sha resolution fails');
  assert.match(promoteProdWorkflow, /id:\s+checkout_candidate[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when candidate checkout fails');
  assert.match(promoteProdWorkflow, /id:\s+require_candidate_checkout_match[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state when candidate checkout validation fails');
  assert.match(promoteProdWorkflow, /id:\s+promote_candidate[\s\S]*?continue-on-error:\s+true/u, 'promote-prod must preserve raw state before failing closed');
  assert.match(promoteProdWorkflow, /prod-promote-raw-state-/u, 'promote-prod must upload a dedicated raw-state artifact');

  assert.match(operationalRefreshWorkflow, /environment:\s+prod/u, 'operational-prod-refresh must run in the protected GitHub prod environment');
  assert.match(operationalRefreshWorkflow, /node packages\/testing\/src\/cli\.mjs prod-operational-refresh/u, 'operational-prod-refresh workflow must invoke the prod-operational-refresh CLI entry');
  assert.match(operationalRefreshWorkflow, /\.github\/workflows\/operational-prod-refresh\.yml/u, 'operational-prod-refresh must permit its own prior runs as future baseline sources');
  assert.match(operationalRefreshWorkflow, /\.github\/workflows\/promote-prod\.yml/u, 'operational-prod-refresh must accept promote-prod as a baseline source');
  assert.match(operationalRefreshWorkflow, /\.github\/workflows\/prod-install\.yml/u, 'operational-prod-refresh must accept prod-install as a baseline source');
  assert.match(operationalRefreshWorkflow, /listWorkflowRunArtifacts/u, 'operational-prod-refresh must inspect upstream run artifacts through the GitHub Actions artifacts API');
  assert.match(operationalRefreshWorkflow, /baseline_artifact_name/u, 'operational-prod-refresh must resolve the exact upstream baseline artifact name');
  assert.match(operationalRefreshWorkflow, /baseline_input_kind/u, 'operational-prod-refresh must distinguish record baselines from current-state snapshot baselines');
  assert.match(operationalRefreshWorkflow, /baseline_input_path/u, 'operational-prod-refresh must persist the baseline artifact payload path');
  assert.match(operationalRefreshWorkflow, /baseline_record_name/u, 'operational-prod-refresh must retain the expected baseline record filename for raw current-state recovery');
  assert.match(operationalRefreshWorkflow, /state\/promote\/current-production-state\.json/u, 'operational-prod-refresh must be able to recover from a prior promote-prod current-state blocker snapshot');
  assert.match(operationalRefreshWorkflow, /node packages\/testing\/src\/cli\.mjs prod-raw-state-stage/u, 'operational-prod-refresh must stage an exact raw-state upload bundle before artifact upload');
  assert.match(operationalRefreshWorkflow, /path:\s+\$\{\{\s*steps\.stage_raw_state\.outputs\.upload_root\s*\}\}/u, 'operational-prod-refresh must upload the staged raw-state root without mutating blocker evidence');
  assert.match(operationalRefreshWorkflow, /current-production-state-disposition\.json/u, 'operational-prod-refresh raw artifacts must retain an explicit disposition record for stale current-production-state handling');
  assert.match(operationalRefreshWorkflow, /state\/operational-refresh\/current-production-state\.json/u, 'operational-prod-refresh must be able to recover from a prior operational refresh current-state blocker snapshot');
  assert.match(operationalRefreshWorkflow, /--baseline-record/u, 'operational-prod-refresh workflow must consume a baseline record');
  assert.match(operationalRefreshWorkflow, /prod-baseline-resolve/u, 'operational-prod-refresh must resolve embedded raw-artifact baseline paths before normalizing current-state blockers');
  assert.match(operationalRefreshWorkflow, /--baseline-record-name/u, 'operational-prod-refresh must pass the expected embedded baseline record filename into the resolver');
  assert.match(operationalRefreshWorkflow, /--promotion-id/u, 'operational-prod-refresh workflow must persist an explicit promotion id');
  assert.match(operationalRefreshWorkflow, /--reason/u, 'operational-prod-refresh workflow must persist the operational reason');
  assert.match(operationalRefreshWorkflow, /--blocked-by-open-questions/u, 'operational-prod-refresh workflow must persist the blocker list');
  assertStepOrder(operationalRefreshWorkflow, 'paths', 'id: checkout_workflow_ref', 'operational-prod-refresh must define raw-artifact paths before checkout');
  assert.match(operationalRefreshWorkflow, /id:\s+require_master_ref[\s\S]*?continue-on-error:\s+true/u, 'operational-prod-refresh must preserve raw state when the dispatch ref is not master');
  assert.match(operationalRefreshWorkflow, /required_ref/u, 'operational-prod-refresh must persist a machine-readable ref gate artifact');
  assert.match(operationalRefreshWorkflow, /refs\/heads\/master/u, 'operational-prod-refresh must fail closed unless dispatched from master');
  assert.match(operationalRefreshWorkflow, /id:\s+require_secrets[\s\S]*?continue-on-error:\s+true/u, 'operational-prod-refresh secret preflight must fail closed only after raw state can be preserved');
  assert.match(operationalRefreshWorkflow, /RUNNER_TEMP/u, 'operational-prod-refresh raw blocker artifacts must live outside the checkout-cleaned workspace');
  assert.match(operationalRefreshWorkflow, /secret-check\.json/u, 'operational-prod-refresh must persist a machine-readable secret blocker artifact');
  assert.match(operationalRefreshWorkflow, /dispatch-request\.json/u, 'operational-prod-refresh raw state must retain the requested baseline and unblock inputs');
  assert.match(operationalRefreshWorkflow, /id:\s+baseline_run[\s\S]*?continue-on-error:\s+true/u, 'operational-prod-refresh must preserve raw state when baseline run resolution fails');
  assert.match(operationalRefreshWorkflow, /id:\s+download_baseline[\s\S]*?continue-on-error:\s+true/u, 'operational-prod-refresh must preserve raw state when baseline download fails');
  assert.match(operationalRefreshWorkflow, /id:\s+download_baseline[\s\S]*?merge-multiple:\s+true/u, 'operational-prod-refresh must flatten the baseline artifact download so recovered baseline paths resolve deterministically');
  assert.match(operationalRefreshWorkflow, /id:\s+resolve_baseline_input[\s\S]*?continue-on-error:\s+true/u, 'operational-prod-refresh must preserve raw state when current-state baseline normalization fails');
  assert.match(operationalRefreshWorkflow, /baseline-resolution\.json/u, 'operational-prod-refresh must retain the resolved baseline input details in raw artifacts');
  assert.match(operationalRefreshWorkflow, /id:\s+operational_refresh[\s\S]*?continue-on-error:\s+true/u, 'operational-prod-refresh must preserve raw state before failing closed');
  assert.match(operationalRefreshWorkflow, /node packages\/testing\/src\/cli\.mjs prod-current-state-failure-validate/u, 'operational-prod-refresh final gate must validate failure-side current-state artifacts with the dedicated CLI contract');
  assert.match(operationalRefreshWorkflow, /elif \[ ! -f "\$\{\{\s*steps\.paths\.outputs\.state_root\s*\}\}\/operational-refresh\/current-production-state\.json" \]; then/u, 'operational-prod-refresh final gate must fail when neither a usable canonical snapshot nor a disposition sidecar survives');
  assert.match(operationalRefreshWorkflow, /prod-operational-refresh-raw-state-/u, 'operational-prod-refresh must upload a dedicated raw-state artifact');

  assert.match(rollbackProdWorkflow, /node packages\/testing\/src\/cli\.mjs prod-rollback/u, 'rollback-prod workflow must invoke the prod-rollback CLI entry');
  assert.match(rollbackProdWorkflow, /\.github\/workflows\/promote-prod\.yml/u, 'rollback-prod workflow must require source runs from promote-prod.yml');
  assertStepOrder(rollbackProdWorkflow, 'paths', 'id: checkout_workflow_ref', 'rollback-prod must define raw-artifact paths before checkout');
  assert.match(rollbackProdWorkflow, /RUNNER_TEMP/u, 'rollback-prod raw blocker artifacts must live outside the checkout-cleaned workspace');
  assert.match(rollbackProdWorkflow, /--promotion-record/u, 'rollback-prod workflow must consume the promotion record artifact');
  assert.match(rollbackProdWorkflow, /--rollback-id/u, 'rollback-prod workflow must persist an explicit rollback id');
  assert.equal((rollbackProdWorkflow.match(/uses:\s+actions\/checkout@v4/gu) ?? []).length, 1, 'rollback-prod must not perform a second checkout to the promoted commit');
  assert.match(rollbackProdWorkflow, /dispatch-request\.json/u, 'rollback-prod raw state must retain the requested promotion input');
  assert.doesNotMatch(rollbackProdWorkflow, /Resolve promotion commit sha/u, 'rollback-prod must not require a promotion commit checkout precondition');
  assert.doesNotMatch(rollbackProdWorkflow, /workers_subdomain:/u, 'rollback-prod must not reintroduce manual workers_subdomain input friction');
  assert.match(rollbackProdWorkflow, /id:\s+promotion_run[\s\S]*?continue-on-error:\s+true/u, 'rollback-prod must preserve raw state when source promotion metadata resolution fails');
  assert.match(rollbackProdWorkflow, /id:\s+download_promotion_record[\s\S]*?continue-on-error:\s+true/u, 'rollback-prod must preserve raw state when promotion record download fails');
  assert.match(rollbackProdWorkflow, /id:\s+execute_rollback[\s\S]*?continue-on-error:\s+true/u, 'rollback-prod must preserve raw state before failing closed');
  assert.match(rollbackProdWorkflow, /prod-rollback-raw-state-/u, 'rollback-prod must upload a dedicated raw-state artifact');

  assertStepOrder(prodCostWorkflow, 'paths', 'id: checkout_workflow_ref', 'prod-cost-monthly must define raw-artifact paths before checkout');
  assert.match(prodCostWorkflow, /node packages\/testing\/src\/cli\.mjs prod-cost-snapshot/u, 'prod-cost-monthly must capture the monthly production cost snapshot');
  assert.match(prodCostWorkflow, /cron:\s*'17 3 1 \* \*'/u, 'prod-cost-monthly must run on a monthly UTC schedule in addition to manual dispatch');
  assert.match(prodCostWorkflow, /RUNNER_TEMP/u, 'prod-cost-monthly raw blocker artifacts must live outside the checkout-cleaned workspace');
  assert.match(prodCostWorkflow, /actions:\s+read/u, 'prod-cost-monthly must request actions:read so it can download the prod install baseline artifact');
  assert.match(prodCostWorkflow, /node packages\/testing\/src\/cli\.mjs prod-cost-billing-window/u, 'prod-cost-monthly must resolve the closed billing window through the billing-profile CLI entry');
  assert.match(prodCostWorkflow, /billing-profile\.json/u, 'prod-cost-monthly raw artifacts must retain the billing-profile lookup payload');
  assert.match(prodCostWorkflow, /workflow_id:\s+'prod-install\.yml'/u, 'prod-cost-monthly must resolve the latest successful prod-install baseline run');
  assert.match(prodCostWorkflow, /pattern:\s+prod-install-record-\*-\$\{\{\s*steps\.install_run\.outputs\.install_run_id\s*\}\}-\$\{\{\s*steps\.install_run\.outputs\.install_run_attempt\s*\}\}/u, 'prod-cost-monthly must download the prod install record artifact for the current baseline');
  assert.match(prodCostWorkflow, /--billing-window/u, 'prod-cost-monthly must pass the resolved billing-window payload into prod-cost snapshot capture');
  assert.match(prodCostWorkflow, /--install-record/u, 'prod-cost-monthly must pass the prod install record baseline into prod-cost snapshot capture');
  assert.match(prodCostWorkflow, /credentials-check\.json/u, 'prod-cost-monthly must persist a machine-readable credentials blocker artifact');
  assert.match(prodCostWorkflow, /node packages\/testing\/src\/cli\.mjs prod-cost-provenance/u, 'prod-cost-monthly must emit provenance before attestation');
  assert.match(prodCostWorkflow, /prod-cost-attestation-/u, 'prod-cost-monthly must upload a dedicated prod-cost attestation artifact');
  assert.match(prodCostWorkflow, /id:\s+capture_snapshot[\s\S]*?continue-on-error:\s+true/u, 'prod-cost-monthly must preserve raw blocker artifacts before failing closed');
  assert.match(prodCostWorkflow, /if:\s+always\(\)/u, 'prod-cost-monthly must keep raw artifact preservation steps on always()');
});

test('prod cost snapshot capture requires the GitHub Actions prod environment claim', async () => {
  await assert.rejects(
    () => captureProdCostSnapshot({
      runTimestamp: '20260405T010203Z',
      artifactRoot: '/tmp/unused-prod-cost-artifacts',
      outputPath: '/tmp/unused-prod-cost-snapshot.json',
    }, {
      requireGitHubActionsExecutionImpl: async (operationName, {
        expectedEnvironmentName = null,
      } = {}) => {
        assert.equal(operationName, 'captureProdCostSnapshot');
        assert.equal(expectedEnvironmentName, 'prod');
        throw new Error('stop after verifying expected prod environment');
      },
    }),
    /stop after verifying expected prod environment/,
  );
});

test('prod cost billing window resolution derives the latest closed billing period from Cloudflare next_bill_date', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-billing-window-'));
  const outputPath = path.join(tempRoot, 'billing-window.json');
  const profileOutputPath = path.join(tempRoot, 'billing-profile.json');

  try {
    const result = await resolveClosedProdBillingWindow({
      artifactRoot: tempRoot,
      outputPath,
      profileOutputPath,
    }, {
      requireGitHubActionsExecutionImpl: async (operationName, {
        expectedEnvironmentName = null,
      } = {}) => {
        assert.equal(operationName, 'resolveClosedProdBillingWindow');
        assert.equal(expectedEnvironmentName, 'prod');
        return {
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        };
      },
      requireCloudflareCredentialsImpl: () => ({
        accountId: 'cf-account',
        apiToken: 'cf-token',
      }),
      callCloudflareApiImpl: async ({ pathname }) => {
        assert.equal(pathname, '/billing/profile');
        return {
          success: true,
          result: {
            next_bill_date: '2026-05-15T12:21:59.3456Z',
          },
        };
      },
      now: new Date('2026-05-05T00:00:00.000Z'),
    });

    assert.equal(result.from_date, '2026-03-16');
    assert.equal(result.to_date, '2026-04-15');
    assert.deepEqual(
      JSON.parse(await fs.readFile(outputPath, 'utf8')),
      {
        resolution_method: 'cloudflare-account-billing-profile-next-bill-date',
        next_bill_date: '2026-05-15T12:21:59.3456Z',
        from_date: '2026-03-16',
        to_date: '2026-04-15',
      },
    );
    assert.equal(
      JSON.parse(await fs.readFile(profileOutputPath, 'utf8')).result.next_bill_date,
      '2026-05-15T12:21:59.3456Z',
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost billing window resolution falls back to account subscriptions current_period_end when billing profile omits next_bill_date', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-billing-window-subscriptions-'));
  const outputPath = path.join(tempRoot, 'billing-window.json');
  const profileOutputPath = path.join(tempRoot, 'billing-profile.json');

  try {
    const result = await resolveClosedProdBillingWindow({
      artifactRoot: tempRoot,
      outputPath,
      profileOutputPath,
    }, {
      requireGitHubActionsExecutionImpl: async () => ({
        repository: 'VrianCao/MatrixFlare',
        run_id: '81234',
      }),
      requireCloudflareCredentialsImpl: () => ({
        accountId: 'cf-account',
        apiToken: 'cf-token',
      }),
      callCloudflareApiImpl: async ({ pathname }) => {
        if (pathname === '/billing/profile') {
          return {
            success: true,
            result: {},
          };
        }
        if (pathname === '/subscriptions') {
          return {
            success: true,
            result: [
              {
                id: 'sub-workers-paid',
                current_period_end: '2026-05-15T12:21:59.3456Z',
              },
              {
                id: 'sub-r2',
                current_period_end: '2026-05-15T12:21:59.3456Z',
              },
            ],
          };
        }
        throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
      },
      now: new Date('2026-05-05T00:00:00.000Z'),
    });

    assert.equal(result.from_date, '2026-03-16');
    assert.equal(result.to_date, '2026-04-15');
    assert.equal(result.resolution_method, 'cloudflare-account-subscriptions-current-period-end');
    assert.deepEqual(
      JSON.parse(await fs.readFile(outputPath, 'utf8')),
      {
        resolution_method: 'cloudflare-account-subscriptions-current-period-end',
        next_bill_date: '2026-05-15T12:21:59.3456Z',
        from_date: '2026-03-16',
        to_date: '2026-04-15',
      },
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(tempRoot, 'billing-subscriptions.json'), 'utf8')).result.map((entry) => entry.current_period_end),
      ['2026-05-15T12:21:59.3456Z', '2026-05-15T12:21:59.3456Z'],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost billing window resolution does not mask billing profile transport failures with subscriptions fallback', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-billing-window-profile-error-'));
  const outputPath = path.join(tempRoot, 'billing-window.json');
  const profileOutputPath = path.join(tempRoot, 'billing-profile.json');

  try {
    await assert.rejects(
      () => resolveClosedProdBillingWindow({
        artifactRoot: tempRoot,
        outputPath,
        profileOutputPath,
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/profile') {
            throw new Error('billing profile request returned 403');
          }
          if (pathname === '/subscriptions') {
            throw new Error('subscriptions fallback should not be called');
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
      }),
      /billing profile request returned 403/,
    );

    assert.match(JSON.parse(await fs.readFile(outputPath, 'utf8')).error, /billing profile request returned 403/u);
    assert.deepEqual(
      JSON.parse(await fs.readFile(outputPath, 'utf8')).attempted_resolution_methods,
      [],
    );
    assert.match(JSON.parse(await fs.readFile(profileOutputPath, 'utf8')).error, /billing profile request returned 403/u);
    await assert.rejects(
      fs.stat(path.join(tempRoot, 'billing-subscriptions.json')),
      /ENOENT/u,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost billing window resolution preserves blocker artifacts when both billing cycle anchors are invalid', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-billing-window-invalid-'));
  const outputPath = path.join(tempRoot, 'billing-window.json');
  const profileOutputPath = path.join(tempRoot, 'billing-profile.json');

  try {
    await assert.rejects(
      () => resolveClosedProdBillingWindow({
        artifactRoot: tempRoot,
        outputPath,
        profileOutputPath,
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/profile') {
            return {
              success: true,
              result: {},
            };
          }
          if (pathname === '/subscriptions') {
            return {
              success: true,
              result: [
                { id: 'sub-workers-paid' },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-05-05T00:00:00.000Z'),
      }),
      /billing cycle anchor resolution failed/,
    );

    assert.deepEqual(
      JSON.parse(await fs.readFile(outputPath, 'utf8')),
      {
        resolution_method: null,
        attempted_resolution_methods: [
          'cloudflare-account-billing-profile-next-bill-date',
          'cloudflare-account-subscriptions-current-period-end',
        ],
        error: 'Cloudflare billing cycle anchor resolution failed: billing profile response omitted next_bill_date, and subscriptions fallback failed with "Cloudflare account subscriptions must include at least one valid current_period_end"',
      },
    );
    assert.deepEqual(JSON.parse(await fs.readFile(profileOutputPath, 'utf8')).result, {});
    assert.match(JSON.parse(await fs.readFile(path.join(tempRoot, 'billing-subscriptions.json'), 'utf8')).error, /current_period_end/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost billing window resolution fails closed when subscriptions expose conflicting current_period_end anchors', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-billing-window-conflicting-'));
  const outputPath = path.join(tempRoot, 'billing-window.json');
  const profileOutputPath = path.join(tempRoot, 'billing-profile.json');

  try {
    await assert.rejects(
      () => resolveClosedProdBillingWindow({
        artifactRoot: tempRoot,
        outputPath,
        profileOutputPath,
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/profile') {
            return {
              success: true,
              result: {},
            };
          }
          if (pathname === '/subscriptions') {
            return {
              success: true,
              result: [
                {
                  id: 'sub-workers-paid',
                  current_period_end: '2026-05-15T12:21:59.3456Z',
                },
                {
                  id: 'sub-r2',
                  current_period_end: '2026-05-20T12:21:59.3456Z',
                },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-05-05T00:00:00.000Z'),
      }),
      /multiple current_period_end anchors/,
    );

    assert.deepEqual(
      JSON.parse(await fs.readFile(outputPath, 'utf8')),
      {
        resolution_method: null,
        attempted_resolution_methods: [
          'cloudflare-account-billing-profile-next-bill-date',
          'cloudflare-account-subscriptions-current-period-end',
        ],
        error: 'Cloudflare billing cycle anchor resolution failed: billing profile response omitted next_bill_date, and subscriptions fallback failed with "Cloudflare account subscriptions returned multiple current_period_end anchors: 2026-05-15T12:21:59.3456Z, 2026-05-20T12:21:59.3456Z"',
      },
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(tempRoot, 'billing-subscriptions.json'), 'utf8')).subscriptions_payload.result.map((entry) => entry.current_period_end),
      ['2026-05-15T12:21:59.3456Z', '2026-05-20T12:21:59.3456Z'],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost billing window resolution rejects stale next_bill_date values', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-billing-window-stale-'));
  const outputPath = path.join(tempRoot, 'billing-window.json');
  const profileOutputPath = path.join(tempRoot, 'billing-profile.json');

  try {
    await assert.rejects(
      () => resolveClosedProdBillingWindow({
        artifactRoot: tempRoot,
        outputPath,
        profileOutputPath,
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        callCloudflareApiImpl: async () => ({
          success: true,
          result: {
            next_bill_date: '2026-01-15T12:21:59.3456Z',
          },
        }),
        now: new Date('2026-05-05T00:00:00.000Z'),
      }),
      /must not be earlier than the current UTC date/,
    );

    assert.match(JSON.parse(await fs.readFile(outputPath, 'utf8')).error, /must not be earlier than the current UTC date/u);
    assert.match(JSON.parse(await fs.readFile(profileOutputPath, 'utf8')).error, /must not be earlier than the current UTC date/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost snapshot capture normalizes official billing usage into a valid prod_cost_snapshot payload', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-snapshot-'));
  const outputPath = path.join(tempRoot, 'snapshot.json');
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const runTimestamp = '20260405T010203Z';
  const billingRecords = [
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 1,
      ConsumedUnit: 'Month',
      ContractedCost: 5,
      PricingQuantity: 1,
      ServiceName: 'Workers Paid Plan',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 12_000_000,
      ConsumedUnit: 'Requests',
      ContractedCost: 0.6,
      PricingQuantity: 12_000_000,
      ServiceName: 'Workers Standard',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 35_000_000,
      ConsumedUnit: 'CPU Milliseconds',
      ContractedCost: 0.1,
      PricingQuantity: 35_000_000,
      ServiceName: 'Workers Standard',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 25_000_000,
      ConsumedUnit: 'Log Events Written',
      ContractedCost: 3,
      PricingQuantity: 25_000_000,
      ServiceName: 'Workers Logs',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 1_500_000,
      ConsumedUnit: 'Requests',
      ContractedCost: 0.075,
      PricingQuantity: 1_500_000,
      ServiceName: 'Durable Objects',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 500_000,
      ConsumedUnit: 'Duration GB-s',
      ContractedCost: 1.25,
      PricingQuantity: 500_000,
      ServiceName: 'Durable Objects',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 26_000_000_000,
      ConsumedUnit: 'Rows Read',
      ContractedCost: 1,
      PricingQuantity: 26_000_000_000,
      ServiceName: 'Durable Objects',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 52_000_000,
      ConsumedUnit: 'Rows Written',
      ContractedCost: 2,
      PricingQuantity: 52_000_000,
      ServiceName: 'Durable Objects',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 7,
      ConsumedUnit: 'SQL Storage GB-Month',
      ContractedCost: 0.4,
      PricingQuantity: 7,
      ServiceName: 'Durable Objects',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 26_000_000_000,
      ConsumedUnit: 'Rows Read',
      ContractedCost: 1,
      PricingQuantity: 26_000_000_000,
      ServiceName: 'D1',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 51_000_000,
      ConsumedUnit: 'Rows Written',
      ContractedCost: 1,
      PricingQuantity: 51_000_000,
      ServiceName: 'D1',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 6,
      ConsumedUnit: 'Storage GB-Month',
      ContractedCost: 0.75,
      PricingQuantity: 6,
      ServiceName: 'D1',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 12,
      ConsumedUnit: 'Storage GB-Month',
      ContractedCost: 0.03,
      PricingQuantity: 12,
      ServiceName: 'R2',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 2_000_000,
      ConsumedUnit: 'Class A Operations',
      ContractedCost: 4.5,
      PricingQuantity: 2_000_000,
      ServiceName: 'R2',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 12_000_000,
      ConsumedUnit: 'Class B Operations',
      ContractedCost: 0.72,
      PricingQuantity: 12_000_000,
      ServiceName: 'R2',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 12_000_000,
      ConsumedUnit: 'Keys Read',
      ContractedCost: 1,
      PricingQuantity: 12_000_000,
      ServiceName: 'Workers KV',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 2_000_000,
      ConsumedUnit: 'Keys Written',
      ContractedCost: 5,
      PricingQuantity: 2_000_000,
      ServiceName: 'Workers KV',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 1_500_000,
      ConsumedUnit: 'Keys Deleted',
      ContractedCost: 2.5,
      PricingQuantity: 1_500_000,
      ServiceName: 'Workers KV',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 1_400_000,
      ConsumedUnit: 'List Requests',
      ContractedCost: 2,
      PricingQuantity: 1_400_000,
      ServiceName: 'Workers KV',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 2,
      ConsumedUnit: 'Storage GB-Month',
      ContractedCost: 0.5,
      PricingQuantity: 2,
      ServiceName: 'Workers KV',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 300_000,
      ConsumedUnit: 'Write Operations',
      ContractedCost: 0,
      PricingQuantity: 300_000,
      ServiceName: 'Queues',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 300_000,
      ConsumedUnit: 'Read Operations',
      ContractedCost: 0,
      PricingQuantity: 300_000,
      ServiceName: 'Queues',
    },
    {
      BillingCurrency: 'USD',
      BillingPeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodStart: '2026-02-16T00:00:00Z',
      ChargePeriodEnd: '2026-03-15T00:00:00Z',
      ConsumedQuantity: 300_000,
      ConsumedUnit: 'Delete Operations',
      ContractedCost: 0,
      PricingQuantity: 300_000,
      ServiceName: 'Queues',
    },
  ];

  try {
    const result = await captureProdCostSnapshot({
      runTimestamp,
      artifactRoot,
      outputPath,
      billingWindow: buildResolvedProdBillingWindowFixture(),
      prodInstallRecord: buildProdInstallRecordFixture(),
    }, {
      requireGitHubActionsExecutionImpl: async (operationName, {
        expectedEnvironmentName = null,
      } = {}) => {
        assert.equal(operationName, 'captureProdCostSnapshot');
        assert.equal(expectedEnvironmentName, 'prod');
        return {
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        };
      },
      requireCloudflareCredentialsImpl: () => ({
        accountId: 'cf-account',
        apiToken: 'cf-token',
      }),
      fetchWorkerDeploymentStateImpl: async ({ scriptName }) => ({
        deployment_ids: [`${scriptName}-dep`],
        active_worker_version_ids: [`${scriptName}-ver`],
        latest_active_deployment_id: `${scriptName}-dep`,
        worker_version_ids: [`${scriptName}-ver`],
      }),
      fetchWorkerBindingStateImpl: async ({ scriptName }) => {
        assert.equal(scriptName, 'matrix-gateway-worker-prod');
        return {
          ratelimit_namespace_ids: Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
            .map((definition) => definition.default_namespace_id)
            .sort(),
        };
      },
      callCloudflareApiImpl: async ({ pathname }) => {
        if (pathname === '/billing/usage/paygo?from=2026-02-16&to=2026-03-15') {
          return {
            success: true,
            result: billingRecords,
          };
        }
        if (pathname === '/workers/scripts') {
          return {
            success: true,
            result: [
              { id: 'matrix-gateway-worker-prod' },
              { id: 'matrix-jobs-worker-prod' },
              { id: 'matrix-ops-worker-prod' },
            ],
          };
        }
        if (pathname === '/d1/database') {
          return {
            success: true,
            result: [{ name: 'matrix-control-and-derived-prod', uuid: 'd1-prod' }],
          };
        }
        if (pathname === '/storage/kv/namespaces') {
          return {
            success: true,
            result: [{ title: 'matrix-edge-cache-prod', id: 'kv-prod' }],
          };
        }
        if (pathname === '/r2/buckets') {
          return {
            success: true,
            result: {
              buckets: [
                { name: 'matrix-archive-prod' },
                { name: 'matrix-evidence-prod' },
                { name: 'matrix-media-prod' },
              ],
            },
          };
        }
        if (pathname === '/queues') {
          return {
            success: true,
            result: [
              { queue_name: 'matrix-search-index-job-prod' },
              { queue_name: 'matrix-media-thumbnail-job-prod' },
              { queue_name: 'matrix-appservice-txn-job-prod' },
              { queue_name: 'matrix-rebuild-shard-job-prod' },
              { queue_name: 'matrix-export-shard-job-prod' },
              { queue_name: 'matrix-restore-shard-job-prod' },
              { queue_name: 'matrix-repair-shard-job-prod' },
            ],
          };
        }
        throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
      },
      now: new Date('2026-04-05T00:00:00.000Z'),
    });

    const snapshot = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const validation = validateManualArtifactPayload('prod_cost_snapshot', snapshot, { runTimestamp });
    assert.deepEqual(validation, { valid: true, error: null });
    assert.equal(result.snapshot.model_comparison.status, 'within_expected');
    assert.equal(result.snapshot.model_comparison.actual_total_usd, result.snapshot.model_comparison.modeled_total_usd);
    assert.equal(result.snapshot.cost_surfaces.workers.request_count, 12_000_000);
    assert.equal(result.snapshot.cost_surfaces.durable_objects.sql_storage_gb_month, 7);
    assert.equal(result.snapshot.cost_surfaces.d1.storage_gb_month, 6);
    assert.equal(result.snapshot.cost_surfaces.kv.storage_gb_month, 2);
    assert.equal(result.snapshot.cost_surfaces.queues.write_ops, 300_000);
    assert.equal(result.snapshot.source_dashboard_uri, 'https://api.cloudflare.com/client/v4/accounts/cf-account/billing/usage/paygo?from=2026-02-16&to=2026-03-15');
    assert.equal(result.snapshot.billing_window_resolution_method, 'cloudflare-account-billing-profile-next-bill-date');
    assert.equal(result.snapshot.billing_cycle_anchor_source_uri, 'https://api.cloudflare.com/client/v4/accounts/cf-account/billing/profile');
    assert.deepEqual(result.snapshot.billing_cycle_anchor_artifact, {
      artifact_path: 'billing-profile.json',
      field_selector: 'result.next_bill_date',
    });
    assert.equal(result.snapshot.billing_cycle_next_bill_date, '2026-04-15T12:21:59.345Z');
    assert.equal(result.snapshot.topology_baseline_install.install_id, 'install-prod-topology-v1');
    assert.ok(await fs.stat(path.join(artifactRoot, 'billing-usage-paygo.json')));
    assert.ok(await fs.stat(path.join(artifactRoot, 'prod-resource-snapshot.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost snapshot capture requires a resolved closed billing window and a post-install baseline', async () => {
  await assert.rejects(
    () => captureProdCostSnapshot({
      runTimestamp: '20260405T010203Z',
      artifactRoot: '/tmp/unused-prod-cost-artifacts',
      outputPath: '/tmp/unused-prod-cost-snapshot.json',
      prodInstallRecord: buildProdInstallRecordFixture(),
    }, {
      requireGitHubActionsExecutionImpl: async () => ({
        repository: 'VrianCao/MatrixFlare',
        run_id: '81234',
      }),
      requireCloudflareCredentialsImpl: () => ({
        accountId: 'cf-account',
        apiToken: 'cf-token',
      }),
      now: new Date('2026-04-05T00:00:00.000Z'),
    }),
    /resolved production billing window must be an object/,
  );

  await assert.rejects(
    () => captureProdCostSnapshot({
      runTimestamp: '20260405T010203Z',
      artifactRoot: '/tmp/unused-prod-cost-artifacts',
      outputPath: '/tmp/unused-prod-cost-snapshot.json',
      billingWindow: buildResolvedProdBillingWindowFixture(),
      prodInstallRecord: buildProdInstallRecordFixture({
        installedAt: '2026-02-16T08:00:00.000Z',
      }),
    }, {
      requireGitHubActionsExecutionImpl: async () => ({
        repository: 'VrianCao/MatrixFlare',
        run_id: '81234',
      }),
      requireCloudflareCredentialsImpl: () => ({
        accountId: 'cf-account',
        apiToken: 'cf-token',
      }),
      now: new Date('2026-04-05T00:00:00.000Z'),
    }),
    /starts after prod install date 2026-02-16/,
  );
});

test('prod cost snapshot capture rejects billing usage rows that do not match the requested closed billing window', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-snapshot-wrong-window-'));

  try {
    await assert.rejects(
      () => captureProdCostSnapshot({
        runTimestamp: '20260405T010203Z',
        artifactRoot: path.join(tempRoot, 'artifacts'),
        outputPath: path.join(tempRoot, 'snapshot.json'),
        billingWindow: buildResolvedProdBillingWindowFixture(),
        prodInstallRecord: buildProdInstallRecordFixture(),
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        fetchWorkerDeploymentStateImpl: async ({ scriptName }) => ({
          deployment_ids: [`${scriptName}-dep`],
          active_worker_version_ids: [`${scriptName}-ver`],
          latest_active_deployment_id: `${scriptName}-dep`,
          worker_version_ids: [`${scriptName}-ver`],
        }),
        fetchWorkerBindingStateImpl: async () => ({
          ratelimit_namespace_ids: Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
            .map((definition) => definition.default_namespace_id)
            .sort(),
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/usage/paygo?from=2026-02-16&to=2026-03-15') {
            return {
              success: true,
              result: buildMinimalProdBillingUsageRecords({
                billingPeriodStart: '2026-01-16T00:00:00Z',
              }),
            };
          }
          if (pathname === '/workers/scripts') {
            return {
              success: true,
              result: [
                { id: 'matrix-gateway-worker-prod' },
                { id: 'matrix-jobs-worker-prod' },
                { id: 'matrix-ops-worker-prod' },
              ],
            };
          }
          if (pathname === '/d1/database') {
            return {
              success: true,
              result: [{ name: 'matrix-control-and-derived-prod', uuid: 'd1-prod' }],
            };
          }
          if (pathname === '/storage/kv/namespaces') {
            return {
              success: true,
              result: [{ title: 'matrix-edge-cache-prod', id: 'kv-prod' }],
            };
          }
          if (pathname === '/r2/buckets') {
            return {
              success: true,
              result: {
                buckets: [
                  { name: 'matrix-archive-prod' },
                  { name: 'matrix-evidence-prod' },
                  { name: 'matrix-media-prod' },
                ],
              },
            };
          }
          if (pathname === '/queues') {
            return {
              success: true,
              result: [
                { queue_name: 'matrix-search-index-job-prod' },
                { queue_name: 'matrix-media-thumbnail-job-prod' },
                { queue_name: 'matrix-appservice-txn-job-prod' },
                { queue_name: 'matrix-rebuild-shard-job-prod' },
                { queue_name: 'matrix-export-shard-job-prod' },
                { queue_name: 'matrix-restore-shard-job-prod' },
                { queue_name: 'matrix-repair-shard-job-prod' },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-04-05T00:00:00.000Z'),
      }),
      /BillingPeriodStart .* does not match requested production billing window start/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost snapshot capture fails closed when the billing account still contains non-production Matrix resources', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-snapshot-overlap-'));

  try {
    await assert.rejects(
      () => captureProdCostSnapshot({
        runTimestamp: '20260405T010203Z',
        artifactRoot: path.join(tempRoot, 'artifacts'),
        outputPath: path.join(tempRoot, 'snapshot.json'),
        billingWindow: buildResolvedProdBillingWindowFixture(),
        prodInstallRecord: buildProdInstallRecordFixture(),
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        fetchWorkerDeploymentStateImpl: async ({ scriptName }) => ({
          deployment_ids: [`${scriptName}-dep`],
          active_worker_version_ids: [`${scriptName}-ver`],
          latest_active_deployment_id: `${scriptName}-dep`,
          worker_version_ids: [`${scriptName}-ver`],
        }),
        fetchWorkerBindingStateImpl: async () => ({
          ratelimit_namespace_ids: Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
            .map((definition) => definition.default_namespace_id)
            .sort(),
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/usage/paygo?from=2026-02-16&to=2026-03-15') {
            return {
              success: true,
              result: buildMinimalProdBillingUsageRecords(),
            };
          }
          if (pathname === '/workers/scripts') {
            return {
              success: true,
              result: [
                { id: 'matrix-gateway-worker-prod' },
                { id: 'matrix-jobs-worker-prod' },
                { id: 'matrix-ops-worker-prod' },
                { id: buildWorkerScriptName('gateway-worker', 'staging') },
              ],
            };
          }
          if (pathname === '/d1/database') {
            return {
              success: true,
              result: [{ name: 'matrix-control-and-derived-prod', uuid: 'd1-prod' }],
            };
          }
          if (pathname === '/storage/kv/namespaces') {
            return {
              success: true,
              result: [{ title: 'matrix-edge-cache-prod', id: 'kv-prod' }],
            };
          }
          if (pathname === '/r2/buckets') {
            return {
              success: true,
              result: {
                buckets: [
                  { name: 'matrix-archive-prod' },
                  { name: 'matrix-evidence-prod' },
                  { name: 'matrix-media-prod' },
                ],
              },
            };
          }
          if (pathname === '/queues') {
            return {
              success: true,
              result: [
                { queue_name: 'matrix-search-index-job-prod' },
                { queue_name: 'matrix-media-thumbnail-job-prod' },
                { queue_name: 'matrix-appservice-txn-job-prod' },
                { queue_name: 'matrix-rebuild-shard-job-prod' },
                { queue_name: 'matrix-export-shard-job-prod' },
                { queue_name: 'matrix-restore-shard-job-prod' },
                { queue_name: 'matrix-repair-shard-job-prod' },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-04-05T00:00:00.000Z'),
      }),
      /account-scoped.*non-production Matrix resources/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost snapshot capture fails closed when the billing account still contains unexpected non-Matrix resources', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-snapshot-unexpected-resource-'));

  try {
    await assert.rejects(
      () => captureProdCostSnapshot({
        runTimestamp: '20260405T010203Z',
        artifactRoot: path.join(tempRoot, 'artifacts'),
        outputPath: path.join(tempRoot, 'snapshot.json'),
        billingWindow: buildResolvedProdBillingWindowFixture(),
        prodInstallRecord: buildProdInstallRecordFixture(),
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        fetchWorkerDeploymentStateImpl: async ({ scriptName }) => ({
          deployment_ids: [`${scriptName}-dep`],
          active_worker_version_ids: [`${scriptName}-ver`],
          latest_active_deployment_id: `${scriptName}-dep`,
          worker_version_ids: [`${scriptName}-ver`],
        }),
        fetchWorkerBindingStateImpl: async () => ({
          ratelimit_namespace_ids: Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
            .map((definition) => definition.default_namespace_id)
            .sort(),
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/usage/paygo?from=2026-02-16&to=2026-03-15') {
            return {
              success: true,
              result: buildMinimalProdBillingUsageRecords(),
            };
          }
          if (pathname === '/workers/scripts') {
            return {
              success: true,
              result: [
                { id: 'matrix-gateway-worker-prod' },
                { id: 'matrix-jobs-worker-prod' },
                { id: 'matrix-ops-worker-prod' },
                { id: 'unrelated-worker-script' },
              ],
            };
          }
          if (pathname === '/d1/database') {
            return {
              success: true,
              result: [{ name: 'matrix-control-and-derived-prod', uuid: 'd1-prod' }],
            };
          }
          if (pathname === '/storage/kv/namespaces') {
            return {
              success: true,
              result: [{ title: 'matrix-edge-cache-prod', id: 'kv-prod' }],
            };
          }
          if (pathname === '/r2/buckets') {
            return {
              success: true,
              result: {
                buckets: [
                  { name: 'matrix-archive-prod' },
                  { name: 'matrix-evidence-prod' },
                  { name: 'matrix-media-prod' },
                ],
              },
            };
          }
          if (pathname === '/queues') {
            return {
              success: true,
              result: [
                { queue_name: 'matrix-search-index-job-prod' },
                { queue_name: 'matrix-media-thumbnail-job-prod' },
                { queue_name: 'matrix-appservice-txn-job-prod' },
                { queue_name: 'matrix-rebuild-shard-job-prod' },
                { queue_name: 'matrix-export-shard-job-prod' },
                { queue_name: 'matrix-restore-shard-job-prod' },
                { queue_name: 'matrix-repair-shard-job-prod' },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-04-05T00:00:00.000Z'),
      }),
      /unexpected non-Matrix Cloudflare resources/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost snapshot capture rejects multiple active worker versions in the production deployment identity', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-snapshot-versions-'));

  try {
    await assert.rejects(
      () => captureProdCostSnapshot({
        runTimestamp: '20260405T010203Z',
        artifactRoot: path.join(tempRoot, 'artifacts'),
        outputPath: path.join(tempRoot, 'snapshot.json'),
        billingWindow: buildResolvedProdBillingWindowFixture(),
        prodInstallRecord: buildProdInstallRecordFixture(),
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        fetchWorkerDeploymentStateImpl: async ({ scriptName }) => ({
          deployment_ids: [`${scriptName}-dep`],
          active_worker_version_ids: scriptName === 'matrix-gateway-worker-prod'
            ? ['gateway-ver-a', 'gateway-ver-b']
            : [`${scriptName}-ver`],
          latest_active_deployment_id: `${scriptName}-dep`,
          worker_version_ids: [`${scriptName}-ver`],
        }),
        fetchWorkerBindingStateImpl: async () => ({
          ratelimit_namespace_ids: Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
            .map((definition) => definition.default_namespace_id)
            .sort(),
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/usage/paygo?from=2026-02-16&to=2026-03-15') {
            return {
              success: true,
              result: buildMinimalProdBillingUsageRecords(),
            };
          }
          if (pathname === '/workers/scripts') {
            return {
              success: true,
              result: [
                { id: 'matrix-gateway-worker-prod' },
                { id: 'matrix-jobs-worker-prod' },
                { id: 'matrix-ops-worker-prod' },
              ],
            };
          }
          if (pathname === '/d1/database') {
            return {
              success: true,
              result: [{ name: 'matrix-control-and-derived-prod', uuid: 'd1-prod' }],
            };
          }
          if (pathname === '/storage/kv/namespaces') {
            return {
              success: true,
              result: [{ title: 'matrix-edge-cache-prod', id: 'kv-prod' }],
            };
          }
          if (pathname === '/r2/buckets') {
            return {
              success: true,
              result: {
                buckets: [
                  { name: 'matrix-archive-prod' },
                  { name: 'matrix-evidence-prod' },
                  { name: 'matrix-media-prod' },
                ],
              },
            };
          }
          if (pathname === '/queues') {
            return {
              success: true,
              result: [
                { queue_name: 'matrix-search-index-job-prod' },
                { queue_name: 'matrix-media-thumbnail-job-prod' },
                { queue_name: 'matrix-appservice-txn-job-prod' },
                { queue_name: 'matrix-rebuild-shard-job-prod' },
                { queue_name: 'matrix-export-shard-job-prod' },
                { queue_name: 'matrix-restore-shard-job-prod' },
                { queue_name: 'matrix-repair-shard-job-prod' },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-04-05T00:00:00.000Z'),
      }),
      /exactly one active worker version id/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost snapshot capture rejects Pages Functions billing rows because they are not attributable to the Matrix worker topology', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-prod-cost-snapshot-pages-functions-'));

  try {
    await assert.rejects(
      () => captureProdCostSnapshot({
        runTimestamp: '20260405T010203Z',
        artifactRoot: path.join(tempRoot, 'artifacts'),
        outputPath: path.join(tempRoot, 'snapshot.json'),
        billingWindow: buildResolvedProdBillingWindowFixture(),
        prodInstallRecord: buildProdInstallRecordFixture(),
      }, {
        requireGitHubActionsExecutionImpl: async () => ({
          repository: 'VrianCao/MatrixFlare',
          run_id: '81234',
        }),
        requireCloudflareCredentialsImpl: () => ({
          accountId: 'cf-account',
          apiToken: 'cf-token',
        }),
        fetchWorkerDeploymentStateImpl: async ({ scriptName }) => ({
          deployment_ids: [`${scriptName}-dep`],
          active_worker_version_ids: [`${scriptName}-ver`],
          latest_active_deployment_id: `${scriptName}-dep`,
          worker_version_ids: [`${scriptName}-ver`],
        }),
        fetchWorkerBindingStateImpl: async () => ({
          ratelimit_namespace_ids: Object.values(GATEWAY_RATE_LIMIT_BINDING_DEFINITIONS)
            .map((definition) => definition.default_namespace_id)
            .sort(),
        }),
        callCloudflareApiImpl: async ({ pathname }) => {
          if (pathname === '/billing/usage/paygo?from=2026-02-16&to=2026-03-15') {
            return {
              success: true,
              result: [
                ...buildMinimalProdBillingUsageRecords(),
                {
                  BillingCurrency: 'USD',
                  BillingPeriodStart: '2026-02-16T00:00:00Z',
                  ChargePeriodStart: '2026-02-16T00:00:00Z',
                  ChargePeriodEnd: '2026-03-15T00:00:00Z',
                  ConsumedQuantity: 42,
                  ConsumedUnit: 'Requests',
                  ContractedCost: 1.5,
                  PricingQuantity: 42,
                  ServiceName: 'Pages Functions',
                },
              ],
            };
          }
          if (pathname === '/workers/scripts') {
            return {
              success: true,
              result: [
                { id: 'matrix-gateway-worker-prod' },
                { id: 'matrix-jobs-worker-prod' },
                { id: 'matrix-ops-worker-prod' },
              ],
            };
          }
          if (pathname === '/d1/database') {
            return {
              success: true,
              result: [{ name: 'matrix-control-and-derived-prod', uuid: 'd1-prod' }],
            };
          }
          if (pathname === '/storage/kv/namespaces') {
            return {
              success: true,
              result: [{ title: 'matrix-edge-cache-prod', id: 'kv-prod' }],
            };
          }
          if (pathname === '/r2/buckets') {
            return {
              success: true,
              result: {
                buckets: [
                  { name: 'matrix-archive-prod' },
                  { name: 'matrix-evidence-prod' },
                  { name: 'matrix-media-prod' },
                ],
              },
            };
          }
          if (pathname === '/queues') {
            return {
              success: true,
              result: [
                { queue_name: 'matrix-search-index-job-prod' },
                { queue_name: 'matrix-media-thumbnail-job-prod' },
                { queue_name: 'matrix-appservice-txn-job-prod' },
                { queue_name: 'matrix-rebuild-shard-job-prod' },
                { queue_name: 'matrix-export-shard-job-prod' },
                { queue_name: 'matrix-restore-shard-job-prod' },
                { queue_name: 'matrix-repair-shard-job-prod' },
              ],
            };
          }
          throw new Error(`Unexpected Cloudflare API pathname: ${pathname}`);
        },
        now: new Date('2026-04-05T00:00:00.000Z'),
      }),
      /Pages Functions billing record .* is not attributable to the Matrix production worker topology/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('uploadImmutableArtifactToR2 ensures the target bucket before invoking wrangler upload', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-upload-r2-ensure-'));
  const filePath = path.join(tempRoot, 'bundle.tgz');
  const outputPath = path.join(tempRoot, 'upload.json');
  const callOrder = [];

  try {
    await fs.writeFile(filePath, 'bundle-bytes');

    const result = await uploadImmutableArtifactToR2({
      repoRoot: '/root/Matrix',
      bucketName: 'matrix-evidence-prod',
      objectKey: 'gha/81234/1/prod/20260405T010203Z/cost-bundle.tgz',
      filePath,
      contentType: 'application/gzip',
      outputPath,
    }, {
      requireGitHubActionsExecutionImpl: async () => {
        callOrder.push('require-github-actions');
      },
      requireCloudflareCredentialsImpl: () => ({
        accountId: 'cf-account',
        apiToken: 'cf-token',
      }),
      ensureR2BucketImpl: async ({ accountId, apiToken, bucketName }) => {
        callOrder.push(`ensure:${accountId}:${apiToken}:${bucketName}`);
      },
      sha256FileHexImpl: async (resolvedFilePath) => {
        assert.equal(resolvedFilePath, filePath);
        callOrder.push('sha256');
        return 'ab'.repeat(32);
      },
      runWranglerImpl: async (args, options) => {
        callOrder.push(`wrangler:${args.join(' ')}`);
        assert.equal(options.repoRoot, '/root/Matrix');
        assert.equal(options.accountId, 'cf-account');
      },
    });

    assert.deepEqual(callOrder, [
      'require-github-actions',
      'sha256',
      'ensure:cf-account:cf-token:matrix-evidence-prod',
      'wrangler:r2 object put matrix-evidence-prod/gha/81234/1/prod/20260405T010203Z/cost-bundle.tgz --remote --file '
        + `${filePath} --content-type application/gzip`,
    ]);
    assert.equal(result.object_uri, 'r2://matrix-evidence-prod/gha/81234/1/prod/20260405T010203Z/cost-bundle.tgz');
    assert.equal(result.file_sha256, 'ab'.repeat(32));
    assert.deepEqual(
      JSON.parse(await fs.readFile(outputPath, 'utf8')),
      result,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prod cost provenance writing requires the GitHub Actions prod environment claim', async () => {
  await assert.rejects(
    () => writeProdCostSnapshotProvenance('/tmp/unused-prod-provenance.json', {
      deploymentIdentity: {
        environment_id: 'prod',
        deployment_ids: ['dep-1'],
        worker_version_ids: ['ver-1'],
      },
      artifactUpload: {
        bucket_name: 'matrix-evidence-prod',
        object_uri: 'r2://matrix-evidence-prod/gha/81234/1/prod/20260405T010203Z/cost-bundle.tgz',
        object_key: 'gha/81234/1/prod/20260405T010203Z/cost-bundle.tgz',
        file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    }, {
      requireGitHubActionsExecutionImpl: async (operationName, {
        expectedEnvironmentName = null,
      } = {}) => {
        assert.equal(operationName, 'writeProdCostSnapshotProvenance');
        assert.equal(expectedEnvironmentName, 'prod');
        throw new Error('stop after verifying expected prod environment');
      },
    }),
    /stop after verifying expected prod environment/,
  );
});

test('prod cost provenance builder emits cloudflare-prod provenance for prod deployment identity', () => {
  const provenance = buildProdCostSnapshotProvenance({
    githubRepository: 'VrianCao/MatrixFlare',
    githubRunId: '81234',
    githubRunAttempt: '2',
    deploymentIdentity: {
      environment_id: 'prod',
      deployment_ids: ['dep-gateway', 'dep-jobs', 'dep-ops'],
      worker_version_ids: ['ver-gateway', 'ver-jobs', 'ver-ops'],
    },
    artifactUpload: {
      bucket_name: 'matrix-evidence-prod',
      object_uri: 'r2://matrix-evidence-prod/gha/81234/2/prod/20260405T010203Z/cost-bundle.tgz',
      object_key: 'gha/81234/2/prod/20260405T010203Z/cost-bundle.tgz',
      file_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  });

  assert.equal(provenance.origin_run_uri, 'https://github.com/VrianCao/MatrixFlare/actions/runs/81234');
  assert.equal(provenance.topology_kind, 'cloudflare-prod');
  assert.equal(provenance.deployment_identity.environment_id, 'prod');
});

test('pre-release rollout deployment retains non-zero share for both baseline and candidate versions', () => {
  const versionSpecs = buildPreReleaseRolloutVersionSpecs('gateway-baseline-v1', 'gateway-candidate-v2');

  assert.deepEqual(versionSpecs, [
    'gateway-baseline-v1@50',
    'gateway-candidate-v2@50',
  ]);
  assert.ok(versionSpecs.every((entry) => !entry.endsWith('@0')), 'rollout skew proof must not zero out either version');
});

test('nonlocal workflow routes prod-cost attestation into the L1 evidence gate', async () => {
  const workflowPath = new URL('../../../.github/workflows/nonlocal-phase08.yml', import.meta.url);
  const workflow = await fs.readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /prod-cost:\n[\s\S]*?environment: prod[\s\S]*?- name: Capture production cost snapshot[\s\S]*?node packages\/testing\/src\/cli\.mjs prod-cost-snapshot/s,
    'workflow must define a dedicated prod-cost job in the GitHub Actions prod environment',
  );
  assert.match(
    workflow,
    /prod-cost:\n[\s\S]*?permissions:\n[\s\S]*?actions: read/s,
    'prod-cost job must request actions:read so it can download the prod install baseline artifact',
  );
  assert.match(
    workflow,
    /- name: Write prod-cost provenance[\s\S]*?node packages\/testing\/src\/cli\.mjs prod-cost-provenance/s,
    'workflow must generate dedicated prod-cost provenance before attestation',
  );
  assert.match(
    workflow,
    /- name: Resolve closed production billing window[\s\S]*?node packages\/testing\/src\/cli\.mjs prod-cost-billing-window/s,
    'workflow must derive an explicit closed production billing window from the official billing profile contract',
  );
  assert.match(
    workflow,
    /billing_profile=\$\{artifact_root\}\/billing-profile\.json/u,
    'workflow must retain the raw billing-profile payload in the prod-cost artifact set',
  );
  assert.match(
    workflow,
    /- name: Capture production cost snapshot[\s\S]*?if: steps\.billing_window\.outcome == 'success'/s,
    'workflow must not attempt prod-cost snapshot capture before billing-window resolution succeeds',
  );
  assert.match(
    workflow,
    /workflow_id:\s+'prod-install\.yml'/u,
    'workflow must resolve the latest successful prod-install baseline run before prod-cost capture',
  );
  assert.match(
    workflow,
    /pattern:\s+prod-install-record-\*-\$\{\{\s*steps\.install_run\.outputs\.install_run_id\s*\}\}-\$\{\{\s*steps\.install_run\.outputs\.install_run_attempt\s*\}\}/u,
    'workflow must download the prod install record artifact for the current baseline',
  );
  assert.match(
    workflow,
    /- name: Capture production cost snapshot[\s\S]*?--billing-window "\$\{\{ steps\.paths\.outputs\.billing_window \}\}"[\s\S]*?--install-record "\$\{\{ steps\.paths\.outputs\.download_root \}\}\/prod-install-record\.json"/s,
    'workflow must pass the resolved billing window and prod install baseline into prod-cost snapshot capture',
  );
  assert.match(
    workflow,
    /- name: Upload raw prod-cost bundle to R2[\s\S]*?\n\s+id: upload_bundle_r2\n\s+continue-on-error: true[\s\S]*?--output "\$\{\{ steps\.paths\.outputs\.bundle_upload \}\}"/s,
    'workflow must record prod-cost R2 upload outcome and bundle upload metadata',
  );
  assert.match(
    workflow,
    /- name: Enforce pre-attestation prod-cost gate[\s\S]*?steps\.billing_window\.outcome[\s\S]*?prod-cost billing-window resolution did not pass[\s\S]*?steps\.upload_bundle_r2\.outcome[\s\S]*?prod-cost R2 upload did not pass/s,
    'workflow must fail closed when prod-cost bundle upload to R2 does not succeed',
  );
  assert.match(
    workflow,
    /- name: Write prod-cost attestation[\s\S]*?node packages\/testing\/src\/cli\.mjs prod-cost-attest/s,
    'workflow must emit a dedicated prod-cost attestation artifact',
  );
  assert.match(
    workflow,
    /evidence-l1:\n[\s\S]*?needs:\n[\s\S]*?- prod-cost\n/s,
    'L1 evidence must wait on the prod-cost job',
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
    /function stableString\(value\) {\n\s+return typeof value === 'string' \? value\.trim\(\) : '';\n}/,
    'rollout start must keep a stableString helper in module scope for version-tag normalization',
  );
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
