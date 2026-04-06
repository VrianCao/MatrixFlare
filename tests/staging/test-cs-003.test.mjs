import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authHeaders,
  expectMatrixError,
  loginWithPassword,
  registerUser,
  request,
  requireRemoteHarnessContext,
  syncRequest,
} from './support.mjs';

function assertOpaqueUiaSessionToken(sessionToken) {
  assert.equal(typeof sessionToken, 'string');
  const parts = sessionToken.split('.');
  assert.equal(parts[0], 'uia');
  assert.equal(parts.length, 5);
}

async function requestAs(harness, accessToken, pathname, {
  method = 'GET',
  json = undefined,
  body = undefined,
} = {}) {
  return request(harness, pathname, {
    method,
    headers: authHeaders(accessToken),
    json,
    body,
  });
}

async function createSharedRoom(harness, ownerAccessToken, inviteeUserId, body = {}) {
  const response = await requestAs(harness, ownerAccessToken, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    json: {
      invite: [inviteeUserId],
      ...body,
    },
  });
  assert.equal(response.response.status, 200);
  return response.payload.room_id;
}

async function enableMegolmRoom(harness, accessToken, roomId) {
  const response = await requestAs(
    harness,
    accessToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
    {
      method: 'PUT',
      json: {
        algorithm: 'm.megolm.v1.aes-sha2',
      },
    },
  );
  assert.equal(response.response.status, 200);
}

