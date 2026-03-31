import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { analyzeRepository } from '../../spec-tools/src/governance.mjs';
import { getRequiredTestFiles, getTestEnvironmentDirectory } from './bootstrap.mjs';

const execFileAsync = promisify(execFile);

const SHARED_RUN_ENVIRONMENTS = Object.freeze([
  'local',
  'ci-integration',
  'staging',
  'pre-release',
]);

const L1_EVIDENCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'EVID-CS-001',
    scope: 'L1',
    test_ids: ['TEST-CS-001'],
    evidence_type: 'integration/protocol',
    generation_method: 'client-core CI + staging report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-CS-001', 'MX-CS-002', 'MX-CS-003', 'MX-CS-005', 'MX-CS-006', 'MX-CS-019', 'MX-CS-024', 'MX-CS-026'],
    pass_criteria: 'Client discovery, capabilities, registration, login, password/UIA, deactivation, refresh, logout, profile fields, and propagation must pass in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-CS-002',
    scope: 'L1',
    test_ids: ['TEST-CS-002'],
    evidence_type: 'protocol',
    generation_method: '/sync conformance report',
    required_environments: ['staging'],
    declared_source_ids: ['MX-CS-004', 'MX-CS-006', 'MX-CS-007', 'MX-CS-010', 'MX-CS-015'],
    pass_criteria: 'Filter lifecycle, sync modes, include_leave, lazy-load members, push rules, and notification counts must pass in staging.',
  }),
  Object.freeze({
    id: 'EVID-CS-003',
    scope: 'L1',
    test_ids: ['TEST-CS-003'],
    evidence_type: 'protocol',
    generation_method: 'devices/E2EE transport report',
    required_environments: ['staging'],
    declared_source_ids: ['MX-CS-013', 'MX-CS-014'],
    pass_criteria: 'Devices, to-device transport, and one-time key at-most-once behavior must pass in staging.',
  }),
  Object.freeze({
    id: 'EVID-CS-004',
    scope: 'L1',
    test_ids: ['TEST-CS-004'],
    evidence_type: 'protocol/governance',
    generation_method: 'stub-only/unsupported route guard report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-CS-003', 'MX-CS-005', 'MX-CS-012', 'MX-CS-016', 'MX-CS-018', 'MX-CS-020', 'MX-CS-021', 'MX-CS-022', 'MX-CS-023', 'MX-CS-025', 'MX-CS-027', 'MX-CS-028', 'MX-CS-029'],
    pass_criteria: 'Stub-only and unsupported client routes must return deterministic wire behavior without truth writes or discoverability drift in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-ROOM-001',
    scope: 'L1',
    test_ids: ['TEST-ROOM-001'],
    evidence_type: 'property/integration',
    generation_method: 'room-core report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-CS-008', 'MX-CS-009', 'MX-CS-010'],
    pass_criteria: 'Room creation, membership, event send, fanout, receipts, and typing must pass in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-ROOM-002',
    scope: 'L1',
    test_ids: ['TEST-ROOM-002'],
    evidence_type: 'protocol/property',
    generation_method: 'room-version report',
    required_environments: ['ci-integration', 'staging'],
    declared_source_ids: ['MX-RV-011', 'MX-RV-012'],
    l1_excluded_source_ids: ['MX-RV-011'],
    pass_criteria: 'For L1, room version 12 defaults and behavior must pass in CI integration and staging.',
  }),
  Object.freeze({
    id: 'EVID-MEDIA-001',
    scope: 'L1',
    test_ids: ['TEST-MEDIA-001'],
    evidence_type: 'integration/load',
    generation_method: 'media pipeline report',
    required_environments: ['staging', 'pre-release'],
    declared_source_ids: ['MX-CS-011', 'MX-FED-008'],
    l1_excluded_source_ids: ['MX-FED-008'],
    pass_criteria: 'For L1, local media upload/download/thumbnail, authenticated current surfaces, legacy unauthenticated freeze behavior, and animated-thumbnail cache isolation must pass in staging and pre-release.',
  }),
  Object.freeze({
    id: 'EVID-DER-001',
    scope: 'L1',
    test_ids: ['TEST-DER-001'],
    evidence_type: 'integration/rebuild',
    generation_method: 'derived-data report',
    required_environments: ['staging', 'pre-release'],
    declared_source_ids: ['MX-CS-017', 'MX-FED-006'],
    l1_excluded_source_ids: ['MX-FED-006'],
    pass_criteria: 'For L1, search, user directory, public rooms, hierarchy, and rebuild consistency must pass in staging and pre-release, including publicRooms dispatch and deterministic rejection of unauthenticated POST.',
  }),
  Object.freeze({
    id: 'EVID-SEC-001',
    scope: 'common',
    test_ids: ['TEST-SEC-001'],
    evidence_type: 'security',
    generation_method: 'security verification bundle',
    required_environments: ['staging', 'pre-release'],
    declared_source_ids: ['REQ-SEC-*', 'MX-CS-002', 'MX-CS-003', 'MX-CS-005', 'MX-CS-016', 'MX-CS-024', 'MX-CS-025', 'MX-CS-026', 'MX-CS-028', 'MX-FED-002'],
    l1_excluded_source_ids: ['REQ-SEC-005', 'MX-FED-002'],
    pass_criteria: 'For L1, token revocation, UIA route binding, secret handling, and baseline abuse guards on always-on surfaces must pass in staging and pre-release.',
  }),
  Object.freeze({
    id: 'EVID-OPS-001',
    scope: 'common',
    test_ids: ['TEST-OPS-001'],
    evidence_type: 'deploy',
    generation_method: 'rollout compatibility report',
    required_environments: ['pre-release'],
    declared_source_ids: ['REQ-OPS-010', 'REQ-OPS-011', 'REQ-OPS-012'],
    pass_criteria: 'Worker/authority version skew paths must pass in pre-release.',
  }),
  Object.freeze({
    id: 'EVID-COST-001',
    scope: 'common',
    test_ids: ['TEST-COST-001'],
    evidence_type: 'cost',
    generation_method: 'monthly dashboard snapshot + model comparison',
    required_environments: ['pre-release'],
    declared_source_ids: ['REQ-OPS-003', 'CF-WKR-015', 'CF-WKR-016', 'CF-WKR-017', 'CF-WKR-018', 'CF-WKR-019', 'CF-DO-011', 'CF-DO-012', 'CF-DO-013', 'CF-D1-006', 'CF-KV-003', 'CF-R2-005', 'CF-QUE-001'],
    pass_criteria: 'Metrics and cost-attribution surfaces must produce stable pre-release evidence without budget-model drift signals.',
  }),
]);

function slugifyTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePathForMarkdown(value) {
  return String(value).replaceAll(path.sep, '/');
}

async function collectCodeVersionContext(repoRoot) {
  try {
    const [{ stdout: commitStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
      execFileAsync('git', ['status', '--short'], { cwd: repoRoot }),
    ]);
    return {
      git_commit: commitStdout.trim() || null,
      worktree_dirty: statusStdout.trim().length > 0,
    };
  } catch {
    return {
      git_commit: null,
      worktree_dirty: null,
    };
  }
}

function collectDataVersionContext(analysis) {
  const requirementRegisterJson = stableJson(analysis.requirementRegister);
  const traceabilityMatrixJson = stableJson(analysis.traceabilityMatrix);
  const expandedSourceIdsJson = stableJson(analysis.expandedSourceIds);
  const wildcardRouteExpansionJson = stableJson(analysis.wildcardRouteExpansion);
  const analysisSnapshotJson = stableJson({
    summary: analysis.summary,
    issues: analysis.issues,
    requirement_register: analysis.requirementRegister,
    traceability_matrix: analysis.traceabilityMatrix,
    expanded_source_ids: analysis.expandedSourceIds,
    wildcard_route_expansion: analysis.wildcardRouteExpansion,
  });
  return {
    analysis_sha256: sha256Hex(analysisSnapshotJson),
    requirement_register_sha256: sha256Hex(requirementRegisterJson),
    traceability_matrix_sha256: sha256Hex(traceabilityMatrixJson),
    expanded_source_ids_sha256: sha256Hex(expandedSourceIdsJson),
    wildcard_route_expansion_sha256: sha256Hex(wildcardRouteExpansionJson),
  };
}

