import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayPhase04Rig } from './support.mjs';

async function expectMatrixError(response, status, errcode) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.errcode, errcode);
  return body;
}

async function createRegisterChallenge(rig, {
  username,
  password,
  deviceId = 'DEVICE1',
} = {}) {
  const challengeResponse = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(challengeResponse.status, 401);
  const challengeBody = await challengeResponse.json();
  assert.deepEqual(challengeBody.flows, [{ stages: ['m.login.dummy'] }]);
  return challengeBody;
}

async function registerViaUia(rig, {
  username,
  password,
  deviceId = 'DEVICE1',
} = {}) {
  const challengeBody = await createRegisterChallenge(rig, {
    username,
    password,
    deviceId,
  });
  const registerResponse = await rig.gatewayFetch('/_matrix/client/v3/register', {
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
  assert.equal(registerResponse.status, 200);
  return registerResponse.json();
}

async function loginWithPassword(rig, {
  user,
  password,
  deviceId = null,
} = {}) {
  const response = await rig.gatewayFetch('/_matrix/client/v3/login', {
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
  return response;
}

test('Phase 04 discovery surfaces return spec-aligned truth', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const clientWellKnown = await rig.gatewayFetch('/.well-known/matrix/client');
  assert.equal(clientWellKnown.status, 200);
  assert.equal(clientWellKnown.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepEqual(await clientWellKnown.json(), {
    'm.homeserver': {
      base_url: 'https://matrix.example.test',
    },
  });

  const serverWellKnown = await rig.gatewayFetch('/.well-known/matrix/server');
  assert.equal(serverWellKnown.status, 200);
  assert.deepEqual(await serverWellKnown.json(), {
    'm.server': 'matrix.example.test',
  });

  const versions = await rig.gatewayFetch('/_matrix/client/versions');
  assert.equal(versions.status, 200);
  assert.deepEqual(await versions.json(), {
    versions: ['v1.17'],
    unstable_features: {},
  });

  const availability = await rig.gatewayFetch('/_matrix/client/v3/register/available?username=alice');
  assert.equal(availability.status, 200);
  assert.equal(availability.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await availability.json(), { available: true });

  const tokenValidity = await rig.gatewayFetch('/_matrix/client/v1/register/m.login.registration_token/validity?token=bogus');
  assert.equal(tokenValidity.status, 200);
  assert.deepEqual(await tokenValidity.json(), { valid: false });
});

test('Phase 04 session lifecycle covers register, login, refresh, logout, whoami, and capabilities', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const loginFlows = await rig.gatewayFetch('/_matrix/client/v3/login');
  assert.equal(loginFlows.status, 200);
  assert.deepEqual(await loginFlows.json(), {
    flows: [{ type: 'm.login.password' }],
  });

  const registrationChallenge = await createRegisterChallenge(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const registrationRequest = {
    username: 'alice',
    password: 'correct horse battery staple',
    device_id: 'ALICEPHONE',
    auth: {
      type: 'm.login.dummy',
      session: registrationChallenge.session,
    },
  };
  const registrationResponse = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: registrationRequest,
  });
  assert.equal(registrationResponse.status, 200);
  const registration = await registrationResponse.json();
  assert.equal(registration.user_id, '@alice:matrix.example.test');
  assert.equal(registration.device_id, 'ALICEPHONE');
  assert.equal(typeof registration.access_token, 'string');
  assert.equal(typeof registration.refresh_token, 'string');

  const registrationRetry = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: registrationRequest,
  });
  assert.equal(registrationRetry.status, 200);
  assert.deepEqual(await registrationRetry.json(), registration);

  rig.env.SESSION_ROOT_KEY_RING = JSON.stringify({
    active: 'v3',
    keys: {
      v3: { secret_text: 'phase04-session-root-v3' },
      v2: { secret_text: 'phase04-session-root-v2' },
      v1: { secret_text: 'phase04-session-root-v1' },
    },
  });
  const registrationRetryAfterKeyRotation = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: registrationRequest,
  });
  assert.equal(registrationRetryAfterKeyRotation.status, 200);
  assert.deepEqual(await registrationRetryAfterKeyRotation.json(), registration);

  const aliceUserDo = rig.getUserDo('alice');
  await aliceUserDo.ensureSchema();
  assert.equal(aliceUserDo.persistence.sessions.list().length, 1);

  const availabilityAfterRegister = await rig.gatewayFetch('/_matrix/client/v3/register/available?username=alice');
  await expectMatrixError(availabilityAfterRegister, 400, 'M_USER_IN_USE');

  const capabilitiesWithoutToken = await rig.gatewayFetch('/_matrix/client/v3/capabilities');
  await expectMatrixError(capabilitiesWithoutToken, 401, 'M_MISSING_TOKEN');

  const capabilities = await rig.gatewayFetch('/_matrix/client/v3/capabilities', {
    headers: rig.authHeaders(registration.access_token),
  });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    capabilities: {
      'm.change_password': { enabled: true },
      'm.3pid_changes': { enabled: false },
      'm.get_login_token': { enabled: false },
      'm.profile_fields': { enabled: false, allowed: [] },
      'm.set_avatar_url': { enabled: false },
      'm.set_displayname': { enabled: false },
    },
  });

  const whoAmI = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(registration.access_token),
  });
  assert.equal(whoAmI.status, 200);
  assert.deepEqual(await whoAmI.json(), {
    user_id: '@alice:matrix.example.test',
    device_id: 'ALICEPHONE',
    is_guest: false,
  });

  const unsupportedLoginType = await rig.gatewayFetch('/_matrix/client/v3/login', {
    method: 'POST',
    json: {
      type: 'm.login.token',
      token: 'disabled-flow-token',
    },
  });
  await expectMatrixError(unsupportedLoginType, 400, 'M_UNKNOWN');

  const wrongPasswordLogin = await loginWithPassword(rig, {
    user: 'alice',
    password: 'incorrect password',
  });
  await expectMatrixError(wrongPasswordLogin, 403, 'M_FORBIDDEN');

  const refreshed = await rig.gatewayFetch('/_matrix/client/v3/refresh', {
    method: 'POST',
    json: {
      refresh_token: registration.refresh_token,
    },
  });
  assert.equal(refreshed.status, 200);
  const refreshedBody = await refreshed.json();
  assert.equal(typeof refreshedBody.access_token, 'string');
  assert.equal(typeof refreshedBody.refresh_token, 'string');
  assert.notEqual(refreshedBody.access_token, registration.access_token);
  assert.notEqual(refreshedBody.refresh_token, registration.refresh_token);

  const oldAccessAfterRefresh = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(registration.access_token),
  });
  await expectMatrixError(oldAccessAfterRefresh, 401, 'M_UNKNOWN_TOKEN');

  const oldRefreshAfterRefresh = await rig.gatewayFetch('/_matrix/client/v3/refresh', {
    method: 'POST',
    json: {
      refresh_token: registration.refresh_token,
    },
  });
  await expectMatrixError(oldRefreshAfterRefresh, 401, 'M_UNKNOWN_TOKEN');

  const logout = await rig.gatewayFetch('/_matrix/client/v3/logout', {
    method: 'POST',
    headers: rig.authHeaders(refreshedBody.access_token),
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), {});

  const whoAmIAfterLogout = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(refreshedBody.access_token),
  });
  await expectMatrixError(whoAmIAfterLogout, 401, 'M_UNKNOWN_TOKEN');

  const loginAgain = await loginWithPassword(rig, {
    user: '@alice:matrix.example.test',
    password: 'correct horse battery staple',
    deviceId: 'ALICELAPTOP',
  });
  assert.equal(loginAgain.status, 200);
  const loginAgainBody = await loginAgain.json();

  const logoutAll = await rig.gatewayFetch('/_matrix/client/v3/logout/all', {
    method: 'POST',
    headers: rig.authHeaders(loginAgainBody.access_token),
  });
  assert.equal(logoutAll.status, 200);
  assert.deepEqual(await logoutAll.json(), {});

  const whoAmIAfterLogoutAll = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(loginAgainBody.access_token),
  });
  await expectMatrixError(whoAmIAfterLogoutAll, 401, 'M_UNKNOWN_TOKEN');
});

