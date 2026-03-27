import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJsonBytes,
  canonicalizeJsonText,
  canonicalizeJsonValue,
  createCanonicalFilterHash,
  createRequestFingerprint,
  parseJsonTextWithDuplicateKeyCheck,
  stableCanonicalPreview,
} from '../../../packages/runtime-core/src/index.mjs';

test('canonical JSON sorts object keys according to JCS', () => {
  assert.equal(
    canonicalizeJsonValue({ z: 1, a: true, nested: { b: 2, a: 1 } }),
    '{"a":true,"nested":{"a":1,"b":2},"z":1}',
  );
});

test('canonical JSON text parsing rejects duplicate keys', () => {
  assert.throws(
    () => parseJsonTextWithDuplicateKeyCheck('{"a":1,"a":2}'),
    /Duplicate key "a"/,
  );
});

test('canonical filter hash is stable across equivalent key orderings', () => {
  const fromObject = createCanonicalFilterHash({
    room: {
      timeline: { limit: 20 },
      include_leave: false,
    },
  });
  const fromText = createCanonicalFilterHash(
    '{"room":{"include_leave":false,"timeline":{"limit":20}}}',
  );

  assert.equal(fromObject, fromText);
});

test('request fingerprint normalizes semantic request shape', () => {
  const fingerprintA = createRequestFingerprint({
    method: 'post',
    routeTemplate: '/_ops/v1/rebuilds',
    principalId: 'operator:alice',
    semanticQuery: { scope: 'global' },
    body: {
      target_scope: { scope_kind: 'global', scope_id: null },
      rebuild_target: 'search_index',
    },
  });

  const fingerprintB = createRequestFingerprint({
    method: 'POST',
    routeTemplate: '/_ops/v1/rebuilds',
    principalId: 'operator:alice',
    semanticQuery: { scope: 'global' },
    body: {
      rebuild_target: 'search_index',
      target_scope: { scope_id: null, scope_kind: 'global' },
    },
  });

  const fingerprintC = createRequestFingerprint({
    method: 'POST',
    routeTemplate: '/_ops/v1/rebuilds',
    principalId: 'operator:alice',
    semanticQuery: { scope: 'room' },
    body: {
      rebuild_target: 'search_index',
      target_scope: { scope_id: null, scope_kind: 'global' },
    },
  });

  assert.equal(fingerprintA, fingerprintB);
  assert.notEqual(fingerprintA, fingerprintC);
});

test('request fingerprint canonicalizes JSON byte payloads the same as JSON text', () => {
  const asBytes = new TextEncoder().encode('{"b":2,"a":1}');
  const fromBytes = createRequestFingerprint({
    method: 'POST',
    routeTemplate: '/_ops/v1/rebuilds',
    principalId: 'operator:alice',
    body: asBytes,
    contentType: 'application/json',
  });
  const fromText = createRequestFingerprint({
    method: 'POST',
    routeTemplate: '/_ops/v1/rebuilds',
    principalId: 'operator:alice',
    body: '{"a":1,"b":2}',
    contentType: 'application/json',
  });

  assert.equal(fromBytes, fromText);
});

test('request fingerprint rejects invalid UTF-8 JSON byte payloads', () => {
  const invalidUtf8JsonBytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);

  assert.throws(
    () =>
      createRequestFingerprint({
        method: 'POST',
        routeTemplate: '/_ops/v1/rebuilds',
        principalId: 'operator:alice',
        body: invalidUtf8JsonBytes,
        contentType: 'application/json',
      }),
    /valid UTF-8/,
  );
});

test('canonical JSON text and value previews align', () => {
  const canonical = canonicalizeJsonText('{"beta":2,"alpha":[3,2,1]}');
  assert.equal(canonical, stableCanonicalPreview({ alpha: [3, 2, 1], beta: 2 }));
});

test('canonical JSON rejects sparse arrays because they are not valid JSON values', () => {
  assert.throws(() => canonicalizeJsonValue([, 1]), /Sparse arrays are not allowed/);
  assert.throws(() => canonicalJsonBytes([, 1]), /Sparse arrays are not allowed/);
});
