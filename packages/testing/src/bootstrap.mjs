import fs from 'node:fs/promises';
import path from 'node:path';

export const TEST_ENVIRONMENTS = Object.freeze({
  local: Object.freeze({
    name: 'local',
    directory: 'tests/local',
  }),
  'ci-integration': Object.freeze({
    name: 'ci-integration',
    directory: 'tests/integration',
  }),
  staging: Object.freeze({
    name: 'staging',
    directory: 'tests/staging',
  }),
  'pre-release': Object.freeze({
    name: 'pre-release',
    directory: 'tests/pre-release',
  }),
});

const TEST_ENVIRONMENT_ALIASES = Object.freeze({
  integration: 'ci-integration',
  ci: 'ci-integration',
  prerelease: 'pre-release',
});

export function listTestEnvironmentNames() {
  return Object.keys(TEST_ENVIRONMENTS);
}

export function resolveTestEnvironmentName(input = process.env.MATRIX_TEST_ENVIRONMENT ?? 'local') {
  const normalized = TEST_ENVIRONMENT_ALIASES[input] ?? input;
  if (!TEST_ENVIRONMENTS[normalized]) {
    throw new RangeError(`Unknown test environment "${input}"`);
  }
  return normalized;
}

export function getTestEnvironmentDefinition(input) {
  return TEST_ENVIRONMENTS[resolveTestEnvironmentName(input)];
}

export function getTestEnvironmentDirectory(input, repoRoot = process.cwd()) {
  const environment = getTestEnvironmentDefinition(input);
  return path.join(repoRoot, environment.directory);
}

async function discoverTestFilesInDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nestedPaths = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return discoverTestFilesInDirectory(absolutePath);
    }
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      return [absolutePath];
    }
    return [];
  }));
  return nestedPaths.flat().sort();
}

export async function discoverTestFiles(input, repoRoot = process.cwd()) {
  const directory = getTestEnvironmentDirectory(input, repoRoot);
  try {
    return await discoverTestFilesInDirectory(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function getRequiredTestFiles(input, repoRoot = process.cwd()) {
  const files = await discoverTestFiles(input, repoRoot);
  if (files.length === 0) {
    const environment = getTestEnvironmentDefinition(input);
    throw new Error(`No ${environment.name} tests found in ${environment.directory}`);
  }
  return files;
}

export function isGenericEnvironmentSmokeTestFile(filePath) {
  const basename = path.basename(filePath);
  return basename === 'bootstrap.test.mjs' || basename === 'l1-mandatory.test.mjs';
}

export async function getReleaseGateTestFiles(input, repoRoot = process.cwd()) {
  const environment = getTestEnvironmentDefinition(input);
  const files = await getRequiredTestFiles(environment.name, repoRoot);
  if (environment.name === 'local') {
    return files;
  }
  const releaseGateFiles = files.filter((file) => !isGenericEnvironmentSmokeTestFile(file));
  if (releaseGateFiles.length === 0) {
    throw new Error(`No ${environment.name} release-gate tests found in ${environment.directory} after excluding generic bootstrap/smoke entrypoints`);
  }
  return releaseGateFiles;
}

export function skipUnlessEnvironment(testContext, expectedEnvironment) {
  const actualEnvironment = resolveTestEnvironmentName();
  const resolvedExpectedEnvironment = resolveTestEnvironmentName(expectedEnvironment);
  if (actualEnvironment !== resolvedExpectedEnvironment) {
    testContext.skip(`Expected ${resolvedExpectedEnvironment}, received ${actualEnvironment}`);
  }
}

export function buildRunEnvironmentVariables(baseEnv, environmentName, {
  allowMissingRemoteHarness = false,
} = {}) {
  return {
    ...baseEnv,
    MATRIX_TEST_ENVIRONMENT: resolveTestEnvironmentName(environmentName),
    MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP: allowMissingRemoteHarness === true ? 'true' : 'false',
  };
}
