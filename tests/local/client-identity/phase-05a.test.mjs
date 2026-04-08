import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayPhase04Rig } from './support.mjs';
import { issueSyncToken } from '../../../packages/runtime-core/src/client-domain.mjs';

async function expectMatrixError(response, status, errcode) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.errcode, errcode);
  return body;
}

function assertOpaqueUiaSessionToken(sessionToken) {
  assert.equal(typeof sessionToken, 'string');
  const parts = sessionToken.split('.');
  assert.equal(parts[0], 'uia');
  assert.equal(parts.length, 5);
}

async function registerUser(rig, {
  username,
  password,
  deviceId,
}) {
  const challenge = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(challenge.status, 401);
  const challengeBody = await challenge.json();
  const response = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
      auth: {
        type: 'm.login.dummy',
        session: challengeBody.session,
      },
    },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function loginWithPassword(rig, {
  user,
  password,
  deviceId = null,
}) {
  return rig.gatewayFetch('/_matrix/client/v3/login', {
    method: 'POST',
    json: {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user,
      },
      password,
      ...(deviceId ? { device_id: deviceId } : {}),
    },
  });
}

async function syncRequest(rig, accessToken, query = '') {
  const suffix = query ? `?${query}` : '';
  const response = await rig.gatewayFetch(`/_matrix/client/v3/sync${suffix}`, {
    headers: rig.authHeaders(accessToken),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function requestAs(rig, accessToken, pathname, {
  method = 'GET',
  json = undefined,
} = {}) {
  return rig.gatewayFetch(pathname, {
    method,
    headers: rig.authHeaders(accessToken),
    json,
  });
}

async function enableMegolmRoom(rig, accessToken, roomId) {
  const response = await requestAs(
    rig,
    accessToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`,
    {
      method: 'PUT',
      json: {
        algorithm: 'm.megolm.v1.aes-sha2',
      },
    },
  );
  assert.equal(response.status, 200);
}

test('Phase 05A device management requires route-bound UIA and revokes deleted device sessions', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const secondLogin = await loginWithPassword(rig, {
    user: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICELAPTOP',
  });
  assert.equal(secondLogin.status, 200);
  const laptopSession = await secondLogin.json();

  const devicesResponse = await rig.gatewayFetch('/_matrix/client/v3/devices', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(devicesResponse.status, 200);
  const devicesBody = await devicesResponse.json();
  assert.deepEqual(devicesBody.devices.map((entry) => entry.device_id).sort(), ['ALICELAPTOP', 'ALICEPHONE']);

  const updateDevice = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      display_name: 'Alice Laptop',
    },
  });
  assert.equal(updateDevice.status, 200);

  const readDevice = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(readDevice.status, 200);
  const readDeviceBody = await readDevice.json();
  assert.deepEqual({
    device_id: readDeviceBody.device_id,
    display_name: readDeviceBody.display_name,
  }, {
    device_id: 'ALICELAPTOP',
    display_name: 'Alice Laptop',
  });
  assert.equal(typeof readDeviceBody.last_seen_ts, 'number');
  assert.equal(Number.isFinite(readDeviceBody.last_seen_ts), true);

  const baselineSync = await syncRequest(rig, alice.access_token);

  const deleteChallenge = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    method: 'DELETE',
    headers: rig.authHeaders(laptopSession.access_token),
    json: {},
  });
  assert.equal(deleteChallenge.status, 401);
  const deleteChallengeBody = await deleteChallenge.json();
  assert.deepEqual(deleteChallengeBody.flows, [{ stages: ['m.login.password'] }]);
  assertOpaqueUiaSessionToken(deleteChallengeBody.session);

  const deleteDevice = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    method: 'DELETE',
    headers: rig.authHeaders(laptopSession.access_token),
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  assert.equal(deleteDevice.status, 200);
  assert.deepEqual(await deleteDevice.json(), {});

  const deleteReplayWithValidToken = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    method: 'DELETE',
    headers: rig.authHeaders(alice.access_token),
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  assert.equal(deleteReplayWithValidToken.status, 200);
  assert.deepEqual(await deleteReplayWithValidToken.json(), {});

  const deleteReplayWithoutToken = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    method: 'DELETE',
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(deleteReplayWithoutToken, 401, 'M_MISSING_TOKEN');

  const deleteReplayWithRevokedToken = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    method: 'DELETE',
    headers: rig.authHeaders(laptopSession.access_token),
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(deleteReplayWithRevokedToken, 401, 'M_UNKNOWN_TOKEN');

  const deleteChangedReplayWithRevokedToken = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICEPHONE', {
    method: 'DELETE',
    headers: rig.authHeaders(laptopSession.access_token),
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(deleteChangedReplayWithRevokedToken, 401, 'M_UNKNOWN_TOKEN');

  const deletedDevice = await rig.gatewayFetch('/_matrix/client/v3/devices/ALICELAPTOP', {
    headers: rig.authHeaders(alice.access_token),
  });
  await expectMatrixError(deletedDevice, 404, 'M_NOT_FOUND');

  const laptopWhoAmI = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(laptopSession.access_token),
  });
  await expectMatrixError(laptopWhoAmI, 401, 'M_UNKNOWN_TOKEN');

  const afterDeleteSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(baselineSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(afterDeleteSync.device_lists.changed, ['@alice:matrix.example.test']);

  const thirdLogin = await loginWithPassword(rig, {
    user: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICETABLET',
  });
  assert.equal(thirdLogin.status, 200);
  const tabletSession = await thirdLogin.json();

  const bulkDeleteChallenge = await rig.gatewayFetch('/_matrix/client/v3/delete_devices', {
    method: 'POST',
    headers: rig.authHeaders(tabletSession.access_token),
    json: {
      devices: ['ALICEPHONE'],
    },
  });
  assert.equal(bulkDeleteChallenge.status, 401);
  const bulkDeleteChallengeBody = await bulkDeleteChallenge.json();
  assertOpaqueUiaSessionToken(bulkDeleteChallengeBody.session);

  const bulkDelete = await rig.gatewayFetch('/_matrix/client/v3/delete_devices', {
    method: 'POST',
    headers: rig.authHeaders(tabletSession.access_token),
    json: {
      devices: ['ALICEPHONE'],
      auth: {
        type: 'm.login.password',
        session: bulkDeleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  assert.equal(bulkDelete.status, 200);

  const bulkConflict = await rig.gatewayFetch('/_matrix/client/v3/delete_devices', {
    method: 'POST',
    headers: rig.authHeaders(tabletSession.access_token),
    json: {
      devices: ['ALICEPHONE', 'MISSINGDEVICE'],
      auth: {
        type: 'm.login.password',
        session: bulkDeleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(bulkConflict, 409, 'M_CONFLICT');

  const phoneWhoAmI = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(alice.access_token),
  });
  await expectMatrixError(phoneWhoAmI, 401, 'M_UNKNOWN_TOKEN');

  const bulkReplayWithRevokedToken = await rig.gatewayFetch('/_matrix/client/v3/delete_devices', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      devices: ['ALICEPHONE'],
      auth: {
        type: 'm.login.password',
        session: bulkDeleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(bulkReplayWithRevokedToken, 401, 'M_UNKNOWN_TOKEN');

  const bulkChangedReplayWithRevokedToken = await rig.gatewayFetch('/_matrix/client/v3/delete_devices', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      devices: ['ALICEPHONE', 'MISSINGDEVICE'],
      auth: {
        type: 'm.login.password',
        session: bulkDeleteChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(bulkChangedReplayWithRevokedToken, 401, 'M_UNKNOWN_TOKEN');
});

test('Phase 05A keys, cross-signing, signatures, and claim flows update sync truth honestly', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const bob = await registerUser(rig, {
    username: 'bob',
    password: 'secret bob password',
    deviceId: 'BOBPHONE',
  });

  const aliceInitialSync = await syncRequest(rig, alice.access_token);
  const uploadAliceDeviceKeysOnly = await rig.gatewayFetch('/_matrix/client/v3/keys/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        user_id: alice.user_id,
        device_id: 'ALICEPHONE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:ALICEPHONE': 'alice-curve',
          'ed25519:ALICEPHONE': 'alice-ed',
        },
        signatures: {},
      },
    },
  });
  assert.equal(uploadAliceDeviceKeysOnly.status, 200);
  assert.deepEqual(await uploadAliceDeviceKeysOnly.json(), {
    one_time_key_counts: {},
  });

  const uploadAliceKeys = await rig.gatewayFetch('/_matrix/client/v3/keys/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        user_id: alice.user_id,
        device_id: 'ALICEPHONE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:ALICEPHONE': 'alice-curve',
          'ed25519:ALICEPHONE': 'alice-ed',
        },
        signatures: {},
      },
      one_time_keys: {
        'signed_curve25519:alice-otk-1': {
          key: 'alice-otk-1',
        },
      },
      fallback_keys: {
        'signed_curve25519:alice-fallback-1': {
          key: 'alice-fallback-1',
        },
      },
    },
  });
  assert.equal(uploadAliceKeys.status, 200);
  assert.deepEqual(await uploadAliceKeys.json(), {
    one_time_key_counts: {
      signed_curve25519: 1,
    },
  });

  const aliceAfterKeyUpload = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(aliceInitialSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(aliceAfterKeyUpload.device_lists.changed, ['@alice:matrix.example.test']);
  assert.deepEqual(aliceAfterKeyUpload.device_one_time_keys_count, {
    signed_curve25519: 1,
  });
  assert.deepEqual(aliceAfterKeyUpload.device_unused_fallback_key_types, ['signed_curve25519']);

  const keysChangesAfterUpload = await rig.gatewayFetch(
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}&to=${encodeURIComponent(aliceAfterKeyUpload.next_batch)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(keysChangesAfterUpload.status, 200);
  assert.deepEqual(await keysChangesAfterUpload.json(), {
    changed: ['@alice:matrix.example.test'],
    left: [],
  });

  const keysChangesCompatibility = await rig.gatewayFetch(
    `/_matrix/client/v1/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}&to=${encodeURIComponent(aliceAfterKeyUpload.next_batch)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(keysChangesCompatibility.status, 200);
  assert.deepEqual(await keysChangesCompatibility.json(), {
    changed: ['@alice:matrix.example.test'],
    left: [],
  });

  const keysChangesMissingFrom = await rig.gatewayFetch(
    `/_matrix/client/v3/keys/changes?to=${encodeURIComponent(aliceAfterKeyUpload.next_batch)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(keysChangesMissingFrom, 400, 'M_MISSING_PARAM');

  const keysChangesFromFuture = await rig.gatewayFetch(
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceAfterKeyUpload.next_batch)}&to=${encodeURIComponent(aliceInitialSync.next_batch)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(keysChangesFromFuture, 400, 'M_INVALID_PARAM');

  const crossDeviceLogin = await loginWithPassword(rig, {
    user: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICETABLET',
  });
  assert.equal(crossDeviceLogin.status, 200);
  const crossDeviceSession = await crossDeviceLogin.json();
  const crossDeviceSync = await syncRequest(rig, crossDeviceSession.access_token);

  const keysChangesCrossDevice = await rig.gatewayFetch(
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}&to=${encodeURIComponent(crossDeviceSync.next_batch)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(keysChangesCrossDevice, 400, 'M_INVALID_PARAM');

  const futureToken = issueSyncToken({
    user_id: alice.user_id,
    device_id: 'ALICEPHONE',
    user_stream_pos: 9999,
    secret_value: rig.env.SESSION_ROOT_KEY_RING,
  });
  const keysChangesFutureTo = await rig.gatewayFetch(
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}&to=${encodeURIComponent(futureToken)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(keysChangesFutureTo, 400, 'M_INVALID_PARAM');

  const queryAliceKeys = await rig.gatewayFetch('/_matrix/client/v3/keys/query', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  assert.equal(queryAliceKeys.status, 200);
  const queryAliceKeysBody = await queryAliceKeys.json();
  assert.equal(queryAliceKeysBody.device_keys[alice.user_id].ALICEPHONE.device_id, 'ALICEPHONE');

  const invalidQueryAliceKeys = await rig.gatewayFetch('/_matrix/client/v3/keys/query', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        [alice.user_id]: [''],
      },
    },
  });
  await expectMatrixError(invalidQueryAliceKeys, 400, 'M_INVALID_PARAM');

  const initialCrossSigningUpload = await rig.gatewayFetch('/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      master_key: {
        user_id: alice.user_id,
        usage: ['master'],
        keys: {
          'ed25519:alice-master-1': 'alice-master-1',
        },
      },
      self_signing_key: {
        user_id: alice.user_id,
        usage: ['self_signing'],
        keys: {
          'ed25519:alice-self-1': 'alice-self-1',
        },
        signatures: {
          [alice.user_id]: {
            'ed25519:alice-master-1': 'sig-self-1',
          },
        },
      },
      user_signing_key: {
        user_id: alice.user_id,
        usage: ['user_signing'],
        keys: {
          'ed25519:alice-user-1': 'alice-user-1',
        },
        signatures: {
          [alice.user_id]: {
            'ed25519:alice-master-1': 'sig-user-1',
          },
        },
      },
    },
  });
  assert.equal(initialCrossSigningUpload.status, 200);
  assert.deepEqual(await initialCrossSigningUpload.json(), {});

  const queryWithCrossSigning = await rig.gatewayFetch('/_matrix/client/v3/keys/query', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  assert.equal(queryWithCrossSigning.status, 200);
  const queryWithCrossSigningBody = await queryWithCrossSigning.json();
  assert.equal(queryWithCrossSigningBody.master_keys[alice.user_id].keys['ed25519:alice-master-1'], 'alice-master-1');
  assert.equal(queryWithCrossSigningBody.self_signing_keys[alice.user_id].keys['ed25519:alice-self-1'], 'alice-self-1');
  assert.equal(queryWithCrossSigningBody.user_signing_keys[alice.user_id].keys['ed25519:alice-user-1'], 'alice-user-1');

  const crossSigningChallenge = await rig.gatewayFetch('/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      master_key: {
        user_id: alice.user_id,
        usage: ['master'],
        keys: {
          'ed25519:alice-master-1': 'alice-master-1',
        },
      },
      self_signing_key: {
        user_id: alice.user_id,
        usage: ['self_signing'],
        keys: {
          'ed25519:alice-self-2': 'alice-self-2',
        },
        signatures: {
          [alice.user_id]: {
            'ed25519:alice-master-1': 'sig-self-2',
          },
        },
      },
    },
  });
  assert.equal(crossSigningChallenge.status, 401);
  const crossSigningChallengeBody = await crossSigningChallenge.json();
  assertOpaqueUiaSessionToken(crossSigningChallengeBody.session);

  const crossSigningUpload = await rig.gatewayFetch('/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      master_key: {
        user_id: alice.user_id,
        usage: ['master'],
        keys: {
          'ed25519:alice-master-1': 'alice-master-1',
        },
      },
      self_signing_key: {
        user_id: alice.user_id,
        usage: ['self_signing'],
        keys: {
          'ed25519:alice-self-2': 'alice-self-2',
        },
        signatures: {
          [alice.user_id]: {
            'ed25519:alice-master-1': 'sig-self-2',
          },
        },
      },
      auth: {
        type: 'm.login.password',
        session: crossSigningChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  assert.equal(crossSigningUpload.status, 200);

  const crossSigningReplay = await rig.gatewayFetch('/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      master_key: {
        user_id: alice.user_id,
        usage: ['master'],
        keys: {
          'ed25519:alice-master-1': 'alice-master-1',
        },
      },
      self_signing_key: {
        user_id: alice.user_id,
        usage: ['self_signing'],
        keys: {
          'ed25519:alice-self-2': 'alice-self-2',
        },
        signatures: {
          [alice.user_id]: {
            'ed25519:alice-master-1': 'sig-self-2',
          },
        },
      },
      auth: {
        type: 'm.login.password',
        session: crossSigningChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  assert.equal(crossSigningReplay.status, 200);

  const crossSigningConflict = await rig.gatewayFetch('/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      master_key: {
        user_id: alice.user_id,
        usage: ['master'],
        keys: {
          'ed25519:alice-master-2': 'alice-master-2',
        },
      },
      auth: {
        type: 'm.login.password',
        session: crossSigningChallengeBody.session,
        user: 'alice',
        password: 'correct horse battery staple',
      },
    },
  });
  await expectMatrixError(crossSigningConflict, 409, 'M_CONFLICT');

  const postSignatureQuery = await rig.gatewayFetch('/_matrix/client/v3/keys/query', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  const postSignatureQueryBody = await postSignatureQuery.json();
  const signedDeviceObject = structuredClone(postSignatureQueryBody.device_keys[alice.user_id].ALICEPHONE);
  signedDeviceObject.signatures = {
    ...(signedDeviceObject.signatures ?? {}),
    [alice.user_id]: {
      ...((signedDeviceObject.signatures ?? {})[alice.user_id] ?? {}),
      'ed25519:alice-self-2': 'device-sig-1',
    },
  };

  const uploadSignature = await rig.gatewayFetch('/_matrix/client/v3/keys/signatures/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      [alice.user_id]: {
        ALICEPHONE: signedDeviceObject,
      },
    },
  });
  assert.equal(uploadSignature.status, 200);
  assert.deepEqual(await uploadSignature.json(), { failures: {} });

  const invalidSignatureLocatorUpload = await rig.gatewayFetch('/_matrix/client/v3/keys/signatures/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      [alice.user_id]: {
        '': signedDeviceObject,
      },
    },
  });
  assert.equal(invalidSignatureLocatorUpload.status, 200);
  assert.deepEqual(await invalidSignatureLocatorUpload.json(), {
    failures: {
      [alice.user_id]: {
        '': {
          errcode: 'M_INVALID_PARAM',
          error: 'request.signed_objects.key must be a non-empty string',
        },
      },
    },
  });

  const queryAfterSignatureUpload = await rig.gatewayFetch('/_matrix/client/v3/keys/query', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  const queryAfterSignatureUploadBody = await queryAfterSignatureUpload.json();
  assert.equal(
    queryAfterSignatureUploadBody.device_keys[alice.user_id].ALICEPHONE.signatures[alice.user_id]['ed25519:alice-self-2'],
    'device-sig-1',
  );

  const mismatchedSignedDeviceObject = structuredClone(queryAfterSignatureUploadBody.device_keys[alice.user_id].ALICEPHONE);
  mismatchedSignedDeviceObject.keys['ed25519:ALICEPHONE'] = 'alice-ed-mismatch';
  mismatchedSignedDeviceObject.signatures = {
    ...(mismatchedSignedDeviceObject.signatures ?? {}),
    [alice.user_id]: {
      ...((mismatchedSignedDeviceObject.signatures ?? {})[alice.user_id] ?? {}),
      'ed25519:alice-self-2': 'device-sig-mismatch',
    },
  };
  const mismatchedSignatureUpload = await rig.gatewayFetch('/_matrix/client/v3/keys/signatures/upload', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      [alice.user_id]: {
        ALICEPHONE: mismatchedSignedDeviceObject,
      },
    },
  });
  assert.equal(mismatchedSignatureUpload.status, 200);
  assert.deepEqual(await mismatchedSignatureUpload.json(), {
    failures: {
      [alice.user_id]: {
        ALICEPHONE: {
          errcode: 'M_INVALID_SIGNATURE',
          error: 'Signed object does not match the stored key',
        },
      },
    },
  });

  const uploadBobKeys = await rig.gatewayFetch('/_matrix/client/v3/keys/upload', {
    method: 'POST',
    headers: rig.authHeaders(bob.access_token),
    json: {
      device_keys: {
        user_id: bob.user_id,
        device_id: 'BOBPHONE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:BOBPHONE': 'bob-curve',
          'ed25519:BOBPHONE': 'bob-ed',
        },
        signatures: {},
      },
      one_time_keys: {
        'signed_curve25519:bob-otk-1': {
          key: 'bob-otk-1',
        },
      },
      fallback_keys: {
        'signed_curve25519:bob-fallback-1': {
          key: 'bob-fallback-1',
        },
      },
    },
  });
  assert.equal(uploadBobKeys.status, 200);
  const bobBaselineSync = await syncRequest(rig, bob.access_token);
  assert.deepEqual(bobBaselineSync.device_one_time_keys_count, {
    signed_curve25519: 1,
  });
  assert.deepEqual(bobBaselineSync.device_unused_fallback_key_types, ['signed_curve25519']);

  const invalidClaim = await rig.gatewayFetch('/_matrix/client/v3/keys/claim', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      one_time_keys: {
        [bob.user_id]: {
          BOBPHONE: {
            algorithm: 'signed_curve25519',
          },
        },
      },
    },
  });
  await expectMatrixError(invalidClaim, 400, 'M_INVALID_PARAM');

  const firstClaim = await rig.gatewayFetch('/_matrix/client/v3/keys/claim', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      one_time_keys: {
        [bob.user_id]: {
          BOBPHONE: 'signed_curve25519',
        },
      },
    },
  });
  assert.equal(firstClaim.status, 200);
  const firstClaimBody = await firstClaim.json();
  assert.deepEqual(firstClaimBody.one_time_keys[bob.user_id].BOBPHONE, {
    'signed_curve25519:bob-otk-1': {
      key: 'bob-otk-1',
    },
  });

  const secondClaim = await rig.gatewayFetch('/_matrix/client/v3/keys/claim', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      one_time_keys: {
        [bob.user_id]: {
          BOBPHONE: 'signed_curve25519',
        },
      },
    },
  });
  assert.equal(secondClaim.status, 200);
  const secondClaimBody = await secondClaim.json();
  assert.deepEqual(secondClaimBody.one_time_keys[bob.user_id].BOBPHONE, {
    'signed_curve25519:bob-fallback-1': {
      key: 'bob-fallback-1',
    },
  });

  const bobAfterClaimSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobBaselineSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(bobAfterClaimSync.device_one_time_keys_count, {});
  assert.deepEqual(bobAfterClaimSync.device_unused_fallback_key_types, []);
});

test('Phase 05A keys/changes reports shared-room peer changes and left users', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const bob = await registerUser(rig, {
    username: 'bob',
    password: 'secret bob password',
    deviceId: 'BOBPHONE',
  });

  const createRoom = await requestAs(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    json: {
      invite: [bob.user_id],
    },
  });
  assert.equal(createRoom.status, 200);
  const { room_id: roomId } = await createRoom.json();
  await enableMegolmRoom(rig, alice.access_token, roomId);

  const bobJoin = await requestAs(rig, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobJoin.status, 200);

  const bobBaselineSync = await syncRequest(rig, bob.access_token);
  const bobTabletLogin = await loginWithPassword(rig, {
    user: 'bob',
    password: 'secret bob password',
    deviceId: 'BOBTABLET',
  });
  assert.equal(bobTabletLogin.status, 200);
  const bobTabletSession = await bobTabletLogin.json();
  const bobTabletSync = await syncRequest(rig, bobTabletSession.access_token);

  const aliceUpload = await requestAs(rig, alice.access_token, '/_matrix/client/v3/keys/upload', {
    method: 'POST',
    json: {
      device_keys: {
        user_id: alice.user_id,
        device_id: 'ALICEPHONE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:ALICEPHONE': 'alice-peer-curve',
          'ed25519:ALICEPHONE': 'alice-peer-ed',
        },
        signatures: {},
      },
    },
  });
  assert.equal(aliceUpload.status, 200);

  const bobAfterAliceChange = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobBaselineSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(bobAfterAliceChange.device_lists.changed, [alice.user_id]);

  const bobKeysChanges = await requestAs(
    rig,
    bob.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(bobBaselineSync.next_batch)}&to=${encodeURIComponent(bobAfterAliceChange.next_batch)}`,
  );
  assert.equal(bobKeysChanges.status, 200);
  assert.deepEqual(await bobKeysChanges.json(), {
    changed: [alice.user_id],
    left: [],
  });

  const bobKeysChangesCrossDevice = await requestAs(
    rig,
    bob.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(bobBaselineSync.next_batch)}&to=${encodeURIComponent(bobTabletSync.next_batch)}`,
  );
  await expectMatrixError(bobKeysChangesCrossDevice, 400, 'M_INVALID_PARAM');

  const futureToken = issueSyncToken({
    user_id: bob.user_id,
    device_id: 'BOBPHONE',
    user_stream_pos: 9999,
    secret_value: rig.env.SESSION_ROOT_KEY_RING,
  });
  const bobKeysChangesFuture = await requestAs(
    rig,
    bob.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(bobBaselineSync.next_batch)}&to=${encodeURIComponent(futureToken)}`,
  );
  await expectMatrixError(bobKeysChangesFuture, 400, 'M_INVALID_PARAM');

  const aliceBaselineForBobLeave = await syncRequest(rig, alice.access_token);
  const bobLeave = await requestAs(rig, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobLeave.status, 200);

  const aliceAfterBobLeave = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(aliceBaselineForBobLeave.next_batch)}&timeout=0`,
  );
  assert.deepEqual(aliceAfterBobLeave.device_lists.left, [bob.user_id]);

  const aliceKeysChangesAfterLeave = await requestAs(
    rig,
    alice.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceBaselineForBobLeave.next_batch)}&to=${encodeURIComponent(aliceAfterBobLeave.next_batch)}`,
  );
  assert.equal(aliceKeysChangesAfterLeave.status, 200);
  assert.deepEqual(await aliceKeysChangesAfterLeave.json(), {
    changed: [],
    left: [bob.user_id],
  });

  const plainCreateRoom = await requestAs(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    json: {
      invite: [bob.user_id],
      name: 'plain-room-negative-device-lists',
    },
  });
  assert.equal(plainCreateRoom.status, 200);
  const { room_id: plainRoomId } = await plainCreateRoom.json();

  const bobPlainJoin = await requestAs(rig, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(plainRoomId)}/join`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobPlainJoin.status, 200);

  const alicePlainBaseline = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(aliceAfterBobLeave.next_batch)}&timeout=0`,
  );
  const bobPlainLeave = await requestAs(rig, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(plainRoomId)}/leave`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobPlainLeave.status, 200);

  const aliceAfterPlainLeave = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(alicePlainBaseline.next_batch)}&timeout=0`,
  );
  assert.deepEqual(aliceAfterPlainLeave.device_lists.left ?? [], []);
});