test('TEST-CS-003 staging covers device CRUD, route-bound UIA delete flows, and session revocation', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-alice',
    password: 'phase08-cs3-staging-password-1',
    deviceId: 'CS3STGPHONE',
  });
  const secondLogin = await loginWithPassword(harness, {
    user: alice.username,
    password: 'phase08-cs3-staging-password-1',
    deviceId: 'CS3STGLAPTOP',
  });
  assert.equal(secondLogin.response.status, 200);
  const laptopSession = secondLogin.payload;

  const devices = await requestAs(harness, alice.access_token, '/_matrix/client/v3/devices');
  assert.equal(devices.response.status, 200);
  assert.deepEqual(devices.payload?.devices?.map((entry) => entry.device_id).sort(), ['CS3STGLAPTOP', 'CS3STGPHONE']);

  const updateDevice = await requestAs(harness, alice.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP', {
    method: 'PUT',
    json: {
      display_name: 'Phase 08 Staging Laptop',
    },
  });
  assert.equal(updateDevice.response.status, 200);
  assert.deepEqual(updateDevice.payload, {});

  const readDevice = await requestAs(harness, alice.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP');
  assert.equal(readDevice.response.status, 200);
  assert.deepEqual({
    device_id: readDevice.payload?.device_id,
    display_name: readDevice.payload?.display_name,
  }, {
    device_id: 'CS3STGLAPTOP',
    display_name: 'Phase 08 Staging Laptop',
  });
  assert.equal(typeof readDevice.payload?.last_seen_ts, 'number');

  const baselineSync = await syncRequest(harness, alice.access_token);

  const deleteChallenge = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP', {
    method: 'DELETE',
    json: {},
  });
  assert.equal(deleteChallenge.response.status, 401);
  assert.deepEqual(deleteChallenge.payload?.flows, [{ stages: ['m.login.password'] }]);
  assertOpaqueUiaSessionToken(deleteChallenge.payload?.session);

  const deleteDevice = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP', {
    method: 'DELETE',
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-1',
      },
    },
  });
  assert.equal(deleteDevice.response.status, 200);
  assert.deepEqual(deleteDevice.payload, {});

  const deleteReplayWithValidToken = await requestAs(harness, alice.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP', {
    method: 'DELETE',
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-1',
      },
    },
  });
  assert.equal(deleteReplayWithValidToken.response.status, 200);
  assert.deepEqual(deleteReplayWithValidToken.payload, {});

  const deleteReplayWithoutToken = await request(harness, '/_matrix/client/v3/devices/CS3STGLAPTOP', {
    method: 'DELETE',
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-1',
      },
    },
  });
  await expectMatrixError(deleteReplayWithoutToken, 401, 'M_MISSING_TOKEN');

  const deleteReplayWithRevokedToken = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP', {
    method: 'DELETE',
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-1',
      },
    },
  });
  await expectMatrixError(deleteReplayWithRevokedToken, 401, 'M_UNKNOWN_TOKEN');

  const deletedDevice = await requestAs(harness, alice.access_token, '/_matrix/client/v3/devices/CS3STGLAPTOP');
  await expectMatrixError(deletedDevice, 404, 'M_NOT_FOUND');

  const laptopWhoAmI = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(laptopWhoAmI, 401, 'M_UNKNOWN_TOKEN');

  const afterDeleteSync = await syncRequest(
    harness,
    alice.access_token,
    `since=${encodeURIComponent(baselineSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(afterDeleteSync.device_lists?.changed, [alice.user_id]);

  const thirdLogin = await loginWithPassword(harness, {
    user: alice.username,
    password: 'phase08-cs3-staging-password-1',
    deviceId: 'CS3STGTABLET',
  });
  assert.equal(thirdLogin.response.status, 200);
  const tabletSession = thirdLogin.payload;

  const bulkDeleteChallenge = await requestAs(harness, tabletSession.access_token, '/_matrix/client/v3/delete_devices', {
    method: 'POST',
    json: {
      devices: ['CS3STGPHONE'],
    },
  });
  assert.equal(bulkDeleteChallenge.response.status, 401);
  assertOpaqueUiaSessionToken(bulkDeleteChallenge.payload?.session);

  const bulkDelete = await requestAs(harness, tabletSession.access_token, '/_matrix/client/v3/delete_devices', {
    method: 'POST',
    json: {
      devices: ['CS3STGPHONE'],
      auth: {
        type: 'm.login.password',
        session: bulkDeleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-1',
      },
    },
  });
  assert.equal(bulkDelete.response.status, 200);
  assert.deepEqual(bulkDelete.payload, {});

  const bulkConflict = await requestAs(harness, tabletSession.access_token, '/_matrix/client/v3/delete_devices', {
    method: 'POST',
    json: {
      devices: ['CS3STGPHONE', 'MISSINGDEVICE'],
      auth: {
        type: 'm.login.password',
        session: bulkDeleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-1',
      },
    },
  });
  await expectMatrixError(bulkConflict, 409, 'M_CONFLICT');

  const phoneWhoAmI = await requestAs(harness, alice.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(phoneWhoAmI, 401, 'M_UNKNOWN_TOKEN');
});

test('TEST-CS-003 staging covers to-device idempotency and transport via /sync', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-tda',
    password: 'phase08-cs3-staging-password-2',
    deviceId: 'CS3TDALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-tdb',
    password: 'phase08-cs3-staging-password-3',
    deviceId: 'CS3TDBOB',
  });

  const sendToDevice = await requestAs(
    harness,
    alice.access_token,
    '/_matrix/client/v3/sendToDevice/m.test.phase08/txn-001',
    {
      method: 'PUT',
      json: {
        messages: {
          [bob.user_id]: {
            CS3TDBOB: {
              body: 'first delivery',
            },
          },
        },
      },
    },
  );
  assert.equal(sendToDevice.response.status, 200);
  assert.deepEqual(sendToDevice.payload, {});

  const bobSync = await syncRequest(harness, bob.access_token);
  assert.deepEqual(bobSync.to_device?.events, [{
    sender: alice.user_id,
    type: 'm.test.phase08',
    content: {
      body: 'first delivery',
    },
  }]);

  const retrySameTxn = await requestAs(
    harness,
    alice.access_token,
    '/_matrix/client/v3/sendToDevice/m.test.phase08/txn-001',
    {
      method: 'PUT',
      json: {
        messages: {
          [bob.user_id]: {
            CS3TDBOB: {
              body: 'first delivery',
            },
          },
        },
      },
    },
  );
  assert.equal(retrySameTxn.response.status, 200);
  assert.deepEqual(retrySameTxn.payload, {});

  const bobNoDuplicateSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(bobSync.next_batch)}&timeout=0`,
  );
  assert.equal(bobNoDuplicateSync.next_batch, bobSync.next_batch);
  assert.equal((bobNoDuplicateSync.to_device?.events ?? []).length, 0);

  const retryDifferentPayload = await requestAs(
    harness,
    alice.access_token,
    '/_matrix/client/v3/sendToDevice/m.test.phase08/txn-001',
    {
      method: 'PUT',
      json: {
        messages: {
          [bob.user_id]: {
            CS3TDBOB: {
              body: 'conflicting payload',
            },
          },
        },
      },
    },
  );
  await expectMatrixError(retryDifferentPayload, 409, 'M_CONFLICT');
});

