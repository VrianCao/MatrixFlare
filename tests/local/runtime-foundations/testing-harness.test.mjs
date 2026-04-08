import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  buildRunEnvironmentVariables,
  discoverTestFiles,
  getReleaseGateTestFiles,
  getTestEnvironmentDefinition,
  getTestEnvironmentDirectory,
  getRequiredTestFiles,
  listTestEnvironmentNames,
  resolveTestEnvironmentName,
} from '../../../packages/testing/src/bootstrap.mjs';
import {
  buildRequiredManualArtifactDefinitions,
  assessNonLocalEnvironmentHarnessReadiness,
  collectTestCoverageResults,
  collectManualArtifactResults,
  getL1EvidenceDefinition,
  getRequiredTestImplementationFiles,
  listL1EvidenceBundleIds,
  validateEnvironmentRunExecutionProof,
  validateEvidenceAttestationBundle,
  validateManualArtifactPayload,
  writeL1Evidence,
} from '../../../packages/testing/src/evidence.mjs';
import {
  buildNonLocalEnvironmentPlan,
} from '../../../packages/testing/src/nonlocal.mjs';
import {
  listProductionRateLimitNamespaces,
} from '../../../packages/testing/src/cloudflare-resources.mjs';
import {
  CLIENT_DISCOVERY_VERSIONS,
  summarizeClientDiscoveryVersionPayload,
} from '../../../packages/testing/src/client-discovery.mjs';
import {
  BROWSER_JOURNEY_MATRIX,
  buildBrowserJourneyCoverageReport,
} from '../../../packages/testing/src/browser-e2e.mjs';
import {
  assertPathsDoNotExist,
  writeGovernanceEvidence,
} from '../../../packages/spec-tools/src/governance.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const execFileAsync = promisify(execFile);
const DEFAULT_TEST_GITHUB_REPOSITORY = typeof process.env.GITHUB_REPOSITORY === 'string' && process.env.GITHUB_REPOSITORY.trim().length > 0
  ? process.env.GITHUB_REPOSITORY.trim()
  : 'example/matrix';
const FOREIGN_TEST_GITHUB_REPOSITORY = DEFAULT_TEST_GITHUB_REPOSITORY === 'example/other'
  ? 'example/matrix'
  : 'example/other';
const DEFAULT_TEST_GIT_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ENVIRONMENT_MANUAL_ARTIFACT_IDS = Object.freeze({
  'ci-integration': 'ci_integration_run_report',
  staging: 'staging_run_report',
  'pre-release': 'pre_release_run_report',
});
const CLIENT_DISCOVERY_VERSION_STEP_DETAIL = Object.freeze(
  {
    ...summarizeClientDiscoveryVersionPayload({ versions: CLIENT_DISCOVERY_VERSIONS }),
    browser_compatible_cors: true,
  },
);

function buildExpectedCloudflareResources(environmentName) {
  if (environmentName === 'prod') {
    return {
      workers: ['matrix-gateway-worker-prod', 'matrix-jobs-worker-prod', 'matrix-ops-worker-prod'],
      durable_objects: ['RoomDO', 'RemoteServerDO', 'UserDO'],
      d1_databases: ['matrix-control-and-derived-prod'],
      r2_buckets: ['matrix-archive-prod', 'matrix-evidence-prod', 'matrix-media-prod'],
      kv_namespaces: ['matrix-edge-cache-prod'],
      ratelimit_namespaces: listProductionRateLimitNamespaces(),
      queues: [
        'matrix-appservice-txn-job-prod',
        'matrix-export-shard-job-prod',
        'matrix-media-thumbnail-job-prod',
        'matrix-rebuild-shard-job-prod',
        'matrix-repair-shard-job-prod',
        'matrix-restore-shard-job-prod',
        'matrix-search-index-job-prod',
      ],
    };
  }
  const plan = buildNonLocalEnvironmentPlan(environmentName, {
    workersSubdomain: 'matrixflare',
  });
  return {
    ...plan.cloudflare_resources,
    r2_buckets: [...plan.cloudflare_resources.r2_buckets, plan.artifact_bucket_name].sort(),
  };
}

function buildGitHubRunId(environmentName, runTimestamp) {
  void environmentName;
  return `9${runTimestamp.replace(/\D/g, '')}`;
}

function buildGitHubRunUri(environmentName, runTimestamp) {
  return `https://github.com/${DEFAULT_TEST_GITHUB_REPOSITORY}/actions/runs/${buildGitHubRunId(environmentName, runTimestamp)}`;
}

function buildPhase08ArtifactStoreKey(environmentName, runTimestamp, fileName) {
  return `gha/${buildGitHubRunId(environmentName, runTimestamp)}/1/${environmentName}/${runTimestamp}/${fileName}`;
}

function buildPhase08ArtifactStoreUri(environmentName, runTimestamp, fileName) {
  return `r2://matrix-evidence-${environmentName}/${buildPhase08ArtifactStoreKey(environmentName, runTimestamp, fileName)}`;
}

function buildValidRolloutSkewProbe(runTimestamp, overrides = {}) {
  const baselineGatewayVersionTag = 'mx-gw-d-baseline';
  const candidateGatewayVersionTag = 'mx-gw-d-candidate';
  return {
    environment_name: 'pre-release',
    probe_run_id: `rollout-${runTimestamp.toLowerCase()}`,
    dual_version_deployment_id: 'pre-release-gateway-dual-deployment',
    baseline_gateway_version_id: 'gateway@pre-release-v1',
    baseline_gateway_version_tag: baselineGatewayVersionTag,
    candidate_gateway_version_id: 'gateway@pre-release-v2',
    candidate_gateway_version_tag: candidateGatewayVersionTag,
    override_strategy: 'cloudflare-version-overrides',
    observations: [
      {
        probe_name: 'new-worker-old-authority',
        request_gateway_version_id: 'gateway@pre-release-v2',
        observed_gateway_version_id: 'gateway@pre-release-v2',
        observed_gateway_version_tag: candidateGatewayVersionTag,
        observed_authority_version_id: 'gateway@pre-release-v1',
        authority_kind: 'UserDO',
        authority_key: '@baseline-user:matrix.example.test',
        request_path: '/_matrix/client/v3/account/whoami',
        observed_at: '2026-03-31T14:03:00.000Z',
      },
      {
        probe_name: 'new-worker-old-authority',
        request_gateway_version_id: 'gateway@pre-release-v2',
        observed_gateway_version_id: 'gateway@pre-release-v2',
        observed_gateway_version_tag: candidateGatewayVersionTag,
        observed_authority_version_id: 'gateway@pre-release-v1',
        authority_kind: 'RoomDO',
        authority_key: '!baseline-room:matrix.example.test',
        request_path: '/_matrix/client/v3/rooms/%21baseline-room%3Amatrix.example.test/state',
        observed_at: '2026-03-31T14:03:01.000Z',
      },
      {
        probe_name: 'old-worker-new-authority',
        request_gateway_version_id: 'gateway@pre-release-v1',
        observed_gateway_version_id: 'gateway@pre-release-v1',
        observed_gateway_version_tag: baselineGatewayVersionTag,
        observed_authority_version_id: 'gateway@pre-release-v2',
        authority_kind: 'UserDO',
        authority_key: '@candidate-user:matrix.example.test',
        request_path: '/_matrix/client/v3/account/whoami',
        observed_at: '2026-03-31T14:03:02.000Z',
      },
      {
        probe_name: 'old-worker-new-authority',
        request_gateway_version_id: 'gateway@pre-release-v1',
        observed_gateway_version_id: 'gateway@pre-release-v1',
        observed_gateway_version_tag: baselineGatewayVersionTag,
        observed_authority_version_id: 'gateway@pre-release-v2',
        authority_kind: 'RoomDO',
        authority_key: '!candidate-room:matrix.example.test',
        request_path: '/_matrix/client/v3/rooms/%21candidate-room%3Amatrix.example.test/state',
        observed_at: '2026-03-31T14:03:03.000Z',
      },
    ],
    assertions: {
      new_worker_old_authority: true,
      old_worker_new_authority: true,
    },
    ...overrides,
  };
}

function buildValidPreReleaseCostObservation(runTimestamp, overrides = {}) {
  return {
    observation_id: `pre-release-cost-${runTimestamp.toLowerCase()}`,
    source_environment: 'pre-release',
    captured_at: '2026-03-31T14:04:00.000Z',
    capture_window: {
      start: '2026-03-31T14:00:00.000Z',
      end: '2026-03-31T14:05:00.000Z',
    },
    capture_method: 'cloudflare-official-metrics',
    source_query_uris: [
      'https://api.cloudflare.com/client/v4/graphql#workersInvocationsAdaptive',
      'https://developers.cloudflare.com/workers/platform/pricing',
    ],
    topology_kind: 'cloudflare-pre-release',
    cloudflare_resources: buildExpectedCloudflareResources('pre-release'),
    cost_surfaces: {
      workers: { requests: 1000, cpu_ms: 250000 },
      durable_objects: { requests: 400, duration_gb_s: 12 },
      d1: { read_rows: 20000, write_rows: 1500 },
      r2: { storage_gb_month: 3, class_a_ops: 120, class_b_ops: 400 },
      kv: { read_ops: 500, write_ops: 40, delete_ops: 3, list_ops: 2 },
      queues: { write_ops: 80, read_ops: 80, delete_ops: 80 },
    },
    model_comparison: {
      status: 'within_expected',
      summary: 'No bounded-workload budget drift detected.',
      actual_total_usd: 1.2,
      modeled_total_usd: 1.1,
      drift_ratio: 0.09,
    },
    ...overrides,
  };
}

function buildValidBrowserJourneyCoverageFixture(overrides = {}) {
  const journeys = BROWSER_JOURNEY_MATRIX
    .filter((journey) => journey.required)
    .map((journey) => ({
      journey_id: journey.journey_id,
      status: 'pass',
      artifacts: [`browser-artifacts/${journey.journey_id.toLowerCase()}.png`],
    }));

  return buildBrowserJourneyCoverageReport({
    environmentName: 'staging',
    capturedAt: '2026-03-31T14:04:30.000Z',
    journeys,
    playwright: {
      package_version: '1.59.1',
      browser_name: 'chromium',
      browser_version: '136.0.0.0',
      headless: true,
    },
    ...overrides,
  });
}

function buildValidEnvironmentReport(environmentName, runTimestamp, overrides = {}) {
  const directory = getTestEnvironmentDefinition(environmentName).directory;
  const readinessSteps = [
    { step: 'versions', ok: true, detail: CLIENT_DISCOVERY_VERSION_STEP_DETAIL },
    { step: 'public_rooms', ok: true, detail: { chunk_length: 0 } },
    { step: 'register_challenge', ok: true, detail: { session_present: true, flows_count: 1 } },
    { step: 'register_complete', ok: true, detail: { user_id_present: true, access_token_present: true } },
    { step: 'sync', ok: true, detail: { next_batch_present: true } },
    { step: 'media_create', ok: true, detail: { content_uri_present: true } },
  ];
  if (environmentName === 'staging' || environmentName === 'pre-release') {
    readinessSteps.push(
      { step: 'ops_healthz', ok: true, detail: { service: 'ops-worker', status: 'ok' } },
      { step: 'ops_rebuild_start', ok: true, detail: { job_id_present: true, job_type: 'rebuild', state: 'accepted' } },
    );
  }
  const report = {
    environment_name: environmentName,
    status: 'pass',
    exit_code: 0,
    started_at: '2026-03-31T14:00:00.000Z',
    completed_at: '2026-03-31T14:05:00.000Z',
    duration_ms: 300000,
    command: null,
    test_directory: directory,
    test_file_count: 1,
    test_files: [`${directory}/remote.test.mjs`],
    expanded_test_file_count: 2,
    expanded_test_files: [
      `${directory}/remote.test.mjs`,
      `${directory}/support.mjs`,
    ],
    output_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    error_message: null,
    log_artifact: `https://example.invalid/logs/${environmentName}/${runTimestamp}.txt`,
    executed_by: 'ci-runner',
    reviewed_by: 'release-reviewer',
    git_commit: DEFAULT_TEST_GIT_COMMIT,
    source_run_uri: `https://example.invalid/runs/${environmentName}/${runTimestamp}`,
    topology_kind: `cloudflare-${environmentName}`,
    cloudflare_resources: buildExpectedCloudflareResources(environmentName),
    rollout_skew_probe: null,
    pre_release_cost_observation: null,
    browser_journey_coverage: null,
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
        workers: {
          'jobs-worker': {
            script_name: `matrix-jobs-worker-${environmentName}`,
            latest_active_deployment_id: `${environmentName}-jobs-deployment`,
            active_worker_version_ids: [`jobs@${environmentName}-v1`],
          },
          'ops-worker': {
            script_name: `matrix-ops-worker-${environmentName}`,
            latest_active_deployment_id: `${environmentName}-ops-deployment`,
            active_worker_version_ids: [`ops@${environmentName}-v1`],
          },
          'gateway-worker': {
            script_name: `matrix-gateway-worker-${environmentName}`,
            latest_active_deployment_id: `${environmentName}-gateway-deployment`,
            active_worker_version_ids: [`gateway@${environmentName}-v1`],
          },
        },
      },
      before_suite: {
        validated_at: '2026-03-31T13:59:31.000Z',
        workers: {
          'jobs-worker': {
            script_name: `matrix-jobs-worker-${environmentName}`,
            latest_active_deployment_id: `${environmentName}-jobs-deployment`,
            active_worker_version_ids: [`jobs@${environmentName}-v1`],
          },
          'ops-worker': {
            script_name: `matrix-ops-worker-${environmentName}`,
            latest_active_deployment_id: `${environmentName}-ops-deployment`,
            active_worker_version_ids: [`ops@${environmentName}-v1`],
          },
          'gateway-worker': {
            script_name: `matrix-gateway-worker-${environmentName}`,
            latest_active_deployment_id: `${environmentName}-gateway-deployment`,
            active_worker_version_ids: [`gateway@${environmentName}-v1`],
          },
        },
      },
    },
    run_timestamp: runTimestamp,
    ...overrides,
  };
  report.command = Object.prototype.hasOwnProperty.call(overrides, 'command')
    ? overrides.command
    : `/usr/bin/node --test ${report.test_files.map((file) => path.join(repoRoot, file)).join(' ')}`;
  return report;
}

function buildValidPreReleaseOpsReport(runTimestamp, overrides = {}) {
  const rolloutSkewProbe = buildValidRolloutSkewProbe(runTimestamp);
  return buildValidEnvironmentReport('pre-release', runTimestamp, {
    test_directory: 'tests/pre-release',
    test_file_count: 1,
    test_files: ['tests/pre-release/test-ops-001.test.mjs'],
    expanded_test_file_count: 1,
    expanded_test_files: ['tests/pre-release/test-ops-001.test.mjs'],
    rollout_skew_probe: rolloutSkewProbe,
    deployment_identity_validation: {
      before_readiness: {
        validated_at: '2026-03-31T13:58:30.000Z',
        workers: {
          'jobs-worker': {
            script_name: 'matrix-jobs-worker-pre-release',
            latest_active_deployment_id: 'pre-release-jobs-deployment',
            active_worker_version_ids: ['jobs@pre-release-v1'],
          },
          'ops-worker': {
            script_name: 'matrix-ops-worker-pre-release',
            latest_active_deployment_id: 'pre-release-ops-deployment',
            active_worker_version_ids: ['ops@pre-release-v1'],
          },
          'gateway-worker': {
            script_name: 'matrix-gateway-worker-pre-release',
            latest_active_deployment_id: rolloutSkewProbe.dual_version_deployment_id,
            active_worker_version_ids: [
              rolloutSkewProbe.baseline_gateway_version_id,
              rolloutSkewProbe.candidate_gateway_version_id,
            ],
          },
        },
      },
      before_suite: {
        validated_at: '2026-03-31T13:59:31.000Z',
        workers: {
          'jobs-worker': {
            script_name: 'matrix-jobs-worker-pre-release',
            latest_active_deployment_id: 'pre-release-jobs-deployment',
            active_worker_version_ids: ['jobs@pre-release-v1'],
          },
          'ops-worker': {
            script_name: 'matrix-ops-worker-pre-release',
            latest_active_deployment_id: 'pre-release-ops-deployment',
            active_worker_version_ids: ['ops@pre-release-v1'],
          },
          'gateway-worker': {
            script_name: 'matrix-gateway-worker-pre-release',
            latest_active_deployment_id: rolloutSkewProbe.dual_version_deployment_id,
            active_worker_version_ids: [
              rolloutSkewProbe.baseline_gateway_version_id,
              rolloutSkewProbe.candidate_gateway_version_id,
            ],
          },
        },
      },
    },
    ...overrides,
  });
}

function buildValidPreReleaseCostReport(runTimestamp, overrides = {}) {
  return buildValidEnvironmentReport('pre-release', runTimestamp, {
    test_directory: 'tests/pre-release',
    test_file_count: 1,
    test_files: ['tests/pre-release/test-cost-001.test.mjs'],
    expanded_test_file_count: 1,
    expanded_test_files: ['tests/pre-release/test-cost-001.test.mjs'],
    pre_release_cost_observation: buildValidPreReleaseCostObservation(runTimestamp),
    ...overrides,
  });
}

function buildValidProdCostSnapshot(runTimestamp, overrides = {}) {
  return {
    artifact_id: 'prod_cost_snapshot',
    source_environment: 'prod',
    captured_at: '2026-05-16T14:00:00.000Z',
    captured_by: 'finance-bot',
    reviewed_by: 'platform-reviewer',
    source_dashboard_uri: 'https://api.cloudflare.com/client/v4/accounts/cf-account/billing/usage/paygo?from=2026-04-16&to=2026-05-15',
    billing_window_resolution_method: 'cloudflare-account-subscriptions-current-period-end',
    billing_cycle_anchor_source_uri: 'https://api.cloudflare.com/client/v4/accounts/cf-account/subscriptions',
    billing_cycle_anchor_artifact: {
      artifact_path: 'billing-subscriptions.json',
      field_selector: 'result[*].current_period_end',
    },
    billing_cycle_next_bill_date: '2026-06-15T12:21:59.345Z',
    topology_kind: 'cloudflare-prod',
    topology_baseline_install: {
      install_id: 'install-prod-topology-v1',
      installed_at: '2026-04-05T11:43:28.000Z',
      origin_run_uri: 'https://github.com/VrianCao/MatrixFlare/actions/runs/24000789563',
    },
    cloudflare_resources: buildExpectedCloudflareResources('prod'),
    billing_period: {
      start: '2026-04-16T00:00:00.000Z',
      end: '2026-05-15T00:00:00.000Z',
    },
    cost_surfaces: {
      workers: { request_count: 1000, cpu_ms: 250000, log_event_count: 500 },
      durable_objects: { request_count: 400, duration_gb_s: 12, sqlite_row_reads: 10000, sqlite_row_writes: 1200 },
      d1: { read_rows: 20000, write_rows: 1500 },
      r2: { storage_gb_month: 3, class_a_ops: 120, class_b_ops: 400 },
      kv: { read_ops: 500, write_ops: 40, delete_ops: 3, list_ops: 2 },
      queues: { write_ops: 80, read_ops: 80, delete_ops: 80 },
      telemetry_export: { trace_span_count: 600, exported_log_event_count: 500, persist_enabled: true },
    },
    model_comparison: {
      status: 'within_expected',
      summary: 'No budget drift detected.',
      actual_total_usd: 12.3,
      modeled_total_usd: 12.1,
      drift_ratio: 0.02,
    },
    run_timestamp: runTimestamp,
    ...overrides,
  };
}

