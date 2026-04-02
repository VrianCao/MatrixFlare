import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authHeaders,
  createRoom,
  expectMatrixError,
  loginWithPassword,
  postAuthenticated,
  putAuthenticated,
  registerUser,
  request,
  requestOps,
  requireRemoteHarnessContext,
  roomPath,
  sleep,
} from './support.mjs';

// The non-local gateway deployment contract currently leaves ABUSE_GUARD_POLICY_JSON empty,
// so gateway_search keeps the runtime default baseline of 60 requests.
const SHARED_SEARCH_LIMITER_BASELINE_LIMIT = 60;

async function requestAs(harness, accessToken, pathname, {
  method = 'GET',
  json = undefined,
  body = undefined,
  headers = {},
} = {}) {
  return request(harness, pathname, {
    method,
    headers: {
      ...authHeaders(accessToken),
      ...headers,
    },
    json,
    body,
  });
}

function assertUnauthorizedOps(result) {
  assert.equal(result.response.status, 401);
  assert.equal(result.payload?.code, 'unauthorized');
  assert.equal(result.payload?.retryable, false);
}

async function collectBatchResponses(total, batchSize, callback) {
  const results = [];
  for (let start = 0; start < total; start += batchSize) {
    const batch = [];
    for (let index = start; index < Math.min(total, start + batchSize); index += 1) {
      batch.push(callback(index));
    }
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

async function exercisePermissiveSearchLimiter(harness, accessToken, searchTerm, {
  attempts = 12,
  batchSize = 8,
  delayMs = 100,
} = {}) {
  let limited = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const responses = await collectBatchResponses(batchSize, batchSize, async () => postAuthenticated(
      harness,
      accessToken,
      '/_matrix/client/v3/search',
      {
        search_categories: {
          room_events: {
            search_term: searchTerm,
            filter: {
              limit: 1,
            },
          },
        },
      },
    ));
    for (const response of responses) {
      if (response.response.status === 429) {
        limited ??= response;
        continue;
      }
      assert.equal(
        response.response.status,
        200,
        `Expected bounded search limiter window to return 200 or 429, received ${response.response.status}`,
      );
      assert.ok(Array.isArray(response.payload?.search_categories?.room_events?.results));
    }
    if (limited != null) {
      break;
    }
    if (attempt + 1 < attempts) {
      await sleep(delayMs);
    }
  }
  if (limited != null) {
    await expectMatrixError(limited, 429, 'M_LIMIT_EXCEEDED');
  }
  return limited;
}

async function assertPermissivePublicRoomsLimiter(harness, {
  attempts = 24,
  delayMs = 100,
} = {}) {
  assert.ok(
    attempts < SHARED_SEARCH_LIMITER_BASELINE_LIMIT,
    `publicRooms follow-up window must stay below the standalone shared search limiter baseline of ${SHARED_SEARCH_LIMITER_BASELINE_LIMIT} requests`,
  );
  let limited = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await request(harness, '/_matrix/client/v3/publicRooms?limit=1');
    if (result.response.status === 429) {
      limited = result;
      break;
    }
    assert.equal(
      result.response.status,
      200,
      `Expected bounded publicRooms limiter window to return 200 or 429, received ${result.response.status}`,
    );
    if (attempt + 1 < attempts) {
      await sleep(delayMs);
    }
  }
  assert.notEqual(limited, null, `Expected shared search/publicRooms limiter to yield 429 within ${attempts} publicRooms attempts after bounded search traffic`);
  await expectMatrixError(limited, 429, 'M_LIMIT_EXCEEDED');
}

