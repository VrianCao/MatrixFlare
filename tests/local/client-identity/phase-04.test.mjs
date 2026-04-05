import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { parseSessionRootKeyRing } from '../../../packages/runtime-core/src/user-identity.mjs';
import { createGatewayPhase04Rig } from './support.mjs';

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
  assert.throws(() => JSON.parse(Buffer.from(parts[3], 'base64url').toString('utf8')));
}

function createLegacySignedUiaSessionToken({
  secretValue,
  routeFamily,
  method,
  authSubjectHint = null,
  nonce = 'uia_legacy_rollout_overlap',
  now = new Date().toISOString(),
  ttlMs = 5 * 60 * 1000,
}) {
  const ring = parseSessionRootKeyRing(secretValue);
  const payload = {
    route_family: routeFamily,
    method,
    issued_at: now,
    expires_at: new Date(Date.parse(now) + ttlMs).toISOString(),
    auth_subject_hint: authSubjectHint,
    completed_stages: [],
    nonce,
    root_key_version: ring.active_version,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `uia.${ring.active_version}.${encodedPayload}`;
  const signature = createHmac('sha256', ring.keys[ring.active_version]).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
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
  assertOpaqueUiaSessionToken(challengeBody.session);
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

  const registerFlows = await rig.gatewayFetch('/_matrix/client/v3/register');
  assert.equal(registerFlows.status, 200);
  assert.equal(registerFlows.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await registerFlows.json(), {
    flows: [{ stages: ['m.login.dummy'] }],
  });

  const registerFlowsR0 = await rig.gatewayFetch('/_matrix/client/r0/register');
  assert.equal(registerFlowsR0.status, 200);
  assert.equal(registerFlowsR0.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await registerFlowsR0.json(), {
    flows: [{ stages: ['m.login.dummy'] }],
  });

  const registerFlowsV1 = await rig.gatewayFetch('/_matrix/client/v1/register');
  assert.equal(registerFlowsV1.status, 200);
  assert.equal(registerFlowsV1.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await registerFlowsV1.json(), {
    flows: [{ stages: ['m.login.dummy'] }],
  });

  const availability = await rig.gatewayFetch('/_matrix/client/v3/register/available?username=alice');
  assert.equal(availability.status, 200);
  assert.equal(availability.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await availability.json(), { available: true });

  const availabilityR0 = await rig.gatewayFetch('/_matrix/client/r0/register/available?username=alice');
  assert.equal(availabilityR0.status, 200);
  assert.equal(availabilityR0.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await availabilityR0.json(), { available: true });

  const tokenValidity = await rig.gatewayFetch('/_matrix/client/v1/register/m.login.registration_token/validity?token=bogus');
  assert.equal(tokenValidity.status, 200);
  assert.deepEqual(await tokenValidity.json(), { valid: false });
});