function buildValidEnvironmentAttestation(environmentName, runTimestamp, reportOverrides = {}, attestationOverrides = {}) {
  const topologyKind = `cloudflare-${environmentName}`;
  const originRunId = buildGitHubRunId(environmentName, runTimestamp);
  const originRunUri = buildGitHubRunUri(environmentName, runTimestamp);
  const artifactId = ENVIRONMENT_MANUAL_ARTIFACT_IDS[environmentName];
  const baseProvenance = {
    origin_system: 'github-actions',
    origin_repository: DEFAULT_TEST_GITHUB_REPOSITORY,
    origin_run_id: originRunId,
    origin_run_attempt: 1,
    origin_run_uri: originRunUri,
    artifact_store_uri: buildPhase08ArtifactStoreUri(environmentName, runTimestamp, 'run-bundle.tgz'),
    artifact_store_key: buildPhase08ArtifactStoreKey(environmentName, runTimestamp, 'run-bundle.tgz'),
    artifact_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    review_record_uri: originRunUri,
    topology_kind: topologyKind,
    deployment_identity: {
      environment_id: environmentName,
      deployment_ids: [`${environmentName}-deployment-001`],
      worker_version_ids: [`gateway@${environmentName}-v1`, `jobs@${environmentName}-v1`, `ops@${environmentName}-v1`],
    },
  };
  const attestationProvenanceOverrides = attestationOverrides.provenance ?? {};

  return {
    schema_version: 1,
    artifact_id: artifactId,
    attestation_kind: 'environment_run',
    source_environment: environmentName,
    run_timestamp: runTimestamp,
    attested_at: '2026-03-31T14:06:00.000Z',
    ...attestationOverrides,
    provenance: {
      ...baseProvenance,
      ...attestationProvenanceOverrides,
      deployment_identity: {
        ...baseProvenance.deployment_identity,
        ...(attestationProvenanceOverrides.deployment_identity ?? {}),
      },
    },
    payload: buildValidEnvironmentReport(environmentName, runTimestamp, {
      source_run_uri: originRunUri,
      topology_kind: topologyKind,
      ...reportOverrides,
    }),
  };
}

function buildValidProdCostSnapshotAttestation(runTimestamp, payloadOverrides = {}, attestationOverrides = {}) {
  const topologyKind = 'cloudflare-prod';
  const originRunId = buildGitHubRunId('prod', runTimestamp);
  const originRunUri = buildGitHubRunUri('prod', runTimestamp);
  const baseProvenance = {
    origin_system: 'github-actions',
    origin_repository: DEFAULT_TEST_GITHUB_REPOSITORY,
    origin_run_id: originRunId,
    origin_run_attempt: 1,
    origin_run_uri: originRunUri,
    artifact_store_uri: buildPhase08ArtifactStoreUri('prod', runTimestamp, 'cost-snapshot.json'),
    artifact_store_key: buildPhase08ArtifactStoreKey('prod', runTimestamp, 'cost-snapshot.json'),
    artifact_sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    review_record_uri: originRunUri,
    topology_kind: topologyKind,
    deployment_identity: {
      environment_id: 'prod',
      deployment_ids: ['prod-deployment-001'],
      worker_version_ids: ['gateway@prod-v1', 'jobs@prod-v1', 'ops@prod-v1'],
    },
  };
  const attestationProvenanceOverrides = attestationOverrides.provenance ?? {};

  return {
    schema_version: 1,
    artifact_id: 'prod_cost_snapshot',
    attestation_kind: 'prod_cost_snapshot',
    source_environment: 'prod',
    run_timestamp: runTimestamp,
    attested_at: '2026-03-31T14:06:00.000Z',
    ...attestationOverrides,
    provenance: {
      ...baseProvenance,
      ...attestationProvenanceOverrides,
      deployment_identity: {
        ...baseProvenance.deployment_identity,
        ...(attestationProvenanceOverrides.deployment_identity ?? {}),
      },
    },
    payload: buildValidProdCostSnapshot(runTimestamp, {
      topology_kind: topologyKind,
      ...payloadOverrides,
    }),
  };
}

function buildValidProdWorkerRecordMap(overrides = {}) {
  const base = {
    'gateway-worker': {
      worker_name: 'gateway-worker',
      script_name: 'matrix-gateway-worker-prod',
      deployment_id: 'gateway-prod-deployment-v1',
      worker_version_id: 'gateway@prod-v1',
      worker_version_tag: 'mx-gw-d-prod1',
      url: 'https://matrix-gateway-worker-prod.matrixflare.workers.dev',
    },
    'jobs-worker': {
      worker_name: 'jobs-worker',
      script_name: 'matrix-jobs-worker-prod',
      deployment_id: 'jobs-prod-deployment-v1',
      worker_version_id: 'jobs@prod-v1',
      worker_version_tag: 'mx-jw-d-prod1',
      url: 'https://matrix-jobs-worker-prod.matrixflare.workers.dev',
    },
    'ops-worker': {
      worker_name: 'ops-worker',
      script_name: 'matrix-ops-worker-prod',
      deployment_id: 'ops-prod-deployment-v1',
      worker_version_id: 'ops@prod-v1',
      worker_version_tag: 'mx-ow-d-prod1',
      url: 'https://matrix-ops-worker-prod.matrixflare.workers.dev',
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

function buildValidProdDeploymentIdentity(overrides = {}) {
  return {
    environment_id: 'prod',
    deployment_ids: [
      'jobs-prod-deployment-v1',
      'ops-prod-deployment-v1',
      'gateway-prod-deployment-v1',
    ],
    worker_version_ids: [
      'jobs@prod-v1',
      'ops@prod-v1',
      'gateway@prod-v1',
    ],
    ...overrides,
  };
}

function buildValidProdReadinessProbe(overrides = {}) {
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

function buildValidProdRollbackHandle(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function buildValidProducerRunIdentity(overrides = {}) {
  return {
    origin_repository: DEFAULT_TEST_GITHUB_REPOSITORY,
    origin_run_id: buildGitHubRunId('prod', '20260331T140000Z'),
    origin_run_attempt: 1,
    origin_run_uri: buildGitHubRunUri('prod', '20260331T140000Z'),
    ...overrides,
  };
}

function buildValidProdPromotionReadinessChecks(overrides = {}) {
  return {
    jobs_promoted: buildValidProdReadinessProbe(),
    ops_promoted: buildValidProdReadinessProbe(),
    ...overrides,
  };
}

function buildValidProdReleaseCandidateManifest(runTimestamp, overrides = {}) {
  const sharedRunId = buildGitHubRunId('prod', runTimestamp);
  const sharedRunUri = buildGitHubRunUri('prod', runTimestamp);
  const sourceRepository = DEFAULT_TEST_GITHUB_REPOSITORY;
  const buildCandidateAttestation = (environmentName) => buildValidEnvironmentAttestation(
    environmentName,
    runTimestamp,
    {
      source_run_uri: sharedRunUri,
    },
    {
      provenance: {
        origin_repository: sourceRepository,
        origin_run_id: sharedRunId,
        origin_run_attempt: 1,
        origin_run_uri: sharedRunUri,
      },
    },
  );
  return {
    schema_version: 1,
    artifact_id: 'prod_release_candidate',
    candidate_id: `candidate-${runTimestamp.toLowerCase()}`,
    created_at: '2026-03-31T14:07:00.000Z',
    release_ref: 'refs/heads/phase08-nonlocal-closure',
    release_commit_sha: '0123456789abcdef0123456789abcdef01234567',
    requires_do_migration: false,
    source_repository: sourceRepository,
    source_run_uri: sharedRunUri,
    ...buildValidProducerRunIdentity(),
    topology_kind: 'cloudflare-prod',
    ci_integration_attestation: buildCandidateAttestation('ci-integration'),
    staging_attestation: buildCandidateAttestation('staging'),
    pre_release_attestation: buildCandidateAttestation('pre-release'),
    ...overrides,
  };
}

function buildValidProdInstallRecord(overrides = {}) {
  return {
    schema_version: 1,
    artifact_id: 'prod_install_record',
    source_environment: 'prod',
    install_id: 'install-prod-topology-v1',
    installed_at: '2026-03-31T14:08:00.000Z',
    ...buildValidProducerRunIdentity(),
    release_commit_sha: '0123456789abcdef0123456789abcdef01234567',
    topology_kind: 'cloudflare-prod',
    workers_subdomain: 'matrixflare',
    cloudflare_resources: buildExpectedCloudflareResources('prod'),
    access: {
      auth_domain: 'matrixflare.cloudflareaccess.com',
      application_id: 'cf-access-app-prod',
      application_audience: 'prod-aud',
      application_domain: 'matrix-ops-worker-prod.matrixflare.workers.dev',
      protected_ops_url: 'https://matrix-ops-worker-prod.matrixflare.workers.dev',
    },
    deployment_identity: buildValidProdDeploymentIdentity(),
    workers: buildValidProdWorkerRecordMap(),
    ...overrides,
  };
}

function buildValidProdPromotionRecord(overrides = {}) {
  return {
    schema_version: 1,
    artifact_id: 'prod_promotion_record',
    source_environment: 'prod',
    promotion_id: 'promotion-prod-v2',
    promoted_at: '2026-03-31T14:09:00.000Z',
    ...buildValidProducerRunIdentity({ origin_run_id: buildGitHubRunId('prod', '20260331T140900Z'), origin_run_uri: buildGitHubRunUri('prod', '20260331T140900Z') }),
    release_commit_sha: '89abcdef0123456789abcdef0123456789abcdef',
    promotion_authority: 'reviewed_candidate',
    promotion_mode: 'gradual',
    source_candidate: {
      candidate_id: 'candidate-20260331t140000z',
      source_run_uri: buildGitHubRunUri('prod', '20260331T140000Z'),
    },
    operational_unblock: null,
    previous_deployment_identity: buildValidProdDeploymentIdentity(),
    current_deployment_identity: buildValidProdDeploymentIdentity({
      deployment_ids: [
        'jobs-prod-deployment-v2',
        'ops-prod-deployment-v2',
        'gateway-prod-deployment-v2',
      ],
      worker_version_ids: [
        'jobs@prod-v2',
        'ops@prod-v2',
        'gateway@prod-v2',
      ],
    }),
    gateway_rollout_steps: [
      { percentage: 10, deployment_id: 'gateway-prod-rollout-10', ready: true, attempt_count: 1, last_error: null },
      { percentage: 50, deployment_id: 'gateway-prod-rollout-50', ready: true, attempt_count: 1, last_error: null },
      { percentage: 100, deployment_id: 'gateway-prod-rollout-100', ready: true, attempt_count: 1, last_error: null },
    ],
    readiness_checks: buildValidProdPromotionReadinessChecks(),
    rollback_handle: buildValidProdRollbackHandle(),
    ...overrides,
  };
}

function buildValidProdRollbackRecord(overrides = {}) {
  return {
    schema_version: 1,
    artifact_id: 'prod_rollback_record',
    source_environment: 'prod',
    rollback_id: 'rollback-prod-v1',
    rolled_back_at: '2026-03-31T14:11:00.000Z',
    ...buildValidProducerRunIdentity({ origin_run_id: buildGitHubRunId('prod', '20260331T141100Z'), origin_run_uri: buildGitHubRunUri('prod', '20260331T141100Z') }),
    source_promotion_id: 'promotion-prod-v2',
    release_commit_sha: '0123456789abcdef0123456789abcdef01234567',
    requested_rollback_handle: buildValidProdRollbackHandle(),
    restored_deployment_identity: buildValidProdDeploymentIdentity(),
    worker_results: {
      'gateway-worker': {
        restored: true,
        deployment_id: 'gateway-prod-deployment-v1',
        worker_version_id: 'gateway@prod-v1',
      },
      'jobs-worker': {
        restored: true,
        deployment_id: 'jobs-prod-deployment-v1',
        worker_version_id: 'jobs@prod-v1',
      },
      'ops-worker': {
        restored: true,
        deployment_id: 'ops-prod-deployment-v1',
        worker_version_id: 'ops@prod-v1',
      },
    },
    readiness_probe: buildValidProdReadinessProbe(),
    ...overrides,
  };
}

function buildSingleFileEnvironmentReportOverrides(relativeTestFile, overrides = {}) {
  return {
    test_files: [relativeTestFile],
    test_file_count: 1,
    expanded_test_files: [relativeTestFile],
    expanded_test_file_count: 1,
    ...overrides,
  };
}

function assertEnvironmentBackedProofRejected(validationError) {
  assert.match(
    validationError ?? '',
    /(harness is not environment-backed|attested payload invalid: environment run report must not expand local test implementations|test_files must not contain unresolved or non-literal dynamic imports|expanded_test_files must equal the repo-owned transitive closure of test_files)/,
  );
}

function normalizeForImportPath(relativePath) {
  return relativePath.replaceAll(path.sep, '/');
}

async function createIsolatedRepoFixture(prefix = 'matrix-testing-harness-repo-') {
  const fixtureParent = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const fixtureRoot = path.join(fixtureParent, 'repo');
  await fs.cp(repoRoot, fixtureRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(repoRoot, source);
      if (relative === '') {
        return true;
      }
      const topLevel = relative.split(path.sep)[0];
      return topLevel === 'package.json'
        || topLevel === 'packages'
        || topLevel === 'research'
        || topLevel === 'notes'
        || topLevel === 'spec'
        || topLevel === 'tests'
        || topLevel === 'TODO.md';
    },
  });
  await execFileAsync('git', ['init', '--initial-branch=master'], { cwd: fixtureRoot });
  await execFileAsync('git', ['config', 'user.name', 'Matrix Test Harness'], { cwd: fixtureRoot });
  await execFileAsync('git', ['config', 'user.email', 'matrix-test-harness@example.test'], { cwd: fixtureRoot });
  await execFileAsync('git', ['remote', 'add', 'origin', `https://github.com/${DEFAULT_TEST_GITHUB_REPOSITORY}.git`], { cwd: fixtureRoot });
  await execFileAsync('git', ['add', '.'], { cwd: fixtureRoot });
  await execFileAsync('git', ['commit', '-m', 'Fixture baseline'], { cwd: fixtureRoot });
  return fixtureRoot;
}

async function loadFixtureEvidenceModule(fixtureRoot) {
  const moduleUrl = pathToFileURL(path.join(fixtureRoot, 'packages/testing/src/evidence.mjs')).href;
  return import(`${moduleUrl}?cacheBust=${Date.now()}-${Math.random()}`);
}

async function createEnvironmentBackedEvidenceFixture() {
  const fixtureRoot = await createIsolatedRepoFixture('matrix-testing-harness-env-backed-repo-');
  const sharedProofFile = 'tests/shared/all-bundles-proof.mjs';
  const environmentTestFiles = {
    local: {
      'TEST-CS-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-CS-002': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-CS-003': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-CS-004': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-ROOM-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-ROOM-002': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-MEDIA-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-DER-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-E2E-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-SEC-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-OPS-001': 'tests/local-env-backed/environment-backed.test.mjs',
      'TEST-COST-001': 'tests/local-env-backed/environment-backed.test.mjs',
    },
    'ci-integration': {
      'TEST-CS-001': 'tests/integration-env-backed/test-cs-001.test.mjs',
      'TEST-CS-004': 'tests/integration-env-backed/test-cs-004.test.mjs',
      'TEST-ROOM-001': 'tests/integration-env-backed/test-room-001.test.mjs',
      'TEST-ROOM-002': 'tests/integration-env-backed/test-room-002.test.mjs',
    },
    staging: {
      'TEST-CS-001': 'tests/staging-env-backed/test-cs-001.test.mjs',
      'TEST-CS-002': 'tests/staging-env-backed/test-cs-002.test.mjs',
      'TEST-CS-003': 'tests/staging-env-backed/test-cs-003.test.mjs',
      'TEST-CS-004': 'tests/staging-env-backed/test-cs-004.test.mjs',
      'TEST-ROOM-001': 'tests/staging-env-backed/test-room-001.test.mjs',
      'TEST-ROOM-002': 'tests/staging-env-backed/test-room-002.test.mjs',
      'TEST-MEDIA-001': 'tests/staging-env-backed/test-media-001.test.mjs',
      'TEST-DER-001': 'tests/staging-env-backed/test-der-001.test.mjs',
      'TEST-E2E-001': 'tests/staging-env-backed/test-e2e-001.test.mjs',
      'TEST-SEC-001': 'tests/staging-env-backed/test-sec-001.test.mjs',
    },
    'pre-release': {
      'TEST-MEDIA-001': 'tests/pre-release-env-backed/test-media-001.test.mjs',
      'TEST-DER-001': 'tests/pre-release-env-backed/test-der-001.test.mjs',
      'TEST-SEC-001': 'tests/pre-release-env-backed/test-sec-001.test.mjs',
      'TEST-OPS-001': 'tests/pre-release-env-backed/test-ops-001.test.mjs',
      'TEST-COST-001': 'tests/pre-release-env-backed/test-cost-001.test.mjs',
    },
  };

  await Promise.all([
    fs.rm(path.join(fixtureRoot, 'tests', 'local-env-backed'), { recursive: true, force: true }),
    fs.rm(path.join(fixtureRoot, 'tests', 'integration-env-backed'), { recursive: true, force: true }),
    fs.rm(path.join(fixtureRoot, 'tests', 'staging-env-backed'), { recursive: true, force: true }),
    fs.rm(path.join(fixtureRoot, 'tests', 'pre-release-env-backed'), { recursive: true, force: true }),
    fs.rm(path.join(fixtureRoot, 'tests', 'shared'), { recursive: true, force: true }),
  ]);
  await Promise.all([
    fs.mkdir(path.join(fixtureRoot, 'tests', 'local-env-backed'), { recursive: true }),
    fs.mkdir(path.join(fixtureRoot, 'tests', 'integration-env-backed'), { recursive: true }),
    fs.mkdir(path.join(fixtureRoot, 'tests', 'staging-env-backed'), { recursive: true }),
    fs.mkdir(path.join(fixtureRoot, 'tests', 'pre-release-env-backed'), { recursive: true }),
    fs.mkdir(path.join(fixtureRoot, 'tests', 'shared'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(fixtureRoot, sharedProofFile), 'export const proof = true;\n');

  const environmentTestSource = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    '',
    "test('environment-backed proof', () => {",
    '  assert.equal(1, 1);',
    '});',
    '',
  ].join('\n');
  const writtenEnvironmentTestFiles = new Set(
    Object.values(environmentTestFiles).flatMap((mapping) => Object.values(mapping)),
  );
  for (const testFile of writtenEnvironmentTestFiles) {
    await fs.writeFile(path.join(fixtureRoot, testFile), environmentTestSource);
  }

  const evidenceFile = path.join(fixtureRoot, 'packages/testing/src/evidence.mjs');
  const bootstrapFile = path.join(fixtureRoot, 'packages/testing/src/bootstrap.mjs');
  const bootstrapSource = await fs.readFile(bootstrapFile, 'utf8');
  assert.match(bootstrapSource, /directory: 'tests\/local'/);
  await fs.writeFile(
    bootstrapFile,
    bootstrapSource
      .replace("directory: 'tests/local'", "directory: 'tests/local-env-backed'")
      .replace("directory: 'tests/integration'", "directory: 'tests/integration-env-backed'")
      .replace("directory: 'tests/staging'", "directory: 'tests/staging-env-backed'")
      .replace("directory: 'tests/pre-release'", "directory: 'tests/pre-release-env-backed'"),
  );

  const evidenceSource = await fs.readFile(evidenceFile, 'utf8');
  const mappingStart = evidenceSource.indexOf('const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({');
  const mappingEnd = evidenceSource.indexOf('const L1_EVIDENCE_DEFINITIONS =');
  assert.notEqual(mappingStart, -1);
  assert.notEqual(mappingEnd, -1);

  const minimalMappingBlock = [
    'const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({',
    `  'TEST-CS-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), 'ci-integration': Object.freeze(['${environmentTestFiles['ci-integration']['TEST-CS-001']}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-CS-001']}']) }),`,
    `  'TEST-CS-002': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-CS-002']}']) }),`,
    `  'TEST-CS-003': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-CS-003']}']) }),`,
    `  'TEST-CS-004': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), 'ci-integration': Object.freeze(['${environmentTestFiles['ci-integration']['TEST-CS-004']}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-CS-004']}']) }),`,
    `  'TEST-ROOM-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), 'ci-integration': Object.freeze(['${environmentTestFiles['ci-integration']['TEST-ROOM-001']}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-ROOM-001']}']) }),`,
    `  'TEST-ROOM-002': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), 'ci-integration': Object.freeze(['${environmentTestFiles['ci-integration']['TEST-ROOM-002']}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-ROOM-002']}']) }),`,
    `  'TEST-MEDIA-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-MEDIA-001']}']), 'pre-release': Object.freeze(['${environmentTestFiles['pre-release']['TEST-MEDIA-001']}']) }),`,
    `  'TEST-DER-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-DER-001']}']), 'pre-release': Object.freeze(['${environmentTestFiles['pre-release']['TEST-DER-001']}']) }),`,
    `  'TEST-E2E-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-E2E-001']}']) }),`,
    `  'TEST-SEC-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), staging: Object.freeze(['${environmentTestFiles.staging['TEST-SEC-001']}']), 'pre-release': Object.freeze(['${environmentTestFiles['pre-release']['TEST-SEC-001']}']) }),`,
    `  'TEST-OPS-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), 'pre-release': Object.freeze(['${environmentTestFiles['pre-release']['TEST-OPS-001']}']) }),`,
    `  'TEST-COST-001': Object.freeze({ local: Object.freeze(['${sharedProofFile}']), 'pre-release': Object.freeze(['${environmentTestFiles['pre-release']['TEST-COST-001']}']) }),`,
    '});',
    '',
  ].join('\n');
  await fs.writeFile(
    evidenceFile,
    `${evidenceSource.slice(0, mappingStart)}${minimalMappingBlock}${evidenceSource.slice(mappingEnd)}`,
  );
  await execFileAsync('git', ['add', '.'], { cwd: fixtureRoot });
  await execFileAsync('git', ['commit', '-m', 'Environment-backed fixture overrides'], { cwd: fixtureRoot });

  return {
    fixtureRoot,
    sharedProofFile,
    environmentTestFiles,
  };
}

async function createEnvironmentBackedManualArtifacts(fixtureRoot, runTimestamp, {
  sharedProofFile,
  environmentTestFiles,
}) {
  const { stdout: fixtureCommitStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot });
  const fixtureGitCommit = fixtureCommitStdout.trim();
  const externalRoot = path.join(fixtureRoot, 'external', runTimestamp);
  await fs.mkdir(externalRoot, { recursive: true });

  const manualArtifacts = {};
  for (const [environmentName, artifactId] of Object.entries(ENVIRONMENT_MANUAL_ARTIFACT_IDS)) {
    const artifactPath = path.join(externalRoot, `${environmentName}.json`);
    const environmentTopLevelTestFiles = [...new Set(Object.values(environmentTestFiles[environmentName]))].sort();
    const environmentTestDirectory = path.dirname(environmentTopLevelTestFiles[0]).replaceAll(path.sep, '/');
    const expandedTestFiles = [...environmentTopLevelTestFiles];
    let reportOverrides = {
      test_directory: environmentTestDirectory,
      test_files: environmentTopLevelTestFiles,
      test_file_count: environmentTopLevelTestFiles.length,
      expanded_test_files: expandedTestFiles,
      expanded_test_file_count: expandedTestFiles.length,
      log_artifact: `https://example.invalid/logs/fixture/${runTimestamp}/${environmentName}.log`,
      git_commit: fixtureGitCommit,
    };
    let attestationOverrides = {};
    const coversPreReleaseOps = environmentName === 'pre-release'
      && environmentTopLevelTestFiles.some((file) => path.basename(file).startsWith('test-ops-001'));
    const coversPreReleaseCost = environmentName === 'pre-release'
      && environmentTopLevelTestFiles.some((file) => path.basename(file).startsWith('test-cost-001'));
    const coversStagingBrowserE2E = environmentName === 'staging'
      && environmentTopLevelTestFiles.some((file) => path.basename(file).startsWith('test-e2e-001'));
    if (coversPreReleaseOps) {
      const validPreReleaseOpsReport = buildValidPreReleaseOpsReport(runTimestamp, reportOverrides);
      reportOverrides = {
        ...validPreReleaseOpsReport,
        source_run_uri: buildGitHubRunUri(environmentName, runTimestamp),
        ...(coversPreReleaseCost
          ? {
            pre_release_cost_observation: buildValidPreReleaseCostObservation(runTimestamp),
          }
          : {}),
      };
      attestationOverrides = {
        provenance: {
          deployment_identity: {
            environment_id: 'pre-release',
            deployment_ids: [validPreReleaseOpsReport.rollout_skew_probe.dual_version_deployment_id],
            worker_version_ids: [
              validPreReleaseOpsReport.rollout_skew_probe.baseline_gateway_version_id,
              validPreReleaseOpsReport.rollout_skew_probe.candidate_gateway_version_id,
              'jobs@pre-release-v1',
              'ops@pre-release-v1',
            ],
          },
        },
      };
    } else if (coversPreReleaseCost) {
      reportOverrides = {
        ...reportOverrides,
        pre_release_cost_observation: buildValidPreReleaseCostObservation(runTimestamp),
      };
    }
    if (coversStagingBrowserE2E) {
      reportOverrides = {
        ...reportOverrides,
        browser_journey_coverage: buildValidBrowserJourneyCoverageFixture(),
      };
    }
    await fs.writeFile(
      artifactPath,
      JSON.stringify(buildValidEnvironmentAttestation(environmentName, runTimestamp, {
        ...reportOverrides,
      }, attestationOverrides), null, 2),
    );
    manualArtifacts[artifactId] = path.relative(fixtureRoot, artifactPath);
  }

  const prodCostSnapshotPath = path.join(externalRoot, 'prod-cost-snapshot.json');
  await fs.writeFile(
    prodCostSnapshotPath,
    JSON.stringify(buildValidProdCostSnapshotAttestation(runTimestamp), null, 2),
  );
  manualArtifacts.prod_cost_snapshot = path.relative(fixtureRoot, prodCostSnapshotPath);

  return manualArtifacts;
}

test('test harness resolves layered environment names', () => {
  assert.equal(resolveTestEnvironmentName('integration'), 'ci-integration');
  assert.equal(resolveTestEnvironmentName('prerelease'), 'pre-release');
  assert.deepEqual(listTestEnvironmentNames(), ['local', 'ci-integration', 'staging', 'pre-release']);
});

test('test harness maps environments to the required directory layout', () => {
  assert.equal(getTestEnvironmentDefinition('staging').directory, 'tests/staging');
  assert.equal(
    getTestEnvironmentDirectory('pre-release', repoRoot),
    path.join(repoRoot, 'tests/pre-release'),
  );
});

test('environment-specific test discovery stays isolated by directory', async () => {
  const localFiles = await discoverTestFiles('local', repoRoot);
  const integrationFiles = await discoverTestFiles('ci-integration', repoRoot);

  assert.ok(localFiles.some((file) => file.endsWith('tests/local/runtime-foundations/config.test.mjs')));
  assert.ok(integrationFiles.every((file) => file.includes(path.join('tests', 'integration'))));
});

test('required test discovery fails closed when an environment layer is empty or missing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });

  await assert.rejects(
    () => getRequiredTestFiles('ci-integration', tempRoot),
    /No ci-integration tests found/,
  );
  await assert.rejects(
    () => getRequiredTestFiles('staging', tempRoot),
    /No staging tests found/,
  );
});

test('release-gate test discovery excludes generic non-local bootstrap and smoke entrypoints', async () => {
  const integrationFiles = await getReleaseGateTestFiles('ci-integration', repoRoot);
  const stagingFiles = await getReleaseGateTestFiles('staging', repoRoot);
  const preReleaseFiles = await getReleaseGateTestFiles('pre-release', repoRoot);

  for (const files of [integrationFiles, stagingFiles, preReleaseFiles]) {
    assert.ok(files.length > 0);
    assert.ok(files.every((file) => !file.endsWith('bootstrap.test.mjs')));
    assert.ok(files.every((file) => !file.endsWith('l1-mandatory.test.mjs')));
  }
});

test('release-gate test discovery fails closed when a non-local environment only has generic smoke entrypoints', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-release-gate-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'tests', 'staging', 'bootstrap.test.mjs'), 'export const bootstrap = true;\n');
  await fs.writeFile(path.join(tempRoot, 'tests', 'staging', 'l1-mandatory.test.mjs'), 'export const smoke = true;\n');

  await assert.rejects(
    () => getReleaseGateTestFiles('staging', tempRoot),
    /No staging release-gate tests found/,
  );
});

