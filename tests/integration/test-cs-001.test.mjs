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

const REGISTER_ALIAS_PATHS = Object.freeze([
  '/_matrix/client/r0/register',
  '/_matrix/client/v1/register',
  '/_matrix/client/v3/register',
]);

const REGISTER_AVAILABILITY_ALIAS_PATHS = Object.freeze([
  '/_matrix/client/r0/register/available',
  '/_matrix/client/v1/register/available',
  '/_matrix/client/v3/register/available',
]);

const LOGIN_ALIAS_PATHS = Object.freeze([
  '/_matrix/client/r0/login',
  '/_matrix/client/v1/login',
  '/_matrix/client/v3/login',
]);

const CLIENT_DISCOVERY_VERSIONS = Object.freeze([
  'r0.6.1',
  'v1.1',
  'v1.2',
  'v1.3',
  'v1.4',
  'v1.5',
  'v1.6',
  'v1.7',
  'v1.8',
  'v1.9',
  'v1.10',
  'v1.11',
  'v1.12',
  'v1.13',
  'v1.14',
  'v1.15',
  'v1.16',
  'v1.17',
]);

function assertCacheControl(result, expectedValue) {
  assert.equal(result.response.headers.get('cache-control'), expectedValue);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function buildAnonymousPublicEntryAliasMatrix(localpart) {
  return [
    ...LOGIN_ALIAS_PATHS.map((pathname) => ({ label: pathname, pathname })),
    ...REGISTER_ALIAS_PATHS.map((pathname) => ({ label: pathname, pathname })),
    ...REGISTER_AVAILABILITY_ALIAS_PATHS.map((pathname) => ({
      label: pathname,
      pathname: `${pathname}?username=${encodeURIComponent(localpart)}`,
    })),
  ];
}

// CF-WKR-027: Cloudflare Workers ratelimits are local-to-location, eventually
// consistent, and permissive. This non-local gate therefore drives the full
// alias matrix until at least one live 429 appears, while locking every alias
// to the expected 200/429 envelope.
async function assertAnonymousPublicEntryLimiterAcrossAliases(harness, localpart, {
  attempts = 100,
  delayMs = 200,
} = {}) {
  const aliasMatrix = buildAnonymousPublicEntryAliasMatrix(localpart);
  const limitedCounts = new Map();
  for (const alias of aliasMatrix) {
    limitedCounts.set(alias.label, 0);
  }
  const recentObservations = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let sawLimitedInAttempt = false;
    const probeResults = [];
    for (const alias of aliasMatrix) {
      probeResults.push(request(harness, alias.pathname));
    }
    const resolvedProbeResults = await Promise.all(probeResults);
    for (let index = 0; index < aliasMatrix.length; index += 1) {
      const { label, pathname } = aliasMatrix[index];
      const probe = resolvedProbeResults[index];
      recentObservations.push(
        `${attempt}:${label}:${probe.response.status}:${probe.response.headers.get('cf-ray') ?? 'n/a'}`,
      );
      if (recentObservations.length > 18) {
        recentObservations.shift();
      }
      if (probe.response.status === 429) {
        await expectMatrixError(probe, 429, 'M_LIMIT_EXCEEDED');
        limitedCounts.set(label, limitedCounts.get(label) + 1);
        sawLimitedInAttempt = true;
        continue;
      }
      assert.equal(
        probe.response.status,
        200,
        `Expected bounded anonymous public-entry limiter to return 200 or 429 for ${pathname}, received ${probe.response.status}`,
      );
    }
    if (sawLimitedInAttempt) {
      return;
    }
    if (attempt + 1 < attempts) {
      await sleep(delayMs);
    }
  }
  assert.fail(
    `Expected anonymous public-entry limiter to yield at least one live 429 across the alias matrix within the bounded window; hits=${JSON.stringify(Object.fromEntries(limitedCounts))}; recent=${recentObservations.join(', ')}`,
  );
}