test('Phase 04 discovery and login surfaces serve browser CORS and preflight truth', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const browserOrigin = 'https://app.element.io';
  const versions = await rig.gatewayFetch('/_matrix/client/versions', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(versions.status, 200);
  assert.equal(versions.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(versions.headers.get('vary') ?? '', /Origin/i);

  const loginFlows = await rig.gatewayFetch('/_matrix/client/v3/login', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(loginFlows.status, 200);
  assert.equal(loginFlows.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(loginFlows.headers.get('vary') ?? '', /Origin/i);

  const registerFlows = await rig.gatewayFetch('/_matrix/client/v3/register', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(registerFlows.status, 200);
  assert.equal(registerFlows.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(registerFlows.headers.get('vary') ?? '', /Origin/i);

  const clientWellKnown = await rig.gatewayFetch('/.well-known/matrix/client', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(clientWellKnown.status, 200);
  assert.equal(clientWellKnown.headers.get('access-control-allow-origin'), browserOrigin);

  const serverWellKnown = await rig.gatewayFetch('/.well-known/matrix/server', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(serverWellKnown.status, 200);
  assert.equal(serverWellKnown.headers.get('access-control-allow-origin'), null);

  const preflight = await rig.gatewayFetch('/_matrix/client/v3/login', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type,authorization');
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
  assert.match(preflight.headers.get('vary') ?? '', /Origin/i);
  assert.match(preflight.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const missingUsername = await rig.gatewayFetch('/_matrix/client/v3/register/available', {
    headers: {
      origin: browserOrigin,
    },
  });
  assert.equal(missingUsername.status, 400);
  assert.equal(missingUsername.headers.get('access-control-allow-origin'), browserOrigin);
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
  const capturedResolveSessionRequests = [];
  const originalResolveSession = aliceUserDo.resolveSession.bind(aliceUserDo);
  aliceUserDo.resolveSession = async (request) => {
    capturedResolveSessionRequests.push(request);
    return originalResolveSession(request);
  };

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
      'm.profile_fields': { enabled: true },
      'm.set_avatar_url': { enabled: true },
      'm.set_displayname': { enabled: true },
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
  assert.ok(capturedResolveSessionRequests.length >= 2);
  for (const envelope of capturedResolveSessionRequests) {
    assert.equal(typeof envelope.access_token_hash, 'string');
    assert.match(envelope.presented_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal('access_token' in envelope, false);
  }

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
  assertOpaqueUiaSessionToken(passwordChallengeBody.session);

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

  const passwordChangeReplay = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
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
  assert.equal(passwordChangeReplay.status, 200);
  assert.deepEqual(await passwordChangeReplay.json(), {});

  const passwordChangeReplayConflict = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two-conflict',
      logout_devices: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallengeBody.session,
        user: 'bob',
        password: 'secret-one',
      },
    },
  });
  await expectMatrixError(passwordChangeReplayConflict, 409, 'M_CONFLICT');

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
  assertOpaqueUiaSessionToken(tokenlessPasswordChallengeBody.session);

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
  assertOpaqueUiaSessionToken(deactivateChallengeBody.session);

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

  const deactivateReplay = await rig.gatewayFetch('/_matrix/client/v3/account/deactivate', {
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
  assert.equal(deactivateReplay.status, 200);
  assert.deepEqual(await deactivateReplay.json(), {
    id_server_unbind_result: 'success',
  });

  const deactivateReplayConflict = await rig.gatewayFetch('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    headers: rig.authHeaders(secondPasswordLoginBody.access_token),
    json: {
      erase: false,
      auth: {
        type: 'm.login.password',
        session: deactivateChallengeBody.session,
        user: 'bob',
        password: 'secret-three',
      },
    },
  });
  await expectMatrixError(deactivateReplayConflict, 409, 'M_CONFLICT');

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

test('Phase 04 password change fingerprint normalizes omitted logout_devices to true', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const registration = await registerViaUia(rig, {
    username: 'dave',
    password: 'secret-one',
    deviceId: 'DAVEPHONE',
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
  assertOpaqueUiaSessionToken(passwordChallengeBody.session);

  const passwordChange = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two',
      auth: {
        type: 'm.login.password',
        session: passwordChallengeBody.session,
        user: 'dave',
        password: 'secret-one',
      },
    },
  });
  assert.equal(passwordChange.status, 200);
  assert.deepEqual(await passwordChange.json(), {});

  const replayWithExplicitTrue = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two',
      logout_devices: true,
      auth: {
        type: 'm.login.password',
        session: passwordChallengeBody.session,
        user: 'dave',
        password: 'secret-one',
      },
    },
  });
  assert.equal(replayWithExplicitTrue.status, 200);
  assert.deepEqual(await replayWithExplicitTrue.json(), {});

  const replayWithExplicitFalse = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two',
      logout_devices: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallengeBody.session,
        user: 'dave',
        password: 'secret-one',
      },
    },
  });
  await expectMatrixError(replayWithExplicitFalse, 409, 'M_CONFLICT');
});

