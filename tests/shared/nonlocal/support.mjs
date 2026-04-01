import assert from 'node:assert/strict';
import process from 'node:process';

import { skipUnlessEnvironment } from '../../../packages/testing/src/bootstrap.mjs';

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function requireRemoteHarnessContext(testContext, expectedEnvironment) {
  skipUnlessEnvironment(testContext, expectedEnvironment);
  const baseUrl = process.env.MATRIX_REMOTE_BASE_URL ?? '';
  const serverName = process.env.MATRIX_REMOTE_SERVER_NAME ?? '';
  if (baseUrl.trim().length === 0 || serverName.trim().length === 0) {
    testContext.skip(`Remote ${expectedEnvironment} harness requires MATRIX_REMOTE_BASE_URL and MATRIX_REMOTE_SERVER_NAME`);
    return null;
  }
  return {
    environmentName: expectedEnvironment,
    baseUrl: trimTrailingSlash(baseUrl.trim()),
    serverName: serverName.trim(),
    opsBaseUrl: trimTrailingSlash((process.env.MATRIX_REMOTE_OPS_BASE_URL ?? '').trim()),
  };
}

async function requestJson(harness, pathname, {
  method = 'GET',
  headers = {},
  json = null,
  body = null,
} = {}) {
  const requestHeaders = new Headers(headers);
  if (json != null && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json; charset=utf-8');
  }
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method,
    headers: requestHeaders,
    body: json == null ? body : JSON.stringify(json),
  });
  let payload = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    payload = await response.text();
  }
  return {
    response,
    payload,
  };
}

function authHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
  };
}

function buildUniqueLocalpart(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

async function createRegisterChallenge(harness, {
  username,
  password,
  deviceId,
}) {
  const { response, payload } = await requestJson(harness, '/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(response.status, 401);
  assert.equal(typeof payload?.session, 'string');
  return payload;
}

export async function registerUser(harness, {
  usernamePrefix,
  password = 'phase08-nonlocal-password',
  deviceId = 'DEVICE1',
} = {}) {
  const username = buildUniqueLocalpart(usernamePrefix);
  const challenge = await createRegisterChallenge(harness, {
    username,
    password,
    deviceId,
  });
  const { response, payload } = await requestJson(harness, '/_matrix/client/v3/register', {
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
  assert.equal(response.status, 200);
  return {
    username,
    password,
    deviceId,
    ...payload,
  };
}

export async function postAuthenticated(harness, accessToken, pathname, json = {}) {
  return requestJson(harness, pathname, {
    method: 'POST',
    headers: authHeaders(accessToken),
    json,
  });
}

export async function putAuthenticated(harness, accessToken, pathname, json = {}) {
  return requestJson(harness, pathname, {
    method: 'PUT',
    headers: authHeaders(accessToken),
    json,
  });
}

export async function getAuthenticated(harness, accessToken, pathname) {
  return requestJson(harness, pathname, {
    method: 'GET',
    headers: authHeaders(accessToken),
  });
}

export async function createRoom(harness, accessToken, roomName) {
  const { response, payload } = await postAuthenticated(harness, accessToken, '/_matrix/client/v3/createRoom', {
    name: roomName,
  });
  assert.equal(response.status, 200);
  assert.equal(typeof payload?.room_id, 'string');
  return payload.room_id;
}

export {
  authHeaders,
  requestJson,
  requireRemoteHarnessContext,
};