test('Phase 04 UIA routes enforce route binding, tokenless password UIA, and deactivation erase semantics', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const registerChallenge = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username: 'bound-user',
      password: 'secret-bound',
    },
  });
  assert.equal(registerChallenge.status, 401);
  const registerChallengeBody = await registerChallenge.json();

  const mismatchedRegister = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username: 'different-user',
      password: 'secret-bound',
      auth: {
        type: 'm.login.dummy',
        session: registerChallengeBody.session,
      },
    },
  });
  await expectMatrixError(mismatchedRegister, 403, 'M_FORBIDDEN');

  const registration = await registerViaUia(rig, {
    username: 'bob',
    password: 'secret-one',
    deviceId: 'BOBPHONE',
  });

  const passwordChallenge = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two',
    },
  });
  assert.equal(passwordChallenge.status, 401);
  const passwordChallengeBody = await passwordChallenge.json();
  assert.deepEqual(passwordChallengeBody.flows, [{ stages: ['m.login.password'] }]);

  const reusedOnDeactivate = await rig.gatewayFetch('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      erase: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallengeBody.session,
        user: 'bob',
        password: 'secret-one',
      },
    },
  });
  assert.equal(reusedOnDeactivate.status, 401);
  const reusedBody = await reusedOnDeactivate.json();
  assert.deepEqual(reusedBody.flows, [{ stages: ['m.login.password'] }]);
  assert.notEqual(reusedBody.session, passwordChallengeBody.session);

  const passwordChange = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two',
      logout_devices: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallengeBody.session,
        user: 'bob',
        password: 'secret-one',
      },
    },
  });
  assert.equal(passwordChange.status, 200);
  assert.deepEqual(await passwordChange.json(), {});

  const oldPasswordLogin = await loginWithPassword(rig, {
    user: 'bob',
    password: 'secret-one',
  });
  await expectMatrixError(oldPasswordLogin, 403, 'M_FORBIDDEN');

  const newPasswordLogin = await loginWithPassword(rig, {
    user: 'bob',
    password: 'secret-two',
    deviceId: 'BOBLAPTOP',
  });
  assert.equal(newPasswordLogin.status, 200);
  const newPasswordLoginBody = await newPasswordLogin.json();

  const tokenlessPasswordChallengeMissingSubject = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'secret-three',
    },
  });
  await expectMatrixError(tokenlessPasswordChallengeMissingSubject, 400, 'M_MISSING_PARAM');

  const tokenlessPasswordChallenge = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'secret-three',
      auth: {
        type: 'm.login.password',
        user: 'bob',
      },
    },
  });
  assert.equal(tokenlessPasswordChallenge.status, 401);
  const tokenlessPasswordChallengeBody = await tokenlessPasswordChallenge.json();

  const tokenlessPasswordChange = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'secret-three',
      auth: {
        type: 'm.login.password',
        session: tokenlessPasswordChallengeBody.session,
        user: 'bob',
        password: 'secret-two',
      },
    },
  });
  assert.equal(tokenlessPasswordChange.status, 200);
  assert.deepEqual(await tokenlessPasswordChange.json(), {});

  const sessionAfterTokenlessChange = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(newPasswordLoginBody.access_token),
  });
  await expectMatrixError(sessionAfterTokenlessChange, 401, 'M_UNKNOWN_TOKEN');

  const secondPasswordLogin = await loginWithPassword(rig, {
    user: 'bob',
    password: 'secret-three',
    deviceId: 'BOBTABLET',
  });
  assert.equal(secondPasswordLogin.status, 200);
  const secondPasswordLoginBody = await secondPasswordLogin.json();

  const userDo = rig.getUserDo('@bob:matrix.example.test');
  await userDo.ensureSchema();
  userDo.persistence.globalAccountData.put({
    type: 'm.ignored_user_list',
    content_hash: 'hash-1',
    updated_at: new Date().toISOString(),
    content_json: { ignored_users: {} },
  });
  userDo.persistence.roomAccountData.put({
    room_id: '!room:matrix.example.test',
    type: 'm.tag',
    content_hash: 'hash-2',
    updated_at: new Date().toISOString(),
    content_json: { work: { order: 0.1 } },
  });
  userDo.persistence.presence.put({
    user_id: '@bob:matrix.example.test',
    presence: 'online',
    status_msg: 'Working',
    currently_active: true,
    last_active_at: new Date().toISOString(),
    presence_version: 1,
    updated_at: new Date().toISOString(),
    record_json: {},
  });
  userDo.persistence.profileDocument.put({
    key_name: 'displayname',
    profile_version: 1,
    updated_at: new Date().toISOString(),
    value_json: 'Bob',
    record_json: {},
  });
  userDo.persistence.pushRules.put({
    scope: 'global',
    kind: 'override',
    rule_id: 'rule.bob',
    enabled: true,
    priority_class: 'user',
    priority_index: 0,
    updated_at: new Date().toISOString(),
    actions_json: ['notify'],
    conditions_json: [],
    record_json: {},
  });

  const deactivateChallenge = await rig.gatewayFetch('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: rig.authHeaders(secondPasswordLoginBody.access_token),
    json: {
      erase: true,
    },
  });
  assert.equal(deactivateChallenge.status, 401);
  const deactivateChallengeBody = await deactivateChallenge.json();

  const deactivate = await rig.gatewayFetch('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: rig.authHeaders(secondPasswordLoginBody.access_token),
    json: {
      erase: true,
      auth: {
        type: 'm.login.password',
        session: deactivateChallengeBody.session,
        user: 'bob',
        password: 'secret-three',
      },
    },
  });
  assert.equal(deactivate.status, 200);
  assert.deepEqual(await deactivate.json(), {
    id_server_unbind_result: 'success',
  });

  const loginAfterDeactivate = await loginWithPassword(rig, {
    user: 'bob',
    password: 'secret-three',
  });
  await expectMatrixError(loginAfterDeactivate, 403, 'M_USER_DEACTIVATED');

  const whoAmIAfterDeactivate = await rig.gatewayFetch('/_matrix/client/v3/account/whoami', {
    headers: rig.authHeaders(secondPasswordLoginBody.access_token),
  });
  await expectMatrixError(whoAmIAfterDeactivate, 401, 'M_UNKNOWN_TOKEN');

  const principal = userDo.persistence.userPrincipal.get();
  assert.equal(Boolean(principal.deactivated_at_or_null), true);
  assert.equal(principal.erase_requested_flag, true);
  assert.equal(userDo.persistence.globalAccountData.list().length, 0);
  assert.equal(userDo.persistence.roomAccountData.list().length, 0);
  assert.equal(userDo.persistence.presence.list().length, 0);
  assert.equal(userDo.persistence.profileDocument.list().length, 0);
  assert.equal(userDo.persistence.pushRules.list().length, 0);
});

