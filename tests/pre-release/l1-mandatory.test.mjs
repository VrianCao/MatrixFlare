import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  getAuthenticated,
  putAuthenticated,
  registerUser,
  requestJson,
  requireRemoteHarnessContext,
} from '../shared/nonlocal/support.mjs';
import {
  CLIENT_DISCOVERY_VERSIONS,
} from '../../packages/testing/src/client-discovery.mjs';

test('pre-release harness drives deployed gateway smoke paths without importing local suites', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'pre-release');
  if (harness == null) {
    return;
  }

  const versions = await requestJson(harness, '/_matrix/client/versions');
  assert.equal(versions.response.status, 200);
  assert.deepEqual(versions.payload, {
    versions: [...CLIENT_DISCOVERY_VERSIONS],
    unstable_features: {},
  });

  const alice = await registerUser(harness, {
    usernamePrefix: 'pre-release-alice',
    deviceId: 'PRERELEASEALICE',
  });
  const roomId = await createRoom(harness, alice.access_token, 'Pre-release Remote Smoke');

  const sendResult = await putAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/pre-release-smoke`,
    {
      msgtype: 'm.text',
      body: 'pre-release smoke event',
    },
  );
  assert.equal(sendResult.response.status, 200);

  const whoAmI = await getAuthenticated(harness, alice.access_token, '/_matrix/client/v3/account/whoami');
  assert.equal(whoAmI.response.status, 200);
  assert.equal(typeof whoAmI.payload?.user_id, 'string');
});