function quoteCommand(argumentsList) {
  return argumentsList.map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument)).join(' ');
}

async function runEnvironmentSuite(environmentName, repoRoot, sharedRunRoot) {
  const startedAt = new Date().toISOString();
  let files;
  let errorMessage = null;
  try {
    files = await getRequiredTestFiles(environmentName, repoRoot);
  } catch (error) {
    files = [];
    errorMessage = error.message;
  }

  const commandArgs = errorMessage
    ? []
    : ['--test', ...files];
  const combinedChunks = [];
  let exitCode = 1;
  const startedMs = Date.now();

  if (errorMessage == null) {
    exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, commandArgs, {
        cwd: repoRoot,
        env: {
          ...process.env,
          MATRIX_TEST_ENVIRONMENT: environmentName,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        combinedChunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk) => {
        combinedChunks.push(Buffer.from(chunk));
      });
      child.on('error', (error) => {
        combinedChunks.push(Buffer.from(`${error.message}\n`, 'utf8'));
        resolve(1);
      });
      child.on('close', (code) => {
        resolve(code ?? 1);
      });
    });
  } else {
    combinedChunks.push(Buffer.from(`${errorMessage}\n`, 'utf8'));
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const logText = Buffer.concat(combinedChunks).toString('utf8');
  const logFile = path.join(sharedRunRoot, `${environmentName}.log`);
  const summaryFile = path.join(sharedRunRoot, `${environmentName}.json`);
  const record = {
    environment_name: environmentName,
    status: exitCode === 0 ? 'pass' : 'fail',
    exit_code: exitCode,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    command: errorMessage == null ? quoteCommand([process.execPath, ...commandArgs]) : null,
    test_directory: normalizePathForMarkdown(path.relative(repoRoot, getTestEnvironmentDirectory(environmentName, repoRoot))),
    test_file_count: files.length,
    test_files: files.map((file) => normalizePathForMarkdown(path.relative(repoRoot, file))),
    output_sha256: sha256Hex(logText),
    error_message: errorMessage,
    log_artifact: normalizePathForMarkdown(path.relative(repoRoot, logFile)),
  };

  await fs.mkdir(sharedRunRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(logFile, logText),
    fs.writeFile(summaryFile, stableJson(record)),
  ]);

  return {
    ...record,
    log_file: logFile,
    summary_file: summaryFile,
  };
}

function expandDeclaredSourceIds(declaredSourceIds, analysis) {
  const allIds = new Set(analysis.definitions.map((definition) => definition.id));
  const expanded = new Set();
  for (const sourceId of declaredSourceIds) {
    if (sourceId.endsWith('*')) {
      const prefix = sourceId.slice(0, -1);
      for (const candidateId of allIds) {
        if (candidateId.startsWith(prefix)) {
          expanded.add(candidateId);
        }
      }
      continue;
    }
    expanded.add(sourceId);
  }
  return [...expanded].sort();
}

function buildApplicableSourceIds(definition, expandedSourceIds) {
  const excluded = new Set(definition.l1_excluded_source_ids ?? []);
  return expandedSourceIds.filter((sourceId) => !excluded.has(sourceId));
}

