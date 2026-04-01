#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
  getTestEnvironmentDirectory,
  getRequiredTestFiles,
  listTestEnvironmentNames,
  resolveTestEnvironmentName,
} from './bootstrap.mjs';
import { writeL1Evidence } from './evidence.mjs';

const EVIDENCE_L1_MANUAL_ARTIFACT_FLAGS = Object.freeze({
  '--ci-integration-attestation': 'ci_integration_run_report',
  '--staging-attestation': 'staging_run_report',
  '--pre-release-attestation': 'pre_release_run_report',
  '--prod-cost-attestation': 'prod_cost_snapshot',
});

async function runEnvironment(environmentName) {
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
      env: {
        ...process.env,
        MATRIX_TEST_ENVIRONMENT: environmentName,
      },
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
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
  const environments = requestedEnvironment === 'all'
    ? listTestEnvironmentNames()
    : [resolveTestEnvironmentName(requestedEnvironment)];

  let exitCode = 0;
  for (const environmentName of environments) {
    const code = await runEnvironment(environmentName);
    if (code !== 0) {
      exitCode = code;
      break;
    }
  }

  process.exitCode = exitCode;
}

await main();