test('L1 evidence bundles require environment-backed artifacts for non-local runs', () => {
  const cs001Requirements = buildRequiredManualArtifactDefinitions(getL1EvidenceDefinition('EVID-CS-001'));
  assert.deepEqual(
    cs001Requirements.map((requirement) => requirement.artifact_id),
    ['ci_integration_run_report', 'staging_run_report'],
  );

  const sec001Requirements = buildRequiredManualArtifactDefinitions(getL1EvidenceDefinition('EVID-SEC-001'));
  assert.deepEqual(
    sec001Requirements.map((requirement) => requirement.artifact_id),
    ['staging_run_report', 'pre_release_run_report'],
  );
});

test('cost evidence keeps the production snapshot requirement alongside pre-release proof', () => {
  const requirements = buildRequiredManualArtifactDefinitions(getL1EvidenceDefinition('EVID-COST-001'));
  assert.deepEqual(
    requirements.map((requirement) => requirement.artifact_id),
    ['pre_release_run_report', 'prod_cost_snapshot'],
  );
});

test('cost evidence source ids stay in sync with the evidence register', () => {
  const definition = getL1EvidenceDefinition('EVID-COST-001');
  assert.deepEqual(
    definition.declared_source_ids,
    [
      'REQ-OPS-003',
      'CF-WKR-015',
      'CF-WKR-016',
      'CF-WKR-017',
      'CF-WKR-018',
      'CF-WKR-019',
      'CF-WKR-029',
      'CF-WKR-030',
      'CF-DO-011',
      'CF-DO-012',
      'CF-DO-013',
      'CF-D1-006',
      'CF-KV-003',
      'CF-R2-005',
      'CF-QUE-001',
    ],
  );
});

test('client-core evidence metadata stays in sync with the evidence register', () => {
  const definition = getL1EvidenceDefinition('EVID-CS-001');
  assert.deepEqual(
    definition.declared_source_ids,
    [
      'MX-CS-001',
      'MX-CS-002',
      'MX-CS-003',
      'MX-CS-005',
      'MX-CS-006',
      'MX-CS-019',
      'MX-CS-024',
      'MX-CS-026',
      'CF-WKR-027',
      'DEC-0007',
    ],
  );
  assert.match(
    definition.pass_criteria,
    /live 429 M_LIMIT_EXCEEDED within a bounded non-local retry window/,
  );
  assert.match(
    definition.pass_criteria,
    /shared public-entry wiring remains separately locked by local runtime-control regression coverage/,
  );
});

test('L1 evidence definitions keep attested generation methods in sync with the evidence register', () => {
  assert.equal(
    getL1EvidenceDefinition('EVID-CS-001').generation_method,
    'client-core CI + staging attestation bundle plus required local runtime-control regression coverage for shared public-entry wiring',
  );
  assert.deepEqual(
    getL1EvidenceDefinition('EVID-CS-001').required_environments,
    ['local', 'ci-integration', 'staging'],
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-CS-002').generation_method,
    '/sync conformance attested staging report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-CS-003').generation_method,
    'devices/E2EE transport attested staging report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-CS-004').generation_method,
    'stub-only/unsupported route guard attested CI + staging report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-ROOM-001').generation_method,
    'room-core attested CI + staging report',
  );
  assert.match(
    getL1EvidenceDefinition('EVID-ROOM-001').pass_criteria,
    /empty-state-key room-state \/state\/\{eventType\} and \/state\/\{eventType\}\/ variants must converge on the same truth/,
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-ROOM-002').generation_method,
    'room-version attested CI + staging report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-MEDIA-001').generation_method,
    'media pipeline attested staging + pre-release report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-DER-001').generation_method,
    'derived-data attested staging + pre-release report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-SEC-001').generation_method,
    'security attested staging + pre-release bundle',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-OPS-001').generation_method,
    'rollout compatibility attested pre-release report',
  );
  assert.equal(
    getL1EvidenceDefinition('EVID-COST-001').generation_method,
    'attested monthly dashboard snapshot + model comparison',
  );
  assert.equal(
    buildRequiredManualArtifactDefinitions(getL1EvidenceDefinition('EVID-COST-001'))[1].description,
    'Production monthly dashboard snapshot attestation for the same evidence run.',
  );
});

test('L1 evidence bundle set includes governance and canonical test implementation mappings', () => {
  assert.deepEqual(listL1EvidenceBundleIds().slice(0, 2), ['EVID-GOV-001', 'EVID-CS-001']);
  assert.deepEqual(
    getRequiredTestImplementationFiles('TEST-CS-001'),
    [
      'tests/local/client-identity/phase-04.test.mjs',
      'tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs',
    ],
  );
  assert.deepEqual(
    getRequiredTestImplementationFiles('TEST-OPS-001'),
    [
      'tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs',
      'tests/local/control-plane/phase-08-ops.test.mjs',
    ],
  );
});

test('non-local coverage fails closed when a required environment report does not execute the canonical implementation', async () => {
  const results = await collectTestCoverageResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    {
      'pre-release': {
        expanded_test_files: [
          'tests/local/control-plane/phase-08-ops.test.mjs',
        ],
      },
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].satisfied, false);
  assert.equal(results[0].mapping_error, null);
  assert.deepEqual(results[0].missing_files, ['tests/pre-release/test-ops-001.test.mjs']);
});

test('EVID-CS-001 fails closed when the required local runtime-control coverage is missing', async () => {
  const results = await collectTestCoverageResults(
    getL1EvidenceDefinition('EVID-CS-001'),
    {
      local: {
        expanded_test_files: [
          'tests/local/client-identity/phase-04.test.mjs',
        ],
      },
      'ci-integration': {
        expanded_test_files: [
          'tests/integration/test-cs-001.test.mjs',
        ],
      },
      staging: {
        expanded_test_files: [
          'tests/staging/test-cs-001.test.mjs',
        ],
      },
    },
  );

  assert.equal(results.length, 3);
  const localResult = results.find((result) => result.environment_name === 'local');
  assert.equal(localResult?.satisfied, false);
  assert.equal(localResult?.mapping_error, null);
  assert.deepEqual(
    localResult?.missing_files,
    ['tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs'],
  );
});

