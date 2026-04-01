import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  discoverTestFiles,
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
  validateManualArtifactPayload,
  writeL1Evidence,
} from '../../../packages/testing/src/evidence.mjs';
import {
  assertPathsDoNotExist,
  writeGovernanceEvidence,
} from '../../../packages/spec-tools/src/governance.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const execFileAsync = promisify(execFile);

function buildValidEnvironmentReport(environmentName, runTimestamp, overrides = {}) {
  const directory = getTestEnvironmentDefinition(environmentName).directory;
  return {
    environment_name: environmentName,
    status: 'pass',
    exit_code: 0,
    started_at: '2026-03-31T14:00:00.000Z',
    completed_at: '2026-03-31T14:05:00.000Z',
    duration_ms: 300000,
    command: `/usr/bin/node --test /tmp/${environmentName}.test.mjs`,
    test_directory: directory,
    test_file_count: 1,
    test_files: [`${directory}/remote.test.mjs`],
    expanded_test_file_count: 2,
    expanded_test_files: [
      `${directory}/remote.test.mjs`,
      'packages/testing/src/bootstrap.mjs',
    ],
    output_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    error_message: null,
    log_artifact: `external/${environmentName}/${runTimestamp}/log.txt`,
    executed_by: 'ci-runner',
    reviewed_by: 'release-reviewer',
    source_run_uri: `https://example.invalid/runs/${environmentName}/${runTimestamp}`,
    topology_kind: `cloudflare-${environmentName}`,
    cloudflare_resources: {
      workers: ['gateway-worker@v1', 'jobs-worker@v1', 'ops-worker@v1'],
      durable_objects: ['UserDO', 'RoomDO', 'RemoteServerDO'],
      d1_databases: [`matrix-${environmentName}-d1`],
      r2_buckets: [`matrix-${environmentName}-r2`],
      kv_namespaces: [`matrix-${environmentName}-kv`],
      queues: [`matrix-${environmentName}-queue`],
    },
    run_timestamp: runTimestamp,
    ...overrides,
  };
}