test('Phase 04 legacy UIA tokens remain valid during session-secret to UIA-secret rollout overlap', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  assert.notEqual(rig.env.SESSION_ROOT_KEY_RING, rig.env.UIA_ROOT_KEY_RING);

  const registration = await registerViaUia(rig, {
    username: 'erin',
    password: 'secret-one',
    deviceId: 'ERINPHONE',
  });

  const legacySessionToken = createLegacySignedUiaSessionToken({
    secretValue: rig.env.SESSION_ROOT_KEY_RING,
    routeFamily: 'account/password',
    method: 'POST',
    authSubjectHint: '@erin:matrix.example.test',
  });

  const passwordChange = await rig.gatewayFetch('/_matrix/client/v3/account/password', {
    method: 'POST',
    headers: rig.authHeaders(registration.access_token),
    json: {
      new_password: 'secret-two',
      auth: {
        type: 'm.login.password',
        session: legacySessionToken,
        user: 'erin',
        password: 'secret-one',
      },
    },
  });
  assert.equal(passwordChange.status, 200);
  assert.deepEqual(await passwordChange.json(), {});

  const oldPasswordLogin = await loginWithPassword(rig, {
    user: 'erin',
    password: 'secret-one',
  });
  await expectMatrixError(oldPasswordLogin, 403, 'M_FORBIDDEN');

  const newPasswordLogin = await loginWithPassword(rig, {
    user: 'erin',
    password: 'secret-two',
  });
  assert.equal(newPasswordLogin.status, 200);
});

