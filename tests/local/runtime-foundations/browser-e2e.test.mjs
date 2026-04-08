import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BROWSER_JOURNEY_MATRIX,
  BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO,
  buildBrowserJourneyCoverageReport,
  validateBrowserJourneyCoverageReport,
} from '../../../packages/testing/src/browser-e2e.mjs';
import {
  buildElementWebConfig,
  startElementWebServer,
} from '../../../packages/testing/src/browser-harness.mjs';
import {
  getRequiredTestImplementationFiles,
  listL1EvidenceBundleIds,
} from '../../../packages/testing/src/evidence.mjs';

function buildPassingP0JourneyInputs() {
  return BROWSER_JOURNEY_MATRIX
    .filter((journey) => journey.required)
    .map((journey) => ({
      journey_id: journey.journey_id,
      status: 'pass',
      artifacts: [`browser-artifacts/${journey.journey_id.toLowerCase()}.zip`],
    }));
}

test('browser E2E journey matrix keeps all P0 journeys explicitly required', () => {
  assert.equal(BROWSER_JOURNEY_MATRIX.length, 15);
  const p0Journeys = BROWSER_JOURNEY_MATRIX.filter((journey) => journey.priority === 'P0');
  assert.equal(p0Journeys.length, 12);
  for (const journey of p0Journeys) {
    assert.equal(journey.required, true, `${journey.journey_id} must remain required`);
  }
  for (const journey of BROWSER_JOURNEY_MATRIX.filter((entry) => entry.priority === 'P1')) {
    assert.equal(journey.required, false, `${journey.journey_id} must remain optional for the 80% threshold`);
  }
});

test('browser journey coverage report passes when all P0 journeys pass and only P1 journeys fail', () => {
  const report = buildBrowserJourneyCoverageReport({
    journeys: buildPassingP0JourneyInputs(),
    playwright: {
      package_version: '1.59.1',
      browser_name: 'chromium',
      browser_version: '136.0.0.0',
      headless: true,
    },
  });
  assert.equal(report.coverage_summary.coverage_ratio, BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO);
  assert.equal(report.coverage_summary.required_pass_ratio, 1);
  const validation = validateBrowserJourneyCoverageReport(report, { expectedEnvironmentName: 'staging' });
  assert.deepEqual(validation, { valid: true, error: null });
});

test('browser journey coverage report fails closed when a required journey fails', () => {
  const report = buildBrowserJourneyCoverageReport({
    journeys: buildPassingP0JourneyInputs().filter((journey) => journey.journey_id !== 'E2E-JRY-015'),
    playwright: {
      package_version: '1.59.1',
      browser_name: 'chromium',
      browser_version: '136.0.0.0',
      headless: true,
    },
  });
  assert.equal(report.coverage_summary.coverage_ratio < BROWSER_JOURNEY_MINIMUM_COVERAGE_RATIO, true);
  const validation = validateBrowserJourneyCoverageReport(report, { expectedEnvironmentName: 'staging' });
  assert.equal(validation.valid, false);
  assert.match(validation.error ?? '', /minimum coverage threshold|required_pass_ratio must be 1/);
});

test('L1 evidence registry exposes TEST-E2E-001 and EVID-E2E-001 mappings', () => {
  assert.equal(listL1EvidenceBundleIds().includes('EVID-E2E-001'), true);
  assert.deepEqual(
    getRequiredTestImplementationFiles('TEST-E2E-001', 'local'),
    ['tests/local/runtime-foundations/browser-e2e.test.mjs'],
  );
  assert.deepEqual(
    getRequiredTestImplementationFiles('TEST-E2E-001', 'staging'),
    ['tests/staging/test-e2e-001.test.mjs'],
  );
});

test('browser harness serves config.json and SPA fallback for pinned Element hosting', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-browser-harness-'));
  const webRoot = path.join(tempRoot, 'web');
  await fs.mkdir(path.join(webRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Element Harness</title>\n', 'utf8');
  await fs.writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log("ok");\n', 'utf8');

  const config = buildElementWebConfig({
    homeserverBaseUrl: 'https://matrix.example.test',
    serverName: 'matrix.example.test',
    brand: 'Matrix Test Browser',
  });
  const server = await startElementWebServer({
    webRoot,
    config,
  });

  try {
    const configResponse = await fetch(`${server.base_url}/config.json`);
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), config);

    const assetResponse = await fetch(`${server.base_url}/assets/app.js`);
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), 'console.log("ok");\n');

    const spaResponse = await fetch(`${server.base_url}/#/login`);
    assert.equal(spaResponse.status, 200);
    assert.match(await spaResponse.text(), /Element Harness/);
  } finally {
    await server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