function buildValidProdCostSnapshot(runTimestamp, overrides = {}) {
  return {
    artifact_id: 'prod_cost_snapshot',
    source_environment: 'prod',
    captured_at: '2026-03-31T14:00:00.000Z',
    captured_by: 'finance-bot',
    reviewed_by: 'platform-reviewer',
    source_dashboard_uri: 'https://example.invalid/cost/2026-03',
    topology_kind: 'cloudflare-prod',
    cloudflare_resources: {
      workers: ['gateway-worker@prod', 'jobs-worker@prod', 'ops-worker@prod'],
      durable_objects: ['UserDO', 'RoomDO', 'RemoteServerDO'],
      d1_databases: ['matrix-prod-d1'],
      r2_buckets: ['matrix-prod-r2'],
      kv_namespaces: ['matrix-prod-kv'],
      queues: ['matrix-prod-queue'],
    },
    billing_period: {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-31T00:00:00.000Z',
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
    local: 'tests/local-env-backed/environment-backed.test.mjs',
    'ci-integration': 'tests/integration-env-backed/environment-backed.test.mjs',
    staging: 'tests/staging-env-backed/environment-backed.test.mjs',
    'pre-release': 'tests/pre-release-env-backed/environment-backed.test.mjs',
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
    "import { proof } from '../shared/all-bundles-proof.mjs';",
    '',
    "test('environment-backed proof', () => {",
    '  assert.equal(proof, true);',
    '});',
    '',
  ].join('\n');
  for (const testFile of Object.values(environmentTestFiles)) {
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
    "  'TEST-CS-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-CS-002': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-CS-003': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-CS-004': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-ROOM-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-ROOM-002': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-MEDIA-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-DER-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-SEC-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-OPS-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    "  'TEST-COST-001': Object.freeze(['tests/shared/all-bundles-proof.mjs']),",
    '});',
    '',
  ].join('\n');
  await fs.writeFile(
    evidenceFile,
    `${evidenceSource.slice(0, mappingStart)}${minimalMappingBlock}${evidenceSource.slice(mappingEnd)}`,
  );

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
  const externalRoot = path.join(fixtureRoot, 'external', runTimestamp);
  await fs.mkdir(externalRoot, { recursive: true });

  const manualArtifacts = {};
  const environmentArtifactIds = {
    'ci-integration': 'ci_integration_run_report',
    staging: 'staging_run_report',
    'pre-release': 'pre_release_run_report',
  };

  for (const [environmentName, artifactId] of Object.entries(environmentArtifactIds)) {
    const artifactPath = path.join(externalRoot, `${environmentName}.json`);
    const environmentTestDirectory = path.dirname(environmentTestFiles[environmentName]).replaceAll(path.sep, '/');
    await fs.writeFile(
      artifactPath,
      JSON.stringify(buildValidEnvironmentReport(environmentName, runTimestamp, {
        test_directory: environmentTestDirectory,
        test_files: [environmentTestFiles[environmentName]],
        test_file_count: 1,
        expanded_test_files: [environmentTestFiles[environmentName], sharedProofFile],
        expanded_test_file_count: 2,
        log_artifact: `external/${runTimestamp}/${environmentName}.log`,
      }), null, 2),
    );
    manualArtifacts[artifactId] = path.relative(fixtureRoot, artifactPath);
  }

  const prodCostSnapshotPath = path.join(externalRoot, 'prod-cost-snapshot.json');
  await fs.writeFile(
    prodCostSnapshotPath,
    JSON.stringify(buildValidProdCostSnapshot(runTimestamp), null, 2),
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

test('L1 evidence bundle set includes governance and canonical test implementation mappings', () => {
  assert.deepEqual(listL1EvidenceBundleIds().slice(0, 2), ['EVID-GOV-001', 'EVID-CS-001']);
  assert.deepEqual(
    getRequiredTestImplementationFiles('TEST-CS-001'),
    ['tests/local/client-identity/phase-04.test.mjs'],
  );
  assert.deepEqual(
    getRequiredTestImplementationFiles('TEST-OPS-001'),
    [
      'tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs',
      'tests/local/control-plane/phase-08-ops.test.mjs',
    ],
  );
});

test('split L1 TEST-ID coverage requires every canonical implementation file', () => {
  const results = collectTestCoverageResults(
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
  assert.deepEqual(results[0].matched_files, ['tests/local/control-plane/phase-08-ops.test.mjs']);
  assert.deepEqual(results[0].missing_files, ['tests/local/runtime-foundations/phase-08-runtime-controls.test.mjs']);
});

test('manual artifact payload validation requires structured non-local reports and typed prod snapshots', () => {
  const runTimestamp = '20260331T140000Z';
  const validStagingReport = buildValidEnvironmentReport('staging', runTimestamp);
  const validProdCostSnapshot = buildValidProdCostSnapshot(runTimestamp);

  assert.deepEqual(
    validateManualArtifactPayload('staging_run_report', validStagingReport, { runTimestamp }),
    {
      valid: true,
      error: null,
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
      source_run_uri: '',
    }, {
      runTimestamp,
    }),
    {
      valid: false,
      error: 'environment run report must include source_run_uri',
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
      error: 'prod_cost_snapshot must include source_dashboard_uri',
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

test('current non-local harness readiness fails closed while staging and pre-release still import local tests', async () => {
  const integrationReadiness = await assessNonLocalEnvironmentHarnessReadiness('ci-integration', repoRoot);
  assert.equal(integrationReadiness.ready, false);
  assert.ok(integrationReadiness.local_test_expansions.some((file) => file.startsWith('tests/local/')));

  const stagingReadiness = await assessNonLocalEnvironmentHarnessReadiness('staging', repoRoot);
  assert.equal(stagingReadiness.ready, false);
  assert.ok(stagingReadiness.local_test_expansions.some((file) => file.startsWith('tests/local/')));

  const preReleaseReadiness = await assessNonLocalEnvironmentHarnessReadiness('pre-release', repoRoot);
  assert.equal(preReleaseReadiness.ready, false);
  assert.ok(preReleaseReadiness.local_test_expansions.some((file) => file.startsWith('tests/local/')));
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

test('non-local harness readiness allows node builtin imports while tracking repo-owned shared proofs', async () => {
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
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
  assert.deepEqual(readiness.unresolved_dynamic_imports, []);
  assert.deepEqual(readiness.repo_boundary_escapes, []);
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
  );
  await fs.writeFile(
    prodCostSnapshotPath,
    JSON.stringify(buildValidProdCostSnapshot(runTimestamp), null, 2),
  );

  const results = await collectManualArtifactResults(
    getL1EvidenceDefinition('EVID-COST-001'),
    tempRoot,
    {
      pre_release_run_report: path.relative(tempRoot, reportPath),
      prod_cost_snapshot: path.relative(tempRoot, prodCostSnapshotPath),
    },
    runTimestamp,
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
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
  );
  await fs.writeFile(
    sharedProdCostSnapshotPath,
    JSON.stringify(buildValidProdCostSnapshot(runTimestamp), null, 2),
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
  const reportPath = path.join(os.tmpdir(), `matrix-pre-release-report-${runTimestamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify(buildValidEnvironmentReport('pre-release', runTimestamp), null, 2),
  );

  try {
    const results = await collectManualArtifactResults(
      getL1EvidenceDefinition('EVID-OPS-001'),
      repoRoot,
      {
        pre_release_run_report: reportPath,
      },
      runTimestamp,
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].valid, false);
    assert.match(results[0].validation_error, /harness is not environment-backed/);
  } finally {
    await fs.rm(reportPath, { force: true });
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
  assert.equal(results[0].valid, true);
  assert.equal(results[0].environment_harness_ready, true);
  assert.equal(results[0].validation_error, null);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
  assert.equal(results[0].environment_harness_ready, false);
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
    JSON.stringify(buildValidEnvironmentReport('staging', runTimestamp, {
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
  assert.match(results[0].validation_error, /harness is not environment-backed/);
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
