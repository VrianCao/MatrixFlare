import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverTestFiles,
  getTestEnvironmentDefinition,
  getTestEnvironmentDirectory,
  getRequiredTestFiles,
  listTestEnvironmentNames,
  resolveTestEnvironmentName,
} from '../../../packages/testing/src/bootstrap.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

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
