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

function allowMissingRemoteHarnessInAggregateLocalRun() {
  return stableString(process.env.MATRIX_AGGREGATE_LOCAL_NONLOCAL_SKIP) === 'true';
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
  if (baseUrl.length === 0 && serverName.length === 0 && allowMissingRemoteHarnessInAggregateLocalRun()) {
    testContext.skip(`Remote ${expectedEnvironment} harness requires MATRIX_REMOTE_BASE_URL and MATRIX_REMOTE_SERVER_NAME`);
    return null;
  }
  assert.notEqual(baseUrl.length, 0, `Remote ${expectedEnvironment} harness requires MATRIX_REMOTE_BASE_URL`);
  assert.notEqual(serverName.length, 0, `Remote ${expectedEnvironment} harness requires MATRIX_REMOTE_SERVER_NAME`);
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new TypeError('MATRIX_REMOTE_BASE_URL must be a valid absolute URL');
  }
  assert.equal(parsedBaseUrl.protocol, 'https:', 'MATRIX_REMOTE_BASE_URL must target an HTTPS origin');
  assert.equal(parsedBaseUrl.host, serverName, 'MATRIX_REMOTE_SERVER_NAME must match the host of MATRIX_REMOTE_BASE_URL');
  const opsBaseUrl = stableString(process.env.MATRIX_REMOTE_OPS_BASE_URL);
  const opsAccessClientId = stableString(process.env.MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID);
  const opsAccessClientSecret = stableString(process.env.MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET);
  let parsedOpsBaseUrl = null;
  if (opsBaseUrl) {
    try {
      parsedOpsBaseUrl = new URL(opsBaseUrl);
    } catch {
      throw new TypeError('MATRIX_REMOTE_OPS_BASE_URL must be a valid absolute URL when provided');
    }
    assert.equal(parsedOpsBaseUrl.protocol, 'https:', 'MATRIX_REMOTE_OPS_BASE_URL must target an HTTPS origin');
  }
  return {
    environmentName: expectedEnvironment,
    baseUrl: trimTrailingSlash(parsedBaseUrl.toString()),
    serverName,
    opsBaseUrl: parsedOpsBaseUrl == null ? '' : trimTrailingSlash(parsedOpsBaseUrl.toString()),
    opsAccessClientId,
    opsAccessClientSecret,
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
  const resolvedBody = json === undefined ? body : JSON.stringify(json);
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method,
    headers: requestHeaders,
    body: resolvedBody,
    ...(resolvedBody && typeof resolvedBody.getReader === 'function'
      ? { duplex: 'half' }
      : {}),
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

export async function requestOps(harness, pathname, {
  method = 'GET',
  headers = {},
  json = undefined,
  body = undefined,
} = {}) {
  assert.equal(typeof harness?.opsBaseUrl, 'string');
  assert.notEqual(harness.opsBaseUrl.length, 0, 'Remote harness requires MATRIX_REMOTE_OPS_BASE_URL');
  const requestHeaders = new Headers(headers);
  if (json !== undefined && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json; charset=utf-8');
  }
  const resolvedBody = json === undefined ? body : JSON.stringify(json);
  const response = await fetch(`${harness.opsBaseUrl}${pathname}`, {
    method,
    headers: requestHeaders,
    body: resolvedBody,
    ...(resolvedBody && typeof resolvedBody.getReader === 'function'
      ? { duplex: 'half' }
      : {}),
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

export function buildOpsAccessHeaders(harness, headers = {}) {
  assert.equal(typeof harness?.opsAccessClientId, 'string');
  assert.equal(typeof harness?.opsAccessClientSecret, 'string');
  assert.notEqual(harness.opsAccessClientId.length, 0, 'Remote harness requires MATRIX_REMOTE_OPS_ACCESS_CLIENT_ID');
  assert.notEqual(harness.opsAccessClientSecret.length, 0, 'Remote harness requires MATRIX_REMOTE_OPS_ACCESS_CLIENT_SECRET');
  return {
    ...headers,
    'CF-Access-Client-Id': harness.opsAccessClientId,
    'CF-Access-Client-Secret': harness.opsAccessClientSecret,
  };
}

export async function requestOpsAuthorized(harness, pathname, {
  method = 'GET',
  headers = {},
  json = undefined,
  body = undefined,
} = {}) {
  return requestOps(harness, pathname, {
    method,
    headers: buildOpsAccessHeaders(harness, headers),
    json,
    body,
  });
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
}) {
  const result = await request(harness, '/_matrix/client/v3/register', {
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
} = {}) {
  const username = uniqueToken(usernamePrefix);
  const challenge = await createRegisterChallenge(harness, {
    username,
    password,
    deviceId,
  });
  const result = await request(harness, '/_matrix/client/v3/register', {
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
}) {
  return request(harness, '/_matrix/client/v3/login', {
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