test('Phase 05A joining an encrypted invited room exposes m.room.encryption in the join /sync delta', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice-encrypted-join-sync',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const bob = await registerUser(rig, {
    username: 'bob-encrypted-join-sync',
    password: 'secret bob password',
    deviceId: 'BOBPHONE',
  });

  const bobBaselineSync = await syncRequest(rig, bob.access_token);
  const createRoom = await requestAs(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    json: {
      invite: [bob.user_id],
      name: 'encrypted-join-sync-room',
    },
  });
  assert.equal(createRoom.status, 200);
  const { room_id: roomId } = await createRoom.json();

  await enableMegolmRoom(rig, alice.access_token, roomId);

  const bobInviteSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobBaselineSync.next_batch)}&timeout=0`,
  );
  assert.ok(bobInviteSync.rooms?.invite?.[roomId], 'expected Bob to observe the invite before joining');

  const bobJoin = await requestAs(rig, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobJoin.status, 200);

  const bobJoinSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobInviteSync.next_batch)}&timeout=0`,
  );
  const joinedRoom = bobJoinSync.rooms?.join?.[roomId];
  assert.ok(joinedRoom, 'expected joined room to appear in Bob incremental /sync');
  assert.ok(
    (joinedRoom.timeline?.events ?? []).some((event) => (
      event.type === 'm.room.member' && event.state_key === bob.user_id && event.content?.membership === 'join'
    )),
    'expected Bob join delta to keep the join event in timeline',
  );
  assert.ok(
    (joinedRoom.state?.events ?? []).some((event) => (
      event.type === 'm.room.encryption'
      && event.state_key === ''
      && event.content?.algorithm === 'm.megolm.v1.aes-sha2'
    )),
    'expected Bob join /sync state to include the room encryption event',
  );
});