test('Phase 04 deterministic stubs short-circuit before auth and discoverability stays closed', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const registration = await registerViaUia(rig, {
    username: 'carol',
    password: 'secret-carol',
    deviceId: 'CAROLPHONE',
  });

  const stubbedRoutes = [
    // IF-CS-065
    ['GET', '/_matrix/client/v1/auth_metadata', null],
    // IF-CS-059
    ['GET', '/_matrix/client/v3/login/sso/redirect', null],
    ['GET', '/_matrix/client/v3/login/sso/redirect/example', null],
    ['POST', '/_matrix/client/v1/login/get_token', { type: 'm.login.token' }],
    // IF-CS-007
    ['POST', '/_matrix/client/v3/register/email/requestToken', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/register/msisdn/requestToken', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/account/password/email/requestToken', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/account/password/msisdn/requestToken', { client_secret: 'disabled' }],
    // IF-CS-053
    ['GET', '/_matrix/client/v3/joined_rooms', null],
    ['GET', '/_matrix/client/v3/directory/room/room-alias', null],
    ['PUT', '/_matrix/client/v3/directory/room/room-alias', { visibility: 'public' }],
    ['DELETE', '/_matrix/client/v3/directory/room/room-alias', null],
    ['GET', '/_matrix/client/v3/rooms/room-id/aliases', null],
    ['GET', '/_matrix/client/v3/directory/list/room/room-id', null],
    ['PUT', '/_matrix/client/v3/directory/list/room/room-id', { visibility: 'public' }],
    ['GET', '/_matrix/client/v1/room_summary/room-id', null],
    // IF-CS-054
    ['GET', '/_matrix/client/v3/notifications', null],
    // IF-CS-055
    ['GET', '/_matrix/client/v3/pushers', null],
    ['POST', '/_matrix/client/v3/pushers/set', { pushkey: 'disabled' }],
    // IF-CS-056
    ['POST', '/_matrix/client/v3/rooms/room-id/upgrade', { new_version: '12' }],
    // IF-CS-057
    ['POST', '/_matrix/client/v3/rooms/room-id/report', { reason: 'disabled' }],
    ['POST', '/_matrix/client/v3/rooms/room-id/report/event-id', { reason: 'disabled' }],
    ['POST', '/_matrix/client/v3/users/@user:matrix.example.test/report', { reason: 'disabled' }],
    // IF-CS-058
    ['GET', '/_matrix/client/v1/media/preview_url', null],
    ['GET', '/_matrix/media/v3/preview_url', null],
    // IF-CS-060
    ['GET', '/_matrix/client/v3/account/3pid', null],
    ['POST', '/_matrix/client/v3/account/3pid', { threepids: [] }],
    ['POST', '/_matrix/client/v3/account/3pid/add', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/account/3pid/bind', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/account/3pid/delete', { address: 'disabled@example.test' }],
    ['POST', '/_matrix/client/v3/account/3pid/email/requestToken', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/account/3pid/msisdn/requestToken', { client_secret: 'disabled' }],
    ['POST', '/_matrix/client/v3/account/3pid/unbind', { address: 'disabled@example.test' }],
    // IF-CS-061
    ['GET', '/_matrix/client/v3/thirdparty/protocols', null],
    ['GET', '/_matrix/client/v3/thirdparty/protocol/irc', null],
    ['GET', '/_matrix/client/v3/thirdparty/location', null],
    ['GET', '/_matrix/client/v3/thirdparty/location/irc', null],
    ['GET', '/_matrix/client/v3/thirdparty/user', null],
    ['GET', '/_matrix/client/v3/thirdparty/user/irc', null],
    ['GET', '/_matrix/client/v3/admin/whois/@user:matrix.example.test', null],
    // IF-CS-062
    ['POST', '/_matrix/client/v3/user/@user:matrix.example.test/openid/request_token', { duration_seconds: 3600 }],
    // IF-CS-063
    ['GET', '/_matrix/client/v3/voip/turnServer', null],
    // IF-CS-064
    ['GET', '/_matrix/client/v3/events', null],
    ['GET', '/_matrix/client/v3/events/event-id', null],
    ['GET', '/_matrix/client/v3/initialSync', null],
    ['GET', '/_matrix/client/v3/rooms/room-id/initialSync', null],
  ];

  for (const [method, path, json] of stubbedRoutes) {
    const response = await rig.gatewayFetch(path, {
      method,
      headers: rig.authHeaders('atk.invalid.token'),
      json,
    });
    const body = await expectMatrixError(response, 404, 'M_UNRECOGNIZED');
    assert.equal(body.error, 'Unrecognized or unsupported endpoint');
  }

  const originalUserDo = rig.env.USER_DO;
  rig.env.USER_DO = {
    idFromName() {
      throw new Error('stubbed routes must short-circuit before Durable Object resolution');
    },
    get() {
      throw new Error('stubbed routes must short-circuit before Durable Object resolution');
    },
  };
  for (const [method, path, json] of stubbedRoutes) {
    const response = await rig.gatewayFetch(path, {
      method,
      headers: rig.authHeaders(registration.access_token),
      json,
    });
    const body = await expectMatrixError(response, 404, 'M_UNRECOGNIZED');
    assert.equal(body.error, 'Unrecognized or unsupported endpoint');
  }
  rig.env.USER_DO = originalUserDo;

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

  const registerFlows = await rig.gatewayFetch('/_matrix/client/v3/register');
  await expectMatrixError(registerFlows, 403, 'M_FORBIDDEN');

  const availability = await rig.gatewayFetch('/_matrix/client/v3/register/available?username=closed');
  await expectMatrixError(availability, 403, 'M_FORBIDDEN');

  const validity = await rig.gatewayFetch('/_matrix/client/v1/register/m.login.registration_token/validity?token=any');
  await expectMatrixError(validity, 403, 'M_FORBIDDEN');
});

test('Phase 04 registration discovery does not overstate UIA stages when tokens are required', async (t) => {
  const rig = createGatewayPhase04Rig({
    MATRIX_REGISTRATION_TOKENS: 'invite-a, invite-b',
  });
  t.after(() => rig.close());

  const registerFlows = await rig.gatewayFetch('/_matrix/client/v3/register');
  assert.equal(registerFlows.status, 200);
  assert.equal(registerFlows.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await registerFlows.json(), {
    flows: [{ stages: ['m.login.dummy'] }],
  });
});