async function writeEvidenceBundle(repoRoot, {
  definition,
  analysis,
  codeVersion,
  dataVersion,
  generatedAt,
  runTimestamp,
  sharedRunRoot,
  environmentRuns,
}) {
  const evidenceRoot = path.join(repoRoot, `evidence/${definition.scope}/${definition.id}/${runTimestamp}`);
  const artifactsDir = path.join(evidenceRoot, 'artifacts');
  const expandedSourceIds = expandDeclaredSourceIds(definition.declared_source_ids, analysis);
  const applicableSourceIds = buildApplicableSourceIds(definition, expandedSourceIds);
  const requiredEnvironments = definition.required_environments.map((environmentName) => environmentRuns[environmentName]);
  const supportingEnvironments = SHARED_RUN_ENVIRONMENTS
    .filter((environmentName) => !definition.required_environments.includes(environmentName))
    .map((environmentName) => environmentRuns[environmentName]);
  const status = analysis.valid && requiredEnvironments.every((environmentRun) => environmentRun.exit_code === 0)
    ? 'pass'
    : 'fail';

  const environmentResults = {
    required_environments: definition.required_environments,
    supporting_environments: supportingEnvironments.map((environmentRun) => environmentRun.environment_name),
    required_results: requiredEnvironments.map((environmentRun) => ({
      environment_name: environmentRun.environment_name,
      status: environmentRun.status,
      exit_code: environmentRun.exit_code,
      duration_ms: environmentRun.duration_ms,
      command: environmentRun.command,
      log_artifact: normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file)),
      summary_artifact: normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file)),
    })),
    supporting_results: supportingEnvironments.map((environmentRun) => ({
      environment_name: environmentRun.environment_name,
      status: environmentRun.status,
      exit_code: environmentRun.exit_code,
      duration_ms: environmentRun.duration_ms,
      command: environmentRun.command,
      log_artifact: normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file)),
      summary_artifact: normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file)),
    })),
    shared_run_root: normalizePathForMarkdown(path.relative(evidenceRoot, sharedRunRoot)),
  };

  const contextRecord = {
    evid_id: definition.id,
    target_profile: 'L1',
    generated_at: generatedAt,
    run_ts: runTimestamp,
    repo_root: normalizePathForMarkdown(repoRoot),
    code_version: codeVersion,
    data_version: dataVersion,
    governance_valid: analysis.valid,
    evidence_type: definition.evidence_type,
    generation_method: definition.generation_method,
    pass_criteria: definition.pass_criteria,
    test_ids: definition.test_ids,
  };

  const sourceIdsRecord = {
    declared_source_ids: definition.declared_source_ids,
    expanded_source_ids: expandedSourceIds,
    applicable_source_ids: applicableSourceIds,
  };

  await fs.mkdir(artifactsDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(artifactsDir, 'context.json'), stableJson(contextRecord)),
    fs.writeFile(path.join(artifactsDir, 'source-ids.json'), stableJson(sourceIdsRecord)),
    fs.writeFile(path.join(artifactsDir, 'environment-results.json'), stableJson(environmentResults)),
  ]);

  const summaryLines = [
    `# ${definition.id} Summary`,
    '',
    `- status: ${status}`,
    `- generated_at: ${generatedAt}`,
    `- run_ts: ${runTimestamp}`,
    `- scope: ${definition.scope}`,
    '- target_profile: L1',
    `- evidence_type: ${definition.evidence_type}`,
    `- generation_method: ${definition.generation_method}`,
    `- repo_root: ${normalizePathForMarkdown(repoRoot)}`,
    '',
    '## Context',
    '',
    `- code_version.git_commit: ${codeVersion.git_commit == null ? '`unknown`' : `\`${codeVersion.git_commit}\``}`,
    `- code_version.worktree_dirty: ${codeVersion.worktree_dirty == null ? 'unknown' : String(codeVersion.worktree_dirty)}`,
    `- data_version.analysis_sha256: \`${dataVersion.analysis_sha256}\``,
    `- data_version.requirement_register_sha256: \`${dataVersion.requirement_register_sha256}\``,
    `- data_version.traceability_matrix_sha256: \`${dataVersion.traceability_matrix_sha256}\``,
    `- data_version.expanded_source_ids_sha256: \`${dataVersion.expanded_source_ids_sha256}\``,
    `- data_version.wildcard_route_expansion_sha256: \`${dataVersion.wildcard_route_expansion_sha256}\``,
    `- governance_valid: ${analysis.valid ? 'true' : 'false'}`,
    '',
    '## Source IDs',
    '',
    `- declared_source_ids: ${definition.declared_source_ids.map((sourceId) => `\`${sourceId}\``).join(', ')}`,
    `- expanded_source_ids: ${expandedSourceIds.map((sourceId) => `\`${sourceId}\``).join(', ')}`,
    `- applicable_source_ids: ${applicableSourceIds.map((sourceId) => `\`${sourceId}\``).join(', ')}`,
    '',
    '## Required Tests',
    '',
    definition.test_ids.map((testId) => `- \`${testId}\``).join('\n'),
    '',
    '## Environment Results',
    '',
  ];

  for (const environmentRun of requiredEnvironments) {
    summaryLines.push(`- required \`${environmentRun.environment_name}\`: ${environmentRun.status} (exit=${environmentRun.exit_code}, duration_ms=${environmentRun.duration_ms})`);
    summaryLines.push(`  artifacts: \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file))}\`, \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file))}\``);
  }
  for (const environmentRun of supportingEnvironments) {
    summaryLines.push(`- supporting \`${environmentRun.environment_name}\`: ${environmentRun.status} (exit=${environmentRun.exit_code}, duration_ms=${environmentRun.duration_ms})`);
    summaryLines.push(`  artifacts: \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.log_file))}\`, \`${normalizePathForMarkdown(path.relative(evidenceRoot, environmentRun.summary_file))}\``);
  }

  summaryLines.push('');
  summaryLines.push('## Pass Criteria');
  summaryLines.push('');
  summaryLines.push(`- ${definition.pass_criteria}`);
  summaryLines.push('');
  summaryLines.push('## Artifacts');
  summaryLines.push('');
  summaryLines.push('- `artifacts/context.json`');
  summaryLines.push('- `artifacts/source-ids.json`');
  summaryLines.push('- `artifacts/environment-results.json`');

  await fs.writeFile(path.join(evidenceRoot, 'summary.md'), summaryLines.join('\n') + '\n');

  return {
    evid_id: definition.id,
    evidence_root: evidenceRoot,
    status,
  };
}

