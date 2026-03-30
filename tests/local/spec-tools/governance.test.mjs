import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeRepository, writeGovernanceEvidence } from '../../../packages/spec-tools/src/governance.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

async function makeTempRepo() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-governance-'));
  await fs.cp(repoRoot, tempRoot, { recursive: true });
  return tempRoot;
}

async function replaceInFile(repoDir, relativePath, searchValue, replaceValue) {
  const absolutePath = path.join(repoDir, relativePath);
  const current = await fs.readFile(absolutePath, 'utf8');
  assert.notEqual(current.includes(searchValue), false, `expected ${relativePath} to contain ${searchValue}`);
  await fs.writeFile(absolutePath, current.replace(searchValue, replaceValue));
}

test('governance analysis succeeds on current repository', async () => {
  const analysis = await analyzeRepository(repoRoot);
  assert.equal(analysis.valid, true, analysis.issues.map((issue) => issue.message).join('\n'));
  assert.ok(analysis.requirementRegister.length > 0);
  assert.ok(analysis.traceabilityMatrix.length > 0);
  assert.ok(analysis.wildcardRouteExpansion.length > 0);
});

test('requirement register contains canonical governance and architecture rows', async () => {
  const analysis = await analyzeRepository(repoRoot);
  const reqIds = new Set(analysis.requirementRegister.map((row) => row.req_id));
  assert.ok(reqIds.has('REQ-GOV-001'));
  assert.ok(reqIds.has('REQ-ARCH-001'));
  assert.ok(reqIds.has('REQ-SEC-001'));
  assert.ok(reqIds.has('REQ-OPS-010'));
});

test('wildcard expansion resolves pinned Matrix v1.17 route families', async () => {
  const analysis = await analyzeRepository(repoRoot);
  const loginFamily = analysis.wildcardRouteExpansion.find(
    (entry) => entry.if_id === 'IF-CS-005' && entry.route_pattern === '/_matrix/client/*/login',
  );
  assert.ok(loginFamily);
  assert.deepEqual(loginFamily.expanded_paths, ['/_matrix/client/v3/login']);

  const publicRoomsFamily = analysis.wildcardRouteExpansion.find(
    (entry) => entry.if_id === 'IF-CS-052' && entry.route_pattern === '/_matrix/client/*/publicRooms',
  );
  assert.ok(publicRoomsFamily);
  assert.ok(publicRoomsFamily.expanded_paths.includes('/_matrix/client/v3/publicRooms'));
});

test('wildcard expansion preserves canonical trailing-slash routes and excludes example pollution', async () => {
  const analysis = await analyzeRepository(repoRoot);
  const pushRulesRoot = analysis.wildcardRouteExpansion.find(
    (entry) => entry.if_id === 'IF-CS-018' && entry.route_pattern === '/_matrix/client/*/pushrules/',
  );
  assert.ok(pushRulesRoot);
  assert.deepEqual(pushRulesRoot.expanded_paths, ['/_matrix/client/v3/pushrules/']);
  assert.equal(
    pushRulesRoot.expanded_paths.some((routePath) => routePath.includes('/global/override/')),
    false,
  );
});

test('wildcard expansion rejects route families that place "*" outside the Matrix version segment', async () => {
  const tempRoot = await makeTempRepo();
  await replaceInFile(
    tempRoot,
    'spec/framework/23-interface-contract-catalog.md',
    '`GET /_matrix/client/*/login`',
    '`GET /_matrix/client/v3/*/login`',
  );

  const analysis = await analyzeRepository(tempRoot);
  assert.equal(analysis.valid, false);
  assert.ok(
    analysis.issues.some(
      (issue) =>
        issue.code === 'wildcard_route_invalid_pattern' &&
        issue.message.includes('/_matrix/client/v3/*/login'),
    ),
  );
});

test('missing REQ sidecar entry fails governance analysis', async () => {
  const tempRoot = await makeTempRepo();
  const sidecarPath = path.join(tempRoot, 'spec/framework/14-requirement-traceability-sidecar.json');
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  delete sidecar.requirements['REQ-GOV-001'];
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');

  const analysis = await analyzeRepository(tempRoot);
  assert.equal(analysis.valid, false);
  assert.ok(
    analysis.issues.some(
      (issue) =>
        issue.code === 'missing_requirement_traceability_entry' &&
        issue.message.includes('REQ-GOV-001'),
    ),
  );
});