test('TEST-CS-003 staging covers /keys/changes for shared-room peer changes and leave detection', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-kca',
    password: 'phase08-cs3-staging-password-4',
    deviceId: 'CS3KCALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-kcb',
    password: 'phase08-cs3-staging-password-5',
    deviceId: 'CS3KCBOB',
  });

  const roomId = await createSharedRoom(harness, alice.access_token, bob.user_id);
  await enableMegolmRoom(harness, alice.access_token, roomId);

  const bobJoin = await requestAs(harness, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobJoin.response.status, 200);

  const bobBaselineSync = await syncRequest(harness, bob.access_token);

  const aliceUpload = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/upload', {
    method: 'POST',
    json: {
      device_keys: {
        user_id: alice.user_id,
        device_id: 'CS3KCALICE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:CS3KCALICE': 'staging-peer-curve',
          'ed25519:CS3KCALICE': 'staging-peer-ed',
        },
        signatures: {},
      },
    },
  });
  assert.equal(aliceUpload.response.status, 200);

  const bobAfterAliceChange = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(bobBaselineSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(bobAfterAliceChange.device_lists?.changed, [alice.user_id]);

  const bobKeysChanges = await requestAs(
    harness,
    bob.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(bobBaselineSync.next_batch)}&to=${encodeURIComponent(bobAfterAliceChange.next_batch)}`,
  );
  assert.equal(bobKeysChanges.response.status, 200);
  assert.deepEqual(bobKeysChanges.payload, {
    changed: [alice.user_id],
    left: [],
  });

  const bobTabletLogin = await loginWithPassword(harness, {
    user: bob.username,
    password: 'phase08-cs3-staging-password-5',
    deviceId: 'CS3KCBOBTAB',
  });
  assert.equal(bobTabletLogin.response.status, 200);
  const bobTabletSync = await syncRequest(harness, bobTabletLogin.payload.access_token);

  const bobKeysChangesCrossDevice = await requestAs(
    harness,
    bob.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(bobBaselineSync.next_batch)}&to=${encodeURIComponent(bobTabletSync.next_batch)}`,
  );
  await expectMatrixError(bobKeysChangesCrossDevice, 400, 'M_INVALID_PARAM');

  const aliceBaselineForBobLeave = await syncRequest(harness, alice.access_token);
  const bobLeave = await requestAs(harness, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobLeave.response.status, 200);

  const aliceAfterBobLeave = await syncRequest(
    harness,
    alice.access_token,
    `since=${encodeURIComponent(aliceBaselineForBobLeave.next_batch)}&timeout=0`,
  );
  assert.deepEqual(aliceAfterBobLeave.device_lists?.left, [bob.user_id]);

  const aliceKeysChangesAfterLeave = await requestAs(
    harness,
    alice.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceBaselineForBobLeave.next_batch)}&to=${encodeURIComponent(aliceAfterBobLeave.next_batch)}`,
  );
  assert.equal(aliceKeysChangesAfterLeave.response.status, 200);
  assert.deepEqual(aliceKeysChangesAfterLeave.payload, {
    changed: [],
    left: [bob.user_id],
  });

  const plainRoomId = await createSharedRoom(harness, alice.access_token, bob.user_id, {
    name: 'staging-plain-room-negative-device-lists',
  });
  const bobPlainJoin = await requestAs(harness, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(plainRoomId)}/join`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobPlainJoin.response.status, 200);

  const alicePlainBaseline = await syncRequest(
    harness,
    alice.access_token,
    `since=${encodeURIComponent(aliceAfterBobLeave.next_batch)}&timeout=0`,
  );
  const bobPlainLeave = await requestAs(harness, bob.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(plainRoomId)}/leave`, {
    method: 'POST',
    json: {},
  });
  assert.equal(bobPlainLeave.response.status, 200);

  const aliceAfterPlainLeave = await syncRequest(
    harness,
    alice.access_token,
    `since=${encodeURIComponent(alicePlainBaseline.next_batch)}&timeout=0`,
  );
  assert.deepEqual(aliceAfterPlainLeave.device_lists?.left ?? [], []);
});

test('TEST-CS-003 staging covers key upload/query/claim, cross-signing, signatures, and /sync device truth', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-e2ee-a',
    password: 'phase08-cs3-staging-password-4',
    deviceId: 'CS3E2EEALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-e2ee-b',
    password: 'phase08-cs3-staging-password-5',
    deviceId: 'CS3E2EEBOB',
  });

  const aliceInitialSync = await syncRequest(harness, alice.access_token);

  const uploadAliceDeviceKeysOnly = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/upload', {
    method: 'POST',
    json: {
      device_keys: {
        user_id: alice.user_id,
        device_id: 'CS3E2EEALICE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:CS3E2EEALICE': 'alice-curve',
          'ed25519:CS3E2EEALICE': 'alice-ed',
        },
        signatures: {},
      },
    },
  });
  assert.equal(uploadAliceDeviceKeysOnly.response.status, 200);
  assert.deepEqual(uploadAliceDeviceKeysOnly.payload, {
    one_time_key_counts: {},
  });

  const uploadAliceKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/upload', {
    method: 'POST',
    json: {
      device_keys: {
        user_id: alice.user_id,
        device_id: 'CS3E2EEALICE',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:CS3E2EEALICE': 'alice-curve',
          'ed25519:CS3E2EEALICE': 'alice-ed',
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
  assert.equal(uploadAliceKeys.response.status, 200);
  assert.deepEqual(uploadAliceKeys.payload, {
    one_time_key_counts: {
      signed_curve25519: 1,
    },
  });

  const aliceAfterKeyUpload = await syncRequest(
    harness,
    alice.access_token,
    `since=${encodeURIComponent(aliceInitialSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(aliceAfterKeyUpload.device_lists?.changed, [alice.user_id]);
  assert.deepEqual(aliceAfterKeyUpload.device_one_time_keys_count, {
    signed_curve25519: 1,
  });
  assert.deepEqual(aliceAfterKeyUpload.device_unused_fallback_key_types, ['signed_curve25519']);

  const keysChangesAfterUpload = await requestAs(
    harness,
    alice.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}&to=${encodeURIComponent(aliceAfterKeyUpload.next_batch)}`,
  );
  assert.equal(keysChangesAfterUpload.response.status, 200);
  assert.deepEqual(keysChangesAfterUpload.payload, {
    changed: [alice.user_id],
    left: [],
  });

  const keysChangesMissingTo = await requestAs(
    harness,
    alice.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}`,
  );
  await expectMatrixError(keysChangesMissingTo, 400, 'M_MISSING_PARAM');

  const keysChangesInverted = await requestAs(
    harness,
    alice.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceAfterKeyUpload.next_batch)}&to=${encodeURIComponent(aliceInitialSync.next_batch)}`,
  );
  await expectMatrixError(keysChangesInverted, 400, 'M_INVALID_PARAM');

  const keysChangesFutureTo = await requestAs(
    harness,
    alice.access_token,
    `/_matrix/client/v3/keys/changes?from=${encodeURIComponent(aliceInitialSync.next_batch)}&to=${encodeURIComponent(`${aliceAfterKeyUpload.next_batch}future`)}`,
  );
  await expectMatrixError(keysChangesFutureTo, 400, 'M_INVALID_PARAM');

  const queryAliceKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/query', {
    method: 'POST',
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  assert.equal(queryAliceKeys.response.status, 200);
  const queryAliceDeviceKeys = queryAliceKeys.payload?.device_keys?.[alice.user_id];
  const queryAliceDevice = queryAliceDeviceKeys?.CS3E2EEALICE;
  assert.equal(queryAliceDevice?.device_id, 'CS3E2EEALICE');

  const invalidQueryAliceKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/query', {
    method: 'POST',
    json: {
      device_keys: {
        [alice.user_id]: [''],
      },
    },
  });
  await expectMatrixError(invalidQueryAliceKeys, 400, 'M_INVALID_PARAM');

  const initialCrossSigningUpload = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
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
  assert.equal(initialCrossSigningUpload.response.status, 200);
  assert.deepEqual(initialCrossSigningUpload.payload, {});

  const queryWithCrossSigning = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/query', {
    method: 'POST',
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  assert.equal(queryWithCrossSigning.response.status, 200);
  const masterKeyEntry = queryWithCrossSigning.payload?.master_keys?.[alice.user_id];
  const selfSigningKeyEntry = queryWithCrossSigning.payload?.self_signing_keys?.[alice.user_id];
  const userSigningKeyEntry = queryWithCrossSigning.payload?.user_signing_keys?.[alice.user_id];
  assert.equal(masterKeyEntry?.keys?.['ed25519:alice-master-1'], 'alice-master-1');
  assert.equal(selfSigningKeyEntry?.keys?.['ed25519:alice-self-1'], 'alice-self-1');
  assert.equal(userSigningKeyEntry?.keys?.['ed25519:alice-user-1'], 'alice-user-1');

  const crossSigningChallenge = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
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
  assert.equal(crossSigningChallenge.response.status, 401);
  assertOpaqueUiaSessionToken(crossSigningChallenge.payload?.session);

  const crossSigningUpload = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
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
        session: crossSigningChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-4',
      },
    },
  });
  assert.equal(crossSigningUpload.response.status, 200);
  assert.deepEqual(crossSigningUpload.payload, {});

  const crossSigningReplay = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
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
        session: crossSigningChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-4',
      },
    },
  });
  assert.equal(crossSigningReplay.response.status, 200);
  assert.deepEqual(crossSigningReplay.payload, {});

  const crossSigningConflict = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/device_signing/upload', {
    method: 'POST',
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
        session: crossSigningChallenge.payload.session,
        user: alice.username,
        password: 'phase08-cs3-staging-password-4',
      },
    },
  });
  await expectMatrixError(crossSigningConflict, 409, 'M_CONFLICT');

  const postSignatureQuery = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/query', {
    method: 'POST',
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  assert.equal(postSignatureQuery.response.status, 200);
  const postSignatureDeviceKeys = postSignatureQuery.payload?.device_keys?.[alice.user_id];
  const signedDeviceObject = structuredClone(postSignatureDeviceKeys?.CS3E2EEALICE);
  signedDeviceObject.signatures = {
    ...(signedDeviceObject.signatures ?? {}),
    [alice.user_id]: {
      ...((signedDeviceObject.signatures ?? {})[alice.user_id] ?? {}),
      'ed25519:alice-self-2': 'device-sig-1',
    },
  };

  const uploadSignature = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/signatures/upload', {
    method: 'POST',
    json: {
      [alice.user_id]: {
        CS3E2EEALICE: signedDeviceObject,
      },
    },
  });
  assert.equal(uploadSignature.response.status, 200);
  assert.deepEqual(uploadSignature.payload, { failures: {} });

  const invalidSignatureLocatorUpload = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/signatures/upload', {
    method: 'POST',
    json: {
      [alice.user_id]: {
        '': signedDeviceObject,
      },
    },
  });
  assert.equal(invalidSignatureLocatorUpload.response.status, 200);
  assert.deepEqual(invalidSignatureLocatorUpload.payload, {
    failures: {
      [alice.user_id]: {
        '': {
          errcode: 'M_INVALID_PARAM',
          error: 'request.signed_objects.key must be a non-empty string',
        },
      },
    },
  });

  const queryAfterSignatureUpload = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/query', {
    method: 'POST',
    json: {
      device_keys: {
        [alice.user_id]: [],
      },
    },
  });
  assert.equal(queryAfterSignatureUpload.response.status, 200);
  const queryAfterSignatureDeviceKeys = queryAfterSignatureUpload.payload?.device_keys?.[alice.user_id];
  const queryAfterSignatureDevice = queryAfterSignatureDeviceKeys?.CS3E2EEALICE;
  const queryAfterSignatureDeviceSignatures = queryAfterSignatureDevice?.signatures?.[alice.user_id];
  assert.equal(
    queryAfterSignatureDeviceSignatures?.['ed25519:alice-self-2'],
    'device-sig-1',
  );

  const mismatchedSignedDeviceObject = structuredClone(queryAfterSignatureDevice);
  mismatchedSignedDeviceObject.keys['ed25519:CS3E2EEALICE'] = 'alice-ed-mismatch';
  mismatchedSignedDeviceObject.signatures = {
    ...(mismatchedSignedDeviceObject.signatures ?? {}),
    [alice.user_id]: {
      ...((mismatchedSignedDeviceObject.signatures ?? {})[alice.user_id] ?? {}),
      'ed25519:alice-self-2': 'device-sig-mismatch',
    },
  };
  const mismatchedSignatureUpload = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/signatures/upload', {
    method: 'POST',
    json: {
      [alice.user_id]: {
        CS3E2EEALICE: mismatchedSignedDeviceObject,
      },
    },
  });
  assert.equal(mismatchedSignatureUpload.response.status, 200);
  assert.deepEqual(mismatchedSignatureUpload.payload, {
    failures: {
      [alice.user_id]: {
        CS3E2EEALICE: {
          errcode: 'M_INVALID_SIGNATURE',
          error: 'Signed object does not match the stored key',
        },
      },
    },
  });

  const uploadBobKeys = await requestAs(harness, bob.access_token, '/_matrix/client/v3/keys/upload', {
    method: 'POST',
    json: {
      device_keys: {
        user_id: bob.user_id,
        device_id: 'CS3E2EEBOB',
        algorithms: ['m.olm.v1.curve25519-aes-sha256'],
        keys: {
          'curve25519:CS3E2EEBOB': 'bob-curve',
          'ed25519:CS3E2EEBOB': 'bob-ed',
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
  assert.equal(uploadBobKeys.response.status, 200);
  assert.deepEqual(uploadBobKeys.payload, {
    one_time_key_counts: {
      signed_curve25519: 1,
    },
  });

  const bobBaselineSync = await syncRequest(harness, bob.access_token);
  assert.deepEqual(bobBaselineSync.device_one_time_keys_count, {
    signed_curve25519: 1,
  });
  assert.deepEqual(bobBaselineSync.device_unused_fallback_key_types, ['signed_curve25519']);

  const invalidClaim = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/claim', {
    method: 'POST',
    json: {
      one_time_keys: {
        [bob.user_id]: {
          CS3E2EEBOB: {
            algorithm: 'signed_curve25519',
          },
        },
      },
    },
  });
  await expectMatrixError(invalidClaim, 400, 'M_INVALID_PARAM');

  const firstClaim = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/claim', {
    method: 'POST',
    json: {
      one_time_keys: {
        [bob.user_id]: {
          CS3E2EEBOB: 'signed_curve25519',
        },
      },
    },
  });
  assert.equal(firstClaim.response.status, 200);
  const firstClaimKeys = firstClaim.payload?.one_time_keys?.[bob.user_id];
  assert.deepEqual(firstClaimKeys?.CS3E2EEBOB, {
    'signed_curve25519:bob-otk-1': {
      key: 'bob-otk-1',
    },
  });

  const secondClaim = await requestAs(harness, alice.access_token, '/_matrix/client/v3/keys/claim', {
    method: 'POST',
    json: {
      one_time_keys: {
        [bob.user_id]: {
          CS3E2EEBOB: 'signed_curve25519',
        },
      },
    },
  });
  assert.equal(secondClaim.response.status, 200);
  const secondClaimKeys = secondClaim.payload?.one_time_keys?.[bob.user_id];
  assert.deepEqual(secondClaimKeys?.CS3E2EEBOB, {
    'signed_curve25519:bob-fallback-1': {
      key: 'bob-fallback-1',
    },
  });

  const bobAfterClaimSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(bobBaselineSync.next_batch)}&timeout=0`,
  );
  assert.deepEqual(bobAfterClaimSync.device_one_time_keys_count, {});
  assert.deepEqual(bobAfterClaimSync.device_unused_fallback_key_types, []);
});

