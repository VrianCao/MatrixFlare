#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  buildRunEnvironmentVariables,
  getTestEnvironmentDirectory,
  getRequiredTestFiles,
  listTestEnvironmentNames,
  resolveTestEnvironmentName,
} from './bootstrap.mjs';
import { writeL1Evidence } from './evidence.mjs';
import {
  buildProductionEnvironmentPlan,
  buildNonLocalEnvironmentPlan,
  buildNonProductionSecretBundle,
  captureProdCostSnapshot,
  createEnvironmentWranglerConfig,
  downloadImmutableArtifactFromR2,
  deployNonLocalEnvironment,
  installProductionTopology,
  normalizeProdCurrentStateSnapshot,
  operationalRefreshProductionEnvironment,
  promoteProductionEnvironment,
  resolveClosedProdBillingWindow,
  rollbackProductionEnvironment,
  stageProductionRawStateArtifactForUpload,
  validateProductionCurrentStateFailureArtifacts,
  writeReleaseCandidateManifest,
  ensureNonLocalEnvironmentResources,
  prepareNonLocalOpsAccessSession,
  resolveProductionBaselineInputArtifact,
  restorePreReleaseGatewayRollout,
  runEnvironmentBackedSuite,
  startPreReleaseGatewayRollout,
  uploadImmutableArtifactToR2,
  writeProdCostSnapshotProvenance,
  writeEnvironmentRunProvenance,
  writeEnvironmentRunAttestation,
  writeEnvironmentWranglerConfig,
  writeProdCostSnapshotAttestation,
} from './nonlocal.mjs';

const EVIDENCE_L1_MANUAL_ARTIFACT_FLAGS = Object.freeze({
  '--ci-integration-attestation': 'ci_integration_run_report',
  '--staging-attestation': 'staging_run_report',
  '--pre-release-attestation': 'pre_release_run_report',
  '--prod-cost-attestation': 'prod_cost_snapshot',
});

const execFileAsync = promisify(execFile);

function parseGitHubRepositoryFromRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim().length === 0) {
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

async function resolveExpectedGitHubRepository(repoRoot) {
  const envRepository = typeof process.env.GITHUB_REPOSITORY === 'string'
    ? process.env.GITHUB_REPOSITORY.trim()
    : '';
  if (envRepository.length > 0) {
    return envRepository;
  }
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    return parseGitHubRepositoryFromRemoteUrl(stdout) ?? null;
  } catch {
    return null;
  }
}

