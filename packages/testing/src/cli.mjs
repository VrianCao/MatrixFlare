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

async function main() {
  const requestedEnvironment = process.argv[2] ?? 'local';
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