test('duplicate DEC/OQ heading IDs fail governance analysis', async () => {
  const tempRoot = await makeTempRepo();
  await replaceInFile(
    tempRoot,
    'spec/open-questions/OQ-0002.md',
    '# OQ-0002',
    '# OQ-0001',
  );

  const analysis = await analyzeRepository(tempRoot);
  assert.equal(analysis.valid, false);
  assert.ok(
    analysis.issues.some(
      (issue) =>
        issue.code === 'duplicate_definition' &&
        issue.message.includes('OQ-0001 is defined multiple times'),
    ),
  );
});

test('ID range and suffix shorthand forms fail governance analysis', async () => {
  const tempRoot = await makeTempRepo();
  await replaceInFile(
    tempRoot,
    'spec/decisions/DEC-0001.md',
    'affected IDs: `OQ-0001`,`MX-CS-003`,`MX-CS-005`,`MX-CS-012`,`MX-CS-016`,`MX-CS-018`,`MX-CS-021`,`MX-CS-022`,`MX-CS-023`,`MX-CS-025`,`MX-CS-027`,`MX-CS-028`,`MX-CS-029`,`IF-CS-007`,`IF-CS-053`,`IF-CS-054`,`IF-CS-055`,`IF-CS-056`,`IF-CS-057`,`IF-CS-058`,`IF-CS-059`,`IF-CS-060`,`IF-CS-062`,`IF-CS-063`,`IF-CS-064`,`IF-CS-065`,`TEST-CS-004`,`TEST-GOV-001`,`EVID-CS-004`',
    'affected IDs: `REQ-ARCH-001, -002`',
  );

  const analysis = await analyzeRepository(tempRoot);
  assert.equal(analysis.valid, false);
  assert.ok(
    analysis.issues.some(
      (issue) =>
        issue.code === 'invalid_id_list' &&
        issue.message.includes('unsupported ID range or shorthand'),
    ),
  );
});

test('governance evidence writer emits required EVID-GOV-001 artifacts', async () => {
  const tempRoot = await makeTempRepo();

  const result = await writeGovernanceEvidence(tempRoot, { timestamp: '20260327T000000Z' });
  assert.equal(result.analysis.valid, true, result.analysis.issues.map((issue) => issue.message).join('\n'));

  const evidenceRoot = path.join(tempRoot, 'evidence/common/EVID-GOV-001/20260327T000000Z');
  const expectedFiles = [
    'summary.md',
    'artifacts/requirement-register.csv',
    'artifacts/requirement-register.json',
    'artifacts/traceability-matrix.csv',
    'artifacts/traceability-matrix.json',
    'artifacts/expanded-source-ids.json',
    'artifacts/wildcard-route-expansion.csv',
    'artifacts/wildcard-route-expansion.json',
  ];

  for (const relativePath of expectedFiles) {
    await fs.access(path.join(evidenceRoot, relativePath));
  }

  const summary = await fs.readFile(path.join(evidenceRoot, 'summary.md'), 'utf8');
  assert.match(summary, /## Context/);
  assert.match(summary, /code_version\.git_commit:/);
  assert.match(summary, /data_version\.analysis_sha256:/);
  assert.match(summary, /## Expanded Source IDs/);
  assert.match(summary, /`REQ-ARCH-001`/);
});

test('governance evidence writer still emits fail evidence when pinned Matrix snapshots are unavailable', async () => {
  const tempRoot = await makeTempRepo();
  await fs.unlink(path.join(tempRoot, 'research/sources/matrix-v1.17-client-server-api.html'));

  const result = await writeGovernanceEvidence(tempRoot, { timestamp: '20260327T010000Z' });
  assert.equal(result.analysis.valid, false);
  assert.ok(
    result.analysis.issues.some((issue) => issue.code === 'matrix_route_catalog_unavailable'),
  );

  const evidenceRoot = path.join(tempRoot, 'evidence/common/EVID-GOV-001/20260327T010000Z');
  await fs.access(path.join(evidenceRoot, 'summary.md'));
  await fs.access(path.join(evidenceRoot, 'artifacts/requirement-register.json'));
  await fs.access(path.join(evidenceRoot, 'artifacts/traceability-matrix.json'));
  await fs.access(path.join(evidenceRoot, 'artifacts/expanded-source-ids.json'));
  await fs.access(path.join(evidenceRoot, 'artifacts/wildcard-route-expansion.json'));

  const summary = await fs.readFile(path.join(evidenceRoot, 'summary.md'), 'utf8');
  assert.match(summary, /- status: fail/);
  assert.match(summary, /matrix_route_catalog_unavailable/);
});
