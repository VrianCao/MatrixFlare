import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authHeaders,
  createRoom,
  deleteAuthenticated,
  eventually,
  expectMatrixError,
  getAuthenticated,
  getJoinedRoomEntry,
  getStateEvents,
  joinRoom,
  loginWithPassword,
  refreshSession,
  registerUser,
  request,
  requireRemoteHarnessContext,
  syncRequest,
} from './support.mjs';

test('TEST-CS-001 ci-integration covers discovery, session lifecycle, and capability truth', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'ci-integration');
  if (harness == null) {
    return;
  }

  const availableLocalpart = `cs1-ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const loginFlows = await request(harness, '/_matrix/client/v3/login');
  assert.equal(loginFlows.response.status, 200);
  assert.deepEqual(loginFlows.payload?.flows, [{ type: 'm.login.password' }]);

  const registerFlows = await request(harness, '/_matrix/client/v3/register');
  assert.equal(registerFlows.response.status, 200);
  assert.deepEqual(registerFlows.payload?.flows, [{ stages: ['m.login.dummy'] }]);

  const registerFlowsCompatibility = await request(harness, '/_matrix/client/r0/register');
  assert.equal(registerFlowsCompatibility.response.status, 200);
  assert.deepEqual(registerFlowsCompatibility.payload?.flows, [{ stages: ['m.login.dummy'] }]);

  const availabilityBefore = await request(
    harness,
    `/_matrix/client/v3/register/available?username=${encodeURIComponent(availableLocalpart)}`,
  );
  assert.equal(availabilityBefore.response.status, 200);
  assert.deepEqual(availabilityBefore.payload, { available: true });

  const availabilityBeforeCompatibility = await request(
    harness,
    `/_matrix/client/r0/register/available?username=${encodeURIComponent(availableLocalpart)}`,
  );
  assert.equal(availabilityBeforeCompatibility.response.status, 200);
  assert.deepEqual(availabilityBeforeCompatibility.payload, { available: true });

  const tokenValidity = await request(
    harness,
    '/_matrix/client/v1/register/m.login.registration_token/validity?token=bogus',
  );
  assert.equal(tokenValidity.response.status, 200);
  assert.deepEqual(tokenValidity.payload, { valid: false });

  const registerChallenge = await request(harness, '/_matrix/client/v3/register', {
    method: 'POST',
    json: {},
  });
  assert.equal(registerChallenge.response.status, 401);
  assert.deepEqual(registerChallenge.payload?.flows, [{ stages: ['m.login.dummy'] }]);
  assert.deepEqual(registerChallenge.payload?.params, {});
  assert.deepEqual(registerChallenge.payload?.completed, []);
  assert.equal(typeof registerChallenge.payload?.session, 'string');

  const browserOrigin = 'https://app.element.io';
  const browserRegisterFlows = await request(harness, '/_matrix/client/v3/register', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(browserRegisterFlows.response.status, 200);
  assert.equal(browserRegisterFlows.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserRegisterFlows.response.headers.get('vary') ?? '', /Origin/i);

  const browserRegisterPreflight = await request(harness, '/_matrix/client/v3/register', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
  assert.equal(browserRegisterPreflight.response.status, 204);
  assert.equal(browserRegisterPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserRegisterPreflight.response.headers.get('access-control-allow-headers'), 'content-type,authorization');
  assert.match(browserRegisterPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
  assert.match(browserRegisterPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserRegisterPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs1-ci-alice',
    password: 'phase08-cs1-ci-password-1',
    deviceId: 'CS1CIALICE',
  });

  const availabilityAfter = await request(
    harness,
    `/_matrix/client/v3/register/available?username=${encodeURIComponent(alice.username)}`,
  );
  await expectMatrixError(availabilityAfter, 400, 'M_USER_IN_USE');

  const capabilities = await getAuthenticated(harness, alice.access_token, '/_matrix/client/v3/capabilities');
  assert.equal(capabilities.response.status, 200);
  assert.deepEqual(capabilities.payload?.capabilities, {
    'm.change_password': { enabled: true },
    'm.3pid_changes': { enabled: false },
    'm.get_login_token': { enabled: false },
    'm.profile_fields': { enabled: true },
    'm.set_avatar_url': { enabled: true },
    'm.set_displayname': { enabled: true },
  });

  const whoAmI = await getAuthenticated(harness, alice.access_token, '/_matrix/client/v3/account/whoami');
  assert.equal(whoAmI.response.status, 200);
  assert.equal(whoAmI.payload?.user_id, alice.user_id);
  assert.equal(whoAmI.payload?.device_id, 'CS1CIALICE');

  const refreshed = await refreshSession(harness, alice.refresh_token);
  assert.equal(refreshed.response.status, 200);
  assert.equal(typeof refreshed.payload?.access_token, 'string');
  assert.equal(typeof refreshed.payload?.refresh_token, 'string');
  assert.notEqual(refreshed.payload.access_token, alice.access_token);
  assert.notEqual(refreshed.payload.refresh_token, alice.refresh_token);

  const oldAccessAfterRefresh = await getAuthenticated(harness, alice.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(oldAccessAfterRefresh, 401, 'M_UNKNOWN_TOKEN');

  const logout = await request(harness, '/_matrix/client/v3/logout', {
    method: 'POST',
    headers: authHeaders(refreshed.payload.access_token),
  });
  assert.equal(logout.response.status, 200);
  assert.deepEqual(logout.payload, {});

  const afterLogout = await getAuthenticated(harness, refreshed.payload.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(afterLogout, 401, 'M_UNKNOWN_TOKEN');

  const loginAgain = await loginWithPassword(harness, {
    user: alice.username,
    password: 'phase08-cs1-ci-password-1',
    deviceId: 'CS1CILAPTOP',
  });
  assert.equal(loginAgain.response.status, 200);

  const logoutAll = await request(harness, '/_matrix/client/v3/logout/all', {
    method: 'POST',
    headers: authHeaders(loginAgain.payload.access_token),
  });
  assert.equal(logoutAll.response.status, 200);
  assert.deepEqual(logoutAll.payload, {});

  const afterLogoutAll = await getAuthenticated(harness, loginAgain.payload.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(afterLogoutAll, 401, 'M_UNKNOWN_TOKEN');
});

test('TEST-CS-001 ci-integration covers password-change UIA branches and deactivation', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'ci-integration');
  if (harness == null) {
    return;
  }

  const carol = await registerUser(harness, {
    usernamePrefix: 'cs1-ci-carol',
    password: 'phase08-cs1-ci-password-2',
    deviceId: 'CS1CICAROL',
  });

  const passwordChallenge = await request(harness, '/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: authHeaders(carol.access_token),
    json: {
      new_password: 'phase08-cs1-ci-password-3',
    },
  });
  assert.equal(passwordChallenge.response.status, 401);
  assert.deepEqual(passwordChallenge.payload?.flows, [{ stages: ['m.login.password'] }]);
  assert.equal(typeof passwordChallenge.payload?.session, 'string');

  const reusedOnDeactivate = await request(harness, '/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: authHeaders(carol.access_token),
    json: {
      erase: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallenge.payload.session,
        user: carol.username,
        password: 'phase08-cs1-ci-password-2',
      },
    },
  });
  assert.equal(reusedOnDeactivate.response.status, 401);
  assert.notEqual(reusedOnDeactivate.payload?.session, passwordChallenge.payload.session);

  const passwordChange = await request(harness, '/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: authHeaders(carol.access_token),
    json: {
      new_password: 'phase08-cs1-ci-password-3',
      logout_devices: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallenge.payload.session,
        user: carol.username,
        password: 'phase08-cs1-ci-password-2',
      },
    },
  });
  assert.equal(passwordChange.response.status, 200);
  assert.deepEqual(passwordChange.payload, {});

  const oldPasswordLogin = await loginWithPassword(harness, {
    user: carol.username,
    password: 'phase08-cs1-ci-password-2',
  });
  await expectMatrixError(oldPasswordLogin, 403, 'M_FORBIDDEN');

  const newPasswordLogin = await loginWithPassword(harness, {
    user: carol.username,
    password: 'phase08-cs1-ci-password-3',
    deviceId: 'CS1CICAROL2',
  });
  assert.equal(newPasswordLogin.response.status, 200);

  const tokenlessPasswordChallenge = await request(harness, '/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'phase08-cs1-ci-password-4',
      auth: {
        type: 'm.login.password',
        user: carol.username,
      },
    },
  });
  assert.equal(tokenlessPasswordChallenge.response.status, 401);
  assert.equal(typeof tokenlessPasswordChallenge.payload?.session, 'string');

  const tokenlessPasswordChange = await request(harness, '/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'phase08-cs1-ci-password-4',
      auth: {
        type: 'm.login.password',
        session: tokenlessPasswordChallenge.payload.session,
        user: carol.username,
        password: 'phase08-cs1-ci-password-3',
      },
    },
  });
  assert.equal(tokenlessPasswordChange.response.status, 200);
  assert.deepEqual(tokenlessPasswordChange.payload, {});

  const revokedOldAccess = await getAuthenticated(harness, newPasswordLogin.payload.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(revokedOldAccess, 401, 'M_UNKNOWN_TOKEN');

  const latestPasswordLogin = await loginWithPassword(harness, {
    user: carol.username,
    password: 'phase08-cs1-ci-password-4',
    deviceId: 'CS1CICAROL3',
  });
  assert.equal(latestPasswordLogin.response.status, 200);

  const deactivateChallenge = await request(harness, '/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: authHeaders(latestPasswordLogin.payload.access_token),
    json: {
      erase: true,
    },
  });
  assert.equal(deactivateChallenge.response.status, 401);
  assert.equal(typeof deactivateChallenge.payload?.session, 'string');

  const deactivate = await request(harness, '/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: authHeaders(latestPasswordLogin.payload.access_token),
    json: {
      erase: true,
      auth: {
        type: 'm.login.password',
        session: deactivateChallenge.payload.session,
        user: carol.username,
        password: 'phase08-cs1-ci-password-4',
      },
    },
  });
  assert.equal(deactivate.response.status, 200);
  assert.deepEqual(deactivate.payload, {
    id_server_unbind_result: 'success',
  });

  const loginAfterDeactivate = await loginWithPassword(harness, {
    user: carol.username,
    password: 'phase08-cs1-ci-password-4',
  });
  await expectMatrixError(loginAfterDeactivate, 403, 'M_USER_DEACTIVATED');
});

test('TEST-CS-001 ci-integration covers profile full reads, keyName GET/PUT/DELETE, and profile propagation', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'ci-integration');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs1-ci-profile-alice',
    deviceId: 'CS1CIPROFILEA',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'cs1-ci-profile-bob',
    deviceId: 'CS1CIPROFILEB',
  });

  const setDisplayName = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/displayname`,
    {
      method: 'PUT',
      headers: authHeaders(alice.access_token),
      json: {
        displayname: 'Alice Seed Profile',
      },
    },
  );
  assert.equal(setDisplayName.response.status, 200);

  const setAvatar = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/avatar_url`,
    {
      method: 'PUT',
      headers: authHeaders(alice.access_token),
      json: {
        avatar_url: 'mxc://matrix.example.test/cs1-ci-avatar',
      },
    },
  );
  assert.equal(setAvatar.response.status, 200);

  const setTimeZone = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/m.tz`,
    {
      method: 'PUT',
      headers: authHeaders(alice.access_token),
      json: {
        'm.tz': 'America/Los_Angeles',
      },
    },
  );
  assert.equal(setTimeZone.response.status, 200);

  const setCustomField = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/com.example.theme`,
    {
      method: 'PUT',
      headers: authHeaders(alice.access_token),
      json: {
        'com.example.theme': {
          palette: 'copper',
        },
      },
    },
  );
  assert.equal(setCustomField.response.status, 200);

  const fullProfile = await request(harness, `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}`);
  assert.equal(fullProfile.response.status, 200);
  assert.deepEqual(fullProfile.payload, {
    displayname: 'Alice Seed Profile',
    avatar_url: 'mxc://matrix.example.test/cs1-ci-avatar',
    'm.tz': 'America/Los_Angeles',
    'com.example.theme': {
      palette: 'copper',
    },
  });

  const displayNameField = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/displayname`,
  );
  assert.equal(displayNameField.response.status, 200);
  assert.deepEqual(displayNameField.payload, {
    displayname: 'Alice Seed Profile',
  });

  const room = await createRoom(harness, alice.access_token, {
    invite: [bob.user_id],
    name: 'CS 001 Profile Propagation CI',
  });
  await joinRoom(harness, bob.access_token, room.room_id);
  const bobBaselineSync = await syncRequest(harness, bob.access_token);

  const changeDisplayName = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/displayname`,
    {
      method: 'PUT',
      headers: authHeaders(alice.access_token),
      json: {
        displayname: 'Alice Propagated Profile',
      },
    },
  );
  assert.equal(changeDisplayName.response.status, 200);

  const deleteAvatar = await deleteAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/avatar_url`,
  );
  assert.equal(deleteAvatar.response.status, 200);

  await eventually(async () => {
    const bobIncrementalSync = await syncRequest(
      harness,
      bob.access_token,
      `since=${encodeURIComponent(bobBaselineSync.next_batch)}&timeout=0`,
    );
    const roomEntry = getJoinedRoomEntry(bobIncrementalSync, room.room_id);
    assert.ok(roomEntry);
    const memberEvents = getStateEvents(roomEntry)
      .filter((event) => event.type === 'm.room.member' && event.state_key === alice.user_id);
    const memberEvent = memberEvents.at(-1) ?? null;
    assert.ok(memberEvent);
    assert.equal(memberEvent.content?.displayname, 'Alice Propagated Profile');
    assert.equal('avatar_url' in (memberEvent.content ?? {}), false);
  });

  const profileAfterDelete = await request(harness, `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}`);
  assert.equal(profileAfterDelete.response.status, 200);
  assert.deepEqual(profileAfterDelete.payload, {
    displayname: 'Alice Propagated Profile',
    'm.tz': 'America/Los_Angeles',
    'com.example.theme': {
      palette: 'copper',
    },
  });

  const avatarAfterDelete = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/avatar_url`,
  );
  await expectMatrixError(avatarAfterDelete, 404, 'M_NOT_FOUND');

  const deleteCustomField = await deleteAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/com.example.theme`,
  );
  assert.equal(deleteCustomField.response.status, 200);

  const customFieldAfterDelete = await request(
    harness,
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/com.example.theme`,
  );
  await expectMatrixError(customFieldAfterDelete, 404, 'M_NOT_FOUND');
});
