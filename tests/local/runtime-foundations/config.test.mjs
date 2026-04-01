import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listFeatureGateIds,
  loadWorkerRuntimeConfig,
  resolveWorkerResourceBindingNames,
} from '../../../packages/runtime-core/src/index.mjs';

function makeGatewayEnv(overrides = {}) {
  return {
    ENVIRONMENT_NAME: 'local',
    MATRIX_SERVER_NAME: 'matrix.example.test',
    RELEASE_PROFILE: 'L1',
    WORKER_VERSION_ID: 'build-123',
    DEPLOYMENT_ID: 'deployment-456',
    LOG_LEVEL: 'debug',
    CPU_LIMIT_CLASS: 'default',
    MATRIX_PUBLIC_BASE_URL: 'https://matrix.example.test',
    MANAGEMENT_API_BASE_URL: 'https://ops.example.test',
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '1048576',
    HOMESERVER_SIGNING_KEY_RING: 'hs-key-ring-v1',
    SESSION_ROOT_KEY_RING: 'session-key-ring-v1',
    UIA_ROOT_KEY_RING: 'uia-key-ring-v1',
    APPSERVICE_TOKEN_SET: 'appservice-token-set-v1',
    FF_FEDERATION: 'false',
    FF_MEDIA_REMOTE_FETCH: 'false',
    FF_APPSERVICE_API: 'false',
    FF_OTEL_EXPORT: 'false',
    FF_OTEL_PERSIST: 'true',
    FF_SSO_LOGIN: 'false',
    FF_LOGIN_TOKEN: 'false',
    FF_THREEPID_CHANGES: 'false',
    FF_URL_PREVIEW: 'false',
    FF_PUSH_GATEWAY: 'false',
    FF_REQUEST_TOKEN_BOOTSTRAP: 'false',
    FF_TURN_CREDENTIALS: 'false',
    ...overrides,
  };
}

test('gateway runtime config validates explicit vars, feature gates, and secrets', () => {
  const config = loadWorkerRuntimeConfig('gateway-worker', makeGatewayEnv());
  assert.equal(config.compatibilityDate, '2026-03-26');
  assert.equal(config.environmentName, 'local');
  assert.equal(config.releaseProfile, 'L1');
  assert.equal(config.text.MATRIX_MEDIA_MAX_UPLOAD_BYTES, 1048576);
  assert.equal(config.featureGates.otel_persist, true);
  assert.equal(config.featureGates.federation, false);
  assert.equal(config.secrets.require('session_root_key_ring'), 'session-key-ring-v1');
  assert.equal(config.secrets.require('uia_root_key_ring'), 'uia-key-ring-v1');
  assert.deepEqual(
    config.secrets.names().sort(),
    ['appservice_token_set', 'homeserver_signing_key_ring', 'session_root_key_ring', 'uia_root_key_ring'],
  );
});

test('worker config rejects missing required env bindings', () => {
  assert.throws(
    () => loadWorkerRuntimeConfig('gateway-worker', makeGatewayEnv({ MATRIX_PUBLIC_BASE_URL: '' })),
    /MATRIX_PUBLIC_BASE_URL/,
  );
});

test('worker config rejects malformed feature gate values', () => {
  assert.throws(
    () => loadWorkerRuntimeConfig('gateway-worker', makeGatewayEnv({ FF_FEDERATION: 'maybe' })),
    /FF_FEDERATION/,
  );
});

test('worker config rejects malformed integer vars instead of truncating them', () => {
  assert.throws(
    () =>
      loadWorkerRuntimeConfig('gateway-worker', makeGatewayEnv({ MATRIX_MEDIA_MAX_UPLOAD_BYTES: '123abc' })),
    /MATRIX_MEDIA_MAX_UPLOAD_BYTES/,
  );
});

test('ops worker enforces Access JWT binding configuration', () => {
  assert.throws(
    () =>
      loadWorkerRuntimeConfig('ops-worker', {
        ENVIRONMENT_NAME: 'staging',
        MATRIX_SERVER_NAME: 'matrix.example.test',
        RELEASE_PROFILE: 'L1',
        MANAGEMENT_API_BASE_URL: 'https://ops.example.test',
      }),
    /ACCESS_TEAM_DOMAIN/,
  );
});

test('feature gate catalog stays non-empty and centrally enumerated', () => {
  const ids = listFeatureGateIds();
  assert.ok(ids.includes('sso_login'));
  assert.ok(ids.includes('appservice_api'));
  assert.ok(ids.includes('otel_export'));
});

test('resource binding names reject malformed JSON instead of silently falling back', () => {
  assert.throws(
    () => resolveWorkerResourceBindingNames({ RESOURCE_BINDING_NAMES_JSON: '{' }),
    /RESOURCE_BINDING_NAMES_JSON must be valid JSON/,
  );
  assert.throws(
    () => resolveWorkerResourceBindingNames({ RESOURCE_BINDING_NAMES_JSON: '[]' }),
    /RESOURCE_BINDING_NAMES_JSON must decode to a JSON object/,
  );
});