test('non-local coverage fails closed when a required environment mapping points at generic or shared non-local files', async () => {
  const fixtureRoot = await createIsolatedRepoFixture('matrix-testing-harness-smoke-mapping-repo-');
  const fixtureParent = path.dirname(fixtureRoot);

  try {
    const evidenceFile = path.join(fixtureRoot, 'packages/testing/src/evidence.mjs');
    const evidenceSource = await fs.readFile(evidenceFile, 'utf8');
    const mappingStart = evidenceSource.indexOf('const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({');
    const mappingEnd = evidenceSource.indexOf('const L1_EVIDENCE_DEFINITIONS =');
    assert.notEqual(mappingStart, -1);
    assert.notEqual(mappingEnd, -1);

    const invalidCases = [
      {
        mappedFile: 'tests/staging/l1-mandatory.test.mjs',
        expectedError: /generic entrypoint/,
      },
      {
        mappedFile: 'tests/staging/bootstrap.test.mjs',
        expectedError: /generic entrypoint/,
      },
      {
        mappedFile: 'tests/shared/nonlocal/support.mjs',
        expectedError: /dedicated environment directory/,
      },
      {
        mappedFile: 'tests/staging/generic-shim.test.mjs',
        expectedError: /basename is anchored by "test-cs-002"/,
      },
      {
        mappedFile: 'tests/staging/test-cs-002-missing.test.mjs',
        expectedError: /must reference existing repo-owned \.test\.mjs files/,
      },
    ];

    for (const { mappedFile, expectedError } of invalidCases) {
      const smokeMappingBlock = [
        'const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({',
        `  'TEST-CS-002': Object.freeze({ staging: Object.freeze(['${mappedFile}']) }),`,
        '});',
        '',
      ].join('\n');
      await fs.writeFile(
        evidenceFile,
        `${evidenceSource.slice(0, mappingStart)}${smokeMappingBlock}${evidenceSource.slice(mappingEnd)}`,
      );

      const fixtureEvidenceModule = await loadFixtureEvidenceModule(fixtureRoot);
      const results = await fixtureEvidenceModule.collectTestCoverageResults(
        fixtureEvidenceModule.getL1EvidenceDefinition('EVID-CS-002'),
        {
          staging: {
            expanded_test_files: [mappedFile],
          },
        },
        fixtureRoot,
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].satisfied, false);
      assert.match(results[0].mapping_error ?? '', expectedError);
    }
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('non-local coverage fails closed when a prefixed wrapper expands generic or shared non-local files', async () => {
  const fixtureRoot = await createIsolatedRepoFixture('matrix-testing-harness-wrapper-mapping-repo-');
  const fixtureParent = path.dirname(fixtureRoot);

  try {
    const evidenceFile = path.join(fixtureRoot, 'packages/testing/src/evidence.mjs');
    const evidenceSource = await fs.readFile(evidenceFile, 'utf8');
    const mappingStart = evidenceSource.indexOf('const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({');
    const mappingEnd = evidenceSource.indexOf('const L1_EVIDENCE_DEFINITIONS =');
    assert.notEqual(mappingStart, -1);
    assert.notEqual(mappingEnd, -1);

    await fs.mkdir(path.join(fixtureRoot, 'tests', 'staging'), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, 'tests', 'shared', 'nonlocal'), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, 'tests', 'shared', 'nonlocal', 'support.mjs'), 'export const support = true;\n');

    const invalidCases = [
      {
        wrapperImport: "await import('./l1-mandatory.test.mjs');\n",
        expectedError: /dependency closure within dedicated environment directory|cannot expand generic entrypoint/,
      },
      {
        wrapperImport: "await import('../shared/nonlocal/support.mjs');\n",
        expectedError: /dependency closure within dedicated environment directory/,
      },
    ];

    for (const { wrapperImport, expectedError } of invalidCases) {
      await fs.writeFile(path.join(fixtureRoot, 'tests', 'staging', 'test-cs-002-wrapper.test.mjs'), wrapperImport);
      const smokeMappingBlock = [
        'const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({',
        "  'TEST-CS-002': Object.freeze({ staging: Object.freeze(['tests/staging/test-cs-002-wrapper.test.mjs']) }),",
        '});',
        '',
      ].join('\n');
      await fs.writeFile(
        evidenceFile,
        `${evidenceSource.slice(0, mappingStart)}${smokeMappingBlock}${evidenceSource.slice(mappingEnd)}`,
      );

      const fixtureEvidenceModule = await loadFixtureEvidenceModule(fixtureRoot);
      const results = await fixtureEvidenceModule.collectTestCoverageResults(
        fixtureEvidenceModule.getL1EvidenceDefinition('EVID-CS-002'),
        {
          staging: {
            expanded_test_files: ['tests/staging/test-cs-002-wrapper.test.mjs'],
          },
        },
        fixtureRoot,
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].satisfied, false);
      assert.match(results[0].mapping_error ?? '', expectedError);
    }
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('non-local coverage fails closed when a canonical suite symlink escapes repo ownership', async () => {
  const fixtureRoot = await createIsolatedRepoFixture('matrix-testing-harness-symlink-mapping-repo-');
  const fixtureParent = path.dirname(fixtureRoot);

  try {
    const evidenceFile = path.join(fixtureRoot, 'packages/testing/src/evidence.mjs');
    const evidenceSource = await fs.readFile(evidenceFile, 'utf8');
    const mappingStart = evidenceSource.indexOf('const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({');
    const mappingEnd = evidenceSource.indexOf('const L1_EVIDENCE_DEFINITIONS =');
    assert.notEqual(mappingStart, -1);
    assert.notEqual(mappingEnd, -1);

    await fs.mkdir(path.join(fixtureRoot, 'tests', 'staging'), { recursive: true });
    const mappedFile = 'tests/staging/test-cs-002-symlink.test.mjs';
    const externalProofFile = path.join(fixtureParent, 'external-proof.test.mjs');
    await fs.writeFile(externalProofFile, "export const proof = true;\n");
    await fs.symlink(externalProofFile, path.join(fixtureRoot, mappedFile));

    const smokeMappingBlock = [
      'const L1_TEST_IMPLEMENTATION_FILES = Object.freeze({',
      `  'TEST-CS-002': Object.freeze({ staging: Object.freeze(['${mappedFile}']) }),`,
      '});',
      '',
    ].join('\n');
    await fs.writeFile(
      evidenceFile,
      `${evidenceSource.slice(0, mappingStart)}${smokeMappingBlock}${evidenceSource.slice(mappingEnd)}`,
    );

    const fixtureEvidenceModule = await loadFixtureEvidenceModule(fixtureRoot);
    const results = await fixtureEvidenceModule.collectTestCoverageResults(
      fixtureEvidenceModule.getL1EvidenceDefinition('EVID-CS-002'),
      {
        staging: {
          expanded_test_files: [mappedFile],
        },
      },
      fixtureRoot,
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].satisfied, false);
    assert.match(results[0].mapping_error ?? '', /escapes repo-owned dependencies/);
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('manual artifact payload validation requires structured non-local reports and typed prod snapshots', () => {
  const runTimestamp = '20260331T140000Z';
  const validStagingReport = buildValidEnvironmentReport('staging', runTimestamp);
  const validPreReleaseReport = buildValidEnvironmentReport('pre-release', runTimestamp);
  const validPreReleaseOpsReport = buildValidPreReleaseOpsReport(runTimestamp);
  const validPreReleaseCostReport = buildValidPreReleaseCostReport(runTimestamp);
  const validProdCostSnapshot = buildValidProdCostSnapshot(runTimestamp);

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', validStagingReport, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', validPreReleaseReport, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', buildValidEnvironmentReport('staging', runTimestamp, {
      test_directory: 'tests/staging',
      test_file_count: 1,
      test_files: ['tests/staging/test-e2e-001.test.mjs'],
      expanded_test_file_count: 1,
      expanded_test_files: ['tests/staging/test-e2e-001.test.mjs'],
      browser_journey_coverage: buildValidBrowserJourneyCoverageFixture(),
    }), { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', buildValidEnvironmentReport('staging', runTimestamp, {
      test_directory: 'tests/staging',
      test_file_count: 1,
      test_files: ['tests/staging/test-e2e-001.test.mjs'],
      expanded_test_file_count: 1,
      expanded_test_files: ['tests/staging/test-e2e-001.test.mjs'],
      browser_journey_coverage: null,
    }), { runTimestamp }),
    {
      valid: false,
      error: 'environment run report browser_journey_coverage is invalid: browser journey coverage report must be an object',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', buildValidEnvironmentReport('staging', runTimestamp, {
      test_directory: 'tests/staging',
      test_file_count: 1,
      test_files: ['tests/staging/test-e2e-001.test.mjs'],
      expanded_test_file_count: 1,
      expanded_test_files: ['tests/staging/test-e2e-001.test.mjs'],
      browser_journey_coverage: buildValidBrowserJourneyCoverageFixture({
        journeys: BROWSER_JOURNEY_MATRIX
          .filter((journey) => journey.required && journey.journey_id !== 'E2E-JRY-015')
          .map((journey) => ({
            journey_id: journey.journey_id,
            status: 'pass',
            artifacts: [`browser-artifacts/${journey.journey_id.toLowerCase()}.png`],
          })),
      }),
    }), { runTimestamp }),
    {
      valid: false,
      error: 'environment run report browser_journey_coverage is invalid: browser journey coverage report coverage_summary.coverage_ratio must satisfy the minimum coverage threshold',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      status: 'fail',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must have status "pass"',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      exit_code: 1,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must have exit_code 0',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      run_timestamp: '20260331T140001Z',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: `environment run report must have run_timestamp ${runTimestamp}`,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      started_at: '2026-03-31T14:00:00+02:00',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include RFC 3339 UTC started_at and completed_at timestamps',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      test_file_count: 2,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include test_files matching test_file_count',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      command: '/usr/bin/node --test /tmp/tests/staging/not-the-real-suite.test.mjs',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report command must enumerate the same repo-relative test_files claimed by the report',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      expanded_test_file_count: 1,
      expanded_test_files: ['tests/staging/support.mjs'],
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report expanded_test_files must include claimed test_file tests/staging/remote.test.mjs',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      executed_by: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include executed_by',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      reviewed_by: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include reviewed_by',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      git_commit: 'not-a-git-commit',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include git_commit as a 40-character lowercase git sha',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      log_artifact: './local.log',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include an absolute external log_artifact',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      source_run_uri: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include an absolute external source_run_uri',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      source_run_uri: 'about:blank',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include an absolute external source_run_uri',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      source_run_uri: 'urn:',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include an absolute external source_run_uri',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      source_run_uri: 'urn:matrix:evidence:run:123',
    }, {
      runTimestamp,
    }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      output_sha256: 'not-a-sha',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include a 64-character hex output_sha256',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      topology_kind: 'local',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include a non-local topology_kind',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      cloudflare_resources: null,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include cloudflare_resources',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      readiness_probe: null,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include readiness_probe',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      readiness_probe: {
        ...validStagingReport.readiness_probe,
        attempts: [{
          ...validStagingReport.readiness_probe.attempts[0],
          steps: validStagingReport.readiness_probe.attempts[0].steps.map((step) => (
            step.step === 'versions'
              ? { ...step, detail: { versions_count: 1, browser_compatible_version_ladder: false, browser_compatible_cors: true } }
              : step
          )),
        }],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report readiness_probe final versions step must prove the browser-compatible version ladder and CORS headers',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      readiness_probe: {
        ...validStagingReport.readiness_probe,
        attempts: [{
          ...validStagingReport.readiness_probe.attempts[0],
          steps: validStagingReport.readiness_probe.attempts[0].steps.map((step) => (
            step.step === 'versions'
              ? { ...step, detail: { versions_count: CLIENT_DISCOVERY_VERSIONS.length, browser_compatible_version_ladder: true, browser_compatible_cors: false } }
              : step
          )),
        }],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report readiness_probe final versions step must prove the browser-compatible version ladder and CORS headers',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      readiness_probe: {
        ...validStagingReport.readiness_probe,
        attempts: [
          {
            ...validStagingReport.readiness_probe.attempts[0],
            ok: false,
            failure: {
              step_name: 'media_create',
              detail: {
                status: 500,
              },
            },
          },
        ],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report readiness_probe must include a successful final attempt',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      readiness_probe: {
        ...validStagingReport.readiness_probe,
        attempts: [
          {
            ...validStagingReport.readiness_probe.attempts[0],
            steps: validStagingReport.readiness_probe.attempts[0].steps.filter((step) => step.step !== 'ops_rebuild_start'),
          },
        ],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report readiness_probe final attempt must include successful steps: ops_rebuild_start',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      cloudflare_resources: {
        ...validStagingReport.cloudflare_resources,
        workers: [],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report cloudflare_resources.workers must be a non-empty string array',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      cloudflare_resources: {
        ...validStagingReport.cloudflare_resources,
        kv_namespaces: [],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report cloudflare_resources.kv_namespaces must be a non-empty string array',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      cloudflare_resources: {
        ...validStagingReport.cloudflare_resources,
        workers: ['matrix-gateway-worker-staging', 'matrix-jobs-worker-staging', 'matrix-ops-worker-ci-integration'],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report cloudflare_resources.workers must match expected staging resources',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      expanded_test_file_count: 2,
      expanded_test_files: [
        'tests/staging/l1-mandatory.test.mjs',
        'tests/local/client-identity/phase-04.test.mjs',
      ],
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must not expand local test implementations',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseReport,
      rollout_skew_probe: buildValidRolloutSkewProbe(runTimestamp),
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report rollout_skew_probe must be null unless TEST-OPS-001 is covered',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseReport,
      pre_release_cost_observation: buildValidPreReleaseCostObservation(runTimestamp),
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report pre_release_cost_observation must be null unless TEST-COST-001 is covered',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseOpsReport,
      rollout_skew_probe: null,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include rollout_skew_probe',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseOpsReport,
      rollout_skew_probe: {
        ...validPreReleaseOpsReport.rollout_skew_probe,
        assertions: {
          new_worker_old_authority: true,
          old_worker_new_authority: false,
        },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report rollout_skew_probe assertions must both be true',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', validPreReleaseOpsReport, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseOpsReport,
      rollout_skew_probe: {
        ...validPreReleaseOpsReport.rollout_skew_probe,
        observations: validPreReleaseOpsReport.rollout_skew_probe.observations.map((entry, index) => index === 0
          ? {
            ...entry,
            observed_gateway_version_tag: `${entry.observed_gateway_version_tag}-unexpected`,
          }
          : entry),
      },
    }, { runTimestamp }),
    {
      valid: false,
      error: 'environment run report rollout_skew_probe must include new-worker-old-authority/UserDO observation',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseOpsReport,
      rollout_skew_probe: {
        ...validPreReleaseOpsReport.rollout_skew_probe,
        observations: validPreReleaseOpsReport.rollout_skew_probe.observations.map((entry) => ({
          ...entry,
          observed_gateway_version_id: null,
        })),
      },
    }, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseCostReport,
      pre_release_cost_observation: null,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include pre_release_cost_observation',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseCostReport,
      pre_release_cost_observation: {
        ...validPreReleaseCostReport.pre_release_cost_observation,
        capture_method: 'estimated-local-model',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report pre_release_cost_observation.capture_method must be cloudflare-official-metrics',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', {
      ...validPreReleaseCostReport,
      pre_release_cost_observation: {
        ...validPreReleaseCostReport.pre_release_cost_observation,
        source_query_uris: ['https://example.invalid/cloudflare/pre-release/cost'],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report pre_release_cost_observation.source_query_uris must be official Cloudflare HTTPS locators',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('pre_release_run_report', validPreReleaseCostReport, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', {
      ...validStagingReport,
      expanded_test_files: [
        'tests/staging/remote.test.mjs',
        'packages/testing/src/bootstrap.mjs',
      ],
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report expanded_test_files must stay within tests/staging',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', validProdCostSnapshot, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      artifact_id: 'unexpected',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot artifact_id must be "prod_cost_snapshot"',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      source_environment: 'staging',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot source_environment must be "prod"',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      run_timestamp: '20260331T140001Z',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: `prod_cost_snapshot must have run_timestamp ${runTimestamp}`,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      captured_at: '2026-03-31T14:00:00+02:00',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot captured_at must be an RFC 3339 UTC timestamp',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_period: {
        start: '2026-03-31T00:00:00+02:00',
        end: '2026-03-31T23:59:59.000Z',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_period must include RFC 3339 UTC start and end timestamps',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_period: {
        start: '2026-03-31T00:00:00.000Z',
        end: '2026-03-01T00:00:00.000Z',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_period start must be earlier than end',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      reviewed_by: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot must include reviewed_by',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      topology_kind: 'local',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot must include a non-local topology_kind',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      cloudflare_resources: {
        ...validProdCostSnapshot.cloudflare_resources,
        queues: [],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot cloudflare_resources.queues must be a non-empty string array',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      cloudflare_resources: {
        ...validProdCostSnapshot.cloudflare_resources,
        r2_buckets: ['matrix-archive-prod', 'matrix-media-prod'],
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot cloudflare_resources.r2_buckets must match expected prod resources',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      cost_surfaces: {
        ...validProdCostSnapshot.cost_surfaces,
        telemetry_export: {
          trace_span_count: 600,
          exported_log_event_count: 500,
        },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot cost_surfaces.telemetry_export.persist_enabled must be boolean when telemetry_export is present',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      source_dashboard_uri: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot source_dashboard_uri must be an official Cloudflare HTTPS locator',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      source_dashboard_uri: 'https://[::ffff:127.0.0.1]/billing',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot source_dashboard_uri must be an official Cloudflare HTTPS locator',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_window_resolution_method: 'manual-calendar-month',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_window_resolution_method must be cloudflare-account-billing-profile-next-bill-date or cloudflare-account-subscriptions-current-period-end',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_cycle_anchor_source_uri: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_cycle_anchor_source_uri must be an official Cloudflare HTTPS locator',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_cycle_anchor_source_uri: 'https://api.cloudflare.com/client/v4/accounts/cf-account/billing/profile',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_cycle_anchor_source_uri must match the official Cloudflare billing-cycle source for billing_window_resolution_method',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_cycle_anchor_artifact: null,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot must include billing_cycle_anchor_artifact',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_cycle_anchor_artifact: {
        artifact_path: 'billing-profile.json',
        field_selector: 'result.next_bill_date',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_cycle_anchor_artifact.artifact_path must match the retained raw billing-cycle artifact for billing_window_resolution_method',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_cycle_next_bill_date: '2026-06-15T12:21:59+02:00',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_cycle_next_bill_date must be an RFC 3339 UTC timestamp',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_cycle_next_bill_date: '2026-04-15T12:21:59.345Z',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_cycle_next_bill_date must not be earlier than the captured_at date',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      topology_baseline_install: null,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot must include topology_baseline_install',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      billing_period: {
        start: '2026-04-01T00:00:00.000Z',
        end: '2026-05-15T00:00:00.000Z',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_period.start must match the latest closed billing period derived from billing_cycle_next_bill_date',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      topology_baseline_install: {
        ...validProdCostSnapshot.topology_baseline_install,
        installed_at: '2026-04-16T09:00:00.000Z',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot billing_period.start must be after topology_baseline_install.installed_at date',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      model_comparison: {
        ...validProdCostSnapshot.model_comparison,
        actual_total_usd: undefined,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot model_comparison.actual_total_usd must be a non-negative number',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      cost_surfaces: {
        ...validProdCostSnapshot.cost_surfaces,
        queues: { write_ops: 80, read_ops: 80 },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot cost_surfaces.queues must include write_ops, read_ops, delete_ops',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      model_comparison: {
        status: 'within_expected',
        summary: 'No budget drift detected.',
        actual_total_usd: 12.3,
        drift_ratio: 0.02,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot model_comparison.modeled_total_usd must be a non-negative number',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_cost_snapshot', {
      ...validProdCostSnapshot,
      model_comparison: {
        status: 'within_expected',
        summary: 'No budget drift detected.',
        actual_total_usd: 12.3,
        modeled_total_usd: 12.1,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'prod_cost_snapshot model_comparison.drift_ratio must be a non-negative number',
    },
  );
});

test('manual artifact payload validation enforces production automation artifact contracts', () => {
  const runTimestamp = '20260331T140000Z';
  const validReleaseCandidate = buildValidProdReleaseCandidateManifest(runTimestamp);
  const validInstallRecord = buildValidProdInstallRecord();
  const validPromotionRecord = buildValidProdPromotionRecord();
  const validRollbackRecord = buildValidProdRollbackRecord();

  assert.deepEqual(
    validateManualArtifactPayload('prod_release_candidate', validReleaseCandidate, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_release_candidate', {
      ...validReleaseCandidate,
      topology_kind: 'cloudflare-pre-release',
    }, { runTimestamp }),
    {
      valid: false,
      error: 'prod_release_candidate topology_kind must be "cloudflare-prod"',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_install_record', validInstallRecord),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_install_record', {
      ...validInstallRecord,
      access: {
        ...validInstallRecord.access,
        application_domain: '',
      },
    }),
    {
      valid: false,
      error: 'prod_install_record access.application_domain must be non-empty',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_promotion_record', validPromotionRecord),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_promotion_record', {
      ...validPromotionRecord,
      promotion_authority: 'operational_unblock',
      source_candidate: null,
      operational_unblock: {
        reason: 'Operational prod refresh to unblock Phase 08 cost closure',
        blocked_by_open_questions: ['OQ-0002', 'OQ-0006'],
      },
    }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_promotion_record', {
      ...validPromotionRecord,
      promotion_authority: 'operational_unblock',
      source_candidate: {
        candidate_id: 'candidate-20260331t140000z',
        source_run_uri: buildGitHubRunUri('prod', '20260331T140000Z'),
      },
      operational_unblock: {
        reason: 'Operational prod refresh to unblock Phase 08 cost closure',
        blocked_by_open_questions: ['OQ-0002', 'OQ-0006'],
      },
    }),
    {
      valid: false,
      error: 'prod_promotion_record source_candidate must be null for operational_unblock promotions',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_promotion_record', {
      ...validPromotionRecord,
      gateway_rollout_steps: [
        { percentage: 0, deployment_id: 'gateway-prod-rollout-0', ready: true },
      ],
    }),
    {
      valid: false,
      error: 'prod_promotion_record gateway_rollout_steps[0].percentage must be an integer between 1 and 100',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_promotion_record', {
      ...validPromotionRecord,
      promotion_mode: 'deploy_with_migration',
      gateway_rollout_steps: [],
      readiness_checks: {
        jobs_promoted: buildValidProdReadinessProbe(),
        ops_promoted: buildValidProdReadinessProbe(),
        gateway_promoted: buildValidProdReadinessProbe(),
      },
      rollback_handle: buildValidProdRollbackHandle(),
    }),
    {
      valid: false,
      error: 'prod_promotion_record rollback_handle must be null for deploy_with_migration promotions',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_promotion_record', {
      ...validPromotionRecord,
      rollback_handle: {
        ...validPromotionRecord.rollback_handle,
        worker_versions: {
          ...validPromotionRecord.rollback_handle.worker_versions,
          'gateway-worker': {
            ...validPromotionRecord.rollback_handle.worker_versions['gateway-worker'],
            restore_version_specs: [],
          },
        },
      },
    }),
    {
      valid: false,
      error: 'prod_promotion_record rollback_handle.worker_versions.gateway-worker.restore_version_specs must be a non-empty string array',
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_rollback_record', validRollbackRecord),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateManualArtifactPayload('prod_rollback_record', {
      ...validRollbackRecord,
      readiness_probe: {
        ...validRollbackRecord.readiness_probe,
        attempts: [],
      },
    }),
    {
      valid: false,
      error: 'prod_rollback_record readiness_probe.attempts must match attempt_count',
    },
  );
});