test('TEST-CS-003 staging covers room-key backup metadata and opaque backup objects', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs3-staging-backup',
    password: 'phase08-cs3-staging-password-6',
    deviceId: 'CS3BACKUP',
  });

  const createVersion = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/version', {
    method: 'POST',
    json: {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: {
        public_key: 'backup-master-1',
      },
    },
  });
  assert.equal(createVersion.response.status, 200);
  assert.deepEqual(createVersion.payload, { version: '1' });

  const currentVersion = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/version');
  assert.equal(currentVersion.response.status, 200);
  assert.equal(currentVersion.payload?.version, '1');
  assert.equal(currentVersion.payload?.algorithm, 'm.megolm_backup.v1.curve25519-aes-sha2');
  assert.deepEqual(currentVersion.payload?.auth_data, {
    public_key: 'backup-master-1',
  });

  const updateVersion = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/version/1', {
    method: 'PUT',
    json: {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: {
        public_key: 'backup-master-2',
      },
    },
  });
  assert.equal(updateVersion.response.status, 200);
  assert.deepEqual(updateVersion.payload, {});

  const putAllKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys?version=1', {
    method: 'PUT',
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
  assert.equal(putAllKeys.response.status, 200);
  assert.equal(putAllKeys.payload?.count, 1);
  assert.equal(typeof putAllKeys.payload?.etag, 'string');

  const getAllKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys?version=1');
  assert.equal(getAllKeys.response.status, 200);
  assert.deepEqual(getAllKeys.payload, {
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

  const getRoomKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test?version=1');
  assert.equal(getRoomKeys.response.status, 200);
  assert.deepEqual(getRoomKeys.payload, {
    sessions: {
      sess1: {
        first_message_index: 1,
        forwarded_count: 0,
        is_verified: true,
        session_data: 'ciphertext-1',
      },
    },
  });

  const getSessionKey = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1');
  assert.equal(getSessionKey.response.status, 200);
  assert.deepEqual(getSessionKey.payload, {
    first_message_index: 1,
    forwarded_count: 0,
    is_verified: true,
    session_data: 'ciphertext-1',
  });

  const deleteSessionKey = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1', {
    method: 'DELETE',
  });
  assert.equal(deleteSessionKey.response.status, 200);
  assert.equal(deleteSessionKey.payload?.count, 0);

  const missingSessionKey = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1');
  await expectMatrixError(missingSessionKey, 404, 'M_NOT_FOUND');

  const putSingleSession = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys/!roomA:matrix.example.test/sess1?version=1', {
    method: 'PUT',
    json: {
      first_message_index: 5,
      forwarded_count: 1,
      is_verified: false,
      session_data: 'ciphertext-2',
    },
  });
  assert.equal(putSingleSession.response.status, 200);
  assert.equal(putSingleSession.payload?.count, 1);
  assert.equal(typeof putSingleSession.payload?.etag, 'string');

  const deleteAllKeys = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys?version=1', {
    method: 'DELETE',
  });
  assert.equal(deleteAllKeys.response.status, 200);
  assert.equal(deleteAllKeys.payload?.count, 0);

  const emptyBackup = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/keys?version=1');
  assert.equal(emptyBackup.response.status, 200);
  assert.deepEqual(emptyBackup.payload, { rooms: {} });

  const deleteVersion = await requestAs(harness, alice.access_token, '/_matrix/client/v3/room_keys/version/1', {
    method: 'DELETE',
  });
  assert.equal(deleteVersion.response.status, 200);
  assert.deepEqual(deleteVersion.payload, {});
});