export async function writeL1Evidence(repoRoot = process.cwd(), options = {}) {
  const analysis = await analyzeRepository(repoRoot);
  const runTimestamp = options.timestamp ?? slugifyTimestamp();
  const generatedAt = new Date().toISOString();
  const sharedRunRoot = path.join(repoRoot, 'evidence/common/_test-runs', runTimestamp);
  const codeVersion = await collectCodeVersionContext(repoRoot);
  const dataVersion = collectDataVersionContext(analysis);

  await fs.mkdir(sharedRunRoot, { recursive: true });

  const environmentRuns = {};
  for (const environmentName of SHARED_RUN_ENVIRONMENTS) {
    environmentRuns[environmentName] = await runEnvironmentSuite(environmentName, repoRoot, sharedRunRoot);
  }

  const bundles = [];
  for (const definition of L1_EVIDENCE_DEFINITIONS) {
    bundles.push(await writeEvidenceBundle(repoRoot, {
      definition,
      analysis,
      codeVersion,
      dataVersion,
      generatedAt,
      runTimestamp,
      sharedRunRoot,
      environmentRuns,
    }));
  }

  return {
    analysis,
    generated_at: generatedAt,
    run_timestamp: runTimestamp,
    shared_run_root: sharedRunRoot,
    code_version: codeVersion,
    data_version: dataVersion,
    environment_runs: environmentRuns,
    bundles,
    ok: analysis.valid
      && Object.values(environmentRuns).every((environmentRun) => environmentRun.exit_code === 0)
      && bundles.every((bundle) => bundle.status === 'pass'),
  };
}