test('manual artifact attestation validation requires immutable provenance plus typed payloads', () => {
  const runTimestamp = '20260331T140000Z';
  const validStagingAttestation = buildValidEnvironmentAttestation('staging', runTimestamp);
  const validPreReleaseOpsReport = buildValidPreReleaseOpsReport(runTimestamp);
  const validPreReleaseOpsAttestation = buildValidEnvironmentAttestation(
    'pre-release',
    runTimestamp,
    {
      ...validPreReleaseOpsReport,
      source_run_uri: buildGitHubRunUri('pre-release', runTimestamp),
      topology_kind: 'cloudflare-pre-release',
    },
    {
      provenance: {
        deployment_identity: {
          environment_id: 'pre-release',
          deployment_ids: [validPreReleaseOpsReport.rollout_skew_probe.dual_version_deployment_id],
          worker_version_ids: [
            validPreReleaseOpsReport.rollout_skew_probe.baseline_gateway_version_id,
            validPreReleaseOpsReport.rollout_skew_probe.candidate_gateway_version_id,
            'jobs@pre-release-v1',
            'ops@pre-release-v1',
          ],
        },
      },
    },
  );
  const validProdCostAttestation = buildValidProdCostSnapshotAttestation(runTimestamp);

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', validStagingAttestation, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('pre_release_run_report', validPreReleaseOpsAttestation, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('pre_release_run_report', {
      ...validPreReleaseOpsAttestation,
      payload: {
        ...validPreReleaseOpsAttestation.payload,
        deployment_identity_validation: null,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attested payload invalid: environment run report must include deployment_identity_validation when TEST-OPS-001 is covered',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('pre_release_run_report', {
      ...validPreReleaseOpsAttestation,
      provenance: {
        ...validPreReleaseOpsAttestation.provenance,
        deployment_identity: {
          ...validPreReleaseOpsAttestation.provenance.deployment_identity,
          deployment_ids: ['wrong-deployment-id'],
        },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity.deployment_ids must include rollout_skew_probe.dual_version_deployment_id',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      schema_version: 2,
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle schema_version must be 1',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      attested_at: '2026-03-31T14:06:00+02:00',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle must include RFC 3339 UTC attested_at',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_repository: '',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_repository must be a GitHub owner/repo slug',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_repository: FOREIGN_TEST_GITHUB_REPOSITORY,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_repository must match provenance.origin_run_uri',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', validStagingAttestation, {
      runTimestamp,
      expectedGitHubRepository: FOREIGN_TEST_GITHUB_REPOSITORY,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_repository must match the current repository',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_id: '',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_id must be non-empty',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_uri: 'not-a-uri',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_uri must be a GitHub Actions run URL',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_uri: `${validStagingAttestation.provenance.origin_run_uri}/artifacts/123`,
      },
      payload: {
        ...validStagingAttestation.payload,
        source_run_uri: `${validStagingAttestation.payload.source_run_uri}/artifacts/123`,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_uri must be a GitHub Actions run URL',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        review_record_uri: 'https://[::ffff:127.0.0.1]/review',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.review_record_uri must be an absolute external URI',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_uri: 'urn:',
      },
      payload: {
        ...validStagingAttestation.payload,
        source_run_uri: 'urn:',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_uri must be a GitHub Actions run URL',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_system: 'not-github-actions',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_system must be github-actions',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_id: 'mismatched-run-id',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_id must match provenance.origin_run_uri',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_uri: 'urn:matrix:evidence:run:123',
      },
      payload: {
        ...validStagingAttestation.payload,
        source_run_uri: 'urn:matrix:evidence:run:123',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_uri must be a GitHub Actions run URL',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        review_record_uri: 'urn:matrix:evidence:review:123',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: 'still-not-a-uri',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_uri must be an immutable R2 object locator',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: 'https://example.invalid/artifacts/staging/attestation.json',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_uri must be an immutable R2 object locator',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: 'r2://matrix-evidence-staging/staging/20260331T140000Z/attestation.json?query=1',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_uri must be an immutable R2 object locator',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_key: 'staging/20260331T140000Z/attestation.json',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must match provenance.artifact_store_uri',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: 'r2://matrix-evidence-staging/gha/99999/1/staging/20260331T140000Z/run-bundle.tgz',
        artifact_store_key: 'gha/99999/1/staging/20260331T140000Z/run-bundle.tgz',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode provenance.origin_run_id',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: `r2://matrix-evidence-staging/${buildPhase08ArtifactStoreKey('staging', runTimestamp, 'run-bundle.tgz').replace('/1/', '/2/')}`,
        artifact_store_key: buildPhase08ArtifactStoreKey('staging', runTimestamp, 'run-bundle.tgz').replace('/1/', '/2/'),
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode provenance.origin_run_attempt',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: `r2://matrix-evidence-staging/gha/${buildGitHubRunId('staging', runTimestamp)}/1/pre-release/${runTimestamp}/run-bundle.tgz`,
        artifact_store_key: `gha/${buildGitHubRunId('staging', runTimestamp)}/1/pre-release/${runTimestamp}/run-bundle.tgz`,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode source_environment',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        artifact_store_uri: `r2://matrix-evidence-staging/gha/${buildGitHubRunId('staging', runTimestamp)}/1/staging/20260331T140001Z/run-bundle.tgz`,
        artifact_store_key: `gha/${buildGitHubRunId('staging', runTimestamp)}/1/staging/20260331T140001Z/run-bundle.tgz`,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_store_key must encode run_timestamp',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        origin_run_uri: 'http://localhost:8787/run',
      },
      payload: {
        ...validStagingAttestation.payload,
        source_run_uri: 'http://localhost:8787/run',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.origin_run_uri must be a GitHub Actions run URL',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        topology_kind: 'local',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.topology_kind must be cloudflare-staging',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      provenance: {
        ...validStagingAttestation.provenance,
        deployment_identity: {
          ...validStagingAttestation.provenance.deployment_identity,
          environment_id: 'pre-release',
        },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.deployment_identity.environment_id must equal source_environment',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      payload: {
        ...validStagingAttestation.payload,
        source_run_uri: 'https://example.invalid/runs/staging/other',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle payload source_run_uri must equal provenance.origin_run_uri',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      payload: {
        ...validStagingAttestation.payload,
        readiness_probe: null,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attested payload invalid: environment run report must include readiness_probe',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      payload: {
        ...validStagingAttestation.payload,
        readiness_probe: {
          ...validStagingAttestation.payload.readiness_probe,
          attempts: [
            {
              ...validStagingAttestation.payload.readiness_probe.attempts[0],
              ok: false,
              failure: {
                step_name: 'media_create',
                detail: {
                  status: 500,
                },
              },
            },
          ],
        },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attested payload invalid: environment run report readiness_probe must include a successful final attempt',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      payload: {
        ...validStagingAttestation.payload,
        readiness_probe: {
          ...validStagingAttestation.payload.readiness_probe,
          attempts: [
            {
              ...validStagingAttestation.payload.readiness_probe.attempts[0],
              steps: validStagingAttestation.payload.readiness_probe.attempts[0].steps.filter((step) => step.step !== 'ops_rebuild_start'),
            },
          ],
        },
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attested payload invalid: environment run report readiness_probe final attempt must include successful steps: ops_rebuild_start',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('staging_run_report', {
      ...validStagingAttestation,
      payload: {
        ...validStagingAttestation.payload,
        expanded_test_files: [
          'tests/staging/l1-mandatory.test.mjs',
          'tests/local/client-identity/phase-04.test.mjs',
        ],
        expanded_test_file_count: 2,
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attested payload invalid: environment run report must not expand local test implementations',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('prod_cost_snapshot', validProdCostAttestation, { runTimestamp }),
    {
      valid: true,
      error: null,
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('prod_cost_snapshot', {
      ...validProdCostAttestation,
      provenance: {
        ...validProdCostAttestation.provenance,
        artifact_sha256: 'bad',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle provenance.artifact_sha256 must be a 64-character hex digest',
    },
  );

  assert.deepEqual(
    validateEvidenceAttestationBundle('prod_cost_snapshot', {
      ...validProdCostAttestation,
      payload: {
        ...validProdCostAttestation.payload,
        topology_kind: 'cloudflare-staging',
      },
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'attestation bundle payload topology_kind must be cloudflare-prod',
    },
  );
});

test('current non-local harness readiness fails closed on default directory discovery until it is scoped to dedicated release-gate suites', async () => {
  const integrationReadiness = await assessNonLocalEnvironmentHarnessReadiness('ci-integration', repoRoot);
  assert.equal(integrationReadiness.ready, false);
  assert.deepEqual(integrationReadiness.local_test_expansions, []);
  assert.match(integrationReadiness.reason ?? '', /generic entrypoints|dedicated environment directory closure/);

  const stagingReadiness = await assessNonLocalEnvironmentHarnessReadiness('staging', repoRoot);
  assert.equal(stagingReadiness.ready, false);
  assert.deepEqual(stagingReadiness.local_test_expansions, []);
  assert.match(stagingReadiness.reason ?? '', /generic entrypoints|dedicated environment directory closure/);

  const preReleaseReadiness = await assessNonLocalEnvironmentHarnessReadiness('pre-release', repoRoot);
  assert.equal(preReleaseReadiness.ready, false);
  assert.deepEqual(preReleaseReadiness.local_test_expansions, []);
  assert.match(preReleaseReadiness.reason ?? '', /generic entrypoints|dedicated environment directory closure/);
});

test('non-local harness readiness can scope expansion to release-gate file selection', async () => {
  const integrationReadiness = await assessNonLocalEnvironmentHarnessReadiness('ci-integration', repoRoot, {
    getRequiredTestFilesImpl: getReleaseGateTestFiles,
  });
  assert.equal(integrationReadiness.ready, true);
  assert.deepEqual(integrationReadiness.local_test_expansions, []);
  assert.ok(!integrationReadiness.expanded_test_files.includes('tests/integration/bootstrap.test.mjs'));
  assert.ok(!integrationReadiness.expanded_test_files.includes('tests/integration/l1-mandatory.test.mjs'));
  assert.ok(!integrationReadiness.expanded_test_files.includes('tests/shared/nonlocal/support.mjs'));
});

test('non-local harness readiness does not treat exported object string literals as module imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-export-strings-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'export-strings.test.mjs'),
    "import './bootstrap-like.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'bootstrap-like.mjs'),
    [
      'export const TEST_ENVIRONMENTS = Object.freeze({',
      "  'ci-integration': Object.freeze({ directory: 'tests/integration' }),",
      "  staging: Object.freeze({ directory: 'tests/staging' }),",
      "  'pre-release': Object.freeze({ directory: 'tests/pre-release' }),",
      '});',
      '',
    ].join('\n'),
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.local_test_expansions, []);
  assert.deepEqual(readiness.unresolved_dynamic_imports, []);
});

test('non-local harness readiness follows dynamic import edges when a staging test reaches tests/local', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-dynamic-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'dynamic.test.mjs'),
    "await import('../local/probe.test.mjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.local_test_expansions.includes('tests/local/probe.test.mjs'));
});

test('non-local harness readiness fails closed on missing static imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-missing-static-import-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'probe.test.mjs'),
    "import './missing.mjs';\n",
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason ?? '', /unresolved or non-literal dynamic imports or unsupported static module specifiers/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/probe.test.mjs -> ./missing.mjs'));
});

test('non-local harness readiness follows side-effect static imports without from clauses', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-side-effect-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'shared'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'side-effect.test.mjs'),
    "import '../shared/bridge.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'shared', 'bridge.mjs'),
    "import '../local/probe.test.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.expanded_test_files.includes('tests/shared/bridge.mjs'));
  assert.ok(readiness.local_test_expansions.includes('tests/local/probe.test.mjs'));
});

test('non-local harness readiness follows side-effect imports and re-exports that carry trailing comments', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-trailing-comment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'shared'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'trailing-comment.test.mjs'),
    "import '../shared/bridge.mjs'; // trailing comment\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'shared', 'bridge.mjs'),
    "export { marker } from '../local/probe.test.mjs'; // trailing comment\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.expanded_test_files.includes('tests/shared/bridge.mjs'));
  assert.ok(readiness.local_test_expansions.includes('tests/local/probe.test.mjs'));
});

test('non-local harness readiness fails closed on template-literal dynamic imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-template-dynamic-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'template-dynamic.test.mjs'),
    "const part = 'probe.test.mjs';\nawait import(`../local/${part}`);\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/template-dynamic.test.mjs'));
});

test('non-local harness readiness fails closed on concatenated dynamic imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-concat-dynamic-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'concat-dynamic.test.mjs'),
    "const part = 'probe.test.mjs';\nawait import('../local/' + part);\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/concat-dynamic.test.mjs'));
});

test('non-local harness readiness fails closed on string-evaluated imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-eval-dynamic-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'eval-dynamic.test.mjs'),
    "const loader = new Function(\"return import('../local/probe.test.mjs');\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/eval-dynamic.test.mjs'));
});

test('non-local harness readiness fails closed on eval-wrapped imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-direct-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'direct-eval.test.mjs'),
    "await eval(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/direct-eval.test.mjs'));
});

test('non-local harness readiness fails closed on aliased computed eval globals', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-aliased-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'aliased-eval.test.mjs'),
    "const run = globalThis['eval'];\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/aliased-eval.test.mjs'));
});

test('non-local harness readiness fails closed on concatenated eval global aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-concat-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'concat-eval.test.mjs'),
    "const run = globalThis['ev' + 'al'];\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/concat-eval.test.mjs'));
});

test('non-local harness readiness fails closed on escaped eval global aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-escaped-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'escaped-eval.test.mjs'),
    "const run = globalThis['ev\\x61l'];\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/escaped-eval.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized eval global aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-paren-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'paren-eval.test.mjs'),
    "const run = globalThis[('eval')];\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/paren-eval.test.mjs'));
});

test('non-local harness readiness fails closed on identifier-indirected eval global aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-key-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'key-eval.test.mjs'),
    "const key = 'eval';\nconst run = globalThis[key];\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/key-eval.test.mjs'));
});

test('non-local harness readiness fails closed on unicode-escaped dot eval aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-unicode-dot-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'unicode-dot-eval.test.mjs'),
    "const run = globalThis.\\u0065val;\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/unicode-dot-eval.test.mjs'));
});

test('non-local harness readiness fails closed on unicode-escaped dot Function aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-unicode-dot-function-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'unicode-dot-function.test.mjs'),
    "const Ctor = globalThis.\\u0046unction;\nconst loader = Ctor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/unicode-dot-function.test.mjs'));
});

test('non-local harness readiness fails closed on unicode-codepoint dot eval aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-unicode-codepoint-eval-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'unicode-codepoint-eval.test.mjs'),
    "const run = globalThis.\\u{65}val;\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/unicode-codepoint-eval.test.mjs'));
});

test('non-local harness readiness fails closed on dot constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-dot-dot-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-dot-dot.test.mjs'),
    "const loader = globalThis.constructor.constructor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-dot-dot.test.mjs'));
});

test('non-local harness readiness fails closed on dot-bracket constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-dot-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-dot-bracket.test.mjs'),
    "const loader = globalThis.constructor['constructor'](\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-dot-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on bracket-dot constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-bracket-dot-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-bracket-dot.test.mjs'),
    "const loader = globalThis['constructor'].constructor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-bracket-dot.test.mjs'));
});

test('non-local harness readiness fails closed on bracket-bracket constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-bracket-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-bracket-bracket.test.mjs'),
    "const loader = globalThis['constructor']['constructor'](\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-bracket-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on optional dot-dot constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-optional-dot-dot-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-optional-dot-dot.test.mjs'),
    "const loader = globalThis?.constructor?.constructor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-optional-dot-dot.test.mjs'));
});

test('non-local harness readiness fails closed on optional dot-bracket constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-optional-dot-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-optional-dot-bracket.test.mjs'),
    "const loader = globalThis.constructor?.['constructor'](\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-optional-dot-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on optional bracket-dot constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-optional-bracket-dot-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-optional-bracket-dot.test.mjs'),
    "const loader = globalThis?.['constructor']?.constructor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-optional-bracket-dot.test.mjs'));
});

test('non-local harness readiness fails closed on optional bracket-bracket constructor-constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-optional-bracket-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-optional-bracket-bracket.test.mjs'),
    "const loader = globalThis?.['constructor']?.['constructor'](\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-optional-bracket-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on invoked dot constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-dot-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-dot.test.mjs'),
    "const loader = (() => {}).constructor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-dot.test.mjs'));
});

test('non-local harness readiness fails closed on invoked identifier constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-identifier-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-identifier.test.mjs'),
    "function base() {}\nconst loader = base.constructor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-identifier.test.mjs'));
});

test('non-local harness readiness fails closed on invoked bracket constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-bracket.test.mjs'),
    "const loader = (() => {})['constructor'](\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on optional invoked dot constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-optional-dot-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-optional-dot.test.mjs'),
    "const loader = (() => {})?.constructor?.(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-optional-dot.test.mjs'));
});

test('non-local harness readiness fails closed on optional invoked bracket constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-optional-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-optional-bracket.test.mjs'),
    "const loader = (() => {})?.['constructor']?.(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-optional-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized invoked constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-parenthesized-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-parenthesized.test.mjs'),
    "const base = (() => {});\nconst loader = (base.constructor)(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-parenthesized.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized optional constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-call-parenthesized-optional-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-call-parenthesized-optional.test.mjs'),
    "const base = (() => {});\nconst loader = ((base['constructor']))?.(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-call-parenthesized-optional.test.mjs'));
});

test('non-local harness readiness fails closed on constructor.call string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-method-call-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-method-call.test.mjs'),
    "const loader = (() => {}).constructor.call(null, \"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-method-call.test.mjs'));
});

test('non-local harness readiness fails closed on constructor.apply string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-method-apply-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-method-apply.test.mjs'),
    "const loader = (() => {})['constructor'].apply(null, [\"return import('../local/probe.test.mjs')\"]);\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-method-apply.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized constructor.call string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-method-parenthesized-call-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-method-parenthesized-call.test.mjs'),
    "const base = (() => {});\nconst loader = (base.constructor).call(null, \"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-method-parenthesized-call.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized optional constructor.apply string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-method-parenthesized-apply-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-method-parenthesized-apply.test.mjs'),
    "const base = (() => {});\nconst loader = ((base['constructor']))?.apply?.(null, [\"return import('../local/probe.test.mjs')\"]);\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-method-parenthesized-apply.test.mjs'));
});

