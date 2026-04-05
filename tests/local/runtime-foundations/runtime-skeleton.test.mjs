import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  BaseDurableObject,
  RemoteServerDO,
  RoomDO,
  UserDO,
  createWranglerConfigSnapshot,
  listWorkerNames,
} from '../../../packages/runtime-core/src/index.mjs';
import { createFakeSqlStorage } from './support.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const execFileAsync = promisify(execFile);
const TEST_ENV = {
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

test('BaseDurableObject binds to the Workers DurableObject base when the runtime provides it', async () => {
  const moduleHref = new URL('../../../packages/runtime-core/src/durable-objects.mjs', import.meta.url).href;
  const script = `
    globalThis.DurableObject = class DurableObject {
      constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
      }
    };
    const { BaseDurableObject, UserDO } = await import(${JSON.stringify(moduleHref)});
    if (Object.getPrototypeOf(BaseDurableObject) !== globalThis.DurableObject) {
      throw new Error('BaseDurableObject did not extend globalThis.DurableObject');
    }
    const ctx = { storage: { get: async () => null } };
    const env = { marker: 'runtime-env' };
    const instance = new UserDO(ctx, env);
    if (!(instance instanceof globalThis.DurableObject)) {
      throw new Error('UserDO did not inherit the runtime DurableObject base');
    }
    if (instance.ctx !== ctx || instance.env !== env) {
      throw new Error('UserDO did not preserve ctx/env when inheriting the runtime DurableObject base');
    }
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoRoot,
  });
});

test('UserDO persistence uses ctx.storage.transactionSync instead of raw BEGIN/COMMIT under the runtime contract', async () => {
  const storage = createFakeSqlStorage();
  const originalExec = storage.sql.exec.bind(storage.sql);
  const forbiddenStatements = [];
  storage.sql.exec = (query, ...bindings) => {
    const normalized = String(query).trim().toUpperCase();
    if (
      normalized.startsWith('BEGIN')
      || normalized.startsWith('COMMIT')
      || normalized.startsWith('ROLLBACK')
      || normalized.startsWith('SAVEPOINT')
    ) {
      forbiddenStatements.push(String(query));
      throw new Error(`raw SQLite transaction statement is forbidden: ${query}`);
    }
    return originalExec(query, ...bindings);
  };
  let transactionSyncCalls = 0;
  storage.transactionSync = (callback) => {
    transactionSyncCalls += 1;
    return callback();
  };

  const userDo = new UserDO({ storage }, TEST_ENV);
  await userDo.ensureSchema();
  const runtimeState = userDo.persistence.setRuntimeIdentity({
    user_id: '@alice:matrix.example.test',
    updated_at: '2026-04-01T00:00:00.000Z',
  });

  assert.equal(runtimeState.user_id, '@alice:matrix.example.test');
  assert.equal(transactionSyncCalls, 1);
  assert.deepEqual(forbiddenStatements, []);
});

test('durable object skeleton fetch paths return deterministic placeholders', async () => {
  const storage = { get: async () => null };
  const roomDo = new RoomDO({ storage }, TEST_ENV);
  const response = await roomDo.fetch(new Request('https://matrix.example.test/room'));
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.authority_kind, 'room');
});
