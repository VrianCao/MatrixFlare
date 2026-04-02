#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  buildRunEnvironmentVariables,
  getTestEnvironmentDirectory,
  getRequiredTestFiles,
  listTestEnvironmentNames,
  resolveTestEnvironmentName,
} from './bootstrap.mjs';
import { writeL1Evidence } from './evidence.mjs';
import {
  buildNonLocalEnvironmentPlan,
  buildNonProductionSecretBundle,
  createEnvironmentWranglerConfig,
  deployNonLocalEnvironment,
  ensureNonLocalEnvironmentResources,
  prepareNonLocalOpsAccessSession,
  runEnvironmentBackedSuite,
  uploadImmutableArtifactToR2,
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

async function main() {
  const requestedEnvironment = process.argv[2] ?? 'local';
  if (requestedEnvironment === 'evidence-l1') {
    const { timestamp, manualArtifacts } = parseEvidenceL1Options(process.argv);
    const result = await writeL1Evidence(process.cwd(), {
      timestamp,
      manualArtifacts,
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
  if (requestedEnvironment === 'nonlocal-run') {
    const options = parseKeyValueOptions(process.argv);
    const deployment = await readJsonFile(path.resolve(process.cwd(), requireOption(options, 'deployment')));
    const accessSession = typeof options['access-session'] === 'string'
      ? await readJsonFile(path.resolve(process.cwd(), options['access-session']))
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
