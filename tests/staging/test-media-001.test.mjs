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

  const alice = await registerUser(harness, {
    usernamePrefix: 'media-staging-alice',
    deviceId: 'MEDIASTGALICE',
  });

  const currentConfig = await request(harness, '/_matrix/client/v1/media/config', {
    headers: {
      authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.equal(currentConfig.response.status, 200);

  const legacyConfig = await request(harness, '/_matrix/media/v3/config', {
    headers: {
      authorization: `Bearer ${alice.access_token}`,
    },
  });
  assert.equal(legacyConfig.response.status, 200);
  assert.deepEqual(legacyConfig.payload, currentConfig.payload);

  const upload = await request(harness, '/_matrix/media/v3/upload?filename=phase08-media.gif', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.access_token}`,
      'content-type': 'image/gif',
    },
    body: 'GIF89a-phase08-media-body',
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
        controller.enqueue(Buffer.from('GIF89a-phase08-stream-', 'utf8'));
        controller.enqueue(Buffer.from('media-body', 'utf8'));
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
    },
  );
  assert.equal(currentDownload.response.status, 200);
  assert.equal(currentDownload.payload, 'GIF89a-phase08-media-body');

  const chunkedCurrentDownload = await request(
    harness,
    `/_matrix/client/v1/media/download/${encodeURIComponent(chunked.serverName)}/${encodeURIComponent(chunked.mediaId)}/phase08-media-stream.gif`,
    {
      headers: {
        authorization: `Bearer ${alice.access_token}`,
      },
    },
  );
  assert.equal(chunkedCurrentDownload.response.status, 200);
  assert.equal(chunkedCurrentDownload.payload, 'GIF89a-phase08-stream-media-body');

  const legacyDownload = await request(
    harness,
    `/_matrix/media/v3/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase08-media.gif`,
  );
  assert.equal(legacyDownload.response.status, 200);
  assert.equal(legacyDownload.payload, 'GIF89a-phase08-media-body');

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

  // The two upload requests above consume the same userdo_media semantic quota window.
  for (let index = 0; index < 6; index += 1) {
    const reservation = await postAuthenticated(harness, alice.access_token, '/_matrix/media/v3/create');
    assert.equal(reservation.response.status, 200);
  }
  const overQuotaReservation = await postAuthenticated(harness, alice.access_token, '/_matrix/media/v3/create');
  await expectMatrixError(overQuotaReservation, 429, 'M_LIMIT_EXCEEDED');
});
