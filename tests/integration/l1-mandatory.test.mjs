import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  postAuthenticated,
  putAuthenticated,
  registerUser,
  requestJson,
  requireRemoteHarnessContext,
} from '../shared/nonlocal/support.mjs';
import {
  CLIENT_DISCOVERY_VERSIONS,
} from '../../packages/testing/src/client-discovery.mjs';

test('ci-integration harness drives remote client and room smoke paths against a deployed environment', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'ci-integration');
  if (harness == null) {
    return;
  }

  const versions = await requestJson(harness, '/_matrix/client/versions');
  assert.equal(versions.response.status, 200);
  assert.deepEqual(versions.payload, {
    versions: [...CLIENT_DISCOVERY_VERSIONS],
    unstable_features: {},
  });

  const loginFlows = await requestJson(harness, '/_matrix/client/v3/login');
  assert.equal(loginFlows.response.status, 200);
  assert.ok(Array.isArray(loginFlows.payload?.flows));

  const alice = await registerUser(harness, {
    usernamePrefix: 'ci-int-alice',
    deviceId: 'CIINTALICE',
  });
  const roomId = await createRoom(harness, alice.access_token, 'CI Integration Remote Smoke');

  const sendResult = await putAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/ci-integration-smoke`,
    {
      msgtype: 'm.text',
      body: 'ci-integration smoke event',
    },
  );
  assert.equal(sendResult.response.status, 200);
  assert.equal(typeof sendResult.payload?.event_id, 'string');

  const publicRooms = await postAuthenticated(harness, alice.access_token, '/_matrix/client/v3/publicRooms', {
    limit: 5,
  });
  assert.equal(publicRooms.response.status, 200);
  assert.ok(Array.isArray(publicRooms.payload?.chunk));
});