test('non-local harness readiness fails closed on aliased constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-alias-call-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-alias-call.test.mjs'),
    "const C = (() => {})['constructor'];\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-alias-call.test.mjs'));
});

test('non-local harness readiness fails closed on aliased constructor.call string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-alias-method-call-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-alias-method-call.test.mjs'),
    "const C = (() => {})['constructor'];\nconst loader = C.call(null, \"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-alias-method-call.test.mjs'));
});

test('non-local harness readiness fails closed on escaped constructor property aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-escaped-property-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-escaped-property-alias.test.mjs'),
    "const C = (() => {})['\\u0063onstructor'];\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-escaped-property-alias.test.mjs'));
});

test('non-local harness readiness fails closed on destructuring-reassigned constructor property aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-destructuring-reassignment.test.mjs'),
    "let C;\n({ C } = { C: (() => {})['\\u0063onstructor'] });\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on computed-key destructuring-reassigned constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-computed-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-computed-destructuring-reassignment.test.mjs'),
    "let C;\n({ C } = { ['C']: (() => {})['\\u0063onstructor'] });\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-computed-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on spread-sourced destructuring-reassigned constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-spread-source-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-spread-source-destructuring-reassignment.test.mjs'),
    "let C;\nconst source = { C: (() => {})['constructor'] };\n({ C } = { ...source });\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-spread-source-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on spread-sourced object-member constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-spread-source-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-spread-source-object-member-alias.test.mjs'),
    "const source = { C: (() => {})['constructor'] };\nconst bag = { ...source };\nconst loader = bag.C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-spread-source-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on object-member constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-object-member-alias.test.mjs'),
    "const bag = { C: (() => {})['constructor'] };\nconst loader = bag.C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized object-member constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-parenthesized-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-parenthesized-object-member-alias.test.mjs'),
    "const bag = ({ C: (() => {})['constructor'] });\nconst loader = bag.C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-parenthesized-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on reassigned constructor.call string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-reassignment-method-call-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-reassignment-method-call.test.mjs'),
    "let C;\nC = (() => {})['constructor'];\nconst loader = C.call(null, \"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-reassignment-method-call.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized reassigned constructor string evaluators', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-constructor-parenthesized-reassignment-method-call-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'constructor-parenthesized-reassignment-method-call.test.mjs'),
    "let C;\n(C = (() => {})['constructor']);\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/constructor-parenthesized-reassignment-method-call.test.mjs'));
});

test('non-local harness readiness fails closed on createRequire-based CommonJS loaders', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require.test.mjs'),
    "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require.test.mjs'));
});

test('non-local harness readiness fails closed on aliased createRequire-based CommonJS loaders', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-alias.test.mjs'),
    "import { createRequire as cr } from 'node:module';\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-alias.test.mjs'));
});

test('non-local harness readiness fails closed on namespace-aliased createRequire-based CommonJS loaders', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-namespace-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-namespace-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst { createRequire: cr } = mod;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-namespace-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized namespace-member createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-parenthesized-namespace-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-parenthesized-namespace-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = (mod).createRequire;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-parenthesized-namespace-alias.test.mjs'));
});

test('non-local harness readiness fails closed on optional-chained createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-optional-chain-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-optional-chain.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = mod?.createRequire;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-optional-chain.test.mjs'));
});

test('non-local harness readiness fails closed on optional-chained bracket createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-optional-chain-bracket-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-optional-chain-bracket.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = mod?.['createRequire'];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-optional-chain-bracket.test.mjs'));
});

test('non-local harness readiness fails closed on escaped createRequire bracket aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-escaped-bracket-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-escaped-bracket-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = mod['\\u0063reateRequire'];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-escaped-bracket-alias.test.mjs'));
});

test('non-local harness readiness fails closed on destructuring-reassigned createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-destructuring-reassignment.test.mjs'),
    "import * as mod from 'node:module';\nlet cr;\n({ cr } = { cr: mod['\\u0063reateRequire'] });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on spread-backed destructuring-reassigned createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-spread-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-spread-destructuring-reassignment.test.mjs'),
    "import * as mod from 'node:module';\nlet cr;\n({ cr } = { ...{}, cr: mod.createRequire });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-spread-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on spread-sourced destructuring-reassigned createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-spread-source-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-spread-source-destructuring-reassignment.test.mjs'),
    "import * as mod from 'node:module';\nlet cr;\nconst source = { cr: mod.createRequire };\n({ cr } = { ...source });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-spread-source-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on expression-built spread-sourced destructuring-reassigned createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-expression-spread-source-destructuring-reassignment-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-expression-spread-source-destructuring-reassignment.test.mjs'),
    "import * as mod from 'node:module';\nlet cr;\nconst source = Object.assign({}, { cr: mod.createRequire });\n({ cr } = { ...source });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-expression-spread-source-destructuring-reassignment.test.mjs'));
});

test('non-local harness readiness fails closed on spread-sourced object-member createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-spread-source-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-spread-source-object-member-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst source = { cr: mod.createRequire };\nconst bag = { ...source };\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-spread-source-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on expression-built spread-sourced object-member createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-expression-spread-source-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-expression-spread-source-object-member-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst source = Object.assign({}, { cr: mod.createRequire });\nconst bag = { ...source };\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-expression-spread-source-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on object-member createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-object-member-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = { cr: mod.createRequire };\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized object-member createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-parenthesized-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-parenthesized-object-member-alias.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = ({ cr: mod.createRequire });\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-parenthesized-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized reassigned createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-parenthesized-reassignment-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-parenthesized-reassignment-alias.test.mjs'),
    "import * as mod from 'node:module';\nlet cr;\n(cr = mod.createRequire);\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-parenthesized-reassignment-alias.test.mjs'));
});

test('non-local harness readiness fails closed on static bracket createRequire loaders', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-static-bracket-loader-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-static-bracket-loader.test.mjs'),
    "import * as mod from 'node:module';\nmod['createRequire'](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-static-bracket-loader.test.mjs'));
});

test('non-local harness readiness fails closed on createRequire.call loaders', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-call-loader-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-call-loader.test.mjs'),
    "import * as mod from 'node:module';\nmod.createRequire.call(mod, import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-call-loader.test.mjs'));
});

test('non-local harness readiness fails closed on aliased createRequire.bind loaders', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-create-require-bind-loader-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'create-require-bind-loader.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = mod.createRequire;\nconst req = cr.bind(mod)(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/create-require-bind-loader.test.mjs'));
});

test('non-local harness readiness fails closed on inline object-literal receiver createRequire aliases built from expression spreads', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-inline-object-receiver-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'inline-object-receiver-create-require.test.mjs'),
    "import * as mod from 'node:module';\nconst req = ({ ...Object.assign({}, { cr: mod.createRequire }) }).cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/inline-object-receiver-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on numeric bracket createRequire object-member aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-numeric-bracket-create-require-object-member-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'numeric-bracket-create-require-object-member.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = { '0': mod.createRequire };\nbag[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/numeric-bracket-create-require-object-member.test.mjs'));
});

test('non-local harness readiness fails closed on numeric bracket inline object-literal receiver createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-numeric-bracket-inline-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'numeric-bracket-inline-create-require.test.mjs'),
    "import * as mod from 'node:module';\n({ '0': mod.createRequire })[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/numeric-bracket-inline-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on computed numeric bracket createRequire object-member aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-computed-numeric-bracket-create-require-object-member-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'computed-numeric-bracket-create-require-object-member.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = { [0]: mod.createRequire };\nbag[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/computed-numeric-bracket-create-require-object-member.test.mjs'));
});

test('non-local harness readiness fails closed on computed numeric bracket inline object-literal receiver createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-computed-numeric-bracket-inline-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'computed-numeric-bracket-inline-create-require.test.mjs'),
    "import * as mod from 'node:module';\n({ [0]: mod.createRequire })[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/computed-numeric-bracket-inline-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on extracted computed numeric bracket createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-extracted-computed-numeric-bracket-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'extracted-computed-numeric-bracket-create-require.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = { [0]: mod.createRequire };\nconst cr = bag[0];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/extracted-computed-numeric-bracket-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on extracted inline object-literal createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-extracted-inline-object-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'extracted-inline-object-create-require.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = ({ cr: mod.createRequire }).cr;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/extracted-inline-object-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on non-finite computed numeric bracket createRequire object-member aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-non-finite-computed-numeric-bracket-create-require-object-member-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'non-finite-computed-numeric-bracket-create-require-object-member.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = { [1e309]: mod.createRequire };\nbag[1e309](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/non-finite-computed-numeric-bracket-create-require-object-member.test.mjs'));
});

test('non-local harness readiness fails closed on non-finite computed numeric bracket inline object-literal receiver createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-non-finite-computed-numeric-bracket-inline-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'non-finite-computed-numeric-bracket-inline-create-require.test.mjs'),
    "import * as mod from 'node:module';\n({ [1e309]: mod.createRequire })[1e309](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/non-finite-computed-numeric-bracket-inline-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on extracted non-finite computed numeric bracket createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-extracted-non-finite-computed-numeric-bracket-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'extracted-non-finite-computed-numeric-bracket-create-require.test.mjs'),
    "import * as mod from 'node:module';\nconst bag = { [1e309]: mod.createRequire };\nconst cr = bag[1e309];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/extracted-non-finite-computed-numeric-bracket-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on extracted non-finite inline object-literal createRequire aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-extracted-non-finite-inline-object-create-require-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'extracted-non-finite-inline-object-create-require.test.mjs'),
    "import * as mod from 'node:module';\nconst cr = ({ [1e309]: mod.createRequire })[1e309];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/extracted-non-finite-inline-object-create-require.test.mjs'));
});

test('non-local harness readiness fails closed on Reflect.get evaluator aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-eval.test.mjs'),
    "const run = Reflect.get(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-eval.test.mjs'));
});

test('non-local harness readiness fails closed on Reflect object aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-object-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-object-alias.test.mjs'),
    "const R = Reflect;\nconst run = R.get(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-object-alias.test.mjs'));
});

test('non-local harness readiness fails closed on destructured Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-alias.test.mjs'),
    "const { get: reflectGet } = Reflect;\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized destructured Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-parenthesized-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-parenthesized-alias.test.mjs'),
    "const { get } = (Reflect);\nconst run = get(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-parenthesized-alias.test.mjs'));
});

test('non-local harness readiness fails closed on bracket-aliased Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-bracket-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-bracket-alias.test.mjs'),
    "const reflectGet = Reflect['get'];\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-bracket-alias.test.mjs'));
});

test('non-local harness readiness fails closed on escaped Reflect.get bracket aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-escaped-bracket-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-escaped-bracket-alias.test.mjs'),
    "const reflectGet = Reflect['\\u0067et'];\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-escaped-bracket-alias.test.mjs'));
});

test('non-local harness readiness fails closed on object-member Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-object-member-alias.test.mjs'),
    "const bag = { g: Reflect.get };\nconst run = bag.g(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on getter-based Reflect.get object members', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-getter-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-getter-object-member-alias.test.mjs'),
    "const bag = {\n  get g() { return Reflect.get; },\n};\nconst run = bag.g(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-getter-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on method-based Reflect.get object members', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-method-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-method-object-member-alias.test.mjs'),
    "const bag = {\n  g() { return Reflect.get; },\n};\nconst reflectGet = bag.g();\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-method-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized reassigned getter-based Reflect.get object members', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-parenthesized-reassignment-getter-object-member-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-parenthesized-reassignment-getter-object-member-alias.test.mjs'),
    "let bag;\n(bag = ({ get g() { return Reflect.get; } }));\nconst run = bag.g(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-parenthesized-reassignment-getter-object-member-alias.test.mjs'));
});

test('non-local harness readiness fails closed on parenthesized dot-member Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-parenthesized-dot-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-parenthesized-dot-alias.test.mjs'),
    "const reflectGet = (Reflect).get;\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-parenthesized-dot-alias.test.mjs'));
});

test('non-local harness readiness fails closed on optional-chained Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-optional-chain-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-optional-chain-alias.test.mjs'),
    "const reflectGet = Reflect?.get;\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-optional-chain-alias.test.mjs'));
});

test('non-local harness readiness fails closed on optional-chained bracket Reflect.get aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-reflect-get-optional-chain-bracket-alias-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'reflect-get-optional-chain-bracket-alias.test.mjs'),
    "const reflectGet = Reflect?.['get'];\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/reflect-get-optional-chain-bracket-alias.test.mjs'));
});

test('non-local harness readiness fails closed on aliased computed Function constructors', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-aliased-function-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'aliased-function.test.mjs'),
    "const Ctor = globalThis['Function'];\nconst loader = Ctor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/aliased-function.test.mjs'));
});

test('non-local harness readiness fails closed on template-literal Function constructor aliases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-template-function-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'template-function.test.mjs'),
    "const Ctor = globalThis[`Function`];\nconst loader = Ctor(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/template-function.test.mjs'));
});

test('non-local harness readiness follows same-line static import and re-export chains', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-same-line-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'shared'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'same-line.test.mjs'),
    "import '../shared/bridge.mjs'; import '../shared/secondary.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'shared', 'bridge.mjs'),
    "export { primary } from '../local/primary.test.mjs'; export { secondary } from '../local/secondary.test.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'shared', 'secondary.mjs'),
    'export const noop = true;\n',
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'primary.test.mjs'),
    'export const primary = true;\n',
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'secondary.test.mjs'),
    'export const secondary = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.expanded_test_files.includes('tests/shared/bridge.mjs'));
  assert.ok(readiness.expanded_test_files.includes('tests/shared/secondary.mjs'));
  assert.ok(readiness.local_test_expansions.includes('tests/local/primary.test.mjs'));
  assert.ok(readiness.local_test_expansions.includes('tests/local/secondary.test.mjs'));
});

test('non-local harness readiness follows static imports that include inline comments', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-commented-import-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'commented.test.mjs'),
    "import /* comment */ '../local/probe.test.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.local_test_expansions.includes('tests/local/probe.test.mjs'));
});

test('non-local harness readiness fails closed when a relative import escapes the repo via prefix-collision siblings', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-prefix-'));
  const siblingRoot = `${tempRoot}-sibling`;
  const stagingDir = path.join(tempRoot, 'tests', 'staging');
  const siblingFile = path.join(siblingRoot, 'escape.mjs');
  const relativeImport = normalizeForImportPath(path.relative(stagingDir, siblingFile));

  await fs.mkdir(stagingDir, { recursive: true });
  await fs.mkdir(siblingRoot, { recursive: true });
  await fs.writeFile(
    path.join(stagingDir, 'prefix-collision.test.mjs'),
    `await import(${JSON.stringify(relativeImport)});\n`,
  );
  await fs.writeFile(siblingFile, 'export const outside = true;\n');

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /escapes repo-owned test dependencies/);
  assert.deepEqual(readiness.local_test_expansions, []);
  assert.ok(readiness.repo_boundary_escapes.includes(`tests/staging/prefix-collision.test.mjs -> ${relativeImport}`));
});

test('non-local harness readiness fails closed when a static absolute import escapes repo ownership', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-static-absolute-'));
  const outsideFile = path.join(os.tmpdir(), `matrix-escape-${Date.now()}.mjs`);
  try {
    await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'tests', 'staging', 'absolute-static.test.mjs'),
      `import ${JSON.stringify(outsideFile)};\n`,
    );
    await fs.writeFile(outsideFile, 'export const outside = true;\n');

    const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /escapes repo-owned test dependencies/);
    assert.ok(readiness.repo_boundary_escapes.includes(`tests/staging/absolute-static.test.mjs -> ${outsideFile}`));
  } finally {
    await fs.rm(outsideFile, { force: true });
  }
});

test('non-local harness readiness follows escaped static imports into local tests', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-escaped-relative-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'escaped-relative.test.mjs'),
    "import '../lo\\x63al/probe.test.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.local_test_expansions.includes('tests/local/probe.test.mjs'));
});

test('non-local harness readiness fails closed on package-import aliases that can hide local test shims', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-package-import-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({
      name: 'matrix-testing-harness-package-import',
      type: 'module',
      imports: {
        '#local-probe': './tests/local/probe.test.mjs',
      },
    }, null, 2),
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'test-cs-002.test.mjs'),
    "import '#local-probe';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/test-cs-002.test.mjs'));
});

test('non-local harness readiness still fails closed when node builtin imports coexist with shared proofs outside the environment directory', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-node-builtin-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'shared'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'node-builtin.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { proof } from '../shared/proof.mjs';",
      '',
      "test('node builtin imports stay allowed', () => {",
      '  assert.equal(proof, true);',
      '});',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'shared', 'proof.mjs'),
    'export const proof = true;\n',
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /escapes dedicated environment directory closure/);
  assert.deepEqual(readiness.unresolved_dynamic_imports, []);
  assert.deepEqual(readiness.repo_boundary_escapes, []);
  assert.deepEqual(readiness.environment_boundary_escapes, ['tests/shared/proof.mjs']);
  assert.ok(readiness.expanded_test_files.includes('tests/shared/proof.mjs'));
});

test('non-local harness readiness fails closed when a dynamic file URL import escapes repo ownership', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-file-url-'));
  const outsideFile = path.join(os.tmpdir(), `matrix-escape-url-${Date.now()}.mjs`);
  const outsideUrl = pathToFileURL(outsideFile).href;
  try {
    await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'tests', 'staging', 'file-url.test.mjs'),
      `await import(${JSON.stringify(outsideUrl)});\n`,
    );
    await fs.writeFile(outsideFile, 'export const outside = true;\n');

    const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /escapes repo-owned test dependencies/);
    assert.ok(readiness.repo_boundary_escapes.includes(`tests/staging/file-url.test.mjs -> ${outsideUrl}`));
  } finally {
    await fs.rm(outsideFile, { force: true });
  }
});

test('non-local harness readiness fails closed when an escaped dynamic file URL import escapes repo ownership', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-escaped-file-url-'));
  const outsideFile = path.join(os.tmpdir(), `matrix-escape-escaped-url-${Date.now()}.mjs`);
  const outsideUrl = pathToFileURL(outsideFile).href;
  const escapedOutsideUrl = outsideUrl.replace('file:', 'file\\x3a');
  try {
    await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'tests', 'staging', 'escaped-file-url.test.mjs'),
      `await import('${escapedOutsideUrl}');\n`,
    );
    await fs.writeFile(outsideFile, 'export const outside = true;\n');

    const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /escapes repo-owned test dependencies/);
    assert.ok(readiness.repo_boundary_escapes.includes(`tests/staging/escaped-file-url.test.mjs -> ${outsideUrl}`));
  } finally {
    await fs.rm(outsideFile, { force: true });
  }
});

test('non-local harness readiness fails closed when a mixed-case dynamic file URL import escapes repo ownership', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-mixed-case-file-url-'));
  const outsideFile = path.join(os.tmpdir(), `matrix-escape-mixed-case-url-${Date.now()}.mjs`);
  const outsideUrl = pathToFileURL(outsideFile).href.replace('file://', 'FiLe://');
  try {
    await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'tests', 'staging', 'mixed-case-file-url.test.mjs'),
      `await import(${JSON.stringify(outsideUrl)});\n`,
    );
    await fs.writeFile(outsideFile, 'export const outside = true;\n');

    const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /escapes repo-owned test dependencies/);
    assert.ok(readiness.repo_boundary_escapes.includes(`tests/staging/mixed-case-file-url.test.mjs -> ${outsideUrl}`));
  } finally {
    await fs.rm(outsideFile, { force: true });
  }
});

