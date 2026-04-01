import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  getAuthenticated,
  postAuthenticated,
  putAuthenticated,
  registerUser,
  requestJson,
  requireRemoteHarnessContext,
} from '../shared/nonlocal/support.mjs';

test('staging harness drives remote sync, media, and derived smoke paths against a deployed environment', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'staging-alice',
    deviceId: 'STAGINGALICE',
  });
  const roomId = await createRoom(harness, alice.access_token, 'Staging Remote Smoke');

  const sendResult = await putAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/staging-smoke`,
    {
      msgtype: 'm.text',
      body: 'staging smoke event',
    },
  );
  assert.equal(sendResult.response.status, 200);

  const syncResult = await getAuthenticated(
    harness,
    alice.access_token,
    '/_matrix/client/v3/sync?timeout=0&set_presence=offline',
  );
  assert.equal(syncResult.response.status, 200);
  assert.equal(typeof syncResult.payload?.next_batch, 'string');

  const mediaReservation = await postAuthenticated(harness, alice.access_token, '/_matrix/media/v3/create');
  assert.equal(mediaReservation.response.status, 200);
  assert.equal(typeof mediaReservation.payload?.content_uri, 'string');

  const publicRooms = await requestJson(harness, '/_matrix/client/v3/publicRooms?limit=5');
  assert.equal(publicRooms.response.status, 200);
  assert.ok(Array.isArray(publicRooms.payload?.chunk));
});
