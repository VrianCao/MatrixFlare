import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectMatrixError,
  getAuthenticated,
  registerUser,
  request,
  requireRemoteHarnessContext,
} from './support.mjs';

test('TEST-CS-004 staging keeps stub-only and unsupported routes deterministic and undiscoverable', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs4-staging-alice',
    deviceId: 'CS4STGALICE',
  });

  const loginFlows = await request(harness, '/_matrix/client/v3/login');
  assert.equal(loginFlows.response.status, 200);
  assert.deepEqual(loginFlows.payload?.flows, [{ type: 'm.login.password' }]);

  const capabilities = await getAuthenticated(harness, alice.access_token, '/_matrix/client/v3/capabilities');
  assert.equal(capabilities.response.status, 200);
  assert.equal(capabilities.payload?.capabilities?.['m.3pid_changes']?.enabled, false);
  assert.equal(capabilities.payload?.capabilities?.['m.get_login_token']?.enabled, false);

  const unsupportedLogin = await request(harness, '/_matrix/client/v3/login', {
    method: 'POST',
    json: {
      type: 'm.login.token',
      token: 'unsupported-login-token',
    },
  });
  await expectMatrixError(unsupportedLogin, 400, 'M_UNKNOWN');

  const unsupportedRoutes = [
    ['/ _matrix/client/v3/account/password/email/requestToken'.replace(' ', ''), 'POST', { client_secret: 'disabled' }],
    ['/_matrix/client/v3/notifications', 'GET'],
    ['/_matrix/client/v3/pushers/set', 'POST', {}],
    ['/_matrix/client/v3/rooms/!missing:example.test/upgrade', 'POST', {}],
    ['/_matrix/client/v3/media/preview_url?url=https%3A%2F%2Fexample.com', 'GET'],
    ['/_matrix/client/v3/login/sso/redirect', 'GET'],
    ['/_matrix/client/v3/account/3pid', 'GET'],
    ['/_matrix/client/v3/thirdparty/protocols', 'GET'],
    ['/_matrix/client/v3/user/@alice:example.test/openid/request_token', 'POST', {}],
    ['/_matrix/client/v3/voip/turnServer', 'GET'],
    ['/_matrix/client/v3/events', 'GET'],
    ['/_matrix/client/v1/auth_metadata', 'GET'],
  ];

  for (const [pathname, method, json] of unsupportedRoutes) {
    const withoutToken = await request(harness, pathname, {
      method,
      ...(json === undefined ? {} : { json }),
    });
    await expectMatrixError(withoutToken, 404, 'M_UNRECOGNIZED');

    const withToken = await request(harness, pathname, {
      method,
      headers: {
        authorization: `Bearer ${alice.access_token}`,
      },
      ...(json === undefined ? {} : { json }),
    });
    await expectMatrixError(withToken, 404, 'M_UNRECOGNIZED');
  }
});