test('non-local harness readiness fails closed when a mixed-case static file URL import escapes repo ownership', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-mixed-case-static-file-url-'));
  const outsideFile = path.join(os.tmpdir(), `matrix-escape-mixed-case-static-url-${Date.now()}.mjs`);
  const outsideUrl = pathToFileURL(outsideFile).href.replace('file://', 'FILE://');
  try {
    await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'tests', 'staging', 'mixed-case-static-file-url.test.mjs'),
      `import ${JSON.stringify(outsideUrl)};\n`,
    );
    await fs.writeFile(outsideFile, 'export const outside = true;\n');

    const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /escapes repo-owned test dependencies/);
    assert.ok(readiness.repo_boundary_escapes.includes(`tests/staging/mixed-case-static-file-url.test.mjs -> ${outsideUrl}`));
  } finally {
    await fs.rm(outsideFile, { force: true });
  }
});

test('non-local harness readiness fails closed on data URL dynamic imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-data-url-dynamic-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'data-url-dynamic.test.mjs'),
    `await import("data:text/javascript,${encodeURIComponent('export const marker = true;')}");\n`,
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/data-url-dynamic.test.mjs'));
});

test('non-local harness readiness fails closed on data URL static imports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-data-url-static-'));
  await fs.mkdir(path.join(tempRoot, 'tests', 'staging'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'staging', 'data-url-static.test.mjs'),
    `import "data:text/javascript,${encodeURIComponent('export const marker = true;')}";\n`,
  );

  const readiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /non-literal dynamic imports/);
  assert.ok(readiness.unresolved_dynamic_imports.includes('tests/staging/data-url-static.test.mjs'));
});

test('manual artifact collection rejects _test-runs paths even when payload structure and harness are otherwise valid', async () => {
  const runTimestamp = '20260331T141500Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', runTimestamp, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.match(results[0].validation_error, /external non-local evidence/);
});

test('manual artifact collection rejects symlinked _test-runs reports even when the provided path looks external', async () => {
  const runTimestamp = '20260331T141550Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-link-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', runTimestamp, 'pre-release.json');
  const externalDir = path.join(tempRoot, 'external');
  const symlinkPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );
  await fs.symlink(reportPath, symlinkPath);

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, symlinkPath),
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.match(results[0].validation_error, /external non-local evidence/);
});

test('manual artifact collection rejects GitHub Actions attestations from another repository when the current repository is known', async () => {
  const runTimestamp = '20260331T141605Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-foreign-repo-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const foreignRunUri = `https://github.com/${FOREIGN_TEST_GITHUB_REPOSITORY}/actions/runs/${buildGitHubRunId('pre-release', runTimestamp)}`;
  const reportPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('pre-release', runTimestamp, {
      source_run_uri: foreignRunUri,
    }, {
      provenance: {
        origin_repository: FOREIGN_TEST_GITHUB_REPOSITORY,
        origin_run_uri: foreignRunUri,
        review_record_uri: foreignRunUri,
      },
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].validation_error, 'attestation bundle provenance.origin_repository must match the current repository');
});

test('manual artifact collection resolves the current repository from GITHUB_REPOSITORY when no explicit repository option is supplied', async () => {
  const runTimestamp = '20260331T141607Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-env-repo-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const foreignRunUri = `https://github.com/${FOREIGN_TEST_GITHUB_REPOSITORY}/actions/runs/${buildGitHubRunId('pre-release', runTimestamp)}`;
  const reportPath = path.join(externalDir, 'pre-release.json');
  const previousRepository = process.env.GITHUB_REPOSITORY;

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('pre-release', runTimestamp, {
      test_directory: 'tests/pre-release',
      test_files: ['tests/pre-release/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/pre-release/remote.test.mjs'],
      expanded_test_file_count: 1,
    }, {
      provenance: {
        origin_repository: FOREIGN_TEST_GITHUB_REPOSITORY,
        origin_run_uri: foreignRunUri,
        review_record_uri: foreignRunUri,
      },
    }), null, 2),
  );

  try {
    process.env.GITHUB_REPOSITORY = DEFAULT_TEST_GITHUB_REPOSITORY;
    const results = await collectManualArtifactResults(
      getL1EvidenceDefinition('EVID-OPS-001'),
      tempRoot,
      {
        pre_release_run_report: path.relative(tempRoot, reportPath),
      },
      runTimestamp,
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].valid, false);
    assert.equal(results[0].validation_error, 'attestation bundle provenance.origin_repository must match the current repository');
  } finally {
    if (previousRepository == null) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = previousRepository;
    }
  }
});

test('manual artifact collection rejects environment attestations from a different git commit', async () => {
  const runTimestamp = '20260331T141607Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-foreign-commit-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('pre-release', runTimestamp, {
      git_commit: '89abcdef0123456789abcdef0123456789abcdef',
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].validation_error, 'attestation bundle payload git_commit must match the current HEAD commit');
});

test('manual artifact collection rejects external attestations when the current checkout has tracked modifications', async () => {
  const runTimestamp = '20260331T141607Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-dirty-checkout-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
      trackedWorktreeDirty: true,
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].validation_error, 'current checkout has tracked modifications; external attestations may only be reused from a clean tracked worktree');
});

test('manual artifact collection rejects external attestations when the current repository cannot be resolved', async () => {
  const runTimestamp = '20260331T141607Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-missing-repo-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');
  const previousRepository = process.env.GITHUB_REPOSITORY;

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );

  try {
    delete process.env.GITHUB_REPOSITORY;
    const results = await collectManualArtifactResults(
      getL1EvidenceDefinition('EVID-OPS-001'),
      tempRoot,
      {
        pre_release_run_report: path.relative(tempRoot, reportPath),
      },
      runTimestamp,
      {
        expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
        trackedWorktreeDirty: false,
      },
    );

    assert.equal(results[0].valid, false);
    assert.equal(results[0].validation_error, 'cannot validate external attestations against the current repository; resolve git origin or set GITHUB_REPOSITORY');
  } finally {
    if (previousRepository == null) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = previousRepository;
    }
  }
});

test('manual artifact collection rejects external attestations when the current HEAD commit cannot be resolved', async () => {
  const runTimestamp = '20260331T141607Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-missing-head-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      trackedWorktreeDirty: false,
    },
  );

  assert.equal(results[0].valid, false);
  assert.equal(results[0].validation_error, 'cannot validate external attestations against the current HEAD commit; resolve git HEAD before reusing external evidence');
});

test('manual artifact collection rejects external attestations when tracked-worktree state is unknown', async () => {
  const runTimestamp = '20260331T141607Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-unknown-dirty-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
    },
  );

  assert.equal(results[0].valid, false);
  assert.equal(results[0].validation_error, 'cannot determine whether the current checkout has tracked modifications; external attestations may only be reused from a clean tracked worktree');
});

test('manual artifact collection rejects attestations that do not share one GitHub Actions run and attempt', async () => {
  const runTimestamp = '20260331T141608Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-same-run-'));
  const ciTestFile = path.join(tempRoot, 'tests', 'integration', 'remote.test.mjs');
  const stagingTestFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const ciPath = path.join(externalDir, 'ci-integration.json');
  const stagingPath = path.join(externalDir, 'staging.json');
  const mismatchedRunId = '8903120260331141608';
  const mismatchedRunUri = `https://github.com/${DEFAULT_TEST_GITHUB_REPOSITORY}/actions/runs/${mismatchedRunId}`;
  const mismatchedArtifactStoreKey = `gha/${mismatchedRunId}/1/staging/${runTimestamp}/run-bundle.tgz`;

  await fs.mkdir(path.dirname(ciTestFile), { recursive: true });
  await fs.mkdir(path.dirname(stagingTestFile), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(ciTestFile, 'export const remote = true;\n');
  await fs.writeFile(stagingTestFile, 'export const remote = true;\n');
  await fs.writeFile(
    ciPath,
    JSON.stringify(buildValidEnvironmentAttestation('ci-integration', runTimestamp, {
      test_directory: 'tests/integration',
      test_files: ['tests/integration/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/integration/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );
  await fs.writeFile(
    stagingPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      source_run_uri: mismatchedRunUri,
      test_directory: 'tests/staging',
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }, {
      provenance: {
        origin_run_id: mismatchedRunId,
        origin_run_uri: mismatchedRunUri,
        artifact_store_uri: `r2://matrix-evidence-staging/${mismatchedArtifactStoreKey}`,
        artifact_store_key: mismatchedArtifactStoreKey,
        review_record_uri: mismatchedRunUri,
      },
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-001'),
    tempRoot,
    {
      ci_integration_run_report: path.relative(tempRoot, ciPath),
      staging_run_report: path.relative(tempRoot, stagingPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
      trackedWorktreeDirty: false,
    },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].valid, true);
  assert.equal(results[1].valid, false);
  assert.match(results[1].validation_error, /must come from GitHub Actions run/);
});

test('manual artifact collection rejects hard-linked _test-runs reports even when the provided path looks external', async () => {
  const runTimestamp = '20260331T141600Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-hardlink-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', runTimestamp, 'pre-release.json');
  const externalDir = path.join(tempRoot, 'external');
  const linkedPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );
  await fs.link(reportPath, linkedPath);

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, linkedPath),
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.match(results[0].validation_error, /external non-local evidence/);
});

test('manual artifact collection rejects hard-linked _test-runs reports from other timestamps', async () => {
  const runTimestamp = '20260331T141700Z';
  const otherTimestamp = '20260331T141600Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-hardlink-other-ts-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', otherTimestamp, 'pre-release.json');
  const externalDir = path.join(tempRoot, 'external');
  const linkedPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );
  await fs.link(reportPath, linkedPath);

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, linkedPath),
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.match(results[0].validation_error, /external non-local evidence/);
});

test('manual artifact collection rejects hard-linked _test-runs artifacts even when the source filename is non-canonical', async () => {
  const runTimestamp = '20260331T141750Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-hardlink-custom-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', '20260331T141100Z', 'custom.json');
  const externalDir = path.join(tempRoot, 'external');
  const linkedPath = path.join(externalDir, 'pre-release.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );
  await fs.link(reportPath, linkedPath);

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-OPS-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, linkedPath),
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.match(results[0].validation_error, /external non-local evidence/);
});

test('manual artifact collection rejects prod cost snapshots from _test-runs even when the pre-release report is external and valid', async () => {
  const runTimestamp = '20260331T141770Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-prod-cost-shared-run-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');
  const prodCostSnapshotPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', runTimestamp, 'prod-cost.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.mkdir(path.dirname(prodCostSnapshotPath), { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );
  await fs.writeFile(
    prodCostSnapshotPath,
    JSON.stringify(buildValidProdCostSnapshotAttestation(runTimestamp), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-COST-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
      prod_cost_snapshot: path.relative(tempRoot, prodCostSnapshotPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
      trackedWorktreeDirty: false,
    },
  );

  assert.equal(results.length, 2);
  const preReleaseReport = results.find((artifact) => artifact.artifact_id === 'pre_release_run_report');
  const prodCostSnapshot = results.find((artifact) => artifact.artifact_id === 'prod_cost_snapshot');
  assert.equal(preReleaseReport?.valid, true);
  assert.equal(prodCostSnapshot?.valid, false);
  assert.match(prodCostSnapshot?.validation_error ?? '', /external non-local evidence/);
});

test('manual artifact collection rejects hard-linked prod cost snapshots from _test-runs even when the provided path looks external', async () => {
  const runTimestamp = '20260331T141771Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-prod-cost-hardlink-'));
  const testFile = path.join(tempRoot, 'tests', 'pre-release', 'remote.test.mjs');
  const externalDir = path.join(tempRoot, 'external');
  const reportPath = path.join(externalDir, 'pre-release.json');
  const sharedProdCostSnapshotPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', '20260331T141100Z', 'custom-prod-cost.json');
  const linkedProdCostSnapshotPath = path.join(externalDir, 'prod-cost.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.mkdir(path.dirname(sharedProdCostSnapshotPath), { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation(
      'pre-release',
      runTimestamp,
      buildSingleFileEnvironmentReportOverrides('tests/pre-release/remote.test.mjs'),
    ), null, 2),
  );
  await fs.writeFile(
    sharedProdCostSnapshotPath,
    JSON.stringify(buildValidProdCostSnapshotAttestation(runTimestamp), null, 2),
  );
  await fs.link(sharedProdCostSnapshotPath, linkedProdCostSnapshotPath);

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-COST-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
      prod_cost_snapshot: path.relative(tempRoot, linkedProdCostSnapshotPath),
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
      trackedWorktreeDirty: false,
    },
  );

  assert.equal(results.length, 2);
  const preReleaseReport = results.find((artifact) => artifact.artifact_id === 'pre_release_run_report');
  const prodCostSnapshot = results.find((artifact) => artifact.artifact_id === 'prod_cost_snapshot');
  assert.equal(preReleaseReport?.valid, true);
  assert.equal(prodCostSnapshot?.valid, false);
  assert.match(prodCostSnapshot?.validation_error ?? '', /external non-local evidence/);
});

test('manual artifact collection rejects otherwise valid external reports when the current harness is not environment-backed', async () => {
  const runTimestamp = '20260331T141700Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-invalid-'));
  const reportPath = path.join(tempRoot, 'external', 'pre-release.json');
  await fs.mkdir(path.join(tempRoot, 'tests', 'pre-release'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'pre-release', 'bridge.test.mjs'),
    "import '../local/probe.test.mjs';\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const probe = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('pre-release', runTimestamp, {
      test_files: ['tests/pre-release/bridge.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/local/probe.test.mjs', 'tests/pre-release/bridge.test.mjs'],
      expanded_test_file_count: 2,
    }), null, 2),
  );

  try {
    const results = await collectManualArtifactResults(
      getL1EvidenceDefinition('EVID-OPS-001'),
      tempRoot,
      {
        pre_release_run_report: reportPath,
      },
      runTimestamp,
      {
        expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
        expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
        trackedWorktreeDirty: false,
      },
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].valid, false);
    assertEnvironmentBackedProofRejected(results[0].validation_error);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('manual artifact collection accepts valid external reports when the harness is environment-backed', async () => {
  const runTimestamp = '20260331T141725Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-valid-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
    {
      expectedGitHubRepository: DEFAULT_TEST_GITHUB_REPOSITORY,
      expectedGitCommit: DEFAULT_TEST_GIT_COMMIT,
      trackedWorktreeDirty: false,
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, true);
  assert.equal(results[0].environment_harness_ready, true);
  assert.equal(results[0].validation_error, null);
});

test('environment run execution proof rejects expanded_test_files that drift from the repo-owned transitive closure', async () => {
  const runTimestamp = '20260331T141725Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-execution-proof-drift-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const supportFile = path.join(tempRoot, 'tests', 'staging', 'support.mjs');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.writeFile(testFile, "import './support.mjs';\n");
  await fs.writeFile(supportFile, 'export const support = true;\n');

  try {
    const validation = await validateEnvironmentRunExecutionProof('staging_run_report', buildValidEnvironmentReport('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
      command: `/usr/bin/node --test ${testFile}`,
    }), tempRoot);

    assert.deepEqual(validation, {
      valid: false,
      error: 'environment run report expanded_test_files must equal the repo-owned transitive closure of test_files',
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('manual artifact collection rejects attestation whose execution proof drifts from the claimed expanded test closure', async () => {
  const runTimestamp = '20260331T141725Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-drift-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const supportFile = path.join(tempRoot, 'tests', 'staging', 'support.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(testFile, "import './support.mjs';\n");
  await fs.writeFile(supportFile, 'export const support = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
      command: `/usr/bin/node --test ${testFile}`,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, true);
  assert.equal(results[0].validation_error, 'environment run report expanded_test_files must equal the repo-owned transitive closure of test_files');
});

test('manual artifact collection rejects raw run reports even when the harness is environment-backed', async () => {
  const runTimestamp = '20260331T141725Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-raw-report-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentReport('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, true);
  assert.equal(results[0].validation_error, 'attestation bundle schema_version must be 1');
});

test('manual artifact collection preserves read failures as explicit invalid results instead of swallowing them as missing', async () => {
  const runTimestamp = '20260331T141726Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-read-failure-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging-directory');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(reportPath, { recursive: true });
  await fs.writeFile(testFile, 'export const remote = true;\n');

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].exists, true);
  assert.equal(results[0].valid, false);
  assert.match(results[0].validation_error ?? '', /failed to read staging_run_report:/);
});