async function runEnvironment(environmentName, options = {}) {
  const repoRoot = process.cwd();
  let files;
  try {
    files = await getRequiredTestFiles(environmentName, repoRoot);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  console.log(`Running ${environmentName} tests from ${path.relative(repoRoot, getTestEnvironmentDirectory(environmentName, repoRoot))}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: repoRoot,
      env: buildRunEnvironmentVariables(process.env, environmentName, {
        allowMissingRemoteHarness: options.allowMissingRemoteHarness === true,
      }),
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

function parseKeyValueOptions(argv, startIndex = 3) {
  const options = {};
  for (let index = startIndex; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      throw new RangeError(`Unexpected positional argument "${current}"`);
    }
    const optionName = current.slice(2);
    const next = argv[index + 1] ?? null;
    if (next == null || next.startsWith('--')) {
      options[optionName] = true;
      continue;
    }
    options[optionName] = next;
    index += 1;
  }
  return options;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function parseEvidenceL1Options(argv) {
  const parsed = {
    timestamp: null,
    manualArtifacts: {},
  };

  for (let index = 3; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--timestamp') {
      const timestamp = argv[index + 1] ?? null;
      if (timestamp == null || timestamp.startsWith('--')) {
        throw new RangeError('--timestamp requires a value');
      }
      parsed.timestamp = timestamp;
      index += 1;
      continue;
    }

    const artifactId = EVIDENCE_L1_MANUAL_ARTIFACT_FLAGS[current] ?? null;
    if (artifactId != null) {
      const artifactPath = argv[index + 1] ?? null;
      if (artifactPath == null || artifactPath.startsWith('--')) {
        throw new RangeError(`${current} requires a value`);
      }
      parsed.manualArtifacts[artifactId] = artifactPath;
      index += 1;
      continue;
    }

    throw new RangeError(`Unknown evidence-l1 option "${current}"`);
  }

  return parsed;
}

function requireOption(options, optionName) {
  const value = options[optionName];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`--${optionName} requires a value`);
  }
  return value;
}

function parseBooleanOption(options, optionName, {
  defaultValue = false,
} = {}) {
  const value = options[optionName];
  if (value == null) {
    return defaultValue;
  }
  if (value === true) {
    return true;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new RangeError(`--${optionName} must be true or false`);
}

async function main() {
  const requestedEnvironment = process.argv[2] ?? 'local';
  if (requestedEnvironment === 'evidence-l1') {
    const { timestamp, manualArtifacts } = parseEvidenceL1Options(process.argv);
    const expectedGitHubRepository = await resolveExpectedGitHubRepository(process.cwd());
    const result = await writeL1Evidence(process.cwd(), {
      timestamp,
      manualArtifacts,
      expectedGitHubRepository,
    });
    console.log(`Wrote L1 evidence bundles for run ${result.run_timestamp}`);
    console.log(`Shared test-run artifacts: ${path.relative(process.cwd(), result.shared_run_root)}`);
    for (const bundle of result.bundles) {
      console.log(`- ${bundle.evid_id}: ${bundle.status} (${path.relative(process.cwd(), bundle.evidence_root)})`);
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (requestedEnvironment === 'nonlocal-plan') {
    const options = parseKeyValueOptions(process.argv);
    const plan = buildNonLocalEnvironmentPlan(requireOption(options, 'environment'), {
      workersSubdomain: typeof options['workers-subdomain'] === 'string' ? options['workers-subdomain'] : null,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-plan') {
    const options = parseKeyValueOptions(process.argv);
    const plan = buildProductionEnvironmentPlan({
      workersSubdomain: typeof options['workers-subdomain'] === 'string' ? options['workers-subdomain'] : null,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-secrets') {
    const options = parseKeyValueOptions(process.argv);
    const accountId = typeof options['account-id'] === 'string'
      ? options['account-id']
      : process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = typeof options['api-token'] === 'string'
      ? options['api-token']
      : process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
      throw new RangeError('nonlocal-secrets requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    }
    const bundle = buildNonProductionSecretBundle({
      environmentName: requireOption(options, 'environment'),
      accountId,
      apiToken,
    });
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-write-wrangler-config') {
    const options = parseKeyValueOptions(process.argv);
    const plan = buildNonLocalEnvironmentPlan(requireOption(options, 'environment'), {
      workersSubdomain: typeof options['workers-subdomain'] === 'string' ? options['workers-subdomain'] : null,
    });
    const result = await writeEnvironmentWranglerConfig(requireOption(options, 'worker'), plan, {
      outputPath: path.resolve(process.cwd(), requireOption(options, 'output')),
      d1DatabaseId: requireOption(options, 'd1-database-id'),
      kvNamespaceId: requireOption(options, 'kv-namespace-id'),
      gatewayBootstrapMode: options['gateway-bootstrap'] === true,
      deploymentId: typeof options['deployment-id'] === 'string' ? options['deployment-id'] : `gha-${plan.environment_name}`,
      workerVersionId: typeof options['worker-version-id'] === 'string' ? options['worker-version-id'] : 'pending-cloudflare-version',
      activeDeploymentComposition: typeof options['active-deployment-composition'] === 'string'
        ? JSON.parse(options['active-deployment-composition'])
        : [],
      access: typeof options['access-auth-domain'] === 'string' && typeof options['access-audience'] === 'string'
        ? {
          auth_domain: options['access-auth-domain'],
          application_audience: options['access-audience'],
        }
        : null,
    });
    process.stdout.write(`${JSON.stringify({
      worker_name: result.worker_name,
      output_path: path.relative(process.cwd(), result.output_path),
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-ensure') {
    const options = parseKeyValueOptions(process.argv);
    const result = await ensureNonLocalEnvironmentResources(requireOption(options, 'environment'), {
      repoRoot: process.cwd(),
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      preferredWorkersSubdomain: typeof options['workers-subdomain'] === 'string' ? options['workers-subdomain'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      environment_name: result.environment_name,
      workers_subdomain: result.workers_subdomain,
      output_path: typeof options.output === 'string' ? options.output : null,
      d1_database_id: result.resources.d1_database.id,
      kv_namespace_id: result.resources.kv_namespace.id,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-deploy') {
    const options = parseKeyValueOptions(process.argv);
    const provisionedEnvironment = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'provisioning')));
    const result = await deployNonLocalEnvironment(requireOption(options, 'environment'), {
      repoRoot: process.cwd(),
      provisionedEnvironment,
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : path.resolve(process.cwd(), '.tmp', 'nonlocal', requireOption(options, 'environment')),
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      deploymentId: typeof options['deployment-id'] === 'string' ? options['deployment-id'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      environment_name: result.environment_name,
      deployment_id: result.deployment_id,
      output_path: typeof options.output === 'string' ? options.output : null,
      deployment_identity: result.deployment_identity,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-install') {
    const options = parseKeyValueOptions(process.argv);
    const result = await installProductionTopology({
      repoRoot: process.cwd(),
      releaseCommitSha: typeof options['release-commit-sha'] === 'string' ? options['release-commit-sha'] : process.env.GITHUB_SHA,
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : path.resolve(process.cwd(), '.tmp', 'prod', 'install'),
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      preferredWorkersSubdomain: typeof options['workers-subdomain'] === 'string' ? options['workers-subdomain'] : null,
      installId: typeof options['install-id'] === 'string' ? options['install-id'] : null,
      deploymentId: typeof options['deployment-id'] === 'string' ? options['deployment-id'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
      productionSecretSeed: typeof options['secret-seed'] === 'string' ? options['secret-seed'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      output_path: typeof options.output === 'string' ? options.output : null,
      install_id: result.record.install_id,
      deployment_identity: result.record.deployment_identity,
      readiness_probe_ready: result.readiness_probe.ready,
      readiness_probe_attempt_count: result.readiness_probe.attempt_count,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-prepare-ops-access') {
    const options = parseKeyValueOptions(process.argv);
    const provisionedEnvironment = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'provisioning')));
    const deploymentSummary = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'deployment')));
    const result = await prepareNonLocalOpsAccessSession(requireOption(options, 'environment'), {
      repoRoot: process.cwd(),
      provisionedEnvironment,
      deploymentSummary,
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : null,
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      environment_name: result.environment_name,
      output_path: typeof options.output === 'string' ? options.output : null,
      policy_id: result.access.policy_id,
      service_token_id: result.access.service_token_id,
      service_token_client_id: result.access.service_token_client_id,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-candidate-write') {
    const options = parseKeyValueOptions(process.argv);
    const ciIntegrationAttestation = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'ci-integration-attestation')));
    const stagingAttestation = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'staging-attestation')));
    const preReleaseAttestation = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'pre-release-attestation')));
    const result = await writeReleaseCandidateManifest(
      path.resolve(process.cwd(), requireOption(options, 'output')),
      {
        releaseRef: requireOption(options, 'release-ref'),
        releaseCommitSha: typeof options['release-commit-sha'] === 'string'
          ? options['release-commit-sha']
          : process.env.GITHUB_SHA,
        requiresDoMigration: parseBooleanOption(options, 'requires-do-migration', {
          defaultValue: false,
        }),
        candidateId: typeof options['candidate-id'] === 'string' ? options['candidate-id'] : null,
        sourceRepository: ciIntegrationAttestation?.provenance?.origin_repository,
        sourceRunUri: ciIntegrationAttestation?.provenance?.origin_run_uri,
        ciIntegrationAttestation,
        stagingAttestation,
        preReleaseAttestation,
      },
    );
    process.stdout.write(`${JSON.stringify({
      output_path: path.relative(process.cwd(), result.output_path),
      candidate_id: result.manifest.candidate_id,
      release_commit_sha: result.manifest.release_commit_sha,
      source_run_uri: result.manifest.source_run_uri,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-rollout-start') {
    const options = parseKeyValueOptions(process.argv);
    const provisionedEnvironment = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'provisioning')));
    const deploymentSummary = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'deployment')));
    const result = await startPreReleaseGatewayRollout(requireOption(options, 'environment'), {
      repoRoot: process.cwd(),
      provisionedEnvironment,
      deploymentSummary,
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : null,
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      deploymentId: typeof options['deployment-id'] === 'string' ? options['deployment-id'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      environment_name: result.environment_name,
      output_path: typeof options.output === 'string' ? options.output : null,
      baseline_gateway_version_id: result.baseline_gateway_version_id,
      baseline_gateway_version_tag: result.baseline_gateway_version_tag,
      candidate_gateway_version_id: result.candidate_gateway_version_id,
      candidate_gateway_version_tag: result.candidate_gateway_version_tag,
      dual_version_deployment_id: result.dual_version_deployment_id,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-rollout-restore') {
    const options = parseKeyValueOptions(process.argv);
    const rolloutState = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'rollout-state')));
    const result = await restorePreReleaseGatewayRollout(requireOption(options, 'environment'), {
      repoRoot: process.cwd(),
      rolloutState,
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      environment_name: result.environment_name,
      output_path: typeof options.output === 'string' ? options.output : null,
      restored_deployment_id: result.restored_deployment_id,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-run') {
    const options = parseKeyValueOptions(process.argv);
    const deployment = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'deployment')));
    const accessSession = typeof options['access-session'] === 'string'
      ? await readJsonFile(path.resolve(process.cwd(), options['access-session']))
      : null;
    const rolloutState = typeof options['rollout-state'] === 'string'
      ? await readJsonFile(path.resolve(process.cwd(), options['rollout-state']))
      : null;
    const result = await runEnvironmentBackedSuite(requireOption(options, 'environment'), process.cwd(), {
      runTimestamp: requireOption(options, 'timestamp'),
      outputRoot: path.resolve(process.cwd(), requireOption(options, 'output-root')),
      sourceRunUri: requireOption(options, 'source-run-uri'),
      logArtifact: requireOption(options, 'log-artifact'),
      executedBy: requireOption(options, 'executed-by'),
      reviewedBy: requireOption(options, 'reviewed-by'),
      topologyKind: requireOption(options, 'topology-kind'),
      deploymentSummary: deployment,
      accessSession,
      rolloutState,
    });
    process.stdout.write(`${JSON.stringify({
      report_path: path.relative(process.cwd(), result.report_path),
      log_path: path.relative(process.cwd(), result.log_path),
      status: result.report.status,
      readiness_probe_ready: result.report.readiness_probe?.ready ?? null,
      readiness_probe_attempt_count: result.report.readiness_probe?.attempt_count ?? null,
      validation_error: result.validation_error,
    }, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (requestedEnvironment === 'nonlocal-upload-r2') {
    const options = parseKeyValueOptions(process.argv);
    const result = await uploadImmutableArtifactToR2({
      repoRoot: process.cwd(),
      bucketName: requireOption(options, 'bucket'),
      objectKey: requireOption(options, 'key'),
      filePath: path.resolve(process.cwd(), requireOption(options, 'file')),
      contentType: typeof options['content-type'] === 'string' ? options['content-type'] : 'application/octet-stream',
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      object_uri: result.object_uri,
      object_key: result.object_key,
      file_sha256: result.file_sha256,
      output_path: typeof options.output === 'string' ? options.output : null,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-download-r2') {
    const options = parseKeyValueOptions(process.argv);
    const result = await downloadImmutableArtifactFromR2({
      repoRoot: process.cwd(),
      bucketName: requireOption(options, 'bucket'),
      objectKey: requireOption(options, 'key'),
      outputPath: path.resolve(process.cwd(), requireOption(options, 'output')),
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      object_uri: result.object_uri,
      output_path: path.relative(process.cwd(), result.output_path),
      file_sha256: result.file_sha256,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-promote') {
    const options = parseKeyValueOptions(process.argv);
    const baselineRecordPath = typeof options['baseline-record'] === 'string'
      ? path.resolve(process.cwd(), options['baseline-record'])
      : null;
    const baselineCurrentStatePath = typeof options['baseline-current-state'] === 'string'
      ? path.resolve(process.cwd(), options['baseline-current-state'])
      : null;
    if (baselineRecordPath == null && baselineCurrentStatePath == null) {
      throw new Error('prod-promote requires --baseline-record or --baseline-current-state');
    }
    if (baselineRecordPath != null && baselineCurrentStatePath != null) {
      throw new Error('prod-promote accepts only one of --baseline-record or --baseline-current-state');
    }
    const result = await promoteProductionEnvironment({
      repoRoot: process.cwd(),
      baselineRecord: baselineRecordPath == null ? null : await readJsonFile(baselineRecordPath),
      baselineCurrentState: baselineCurrentStatePath == null ? null : await readJsonFile(baselineCurrentStatePath),
      candidateManifest: await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'candidate-manifest'))),
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : path.resolve(process.cwd(), '.tmp', 'prod', 'promote'),
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      promotionId: typeof options['promotion-id'] === 'string' ? options['promotion-id'] : null,
      deploymentId: typeof options['deployment-id'] === 'string' ? options['deployment-id'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
      productionSecretSeed: typeof options['secret-seed'] === 'string' ? options['secret-seed'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      output_path: typeof options.output === 'string' ? options.output : null,
      promotion_id: result.record.promotion_id,
      promotion_mode: result.record.promotion_mode,
      current_deployment_identity: result.record.current_deployment_identity,
      gateway_rollout_steps: result.record.gateway_rollout_steps.length,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-current-state-normalize') {
    const options = parseKeyValueOptions(process.argv);
    const normalizedSnapshot = normalizeProdCurrentStateSnapshot(
      await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'snapshot'))),
      {
        baselineRecord: await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'baseline-record'))),
        originRunIdentity: {
          origin_repository: requireOption(options, 'origin-repository'),
          origin_run_id: requireOption(options, 'origin-run-id'),
          origin_run_attempt: Number.parseInt(requireOption(options, 'origin-run-attempt'), 10),
          origin_run_uri: requireOption(options, 'origin-run-uri'),
        },
      },
    );
    const outputPath = typeof options.output === 'string'
      ? path.resolve(process.cwd(), options.output)
      : null;
    if (outputPath != null) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(normalizedSnapshot, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      output_path: typeof options.output === 'string' ? options.output : null,
      artifact_id: normalizedSnapshot.artifact_id,
      observed_at: normalizedSnapshot.observed_at,
      workers_subdomain: normalizedSnapshot.workers_subdomain,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-baseline-resolve') {
    const options = parseKeyValueOptions(process.argv);
    const resolvedBaseline = await resolveProductionBaselineInputArtifact({
      downloadRoot: path.resolve(process.cwd(), requireOption(options, 'download-root')),
      baselineInputKind: requireOption(options, 'baseline-input-kind'),
      baselineInputPath: requireOption(options, 'baseline-input-path'),
      baselineRecordName: requireOption(options, 'baseline-record-name'),
      normalizedOutputPath: typeof options['normalized-output'] === 'string'
        ? path.resolve(process.cwd(), options['normalized-output'])
        : null,
      originRunIdentity: {
        origin_repository: requireOption(options, 'origin-repository'),
        origin_run_id: requireOption(options, 'origin-run-id'),
        origin_run_attempt: Number.parseInt(requireOption(options, 'origin-run-attempt'), 10),
        origin_run_uri: requireOption(options, 'origin-run-uri'),
      },
    });
    const outputPath = typeof options.output === 'string'
      ? path.resolve(process.cwd(), options.output)
      : null;
    if (outputPath != null) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(resolvedBaseline, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      output_path: typeof options.output === 'string' ? options.output : null,
      ...resolvedBaseline,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-current-state-failure-validate') {
    const options = parseKeyValueOptions(process.argv);
    const validation = await validateProductionCurrentStateFailureArtifacts({
      currentStateSnapshotPath: path.resolve(process.cwd(), requireOption(options, 'current-state-snapshot')),
    });
    if (!validation.valid) {
      throw new Error(`Production current-state failure artifacts are invalid: ${validation.error}`);
    }
    process.stdout.write(`${JSON.stringify({
      current_state_snapshot: requireOption(options, 'current-state-snapshot'),
      status: 'valid',
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-raw-state-stage') {
    const options = parseKeyValueOptions(process.argv);
    const result = await stageProductionRawStateArtifactForUpload({
      stateRoot: path.resolve(process.cwd(), requireOption(options, 'state-root')),
      downloadRoot: path.resolve(process.cwd(), requireOption(options, 'download-root')),
      artifactRoot: path.resolve(process.cwd(), requireOption(options, 'artifact-root')),
      outputRoot: path.resolve(process.cwd(), requireOption(options, 'output-root')),
    });
    process.stdout.write(`${JSON.stringify({
      output_root: path.relative(process.cwd(), result.output_root),
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-operational-refresh') {
    const options = parseKeyValueOptions(process.argv);
    const baselineRecordPath = typeof options['baseline-record'] === 'string'
      ? path.resolve(process.cwd(), options['baseline-record'])
      : null;
    const baselineCurrentStatePath = typeof options['baseline-current-state'] === 'string'
      ? path.resolve(process.cwd(), options['baseline-current-state'])
      : null;
    if (baselineRecordPath == null && baselineCurrentStatePath == null) {
      throw new Error('prod-operational-refresh requires --baseline-record or --baseline-current-state');
    }
    if (baselineRecordPath != null && baselineCurrentStatePath != null) {
      throw new Error('prod-operational-refresh accepts only one of --baseline-record or --baseline-current-state');
    }
    const result = await operationalRefreshProductionEnvironment({
      repoRoot: process.cwd(),
      baselineRecord: baselineRecordPath == null ? null : await readJsonFile(baselineRecordPath),
      baselineCurrentState: baselineCurrentStatePath == null ? null : await readJsonFile(baselineCurrentStatePath),
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : path.resolve(process.cwd(), '.tmp', 'prod', 'operational-refresh'),
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      promotionId: typeof options['promotion-id'] === 'string' ? options['promotion-id'] : null,
      deploymentId: typeof options['deployment-id'] === 'string' ? options['deployment-id'] : null,
      blockedByOpenQuestions: typeof options['blocked-by-open-questions'] === 'string'
        ? options['blocked-by-open-questions'].split(',').map((entry) => entry.trim()).filter(Boolean)
        : ['OQ-0002', 'OQ-0006'],
      reason: typeof options.reason === 'string'
        ? options.reason
        : 'Operational prod refresh to unblock Phase 08 cost closure',
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
      productionSecretSeed: typeof options['secret-seed'] === 'string' ? options['secret-seed'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      output_path: typeof options.output === 'string' ? options.output : null,
      promotion_id: result.record.promotion_id,
      promotion_mode: result.record.promotion_mode,
      promotion_authority: result.record.promotion_authority,
      current_deployment_identity: result.record.current_deployment_identity,
      gateway_rollout_steps: result.record.gateway_rollout_steps.length,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-rollback') {
    const options = parseKeyValueOptions(process.argv);
    const result = await rollbackProductionEnvironment({
      repoRoot: process.cwd(),
      promotionRecord: await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'promotion-record'))),
      workingRoot: typeof options['working-root'] === 'string'
        ? path.resolve(process.cwd(), options['working-root'])
        : path.resolve(process.cwd(), '.tmp', 'prod', 'rollback'),
      outputPath: typeof options.output === 'string' ? path.resolve(process.cwd(), options.output) : null,
      rollbackId: typeof options['rollback-id'] === 'string' ? options['rollback-id'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      output_path: typeof options.output === 'string' ? options.output : null,
      rollback_id: result.record.rollback_id,
      release_commit_sha: result.record.release_commit_sha,
      readiness_probe_ready: result.record.readiness_probe.ready,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-provenance') {
    const options = parseKeyValueOptions(process.argv);
    const deploymentSummary = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'deployment')));
    const artifactUpload = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'artifact-upload')));
    const githubArtifact = typeof options['github-artifact'] === 'string'
      ? await readJsonFile(path.resolve(process.cwd(), options['github-artifact']))
      : null;
    const result = await writeEnvironmentRunProvenance(path.resolve(process.cwd(), requireOption(options, 'output')), {
      environmentName: requireOption(options, 'environment'),
      githubRepository: requireOption(options, 'github-repository'),
      githubRunId: requireOption(options, 'github-run-id'),
      githubRunAttempt: requireOption(options, 'github-run-attempt'),
      deploymentSummary,
      artifactUpload,
      githubArtifact,
      reviewRecordUri: typeof options['review-record-uri'] === 'string' ? options['review-record-uri'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      provenance_path: path.relative(process.cwd(), result.output_path),
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-cost-snapshot') {
    const options = parseKeyValueOptions(process.argv);
    if (typeof options.from === 'string' || typeof options.to === 'string') {
      throw new Error('prod-cost-snapshot no longer accepts --from/--to; pass --billing-window');
    }
    const result = await captureProdCostSnapshot({
      runTimestamp: requireOption(options, 'timestamp'),
      outputPath: path.resolve(process.cwd(), requireOption(options, 'output')),
      artifactRoot: path.resolve(process.cwd(), requireOption(options, 'artifact-root')),
      billingWindow: await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'billing-window'))),
      prodInstallRecord: await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'install-record'))),
      capturedBy: typeof options['captured-by'] === 'string' ? options['captured-by'] : null,
      reviewedBy: typeof options['reviewed-by'] === 'string' ? options['reviewed-by'] : null,
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      output_path: path.relative(process.cwd(), result.output_path),
      deployment_identity_path: path.relative(process.cwd(), result.deployment_identity_path),
      billing_usage_path: path.relative(process.cwd(), result.billing_usage_path),
      resource_snapshot_path: path.relative(process.cwd(), result.resource_snapshot_path),
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-cost-billing-window') {
    const options = parseKeyValueOptions(process.argv);
    const result = await resolveClosedProdBillingWindow({
      artifactRoot: typeof options['artifact-root'] === 'string' ? path.resolve(process.cwd(), options['artifact-root']) : null,
      outputPath: path.resolve(process.cwd(), requireOption(options, 'output')),
      profileOutputPath: path.resolve(process.cwd(), requireOption(options, 'profile-output')),
      accountId: typeof options['account-id'] === 'string' ? options['account-id'] : null,
      apiToken: typeof options['api-token'] === 'string' ? options['api-token'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      output_path: path.relative(process.cwd(), result.output_path),
      profile_path: path.relative(process.cwd(), result.profile_path),
      from_date: result.from_date,
      to_date: result.to_date,
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-cost-provenance') {
    const options = parseKeyValueOptions(process.argv);
    const deploymentIdentity = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'deployment-identity')));
    const artifactUpload = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'artifact-upload')));
    const githubArtifact = typeof options['github-artifact'] === 'string'
      ? await readJsonFile(path.resolve(process.cwd(), options['github-artifact']))
      : null;
    const result = await writeProdCostSnapshotProvenance(path.resolve(process.cwd(), requireOption(options, 'output')), {
      deploymentIdentity,
      artifactUpload,
      githubArtifact,
      reviewRecordUri: typeof options['review-record-uri'] === 'string' ? options['review-record-uri'] : null,
    });
    process.stdout.write(`${JSON.stringify({
      provenance_path: path.relative(process.cwd(), result.output_path),
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'nonlocal-attest') {
    const options = parseKeyValueOptions(process.argv);
    const provenance = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'provenance')));
    const result = await writeEnvironmentRunAttestation(requireOption(options, 'environment'), {
      runTimestamp: requireOption(options, 'timestamp'),
      reportPath: path.resolve(process.cwd(), requireOption(options, 'report')),
      outputPath: path.resolve(process.cwd(), requireOption(options, 'output')),
      provenance,
    });
    process.stdout.write(`${JSON.stringify({
      attestation_path: path.relative(process.cwd(), result.attestation_path),
    }, null, 2)}\n`);
    return;
  }
  if (requestedEnvironment === 'prod-cost-attest') {
    const options = parseKeyValueOptions(process.argv);
    const provenance = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'provenance')));
    const result = await writeProdCostSnapshotAttestation({
      runTimestamp: requireOption(options, 'timestamp'),
      payloadPath: path.resolve(process.cwd(), requireOption(options, 'payload')),
      outputPath: path.resolve(process.cwd(), requireOption(options, 'output')),
      provenance,
    });
    process.stdout.write(`${JSON.stringify({
      attestation_path: path.relative(process.cwd(), result.attestation_path),
    }, null, 2)}\n`);
    return;
  }
  const environments = requestedEnvironment === 'all'
    ? listTestEnvironmentNames()
    : [resolveTestEnvironmentName(requestedEnvironment)];

  let exitCode = 0;
  for (const environmentName of environments) {
    const code = await runEnvironment(environmentName, {
      allowMissingRemoteHarness: requestedEnvironment === 'all' && environmentName !== 'local',
    });
    if (code !== 0) {
      exitCode = code;
      break;
    }
  }

  process.exitCode = exitCode;
}

await main();
