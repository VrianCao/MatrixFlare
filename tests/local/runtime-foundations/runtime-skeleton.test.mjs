import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  BaseDurableObject,
  RemoteServerDO,
  RoomDO,
  UserDO,
  createWranglerConfigSnapshot,
  listWorkerNames,
} from '../../../packages/runtime-core/src/index.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

async function readWranglerConfig(relativePath) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), 'utf8'));
}

test('wrangler configs stay aligned with the runtime manifest', async () => {
  const workers = listWorkerNames();
  for (const workerName of workers) {
    const config = await readWranglerConfig(`apps/${workerName}/wrangler.jsonc`);
    assert.deepEqual(config, createWranglerConfigSnapshot(workerName));
  }
});

test('worker entries expose the runtime skeleton handlers and DO classes', async () => {
  const gatewayModule = await import('../../../apps/gateway-worker/src/index.mjs');
  const jobsModule = await import('../../../apps/jobs-worker/src/index.mjs');
  const opsModule = await import('../../../apps/ops-worker/src/index.mjs');

  assert.equal(typeof gatewayModule.default.fetch, 'function');
  assert.equal(typeof jobsModule.default.fetch, 'function');
  assert.equal(typeof jobsModule.default.queue, 'function');
  assert.equal(typeof opsModule.default.fetch, 'function');

  assert.equal(UserDO.authorityKind, 'user');
  assert.equal(RoomDO.authorityKind, 'room');
  assert.equal(RemoteServerDO.authorityKind, 'remote-server');

  assert.ok(new UserDO({ storage: { get: async () => null } }, {}).constructor.prototype instanceof BaseDurableObject);
});

test('durable object skeleton fetch paths return deterministic placeholders', async () => {
  const env = {
    ENVIRONMENT_NAME: 'local',
    MATRIX_SERVER_NAME: 'matrix.example.test',
    RELEASE_PROFILE: 'L1',
    MATRIX_PUBLIC_BASE_URL: 'https://matrix.example.test',
    MANAGEMENT_API_BASE_URL: 'https://ops.example.test',
    ACCESS_TEAM_DOMAIN: 'matrix.cloudflareaccess.com',
    ACCESS_AUDIENCE: 'aud',
    HOMESERVER_SIGNING_KEY_RING: 'hs',
    SESSION_ROOT_KEY_RING: 'session',
    UIA_ROOT_KEY_RING: 'uia',
    APPSERVICE_TOKEN_SET: 'appservices',
  };

  const storage = { get: async () => null };
  const roomDo = new RoomDO({ storage }, env);
  const response = await roomDo.fetch(new Request('https://matrix.example.test/room'));
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.authority_kind, 'room');
});