test('manual artifact collection rejects getter-based Reflect.get object members that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141726Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-reflect-get-getter-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const bag = {\n  get g() { return Reflect.get; },\n};\nconst run = bag.g(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects method-based Reflect.get object members that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141727Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-reflect-get-method-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const bag = {\n  g() { return Reflect.get; },\n};\nconst reflectGet = bag.g();\nconst run = reflectGet(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects parenthesized reassigned getter-based Reflect.get object members that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141728Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-reflect-get-parenthesized-reassignment-getter-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "let bag;\n(bag = ({ get g() { return Reflect.get; } }));\nconst run = bag.g(globalThis, 'eval');\nawait run(\"import('../local/probe.test.mjs')\");\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects aliased createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141730Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import { createRequire as cr } from 'node:module';\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects parenthesized reassigned createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141731Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-parenthesized-reassignment-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nlet cr;\n(cr = mod.createRequire);\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects namespace-aliased createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141735Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-namespace-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst { createRequire: cr } = mod;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects parenthesized namespace-member createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141740Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-parenthesized-namespace-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst cr = (mod).createRequire;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects optional-chained createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141742Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-optional-chain-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst cr = mod?.createRequire;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects escaped createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141743Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-escaped-bracket-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst cr = mod['\\u0063reateRequire'];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects destructuring-reassigned createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141744Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nlet cr;\n({ cr } = { cr: mod['\\u0063reateRequire'] });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects spread-backed destructuring-reassigned createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141748Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-spread-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nlet cr;\n({ cr } = { ...{}, cr: mod.createRequire });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects spread-sourced destructuring-reassigned createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141752Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-spread-source-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nlet cr;\nconst source = { cr: mod.createRequire };\n({ cr } = { ...source });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects expression-built spread-sourced destructuring-reassigned createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141758Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-expression-spread-source-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nlet cr;\nconst source = Object.assign({}, { cr: mod.createRequire });\n({ cr } = { ...source });\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects spread-sourced object-member createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141753Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-spread-source-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst source = { cr: mod.createRequire };\nconst bag = { ...source };\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects expression-built spread-sourced object-member createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141759Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-expression-spread-source-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst source = Object.assign({}, { cr: mod.createRequire });\nconst bag = { ...source };\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects object-member createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141750Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = { cr: mod.createRequire };\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects parenthesized object-member createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141756Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-parenthesized-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = ({ cr: mod.createRequire });\nconst req = bag.cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects static bracket createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141760Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-static-bracket-loader-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nmod['createRequire'](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects createRequire.call harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141761Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-call-loader-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nmod.createRequire.call(mod, import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects aliased createRequire.bind harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141762Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-create-require-bind-loader-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst cr = mod.createRequire;\nconst req = cr.bind(mod)(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects inline object-literal receiver createRequire harnesses built from expression spreads that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141763Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-inline-object-receiver-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst req = ({ ...Object.assign({}, { cr: mod.createRequire }) }).cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects numeric bracket createRequire object-member harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141764Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-numeric-bracket-create-require-object-member-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = { '0': mod.createRequire };\nbag[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects numeric bracket inline object-literal receiver createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141765Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-numeric-bracket-inline-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\n({ '0': mod.createRequire })[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects computed numeric bracket createRequire object-member harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141766Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-computed-numeric-bracket-create-require-object-member-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = { [0]: mod.createRequire };\nbag[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects computed numeric bracket inline object-literal receiver createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141767Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-computed-numeric-bracket-inline-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\n({ [0]: mod.createRequire })[0](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects extracted computed numeric bracket createRequire aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141768Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-extracted-computed-numeric-bracket-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = { [0]: mod.createRequire };\nconst cr = bag[0];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects extracted inline object-literal createRequire aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141769Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-extracted-inline-object-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst cr = ({ cr: mod.createRequire }).cr;\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects non-finite computed numeric bracket createRequire object-member harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141770Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-non-finite-computed-numeric-bracket-create-require-object-member-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = { [1e309]: mod.createRequire };\nbag[1e309](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects non-finite computed numeric bracket inline object-literal receiver createRequire harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141771Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-non-finite-computed-numeric-bracket-inline-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\n({ [1e309]: mod.createRequire })[1e309](import.meta.url)('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects extracted non-finite computed numeric bracket createRequire aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141772Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-extracted-non-finite-computed-numeric-bracket-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst bag = { [1e309]: mod.createRequire };\nconst cr = bag[1e309];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects extracted non-finite inline object-literal createRequire aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141773Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-extracted-non-finite-inline-object-create-require-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "import * as mod from 'node:module';\nconst cr = ({ [1e309]: mod.createRequire })[1e309];\nconst req = cr(import.meta.url);\nreq('../local/bridge.cjs');\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'bridge.cjs'),
    'module.exports = { marker: true };\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects aliased constructor.call harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141745Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-alias-method-call-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const C = (() => {})['constructor'];\nconst loader = C.call(null, \"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects escaped constructor property aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141746Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-escaped-property-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const C = (() => {})['\\u0063onstructor'];\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects destructuring-reassigned constructor property aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141746Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "let C;\n({ C } = { C: (() => {})['\\u0063onstructor'] });\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects computed-key destructuring-reassigned constructor aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141749Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-computed-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "let C;\n({ C } = { ['C']: (() => {})['\\u0063onstructor'] });\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects spread-sourced destructuring-reassigned constructor aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141754Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-spread-source-destructuring-reassignment-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "let C;\nconst source = { C: (() => {})['constructor'] };\n({ C } = { ...source });\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects spread-sourced object-member constructor aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141755Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-spread-source-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const source = { C: (() => {})['constructor'] };\nconst bag = { ...source };\nconst loader = bag.C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects object-member constructor aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141751Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const bag = { C: (() => {})['constructor'] };\nconst loader = bag.C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects parenthesized object-member constructor aliases that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141757Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-parenthesized-object-member-alias-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "const bag = ({ C: (() => {})['constructor'] });\nconst loader = bag.C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects reassigned constructor.call harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141747Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-reassignment-method-call-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "let C;\nC = (() => {})['constructor'];\nconst loader = C.call(null, \"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('manual artifact collection rejects parenthesized reassigned constructor harnesses that only look environment-backed on the report surface', async () => {
  const runTimestamp = '20260331T141748Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-manual-constructor-parenthesized-reassignment-method-call-'));
  const testFile = path.join(tempRoot, 'tests', 'staging', 'remote.test.mjs');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'tests', 'local'), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    testFile,
    "let C;\n(C = (() => {})['constructor']);\nconst loader = C(\"return import('../local/probe.test.mjs')\");\nawait loader();\n",
  );
  await fs.writeFile(
    path.join(tempRoot, 'tests', 'local', 'probe.test.mjs'),
    'export const marker = true;\n',
  );
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].environment_harness_ready, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('non-local harness readiness is recomputed after files change and manual artifact validation reuses the fresh result', async () => {
  const runTimestamp = '20260331T141800Z';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-testing-harness-cache-refresh-'));
  const stagingDir = path.join(tempRoot, 'tests', 'staging');
  const localDir = path.join(tempRoot, 'tests', 'local');
  const reportPath = path.join(tempRoot, 'external', 'staging.json');

  await fs.mkdir(stagingDir, { recursive: true });
  await fs.mkdir(localDir, { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(path.join(stagingDir, 'remote.test.mjs'), 'export const remote = true;\n');

  const initialReadiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(initialReadiness.ready, true);

  await fs.writeFile(path.join(localDir, 'probe.test.mjs'), 'export const probe = true;\n');
  await fs.writeFile(path.join(stagingDir, 'remote.test.mjs'), "await import('../local/probe.test.mjs');\n");
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentAttestation('staging', runTimestamp, {
      test_files: ['tests/staging/remote.test.mjs'],
      test_file_count: 1,
      expanded_test_files: ['tests/staging/remote.test.mjs'],
      expanded_test_file_count: 1,
    }), null, 2),
  );

  const refreshedReadiness = await assessNonLocalEnvironmentHarnessReadiness('staging', tempRoot);
  assert.equal(refreshedReadiness.ready, false);
  assert.ok(refreshedReadiness.local_test_expansions.includes('tests/local/probe.test.mjs'));

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-CS-002'),
    tempRoot,
    {
      staging_run_report: reportPath,
    },
    runTimestamp,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assertEnvironmentBackedProofRejected(results[0].validation_error);
});

test('writeL1Evidence keeps end-to-end bundle gating fail-closed without manual artifacts and passes once environment-backed artifacts exist', async () => {
  const {
    fixtureRoot,
    sharedProofFile,
    environmentTestFiles,
  } = await createEnvironmentBackedEvidenceFixture();
  const fixtureParent = path.dirname(fixtureRoot);

  try {
    const fixtureEvidenceModule = await loadFixtureEvidenceModule(fixtureRoot);
    const failTimestamp = '20260331T145500Z';
    const failResult = await fixtureEvidenceModule.writeL1Evidence(fixtureRoot, {
      timestamp: failTimestamp,
    });

    assert.equal(failResult.ok, false);
    assert.ok(!failResult.environment_runs.local.test_files.includes('tests/local/runtime-foundations/testing-harness.test.mjs'));
    assert.equal(
      failResult.bundles.find((bundle) => bundle.evid_id === 'EVID-CS-001')?.status,
      'fail',
    );
    const failCs001Root = failResult.bundles.find((bundle) => bundle.evid_id === 'EVID-CS-001')?.evidence_root;
    const failManualArtifacts = JSON.parse(
      await fs.readFile(path.join(failCs001Root, 'artifacts', 'manual-artifacts.json'), 'utf8'),
    );
    assert.ok(failManualArtifacts.some((artifact) => artifact.artifact_id === 'ci_integration_run_report' && artifact.valid === false));
    assert.ok(failManualArtifacts.some((artifact) => artifact.artifact_id === 'staging_run_report' && artifact.valid === false));

    const passTimestamp = '20260331T145600Z';
    const manualArtifacts = await createEnvironmentBackedManualArtifacts(fixtureRoot, passTimestamp, {
      sharedProofFile,
      environmentTestFiles,
    });
    const passResult = await fixtureEvidenceModule.writeL1Evidence(fixtureRoot, {
      timestamp: passTimestamp,
      manualArtifacts,
    });

    assert.equal(passResult.ok, true);
    assert.ok(passResult.bundles.every((bundle) => bundle.status === 'pass'));
    const passCs001Root = passResult.bundles.find((bundle) => bundle.evid_id === 'EVID-CS-001')?.evidence_root;
    const passManualArtifacts = JSON.parse(
      await fs.readFile(path.join(passCs001Root, 'artifacts', 'manual-artifacts.json'), 'utf8'),
    );
    const passEnvironmentResults = JSON.parse(
      await fs.readFile(path.join(passCs001Root, 'artifacts', 'environment-results.json'), 'utf8'),
    );
    const passSummary = await fs.readFile(path.join(passCs001Root, 'summary.md'), 'utf8');
    const stagingArtifact = passManualArtifacts.find((artifact) => artifact.artifact_id === 'staging_run_report');
    assert.equal(stagingArtifact?.attestation_origin_run_attempt, 1);
    assert.equal(stagingArtifact?.attestation_origin_run_uri, buildGitHubRunUri('staging', passTimestamp));
    assert.equal(stagingArtifact?.attestation_artifact_store_key, buildPhase08ArtifactStoreKey('staging', passTimestamp, 'run-bundle.tgz'));
    assert.equal(stagingArtifact?.attestation_artifact_sha256, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    assert.equal(stagingArtifact?.attestation_deployment_identity?.environment_id, 'staging');
    assert.equal(stagingArtifact?.attestation_provenance?.review_record_uri, buildGitHubRunUri('staging', passTimestamp));
    const stagingEnvironmentResult = passEnvironmentResults.required_results.find((entry) => entry.environment_name === 'staging');
    assert.equal(stagingEnvironmentResult?.readiness_probe?.ready, true);
    assert.equal(stagingEnvironmentResult?.readiness_probe?.attempt_count, 1);
    assert.equal(stagingEnvironmentResult?.deployment_identity_validation?.before_suite?.workers?.['gateway-worker']?.script_name, 'matrix-gateway-worker-staging');
    assert.match(passSummary, /readiness: ready=true, attempts=1/);
    const passCostRoot = passResult.bundles.find((bundle) => bundle.evid_id === 'EVID-COST-001')?.evidence_root;
    const passCostSourceIds = JSON.parse(
      await fs.readFile(path.join(passCostRoot, 'artifacts', 'source-ids.json'), 'utf8'),
    );
    assert.deepEqual(
      passCostSourceIds.declared_source_ids,
      getL1EvidenceDefinition('EVID-COST-001').declared_source_ids,
    );
    assert.ok(passCostSourceIds.expanded_source_ids.includes('CF-WKR-029'));
    assert.ok(passCostSourceIds.expanded_source_ids.includes('CF-WKR-030'));
    assert.ok(passCostSourceIds.applicable_source_ids.includes('CF-WKR-029'));
    assert.ok(passCostSourceIds.applicable_source_ids.includes('CF-WKR-030'));
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('evidence writers reject invalid timestamps and existing run roots at their entrypoints', async () => {
  const governanceTimestamp = '20991231T235959Z';
  const l1Timestamp = '20991231T235958Z';
  const fixtureRoot = await createIsolatedRepoFixture();
  const fixtureParent = path.dirname(fixtureRoot);
  const governanceRoot = path.join(fixtureRoot, 'evidence', 'common', 'EVID-GOV-001', governanceTimestamp);
  const l1Root = path.join(fixtureRoot, 'evidence', 'common', '_test-runs', l1Timestamp);

  try {
    await assert.rejects(
      () => writeGovernanceEvidence(fixtureRoot, { timestamp: '../escape' }),
      /timestamp must match/,
    );
    await assert.rejects(
      () => writeL1Evidence(fixtureRoot, { timestamp: '../escape' }),
      /timestamp must match/,
    );

    await fs.mkdir(governanceRoot, { recursive: true });
    await fs.mkdir(l1Root, { recursive: true });

    await assert.rejects(
      () => writeGovernanceEvidence(fixtureRoot, { timestamp: governanceTimestamp }),
      /immutable|already exist/,
    );
    await assert.rejects(
      () => writeL1Evidence(fixtureRoot, { timestamp: l1Timestamp }),
      /immutable|already exist/,
    );
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('evidence output paths are immutable once a run timestamp already exists', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-evidence-immutability-'));
  const existingPath = path.join(tempRoot, 'evidence', 'common', '_test-runs', '20260331T140000Z');
  await fs.mkdir(existingPath, { recursive: true });

  await assert.rejects(
    () => assertPathsDoNotExist([existingPath], {
      label: 'L1 evidence output paths for run 20260331T140000Z',
    }),
    /immutable|already exist/,
  );
});

test('concurrent governance evidence writes fail closed on the same run timestamp', async () => {
  const timestamp = '20991231T235957Z';
  const fixtureRoot = await createIsolatedRepoFixture('matrix-governance-race-fixture-');
  const fixtureParent = path.dirname(fixtureRoot);

  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => writeGovernanceEvidence(fixtureRoot, { timestamp })),
    );
    const succeeded = attempts.filter((result) => result.status === 'fulfilled');
    const failed = attempts.filter((result) => result.status === 'rejected');

    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 7);
    for (const result of failed) {
      assert.match(result.reason?.message ?? String(result.reason), /immutable|already exist/);
    }
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('staging security suite fails closed when the non-local environment is selected without a remote harness', async () => {
  const supportModule = await import(`${pathToFileURL(path.join(repoRoot, 'tests/staging/support.mjs')).href}?cacheBust=${Date.now()}-${Math.random()}`);
  const savedEnvironment = {
    MATRIX_TEST_ENVIRONMENT: process.env.MATRIX_TEST_ENVIRONMENT,
    MATRIX_REMOTE_BASE_URL: process.env.MATRIX_REMOTE_BASE_URL,
    MATRIX_REMOTE_SERVER_NAME: process.env.MATRIX_REMOTE_SERVER_NAME,
    MATRIX_REMOTE_OPS_BASE_URL: process.env.MATRIX_REMOTE_OPS_BASE_URL,
    MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP: process.env.MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP,
  };
  try {
    process.env.MATRIX_TEST_ENVIRONMENT = 'staging';
    delete process.env.MATRIX_REMOTE_BASE_URL;
    delete process.env.MATRIX_REMOTE_SERVER_NAME;
    delete process.env.MATRIX_REMOTE_OPS_BASE_URL;
    delete process.env.MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP;

    assert.throws(
      () => supportModule.requireRemoteHarnessContext({ skip() {} }, 'staging'),
      /Remote staging harness requires MATRIX_REMOTE_BASE_URL/,
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('staging security suite skips cleanly during aggregate local runs when no remote harness is configured', async () => {
  const supportModule = await import(`${pathToFileURL(path.join(repoRoot, 'tests/staging/support.mjs')).href}?cacheBust=${Date.now()}-${Math.random()}`);
  const savedEnvironment = {
    MATRIX_TEST_ENVIRONMENT: process.env.MATRIX_TEST_ENVIRONMENT,
    MATRIX_REMOTE_BASE_URL: process.env.MATRIX_REMOTE_BASE_URL,
    MATRIX_REMOTE_SERVER_NAME: process.env.MATRIX_REMOTE_SERVER_NAME,
    MATRIX_REMOTE_OPS_BASE_URL: process.env.MATRIX_REMOTE_OPS_BASE_URL,
    MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP: process.env.MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP,
  };
  const skipCalls = [];

  try {
    process.env.MATRIX_TEST_ENVIRONMENT = 'staging';
    delete process.env.MATRIX_REMOTE_BASE_URL;
    delete process.env.MATRIX_REMOTE_SERVER_NAME;
    delete process.env.MATRIX_REMOTE_OPS_BASE_URL;
    process.env.MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP = 'true';

    const harness = supportModule.requireRemoteHarnessContext({
      skip(message) {
        skipCalls.push(message);
      },
    }, 'staging');

    assert.equal(harness, null);
    assert.deepEqual(skipCalls, [
      'Remote staging harness requires MATRIX_REMOTE_BASE_URL and MATRIX_REMOTE_SERVER_NAME',
    ]);
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('explicit non-local run environment overrides an ambient aggregate-local skip flag back to fail-closed', () => {
  const runEnv = buildRunEnvironmentVariables({
    MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP: 'true',
  }, 'staging');

  assert.equal(runEnv.MATRIX_TEST_ENVIRONMENT, 'staging');
  assert.equal(runEnv.MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP, 'false');
});

test('CLI failure paths surface immutability errors and exit with code 1', async () => {
  const testingTimestamp = '20991231T235957Z';
  const governanceTimestamp = '20991231T235956Z';
  const fixtureRoot = await createIsolatedRepoFixture('matrix-testing-harness-cli-repo-');
  const fixtureParent = path.dirname(fixtureRoot);
  const testingRoot = path.join(fixtureRoot, 'evidence', 'common', '_test-runs', testingTimestamp);
  const governanceRoot = path.join(fixtureRoot, 'evidence', 'common', 'EVID-GOV-001', governanceTimestamp);
  await fs.mkdir(testingRoot, { recursive: true });
  await fs.mkdir(governanceRoot, { recursive: true });

  try {
    let testingCliError;
    try {
      await execFileAsync(process.execPath, [
        'packages/testing/src/cli.mjs',
        'evidence-l1',
        '--timestamp',
        testingTimestamp,
      ], {
        cwd: fixtureRoot,
      });
    } catch (error) {
      testingCliError = error;
    }
    assert.equal(testingCliError?.code, 1);
    assert.match(testingCliError?.stderr ?? '', /immutable|already exist/);

    let governanceCliError;
    try {
      await execFileAsync(process.execPath, [
        'packages/spec-tools/src/cli.mjs',
        'governance-evidence',
        '--timestamp',
        governanceTimestamp,
      ], {
        cwd: fixtureRoot,
      });
    } catch (error) {
      governanceCliError = error;
    }
    assert.equal(governanceCliError?.code, 1);
    assert.match(governanceCliError?.stderr ?? '', /immutable|already exist/);
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('CLI evidence-l1 forwards attestation paths into the evidence writer', async () => {
  const {
    fixtureRoot,
    sharedProofFile,
    environmentTestFiles,
  } = await createEnvironmentBackedEvidenceFixture();
  const fixtureParent = path.dirname(fixtureRoot);

  try {
    const runTimestamp = '20260401T010203Z';
    const manualArtifacts = await createEnvironmentBackedManualArtifacts(fixtureRoot, runTimestamp, {
      sharedProofFile,
      environmentTestFiles,
    });

    const { stdout } = await execFileAsync(process.execPath, [
      'packages/testing/src/cli.mjs',
      'evidence-l1',
      '--timestamp',
      runTimestamp,
      '--ci-integration-attestation',
      manualArtifacts.ci_integration_run_report,
      '--staging-attestation',
      manualArtifacts.staging_run_report,
      '--pre-release-attestation',
      manualArtifacts.pre_release_run_report,
      '--prod-cost-attestation',
      manualArtifacts.prod_cost_snapshot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: DEFAULT_TEST_GITHUB_REPOSITORY,
      },
    });

    assert.match(stdout, /Wrote L1 evidence bundles/);
    assert.match(stdout, /EVID-CS-001: pass/);
    assert.match(stdout, /EVID-COST-001: pass/);
  } finally {
    await fs.rm(fixtureParent, { recursive: true, force: true });
  }
});

test('CLI evidence-l1 rejects legacy report and snapshot flags after the attestation cutover', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      'packages/testing/src/cli.mjs',
      'evidence-l1',
      '--timestamp',
      '20260401T010203Z',
      '--staging-report',
      'external/staging.json',
    ], {
      cwd: repoRoot,
    }),
    /Unknown evidence-l1 option "--staging-report"/,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      'packages/testing/src/cli.mjs',
      'evidence-l1',
      '--timestamp',
      '20260401T010203Z',
      '--prod-cost-snapshot',
      'external/prod.json',
    ], {
      cwd: repoRoot,
    }),
    /Unknown evidence-l1 option "--prod-cost-snapshot"/,
  );
});