test('TEST-CS-001 ci-integration covers discovery, session lifecycle, and capability truth', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'ci-integration');
  if (harness == null) {
    return;
  }

  const clientWellKnown = await request(harness, '/.well-known/matrix/client');
  assert.equal(clientWellKnown.response.status, 200);
  assert.deepEqual(clientWellKnown.payload, {
    'm.homeserver': {
      base_url: harness.baseUrl,
    },
  });

  const serverWellKnown = await request(harness, '/.well-known/matrix/server');
  assert.equal(serverWellKnown.response.status, 200);
  assert.deepEqual(serverWellKnown.payload, {
    'm.server': harness.serverName,
  });

  const versions = await request(harness, '/_matrix/client/versions');
  assert.equal(versions.response.status, 200);
  assert.deepEqual(versions.payload, {
    versions: [...CLIENT_DISCOVERY_VERSIONS],
    unstable_features: {},
  });

  const browserClientWellKnown = await request(harness, '/.well-known/matrix/client', {
    headers: {
      origin: 'https://app.element.io',
    },
  });
  assert.equal(browserClientWellKnown.response.status, 200);
  assert.equal(browserClientWellKnown.response.headers.get('access-control-allow-origin'), 'https://app.element.io');
  assert.match(browserClientWellKnown.response.headers.get('vary') ?? '', /Origin/i);

  const browserVersions = await request(harness, '/_matrix/client/versions', {
    headers: {
      origin: 'https://app.element.io',
    },
  });
  assert.equal(browserVersions.response.status, 200);
  assert.equal(browserVersions.response.headers.get('access-control-allow-origin'), 'https://app.element.io');
  assert.match(browserVersions.response.headers.get('vary') ?? '', /Origin/i);
  assert.deepEqual(browserVersions.payload, {
    versions: [...CLIENT_DISCOVERY_VERSIONS],
    unstable_features: {},
  });

  const browserClientWellKnownPreflight = await request(harness, '/.well-known/matrix/client', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.element.io',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-matrix-client',
    },
  });
  assert.equal(browserClientWellKnownPreflight.response.status, 204);
  assert.equal(browserClientWellKnownPreflight.response.headers.get('access-control-allow-origin'), 'https://app.element.io');
  assert.equal(browserClientWellKnownPreflight.response.headers.get('access-control-allow-headers'), 'x-matrix-client');
  assert.match(browserClientWellKnownPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserClientWellKnownPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserClientWellKnownPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const browserVersionsPreflight = await request(harness, '/_matrix/client/versions', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.element.io',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-matrix-client',
    },
  });
  assert.equal(browserVersionsPreflight.response.status, 204);
  assert.equal(browserVersionsPreflight.response.headers.get('access-control-allow-origin'), 'https://app.element.io');
  assert.equal(browserVersionsPreflight.response.headers.get('access-control-allow-headers'), 'x-matrix-client');
  assert.match(browserVersionsPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserVersionsPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserVersionsPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const availableLocalpart = `cs1-ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const loginFlows = await request(harness, '/_matrix/client/v3/login');
  assert.equal(loginFlows.response.status, 200);
  assertCacheControl(loginFlows, 'public, max-age=60');
  assert.deepEqual(loginFlows.payload?.flows, [{ type: 'm.login.password' }]);

  const loginFlowsR0 = await request(harness, '/_matrix/client/r0/login');
  assert.equal(loginFlowsR0.response.status, 200);
  assertCacheControl(loginFlowsR0, 'public, max-age=60');
  assert.deepEqual(loginFlowsR0.payload?.flows, [{ type: 'm.login.password' }]);

  const loginFlowsV1 = await request(harness, '/_matrix/client/v1/login');
  assert.equal(loginFlowsV1.response.status, 200);
  assertCacheControl(loginFlowsV1, 'public, max-age=60');
  assert.deepEqual(loginFlowsV1.payload?.flows, [{ type: 'm.login.password' }]);

  const registerFlows = await request(harness, '/_matrix/client/v3/register');
  assert.equal(registerFlows.response.status, 200);
  assertCacheControl(registerFlows, 'no-store');
  assert.deepEqual(registerFlows.payload?.flows, [{ stages: ['m.login.dummy'] }]);

  const registerFlowsCompatibility = await request(harness, '/_matrix/client/r0/register');
  assert.equal(registerFlowsCompatibility.response.status, 200);
  assertCacheControl(registerFlowsCompatibility, 'no-store');
  assert.deepEqual(registerFlowsCompatibility.payload?.flows, [{ stages: ['m.login.dummy'] }]);

  const registerFlowsV1 = await request(harness, '/_matrix/client/v1/register');
  assert.equal(registerFlowsV1.response.status, 200);
  assertCacheControl(registerFlowsV1, 'no-store');
  assert.deepEqual(registerFlowsV1.payload?.flows, [{ stages: ['m.login.dummy'] }]);

  for (const availabilityPath of REGISTER_AVAILABILITY_ALIAS_PATHS) {
    const availabilityBefore = await request(
      harness,
      `${availabilityPath}?username=${encodeURIComponent(availableLocalpart)}`,
    );
    assert.equal(availabilityBefore.response.status, 200);
    assertCacheControl(availabilityBefore, 'no-store');
    assert.deepEqual(availabilityBefore.payload, { available: true });
  }

  const tokenValidity = await request(
    harness,
    '/_matrix/client/v1/register/m.login.registration_token/validity?token=bogus',
  );
  assert.equal(tokenValidity.response.status, 200);
  assert.deepEqual(tokenValidity.payload, { valid: false });

  for (const registerPath of REGISTER_ALIAS_PATHS) {
    const registerChallenge = await request(harness, registerPath, {
      method: 'POST',
      json: {},
    });
    assert.equal(registerChallenge.response.status, 401);
    assert.deepEqual(registerChallenge.payload?.flows, [{ stages: ['m.login.dummy'] }]);
    assert.deepEqual(registerChallenge.payload?.params, {});
    assert.deepEqual(registerChallenge.payload?.completed, []);
    assert.equal(typeof registerChallenge.payload?.session, 'string');
  }

  const browserOrigin = 'https://app.element.io';
  for (const loginPath of LOGIN_ALIAS_PATHS) {
    const browserLoginFlows = await request(harness, loginPath, {
      headers: {
        origin: browserOrigin,
      },
    });
    assert.equal(browserLoginFlows.response.status, 200);
    assertCacheControl(browserLoginFlows, 'public, max-age=60');
    assert.equal(browserLoginFlows.response.headers.get('access-control-allow-origin'), browserOrigin);
    assert.match(browserLoginFlows.response.headers.get('vary') ?? '', /Origin/i);
  }

  for (const registerPath of REGISTER_ALIAS_PATHS) {
    const browserRegisterFlows = await request(harness, registerPath, {
      headers: {
        origin: browserOrigin,
      },
    });
    assert.equal(browserRegisterFlows.response.status, 200);
    assertCacheControl(browserRegisterFlows, 'no-store');
    assert.equal(browserRegisterFlows.response.headers.get('access-control-allow-origin'), browserOrigin);
    assert.match(browserRegisterFlows.response.headers.get('vary') ?? '', /Origin/i);
  }

  for (const availabilityPath of REGISTER_AVAILABILITY_ALIAS_PATHS) {
    const browserRegisterAvailability = await request(
      harness,
      `${availabilityPath}?username=${encodeURIComponent(availableLocalpart)}`,
      {
        headers: {
          origin: browserOrigin,
        },
      },
    );
    assert.equal(browserRegisterAvailability.response.status, 200);
    assertCacheControl(browserRegisterAvailability, 'no-store');
    assert.equal(browserRegisterAvailability.response.headers.get('access-control-allow-origin'), browserOrigin);
    assert.match(browserRegisterAvailability.response.headers.get('vary') ?? '', /Origin/i);
    assert.deepEqual(browserRegisterAvailability.payload, { available: true });
  }

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

  const browserAvailabilityPreflight = await request(harness, '/_matrix/client/v1/register/available', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-matrix-client',
    },
  });
  assert.equal(browserAvailabilityPreflight.response.status, 204);
  assert.equal(browserAvailabilityPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserAvailabilityPreflight.response.headers.get('access-control-allow-headers'), 'x-matrix-client');
  assert.match(browserAvailabilityPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserAvailabilityPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserAvailabilityPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const browserLoginPreflight = await request(harness, '/_matrix/client/r0/login', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
  assert.equal(browserLoginPreflight.response.status, 204);
  assert.equal(browserLoginPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserLoginPreflight.response.headers.get('access-control-allow-headers'), 'content-type,authorization');
  assert.match(browserLoginPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
  assert.match(browserLoginPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserLoginPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const compatibilityUsers = [];
  for (const [index, registerPath] of REGISTER_ALIAS_PATHS.entries()) {
    const password = `phase08-cs1-ci-password-compat-${index}`;
    const compatibilityUser = await registerUser(harness, {
      usernamePrefix: `cs1-ci-compat-${index}`,
      password,
      deviceId: `CS1CICOMPAT${index}`,
      registerPath,
    });
    assert.equal(compatibilityUser.user_id, `@${compatibilityUser.username}:${harness.serverName}`);
    assert.equal(compatibilityUser.device_id, `CS1CICOMPAT${index}`);
    assert.equal(typeof compatibilityUser.access_token, 'string');
    assert.equal(typeof compatibilityUser.refresh_token, 'string');
    compatibilityUsers.push({ ...compatibilityUser, password });
  }

  for (const compatibilityUser of compatibilityUsers) {
    const compatibilityWhoAmI = await getAuthenticated(
      harness,
      compatibilityUser.access_token,
      '/_matrix/client/v3/account/whoami',
    );
    assert.equal(compatibilityWhoAmI.response.status, 200);
    assert.equal(compatibilityWhoAmI.payload?.user_id, compatibilityUser.user_id);
    assert.equal(compatibilityWhoAmI.payload?.device_id, compatibilityUser.device_id);

    const refreshedCompatibilitySession = await refreshSession(harness, compatibilityUser.refresh_token);
    assert.equal(refreshedCompatibilitySession.response.status, 200);
    assert.equal(typeof refreshedCompatibilitySession.payload?.access_token, 'string');
    assert.equal(typeof refreshedCompatibilitySession.payload?.refresh_token, 'string');
    assert.notEqual(refreshedCompatibilitySession.payload.access_token, compatibilityUser.access_token);
    assert.notEqual(refreshedCompatibilitySession.payload.refresh_token, compatibilityUser.refresh_token);

    const refreshedCompatibilityWhoAmI = await getAuthenticated(
      harness,
      refreshedCompatibilitySession.payload.access_token,
      '/_matrix/client/v3/account/whoami',
    );
    assert.equal(refreshedCompatibilityWhoAmI.response.status, 200);
    assert.equal(refreshedCompatibilityWhoAmI.payload?.user_id, compatibilityUser.user_id);
    assert.equal(refreshedCompatibilityWhoAmI.payload?.device_id, compatibilityUser.device_id);

    for (const availabilityPath of REGISTER_AVAILABILITY_ALIAS_PATHS) {
      const availabilityAfterCompatibility = await request(
        harness,
        `${availabilityPath}?username=${encodeURIComponent(compatibilityUser.username)}`,
      );
      await expectMatrixError(availabilityAfterCompatibility, 400, 'M_USER_IN_USE');
    }
  }

  for (const [userIndex, compatibilityUser] of compatibilityUsers.entries()) {
    for (const [loginIndex, loginPath] of LOGIN_ALIAS_PATHS.entries()) {
      const deviceId = `CS1CICOMPAT${userIndex}${loginIndex}`;
      const compatibilityLogin = await loginWithPassword(harness, {
        user: compatibilityUser.username,
        password: compatibilityUser.password,
        deviceId,
        loginPath,
      });
      assert.equal(compatibilityLogin.response.status, 200);
      assert.equal(compatibilityLogin.payload?.user_id, compatibilityUser.user_id);
      assert.equal(compatibilityLogin.payload?.device_id, deviceId);
      assert.equal(typeof compatibilityLogin.payload?.access_token, 'string');
      assert.equal(typeof compatibilityLogin.payload?.refresh_token, 'string');
    }
  }

  for (const loginPath of LOGIN_ALIAS_PATHS) {
    const wrongPasswordLogin = await loginWithPassword(harness, {
      user: compatibilityUsers[0].username,
      password: 'definitely-not-the-password',
      loginPath,
    });
    await expectMatrixError(wrongPasswordLogin, 403, 'M_FORBIDDEN');

    const unsupportedLoginType = await request(harness, loginPath, {
      method: 'POST',
      json: {
        type: 'm.login.token',
        token: 'disabled-flow-token',
      },
    });
    await expectMatrixError(unsupportedLoginType, 400, 'M_UNKNOWN');
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs1-ci-alice',
    password: 'phase08-cs1-ci-password-1',
    deviceId: 'CS1CIALICE',
  });

  for (const availabilityPath of REGISTER_AVAILABILITY_ALIAS_PATHS) {
    const availabilityAfter = await request(
      harness,
      `${availabilityPath}?username=${encodeURIComponent(alice.username)}`,
    );
    await expectMatrixError(availabilityAfter, 400, 'M_USER_IN_USE');
  }

  const capabilities = await getAuthenticated(harness, alice.access_token, '/_matrix/client/v3/capabilities');
  assert.equal(capabilities.response.status, 200);
  assert.deepEqual(capabilities.payload?.capabilities, {
    'm.change_password': { enabled: true },
    'm.3pid_changes': { enabled: false },
    'm.get_login_token': { enabled: false },
    'm.profile_fields': { enabled: true },
    'm.room_versions': {
      default: '12',
      available: {
        '11': 'stable',
        '12': 'stable',
      },
    },
    'm.set_avatar_url': { enabled: true },
    'm.set_displayname': { enabled: true },
  });

  const browserAuthenticatedHeaders = {
    ...authHeaders(alice.access_token),
    origin: browserOrigin,
  };
  const browserCapabilitiesWithoutToken = await request(harness, '/_matrix/client/v3/capabilities', {
    headers: {
      origin: browserOrigin,
    },
  });
  await expectMatrixError(browserCapabilitiesWithoutToken, 401, 'M_MISSING_TOKEN');
  assert.equal(browserCapabilitiesWithoutToken.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserCapabilitiesWithoutToken.response.headers.get('vary') ?? '', /Origin/i);

  const browserCapabilities = await request(harness, '/_matrix/client/v3/capabilities', {
    headers: browserAuthenticatedHeaders,
  });
  assert.equal(browserCapabilities.response.status, 200);
  assert.equal(browserCapabilities.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserCapabilities.response.headers.get('vary') ?? '', /Origin/i);
  assert.deepEqual(browserCapabilities.payload?.capabilities, capabilities.payload?.capabilities);

  const browserCapabilitiesPreflight = await request(harness, '/_matrix/client/v3/capabilities', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(browserCapabilitiesPreflight.response.status, 204);
  assert.equal(browserCapabilitiesPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserCapabilitiesPreflight.response.headers.get('access-control-allow-headers'), 'authorization');
  assert.match(browserCapabilitiesPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserCapabilitiesPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserCapabilitiesPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const browserSync = await request(harness, '/_matrix/client/v3/sync?timeout=0', {
    headers: browserAuthenticatedHeaders,
  });
  assert.equal(browserSync.response.status, 200);
  assert.equal(browserSync.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserSync.response.headers.get('vary') ?? '', /Origin/i);
  assert.equal(typeof browserSync.payload?.next_batch, 'string');

  const browserSyncPreflight = await request(harness, '/_matrix/client/v3/sync?timeout=0', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(browserSyncPreflight.response.status, 204);
  assert.equal(browserSyncPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserSyncPreflight.response.headers.get('access-control-allow-headers'), 'authorization');
  assert.match(browserSyncPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserSyncPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserSyncPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

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

  const publicEntryProbeLocalpart = `cs1-ci-public-entry-${Date.now().toString(36)}`.toLowerCase();
  await assertAnonymousPublicEntryLimiterAcrossAliases(harness, publicEntryProbeLocalpart);
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
    return memberEvent;
  }, {
    attempts: 60,
    delayMs: 500,
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