test('Phase 05A room key backup metadata and opaque backup objects round-trip via HTTP surface', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const createVersion = await rig.gatewayFetch('/_matrix/client/v3/room_keys/version', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: {
        public_key: 'backup-master-1',
      },
    },
  });
  assert.equal(createVersion.status, 200);
  assert.deepEqual(await createVersion.json(), { version: '1' });

  const currentVersion = await rig.gatewayFetch('/_matrix/client/v3/room_keys/version', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(currentVersion.status, 200);
  const currentVersionBody = await currentVersion.json();
  assert.equal(currentVersionBody.version, '1');
  assert.equal(currentVersionBody.algorithm, 'm.megolm_backup.v1.curve25519-aes-sha2');
  assert.deepEqual(currentVersionBody.auth_data, {
    public_key: 'backup-master-1',
  });

  const updateVersion = await rig.gatewayFetch('/_matrix/client/v3/room_keys/version/1', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: {
        public_key: 'backup-master-2',
      },
    },
  });
  assert.equal(updateVersion.status, 200);

  const putAllKeys = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys?version=1', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      rooms: {
        '!roomA:matrix.example.test': {
          sessions: {
            sess1: {
              first_message_index: 1,
              forwarded_count: 0,
              is_verified: true,
              session_data: 'ciphertext-1',
            },
          },
        },
      },
    },
  });
  assert.equal(putAllKeys.status, 200);
  const putAllKeysBody = await putAllKeys.json();
  assert.equal(putAllKeysBody.count, 1);
  assert.equal(typeof putAllKeysBody.etag, 'string');

  const getAllKeys = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys?version=1', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(getAllKeys.status, 200);
  assert.deepEqual(await getAllKeys.json(), {
    rooms: {
      '!roomA:matrix.example.test': {
        sessions: {
          sess1: {
            first_message_index: 1,
            forwarded_count: 0,
            is_verified: true,
            session_data: 'ciphertext-1',
          },
        },
      },
    },
  });

  const getRoomKeys = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test?version=1', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(getRoomKeys.status, 200);
  assert.deepEqual(await getRoomKeys.json(), {
    sessions: {
      sess1: {
        first_message_index: 1,
        forwarded_count: 0,
        is_verified: true,
        session_data: 'ciphertext-1',
      },
    },
  });

  const getSessionKey = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(getSessionKey.status, 200);
  assert.deepEqual(await getSessionKey.json(), {
    first_message_index: 1,
    forwarded_count: 0,
    is_verified: true,
    session_data: 'ciphertext-1',
  });

  const deleteSessionKey = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1', {
    method: 'DELETE',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(deleteSessionKey.status, 200);
  const deleteSessionKeyBody = await deleteSessionKey.json();
  assert.equal(deleteSessionKeyBody.count, 0);

  const missingSessionKey = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1', {
    headers: rig.authHeaders(alice.access_token),
  });
  await expectMatrixError(missingSessionKey, 404, 'M_NOT_FOUND');

  const putSingleSession = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      first_message_index: 5,
      forwarded_count: 1,
      is_verified: false,
      session_data: 'ciphertext-2',
    },
  });
  assert.equal(putSingleSession.status, 200);

  const deleteAllKeys = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys?version=1', {
    method: 'DELETE',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(deleteAllKeys.status, 200);
  const deleteAllKeysBody = await deleteAllKeys.json();
  assert.equal(deleteAllKeysBody.count, 0);

  const emptyBackup = await rig.gatewayFetch('/_matrix/client/v3/room_keys/keys?version=1', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(emptyBackup.status, 200);
  assert.deepEqual(await emptyBackup.json(), { rooms: {} });

  const deleteVersion = await rig.gatewayFetch('/_matrix/client/v3/room_keys/version/1', {
    method: 'DELETE',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(deleteVersion.status, 200);
  assert.deepEqual(await deleteVersion.json(), {});
});