test('Phase 04 deterministic stubs short-circuit before auth and discoverability stays closed', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const registration = await registerViaUia(rig, {
    username: 'carol',
    password: 'secret-carol',
    deviceId: 'CAROLPHONE',
  });

  for (const [method, path] of [
    ['GET', '/_matrix/client/v1/auth_metadata'],
    ['POST', '/_matrix/client/v1/login/get_token'],
    ['GET', '/_matrix/client/v3/account/3pid'],
    ['GET', '/_matrix/client/v3/joined_rooms'],
    ['GET', '/_matrix/client/v3/notifications'],
    ['GET', '/_matrix/client/v3/voip/turnServer'],
    ['GET', '/_matrix/client/v3/events'],
  ]) {
    const response = await rig.gatewayFetch(path, {
      method,
      headers: rig.authHeaders('atk.invalid.token'),
    });
    const body = await expectMatrixError(response, 404, 'M_UNRECOGNIZED');
    assert.equal(body.error, 'Unrecognized or unsupported endpoint');
  }

  const loginFlows = await rig.gatewayFetch('/_matrix/client/v3/login');
  const loginBody = await loginFlows.json();
  assert.deepEqual(loginBody.flows, [{ type: 'm.login.password' }]);

  const capabilities = await rig.gatewayFetch('/_matrix/client/v3/capabilities', {
    headers: rig.authHeaders(registration.access_token),
  });
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilitiesBody.capabilities['m.3pid_changes'].enabled, false);
  assert.equal(capabilitiesBody.capabilities['m.get_login_token'].enabled, false);
});

test('Phase 04 registration policy can fail closed when disabled', async (t) => {
  const rig = createGatewayPhase04Rig({
    MATRIX_REGISTRATION_ENABLED: 'false',
  });
  t.after(() => rig.close());

  const availability = await rig.gatewayFetch('/_matrix/client/v3/register/available?username=closed');
  await expectMatrixError(availability, 403, 'M_FORBIDDEN');

  const validity = await rig.gatewayFetch('/_matrix/client/v1/register/m.login.registration_token/validity?token=any');
  await expectMatrixError(validity, 403, 'M_FORBIDDEN');
});
