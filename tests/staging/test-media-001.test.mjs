import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectMatrixError,
  parseMxc,
  postAuthenticated,
  registerUser,
  request,
  requireRemoteHarnessContext,
} from './support.mjs';

test('TEST-MEDIA-001 staging covers current auth media, legacy unauth compatibility, animated thumbnails, and pending-upload quota', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }
  const binaryUploadBody = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0xff, 0x7f, 0x0a, 0x42]);
  const binaryChunkedUploadBody = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x41]);

  const alice = await registerUser(harness, {
    usernamePrefix: 'media-staging-alice',
    deviceId: 'MEDIASTGALICE',
  });

  const currentConfigWithoutToken = await request(harness, '/_matrix/client/v1/media/config');
  await expectMatrixError(currentConfigWithoutToken, 401, 'M_MISSING_TOKEN');

  const currentConfig = await request(harness, '/_matrix/client/v1/media/config', {
    headers: {
      authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.equal(currentConfig.response.status, 200);

  const legacyConfigWithoutToken = await request(harness, '/_matrix/media/v3/config');
  await expectMatrixError(legacyConfigWithoutToken, 401, 'M_MISSING_TOKEN');

  const legacyConfig = await request(harness, '/_matrix/media/v3/config', {
    headers: {
      authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.equal(legacyConfig.response.status, 200);
  assert.deepEqual(legacyConfig.payload, currentConfig.payload);

  const browserOrigin = 'https://app.cinny.in';
  const browserCurrentConfig = await request(harness, '/_matrix/client/v1/media/config', {
    headers: {
      origin: browserOrigin,
      authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.equal(browserCurrentConfig.response.status, 200);
  assert.equal(browserCurrentConfig.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserCurrentConfig.response.headers.get('vary') ?? '', /Origin/i);

  const browserCurrentConfigPreflight = await request(harness, '/_matrix/client/v1/media/config', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(browserCurrentConfigPreflight.response.status, 204);
  assert.equal(browserCurrentConfigPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserCurrentConfigPreflight.response.headers.get('access-control-allow-headers'), 'authorization');
  assert.match(browserCurrentConfigPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserCurrentConfigPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserCurrentConfigPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const browserLegacyConfig = await request(harness, '/_matrix/media/v3/config', {
    headers: {
      origin: browserOrigin,
      authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.equal(browserLegacyConfig.response.status, 200);
  assert.equal(browserLegacyConfig.response.headers.get('access-control-allow-origin'), browserOrigin);

  const browserLegacyConfigPreflight = await request(harness, '/_matrix/media/v3/config', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(browserLegacyConfigPreflight.response.status, 204);
  assert.equal(browserLegacyConfigPreflight.response.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserLegacyConfigPreflight.response.headers.get('access-control-allow-headers'), 'authorization');
  assert.match(browserLegacyConfigPreflight.response.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserLegacyConfigPreflight.response.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserLegacyConfigPreflight.response.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const upload = await request(harness, '/_matrix/media/v3/upload?filename=phase08-media.gif', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.access_token}`,
      'content-type': 'image/gif',
    },
    body: binaryUploadBody,
  });
  assert.equal(upload.response.status, 200);
  const uploaded = parseMxc(upload.payload?.content_uri);

  const chunkedUpload = await request(harness, '/_matrix/media/v3/upload?filename=phase08-media-stream.gif', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.access_token}`,
      'content-type': 'image/gif',
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(binaryChunkedUploadBody.subarray(0, 6));
        controller.enqueue(binaryChunkedUploadBody.subarray(6));
        controller.close();
      },
    }),
  });
  assert.equal(chunkedUpload.response.status, 200);
  const chunked = parseMxc(chunkedUpload.payload?.content_uri);

  const currentDownloadWithoutToken = await request(
    harness,
    `/_matrix/client/v1/media/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase08-media.gif`,
  );
  await expectMatrixError(currentDownloadWithoutToken, 401, 'M_MISSING_TOKEN');

  const currentDownload = await request(
    harness,
    `/_matrix/client/v1/media/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase08-media.gif`,
    {
      headers: {
        authorization: `Bearer ${alice.access_token}`,
      },
      responseType: 'bytes',
    },
  );
  assert.equal(currentDownload.response.status, 200);
  assert.deepEqual(currentDownload.payload, binaryUploadBody);

  const chunkedCurrentDownload = await request(
    harness,
    `/_matrix/client/v1/media/download/${encodeURIComponent(chunked.serverName)}/${encodeURIComponent(chunked.mediaId)}/phase08-media-stream.gif`,
    {
      headers: {
        authorization: `Bearer ${alice.access_token}`,
      },
      responseType: 'bytes',
    },
  );
  assert.equal(chunkedCurrentDownload.response.status, 200);
  assert.deepEqual(chunkedCurrentDownload.payload, binaryChunkedUploadBody);

  const legacyDownload = await request(
    harness,
    `/_matrix/media/v3/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase08-media.gif`,
    {
      responseType: 'bytes',
    },
  );
  assert.equal(legacyDownload.response.status, 200);
  assert.deepEqual(legacyDownload.payload, binaryUploadBody);

  const currentThumbnailWithoutToken = await request(
    harness,
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=48&height=48&method=scale&animated=false`,
  );
  await expectMatrixError(currentThumbnailWithoutToken, 401, 'M_MISSING_TOKEN');

  const staticThumbnail = await request(
    harness,
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=48&height=48&method=scale&animated=false`,
    {
      headers: {
        authorization: `Bearer ${alice.access_token}`,
      },
    },
  );
  assert.equal(staticThumbnail.response.status, 200);
  assert.match(staticThumbnail.payload, /^thumbnail:48x48:scale:static\n/u);

  const animatedThumbnail = await request(
    harness,
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=48&height=48&method=scale&animated=true`,
    {
      headers: {
        authorization: `Bearer ${alice.access_token}`,
      },
    },
  );
  assert.equal(animatedThumbnail.response.status, 200);
  assert.match(animatedThumbnail.payload, /^thumbnail:48x48:scale:animated\n/u);
  assert.notEqual(animatedThumbnail.payload, staticThumbnail.payload);

  const quotaUser = await registerUser(harness, {
    usernamePrefix: 'media-staging-quota',
    deviceId: 'MEDIASTGQUOTA',
  });

  for (let index = 0; index < 8; index += 1) {
    const reservation = await postAuthenticated(harness, quotaUser.access_token, '/_matrix/media/v3/create');
    assert.equal(reservation.response.status, 200);
  }
  const overQuotaReservation = await postAuthenticated(harness, quotaUser.access_token, '/_matrix/media/v3/create');
  await expectMatrixError(overQuotaReservation, 429, 'M_LIMIT_EXCEEDED');
});
