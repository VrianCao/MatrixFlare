import assert from 'node:assert/strict';
import process from 'node:process';

const DEFAULT_PASSWORD = 'phase08-nonlocal-password';

function stableString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function currentEnvironmentName() {
  return stableString(process.env.MATRIX_TEST_ENVIRONMENT) || 'local';
}

function uniqueToken(prefix = 'phase08') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

export function makeTxnId(prefix = 'txn') {
  return uniqueToken(prefix);
}

export function buildUniqueAliasLocalpart(prefix = 'room') {
  return uniqueToken(prefix).replace(/[^a-z0-9._=-]/g, '-');
}

export function requireRemoteHarnessContext(testContext, expectedEnvironment) {
  const actualEnvironment = currentEnvironmentName();
  if (actualEnvironment !== expectedEnvironment) {
    testContext.skip(`Expected ${expectedEnvironment}, received ${actualEnvironment}`);
    return null;
  }
  const baseUrl = stableString(process.env.MATRIX_REMOTE_BASE_URL);
  const serverName = stableString(process.env.MATRIX_REMOTE_SERVER_NAME);
  if (!baseUrl || !serverName) {
    testContext.skip(`Remote ${expectedEnvironment} harness requires MATRIX_REMOTE_BASE_URL and MATRIX_REMOTE_SERVER_NAME`);
    return null;
  }
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    testContext.skip('MATRIX_REMOTE_BASE_URL must be a valid absolute URL');
    return null;
  }
  if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.host !== serverName) {
    testContext.skip('Remote harness must target an HTTPS gateway host matching MATRIX_REMOTE_SERVER_NAME');
    return null;
  }
  return {
    environmentName: expectedEnvironment,
    baseUrl: trimTrailingSlash(parsedBaseUrl.toString()),
    serverName,
  };
}

export async function request(harness, pathname, {
  method = 'GET',
  headers = {},
  json = undefined,
  body = undefined,
} = {}) {
  const requestHeaders = new Headers(headers);
  if (json !== undefined && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method,
    headers: requestHeaders,
    body: json === undefined ? body : JSON.stringify(json),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return {
    response,
    payload,
  };
}

export function authHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
  };
}

export async function expectMatrixError(result, status, errcode) {
  assert.equal(result.response.status, status);
  assert.equal(result.payload?.errcode, errcode);
  return result.payload;
}

async function createRegisterChallenge(harness, {
  username,
  password,
  deviceId,
  registerPath = '/_matrix/client/v3/register',
}) {
  const result = await request(harness, registerPath, {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(result.response.status, 401);
  assert.equal(typeof result.payload?.session, 'string');
  return result.payload;
}

export async function registerUser(harness, {
  usernamePrefix,
  password = DEFAULT_PASSWORD,
  deviceId = 'DEVICE1',
  registerPath = '/_matrix/client/v3/register',
} = {}) {
  const username = uniqueToken(usernamePrefix);
  const challenge = await createRegisterChallenge(harness, {
    username,
    password,
    deviceId,
    registerPath,
  });
  const result = await request(harness, registerPath, {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
      auth: {
        type: 'm.login.dummy',
        session: challenge.session,
      },
    },
  });
  assert.equal(result.response.status, 200);
  return {
    username,
    password,
    deviceId,
    ...result.payload,
  };
}

export async function loginWithPassword(harness, {
  user,
  password = DEFAULT_PASSWORD,
  deviceId = null,
  loginPath = '/_matrix/client/v3/login',
}) {
  return request(harness, loginPath, {
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
}

export async function refreshSession(harness, refreshToken) {
  return request(harness, '/_matrix/client/v3/refresh', {
    method: 'POST',
    json: {
      refresh_token: refreshToken,
    },
  });
}

export async function postAuthenticated(harness, accessToken, pathname, json = {}) {
  return request(harness, pathname, {
    method: 'POST',
    headers: authHeaders(accessToken),
    json,
  });
}

export async function putAuthenticated(harness, accessToken, pathname, json = {}) {
  return request(harness, pathname, {
    method: 'PUT',
    headers: authHeaders(accessToken),
    json,
  });
}

export async function getAuthenticated(harness, accessToken, pathname) {
  return request(harness, pathname, {
    headers: authHeaders(accessToken),
  });
}

export async function deleteAuthenticated(harness, accessToken, pathname, json = undefined) {
  return request(harness, pathname, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
    json,
  });
}

export async function createRoom(harness, accessToken, body = {}) {
  const result = await postAuthenticated(harness, accessToken, '/_matrix/client/v3/createRoom', body);
  assert.equal(result.response.status, 200);
  assert.equal(typeof result.payload?.room_id, 'string');
  return result.payload;
}

export async function joinRoom(harness, accessToken, roomIdOrAlias, body = {}) {
  const result = await postAuthenticated(
    harness,
    accessToken,
    `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`,
    body,
  );
  assert.equal(result.response.status, 200);
  assert.equal(typeof result.payload?.room_id, 'string');
  return result.payload;
}

export async function syncRequest(harness, accessToken, query = '') {
  const suffix = query ? `?${query}` : '';
  const result = await getAuthenticated(harness, accessToken, `/_matrix/client/v3/sync${suffix}`);
  assert.equal(result.response.status, 200);
  return result.payload;
}

export async function uploadFilter(harness, accessToken, userId, filter) {
  const result = await postAuthenticated(
    harness,
    accessToken,
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`,
    filter,
  );
  assert.equal(result.response.status, 200);
  assert.equal(typeof result.payload?.filter_id, 'string');
  return result.payload;
}

export function roomPath(roomId, suffix = '') {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

export function getJoinedRoomEntry(syncBody, roomId) {
  return syncBody.rooms?.join?.[roomId] ?? null;
}

export function getLeftRoomEntry(syncBody, roomId) {
  return syncBody.rooms?.leave?.[roomId] ?? null;
}

export function getStateEvents(roomEntry) {
  return [
    ...(roomEntry?.state?.events ?? []),
    ...(roomEntry?.state_after?.events ?? []),
  ];
}

export function findStateEvent(roomEntry, {
  type,
  stateKey = undefined,
} = {}) {
  return getStateEvents(roomEntry).find((event) => (
    event?.type === type
    && (stateKey === undefined || event?.state_key === stateKey)
  )) ?? null;
}

export function parseMxc(contentUri) {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(String(contentUri));
  assert.ok(match, `invalid content_uri: ${contentUri}`);
  return {
    serverName: match[1],
    mediaId: match[2],
  };
}

export async function eventually(callback, {
  attempts = 20,
  delayMs = 500,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callback(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw lastError;
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}