test('TEST-SEC-001 staging covers token revocation, route-bound UIA, and ops secret-bearing auth fail-closed paths', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'sec-staging-alice',
    password: 'phase08-sec-staging-password-1',
    deviceId: 'SECSTGPHONE',
  });
  const secondLogin = await loginWithPassword(harness, {
    user: alice.username,
    password: 'phase08-sec-staging-password-1',
    deviceId: 'SECSTGLAPTOP',
  });
  assert.equal(secondLogin.response.status, 200);
  const laptopSession = secondLogin.payload;

  const passwordChallenge = await requestAs(harness, alice.access_token, '/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'phase08-sec-staging-password-2',
    },
  });
  assert.equal(passwordChallenge.response.status, 401);
  assert.deepEqual(passwordChallenge.payload?.flows, [{ stages: ['m.login.password'] }]);
  assert.equal(typeof passwordChallenge.payload?.session, 'string');

  const reusedOnDeactivate = await requestAs(harness, alice.access_token, '/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    json: {
      erase: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallenge.payload.session,
        user: alice.username,
        password: 'phase08-sec-staging-password-1',
      },
    },
  });
  assert.equal(reusedOnDeactivate.response.status, 401);
  assert.notEqual(reusedOnDeactivate.payload?.session, passwordChallenge.payload.session);

  const passwordChange = await requestAs(harness, alice.access_token, '/_matrix/client/v3/account/password', {
    method: 'POST',
    json: {
      new_password: 'phase08-sec-staging-password-2',
      logout_devices: false,
      auth: {
        type: 'm.login.password',
        session: passwordChallenge.payload.session,
        user: alice.username,
        password: 'phase08-sec-staging-password-1',
      },
    },
  });
  assert.equal(passwordChange.response.status, 200);
  assert.deepEqual(passwordChange.payload, {});

  const oldPasswordLogin = await loginWithPassword(harness, {
    user: alice.username,
    password: 'phase08-sec-staging-password-1',
    deviceId: 'SECSTGOLDPWD',
  });
  await expectMatrixError(oldPasswordLogin, 403, 'M_FORBIDDEN');

  const latestPasswordLogin = await loginWithPassword(harness, {
    user: alice.username,
    password: 'phase08-sec-staging-password-2',
    deviceId: 'SECSTGNEWPWD',
  });
  assert.equal(latestPasswordLogin.response.status, 200);

  const deleteChallenge = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/devices/SECSTGLAPTOP', {
    method: 'DELETE',
    json: {},
  });
  assert.equal(deleteChallenge.response.status, 401);
  assert.deepEqual(deleteChallenge.payload?.flows, [{ stages: ['m.login.password'] }]);
  assert.equal(typeof deleteChallenge.payload?.session, 'string');

  const deleteDevice = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/devices/SECSTGLAPTOP', {
    method: 'DELETE',
    json: {
      auth: {
        type: 'm.login.password',
        session: deleteChallenge.payload.session,
        user: alice.username,
        password: 'phase08-sec-staging-password-2',
      },
    },
  });
  assert.equal(deleteDevice.response.status, 200);
  assert.deepEqual(deleteDevice.payload, {});

  const revokedLaptop = await requestAs(harness, laptopSession.access_token, '/_matrix/client/v3/account/whoami');
  await expectMatrixError(revokedLaptop, 401, 'M_UNKNOWN_TOKEN');

  const latestPasswordWhoAmI = await requestAs(harness, latestPasswordLogin.payload.access_token, '/_matrix/client/v3/account/whoami');
  assert.equal(latestPasswordWhoAmI.response.status, 200);
  assert.equal(latestPasswordWhoAmI.payload?.user_id, alice.user_id);

  const opsWithoutJwt = await requestOps(harness, '/_ops/v1/healthz');
  assertUnauthorizedOps(opsWithoutJwt);

  const opsWithServiceTokenHeaders = await requestOps(harness, '/_ops/v1/healthz', {
    headers: {
      'CF-Access-Client-Id': 'fake-client-id.access',
      'CF-Access-Client-Secret': 'fake-client-secret',
    },
  });
  assertUnauthorizedOps(opsWithServiceTokenHeaders);

  const opsWithCookieOnly = await requestOps(harness, '/_ops/v1/healthz', {
    headers: {
      cookie: 'CF_Authorization=fake-cookie',
      'cf-access-token': 'fake-cookie',
    },
  });
  assertUnauthorizedOps(opsWithCookieOnly);
});

