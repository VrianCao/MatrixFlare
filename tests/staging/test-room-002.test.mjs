import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  expectMatrixError,
  getAuthenticated,
  putAuthenticated,
  registerUser,
  request,
  requireRemoteHarnessContext,
  roomPath,
} from './support.mjs';

test('TEST-ROOM-002 staging validates the L1 room version 12 default and redaction behavior', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'room2-staging-alice',
    deviceId: 'ROOM2STGALICE',
  });

  const defaultRoom = await createRoom(harness, alice.access_token, {});
  const createContent = await getAuthenticated(
    harness,
    alice.access_token,
    roomPath(defaultRoom.room_id, '/state/m.room.create'),
  );
  assert.equal(createContent.response.status, 200);
  assert.equal(createContent.payload?.room_version, '12');

  const unsupportedRoom = await request(harness, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.access_token}`,
    },
    json: {
      room_version: '99',
    },
  });
  await expectMatrixError(unsupportedRoom, 400, 'M_UNSUPPORTED_ROOM_VERSION');

  const allState = await getAuthenticated(harness, alice.access_token, roomPath(defaultRoom.room_id, '/state'));
  assert.equal(allState.response.status, 200);
  const powerLevelsEvent = allState.payload.find((event) => event.type === 'm.room.power_levels' && event.state_key === '');
  assert.ok(powerLevelsEvent);

  const redact = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(defaultRoom.room_id, `/redact/${encodeURIComponent(powerLevelsEvent.event_id)}/rv12-redact`),
    {},
  );
  assert.equal(redact.response.status, 200);

  const redactedPowerLevels = await getAuthenticated(
    harness,
    alice.access_token,
    roomPath(defaultRoom.room_id, `/event/${encodeURIComponent(powerLevelsEvent.event_id)}`),
  );
  assert.equal(redactedPowerLevels.response.status, 200);
  assert.deepEqual(redactedPowerLevels.payload?.content, {});
});