test('TEST-SEC-001 staging enforces baseline abuse guards on always-on login, media, and search surfaces', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const registeredUser = await registerUser(harness, {
    usernamePrefix: 'sec-staging-register',
    password: 'phase08-sec-staging-password-5',
    deviceId: 'SECSTGREG0',
  });
  let registerLimited = null;
  for (let index = 1; index <= 8; index += 1) {
    const challenge = await request(harness, '/_matrix/client/v3/register', {
      method: 'POST',
      json: {
        username: registeredUser.username,
        password: 'phase08-sec-staging-password-5',
        device_id: `SECSTGREG${index}`,
      },
    });
    assert.equal(challenge.response.status, 401);
    assert.equal(typeof challenge.payload?.session, 'string');
    const duplicate = await request(harness, '/_matrix/client/v3/register', {
      method: 'POST',
      json: {
        username: registeredUser.username,
        password: 'phase08-sec-staging-password-5',
        device_id: `SECSTGREG${index}`,
        auth: {
          type: 'm.login.dummy',
          session: challenge.payload.session,
        },
      },
    });
    if (duplicate.response.status === 429) {
      registerLimited = duplicate;
      break;
    }
    await expectMatrixError(duplicate, 400, 'M_USER_IN_USE');
  }
  assert.notEqual(registerLimited, null);
  await expectMatrixError(registerLimited, 429, 'M_LIMIT_EXCEEDED');

  const loginUser = await registerUser(harness, {
    usernamePrefix: 'sec-staging-login',
    password: 'phase08-sec-staging-password-3',
    deviceId: 'SECSTGLOGIN0',
  });
  for (let index = 1; index <= 8; index += 1) {
    const login = await loginWithPassword(harness, {
      user: loginUser.username,
      password: 'phase08-sec-staging-password-3',
      deviceId: `SECSTGLOGIN${index}`,
    });
    assert.equal(login.response.status, 200);
  }
  const loginLimited = await loginWithPassword(harness, {
    user: loginUser.username,
    password: 'phase08-sec-staging-password-3',
    deviceId: 'SECSTGLOGIN9',
  });
  await expectMatrixError(loginLimited, 429, 'M_LIMIT_EXCEEDED');

  const mediaUser = await registerUser(harness, {
    usernamePrefix: 'sec-staging-media',
    password: 'phase08-sec-staging-password-4',
    deviceId: 'SECSTGMEDIA',
  });
  for (let index = 0; index < 8; index += 1) {
    const reservation = await postAuthenticated(harness, mediaUser.access_token, '/_matrix/media/v3/create');
    assert.equal(reservation.response.status, 200);
  }
  const mediaLimited = await postAuthenticated(harness, mediaUser.access_token, '/_matrix/media/v3/create');
  await expectMatrixError(mediaLimited, 429, 'M_LIMIT_EXCEEDED');

  const searchUser = await registerUser(harness, {
    usernamePrefix: 'sec-staging-search',
    password: 'phase08-sec-staging-password-6',
    deviceId: 'SECSTGSEARCH',
  });
  await exercisePermissiveSearchLimiter(harness, searchUser.access_token, 'phase08-sec-staging');

  await assertPermissivePublicRoomsLimiter(harness);

  const roomUser = await registerUser(harness, {
    usernamePrefix: 'sec-staging-roomsend',
    password: 'phase08-sec-staging-password-7',
    deviceId: 'SECSTGSEND0',
  });
  const rateLimitedRoom = await createRoom(harness, roomUser.access_token, {
    name: 'Phase 08 Security Staging Room Send Limit',
  });
  const sendResponses = await collectBatchResponses(144, 24, async (index) => putAuthenticated(
    harness,
    roomUser.access_token,
    roomPath(rateLimitedRoom.room_id, `/send/m.room.message/sec-stg-send-${index}`),
    {
      msgtype: 'm.text',
      body: `phase08 security staging burst ${index}`,
    },
  ));
  assert.ok(sendResponses.some((result) => result.response.status === 200));
  const roomSendLimited = sendResponses.find((result) => result.response.status === 429) ?? null;
  assert.notEqual(roomSendLimited, null);
  await expectMatrixError(roomSendLimited, 429, 'M_LIMIT_EXCEEDED');
});
