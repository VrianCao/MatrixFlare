import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import jobsWorkerModule from '../../../apps/jobs-worker/src/index.mjs';
import opsWorkerModule from '../../../apps/ops-worker/src/index.mjs';
import {
  createD1ControlPlanePersistence,
  createJwtForTest,
} from '../../../packages/control-plane/src/index.mjs';
import {
  DEFAULT_MEDIA_ORPHAN_RETENTION_MS,
  buildLocalMediaObjectKey,
  buildMxcUri,
  buildRemoteMediaObjectKey,
  buildRoomArchiveObjectKey,
  buildThumbnailObjectKey,
  createD1DerivedDataPersistence,
  clearDerivedTarget,
} from '../../../packages/runtime-core/src/index.mjs';
import { createGatewayPhase04Rig } from './support.mjs';

async function expectMatrixError(response, status, errcode) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.errcode, errcode);
  return body;
}

async function registerUser(rig, {
  username,
  password = 'phase07-password',
  deviceId = `${username}-device`,
} = {}) {
  const challenge = await rig.gatewayFetch('/_matrix/client/v3/register', {
    method: 'POST',
    json: {
      username,
      password,
      device_id: deviceId,
    },
  });
  assert.equal(challenge.status, 401);
  const challengeBody = await challenge.json();
  const response = await rig.gatewayFetch('/_matrix/client/v3/register', {
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
  assert.equal(response.status, 200);
  return response.json();
}

async function getJson(rig, accessToken, pathname) {
  const response = await rig.gatewayFetch(pathname, {
    headers: rig.authHeaders(accessToken),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(rig, accessToken, pathname, json = {}) {
  const response = await rig.gatewayFetch(pathname, {
    method: 'POST',
    headers: rig.authHeaders(accessToken),
    json,
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function putJson(rig, accessToken, pathname, json = {}) {
  const response = await rig.gatewayFetch(pathname, {
    method: 'PUT',
    headers: rig.authHeaders(accessToken),
    json,
  });
  assert.equal(response.status, 200);
  return response.json();
}

function parseMxc(contentUri) {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(String(contentUri));
  assert.ok(match, `invalid content_uri: ${contentUri}`);
  return {
    serverName: match[1],
    mediaId: match[2],
  };
}

async function readResponseText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('utf8');
}

async function createOpsHarness(rig) {
  const teamDomain = `phase07-${Date.now()}.cloudflareaccess.com`;
  const audience = 'aud-phase07-ops';
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicJwk = keyPair.publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'kid-phase07-current';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const persistence = createD1ControlPlanePersistence(rig.env.MATRIX_CONTROL_D1);
  await persistence.ensureSchema();
  await persistence.upsertOperatorPolicy({
    principal_id: 'phase07-operator',
    principal_type: 'human',
    access_issuer: `https://${teamDomain}`,
    access_audience: audience,
    access_subject_binding: { mode: 'sub' },
    access_subject_value: '@operator:example.test',
    allowed_scopes: ['ops.read', 'ops.rebuild.write'],
    target_scope_constraints: {
      global: true,
    },
    expires_at: null,
    disabled_at: null,
    require_reason: false,
    require_ticket: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const opsEnv = {
    ...rig.env,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUDIENCE: audience,
    JOBS_WORKER: rig.env.JOBS_WORKER,
    __ACCESS_FETCH__: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    }),
  };

  function createAccessJwt({
    subject = '@operator:example.test',
    expiresInSeconds = 300,
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return createJwtForTest({
      header: {
        alg: 'RS256',
        typ: 'JWT',
        kid: 'kid-phase07-current',
      },
      payload: {
        iss: `https://${teamDomain}`,
        aud: audience,
        sub: subject,
        nbf: now - 10,
        exp: now + expiresInSeconds,
      },
      privateKeyPem,
    });
  }

  function makeOpsRequest(pathname, {
    method = 'GET',
    body = null,
    headers = {},
  } = {}) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Cf-Access-Jwt-Assertion', createAccessJwt());
    if (body != null) {
      requestHeaders.set('content-type', 'application/json; charset=utf-8');
    }
    return new Request(`https://ops.example.test${pathname}`, {
      method,
      headers: requestHeaders,
      body: body == null ? null : JSON.stringify(body),
    });
  }

  return {
    opsEnv,
    persistence,
    makeOpsRequest,
  };
}

async function archiveEventForRebuild(rig, roomId, eventId) {
  const roomDo = rig.getRoomDo(roomId);
  const hotRow = roomDo.persistence.hotEventJson.get({ event_id: eventId });
  assert.ok(hotRow, `expected hot event ${eventId}`);
  const metadata = roomDo.persistence.eventMetadata.get({ event_id: eventId });
  assert.ok(metadata, `expected event metadata ${eventId}`);
  const archiveKey = buildRoomArchiveObjectKey({
    roomId,
    checkpointId: `phase07-rebuild-${roomId}`,
    sequence: metadata.room_pos,
    segmentId: eventId.replace(/[^A-Za-z0-9._-]/g, '_'),
  });
  await rig.buckets.archive.put(archiveKey, hotRow.canonical_json, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
    },
  });
  roomDo.persistence.hotEventJson.delete({ event_id: eventId });
  roomDo.persistence.eventMetadata.put({
    ...metadata,
    archive_object_key_or_segment_id: archiveKey,
    record_json: metadata.record ?? null,
  });
  assert.equal(roomDo.persistence.hotEventJson.get({ event_id: eventId }), null);
  return archiveKey;
}

test('Phase 07 covers local media upload/download, compatibility routes, thumbnails, and lifecycle cleanup', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-media-alice' });
  const derived = createD1DerivedDataPersistence(rig.d1);
  await derived.ensureSchema();

  const currentConfig = await getJson(rig, alice.access_token, '/_matrix/client/v1/media/config');
  const legacyConfig = await getJson(rig, alice.access_token, '/_matrix/media/v3/config');
  assert.deepEqual(currentConfig, legacyConfig);
  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v1/media/config'),
    401,
    'M_MISSING_TOKEN',
  );
  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/config'),
    401,
    'M_MISSING_TOKEN',
  );

  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=phase07.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'image/gif',
    },
    body: 'GIF89a-phase07-local-media',
  });
  assert.equal(uploadResponse.status, 200);
  const uploadBody = await uploadResponse.json();
  const uploaded = parseMxc(uploadBody.content_uri);
  assert.equal(uploaded.serverName, rig.env.MATRIX_SERVER_NAME);

  await expectMatrixError(
    await rig.gatewayFetch(`/_matrix/client/v1/media/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}`),
    401,
    'M_MISSING_TOKEN',
  );

  const localObject = await rig.buckets.media.get(buildLocalMediaObjectKey(uploaded.mediaId));
  assert.ok(localObject);
  assert.equal(localObject.customMetadata?.legacy_unauth_access_flag, 'true');

  const currentDownload = await rig.gatewayFetch(
    `/_matrix/client/v1/media/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase07.txt`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(currentDownload.status, 200);
  assert.equal(await readResponseText(currentDownload), 'GIF89a-phase07-local-media');
  assert.match(currentDownload.headers.get('content-disposition') ?? '', /phase07\.txt/);

  const legacyDownload = await rig.gatewayFetch(
    `/_matrix/media/v3/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase07.txt`,
  );
  assert.equal(legacyDownload.status, 200);
  assert.equal(await readResponseText(legacyDownload), 'GIF89a-phase07-local-media');

  await rig.drainJobsQueues();
  const catalogRow = await derived.mediaCatalog.get({ mxc_uri: uploadBody.content_uri });
  assert.ok(catalogRow);
  assert.equal(catalogRow.origin_kind, 'local');
  assert.equal(catalogRow.legacy_unauth_access_flag, true);

  await expectMatrixError(
    await rig.gatewayFetch(
      `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=64&height=64&method=scale&animated=false`,
    ),
    401,
    'M_MISSING_TOKEN',
  );

  const staticThumbnail = await rig.gatewayFetch(
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=64&height=64&method=scale&animated=false`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(staticThumbnail.status, 200);
  const staticBody = await readResponseText(staticThumbnail);
  assert.match(staticBody, /^thumbnail:64x64:scale:static\n/);

  const animatedThumbnail = await rig.gatewayFetch(
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=64&height=64&method=scale&animated=true`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(animatedThumbnail.status, 200);
  const animatedBody = await readResponseText(animatedThumbnail);
  assert.match(animatedBody, /^thumbnail:64x64:scale:animated\n/);
  assert.notEqual(staticBody, animatedBody);

  assert.ok(
    [...rig.buckets.media.objects.keys()].some((key) => key.endsWith('/64x64/scale/static')),
    'expected a static thumbnail cache key',
  );
  assert.ok(
    [...rig.buckets.media.objects.keys()].some((key) => key.endsWith('/64x64/scale/animated')),
    'expected an animated thumbnail cache key',
  );

  const createResponse = await rig.gatewayFetch('/_matrix/media/v3/create', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(createResponse.status, 200);
  const reservation = await createResponse.json();
  const reserved = parseMxc(reservation.content_uri);

  const uploadByIdResponse = await rig.gatewayFetch(
    `/_matrix/media/v3/upload/${encodeURIComponent(reserved.serverName)}/${encodeURIComponent(reserved.mediaId)}?filename=reserved.txt`,
    {
      method: 'PUT',
      headers: {
        ...rig.authHeaders(alice.access_token),
        'content-type': 'text/plain; charset=utf-8',
      },
      body: 'reserved-media-body',
    },
  );
  assert.equal(uploadByIdResponse.status, 200);
  const uploadByIdBody = await uploadByIdResponse.json();
  assert.equal(uploadByIdBody.content_uri, reservation.content_uri);

  const unusedReservationResponse = await rig.gatewayFetch('/_matrix/media/v3/create', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(unusedReservationResponse.status, 200);
  const unusedReservation = await unusedReservationResponse.json();
  const unusedReserved = parseMxc(unusedReservation.content_uri);
  const userDo = rig.getUserDo(alice.user_id);
  const reservationGrant = userDo.persistence.pendingUploadGrants.list()
    .find((row) => row.media_id === unusedReserved.mediaId);
  assert.ok(reservationGrant);
  await userDo.alarm({
    scheduledTime: Date.parse(reservationGrant.expires_at) + 1,
  });
  const expiredGrant = userDo.persistence.pendingUploadGrants.get({
    pending_upload_id: reservationGrant.pending_upload_id,
  });
  assert.equal(expiredGrant.state, 'expired');

  const orphanGrantResult = await userDo.beginMediaUpload({
    user_id: alice.user_id,
    content_type: 'text/plain',
    declared_size: 1,
    media_id: 'phase07-orphaned-media',
  });
  assert.equal(orphanGrantResult.ok, true);
  const orphanObjectKey = buildLocalMediaObjectKey('phase07-orphaned-media');
  await rig.buckets.media.put(orphanObjectKey, 'orphan-body', {
    customMetadata: {
      first_ingested_at: new Date().toISOString(),
      legacy_unauth_access_flag: 'true',
      content_type: 'text/plain',
      byte_size: '11',
      content_hash: 'orphan-hash',
    },
    httpMetadata: {
      contentType: 'text/plain',
    },
  });
  const orphanedAt = new Date().toISOString();
  const orphanFinalize = await userDo.finalizeMediaUpload({
    pending_upload_id: orphanGrantResult.grant.pending_upload_id,
    finalize_state: 'orphaned',
    r2_object_key: orphanObjectKey,
    error_message: 'forced orphan for lifecycle cleanup',
    upload_completed_at: orphanedAt,
  });
  assert.equal(orphanFinalize.ok, true);
  assert.ok(await rig.buckets.media.get(orphanObjectKey));
  await userDo.alarm({
    scheduledTime: Date.parse(orphanedAt) + DEFAULT_MEDIA_ORPHAN_RETENTION_MS + 1_000,
  });
  assert.equal(await rig.buckets.media.get(orphanObjectKey), null);
  const cleanedGrant = userDo.persistence.pendingUploadGrants.get({
    pending_upload_id: orphanGrantResult.grant.pending_upload_id,
  });
  assert.equal(cleanedGrant.state, 'cleaned');
});

test('Phase 07 media upload uses multipart writes for request streams without content-length', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-stream-upload-alice' });
  const originalCreateMultipartUpload = rig.env.MATRIX_MEDIA_BUCKET.createMultipartUpload.bind(rig.env.MATRIX_MEDIA_BUCKET);
  let multipartUploadUsed = false;
  let uploadedPartCount = 0;

  rig.env.MATRIX_MEDIA_BUCKET.createMultipartUpload = async (...args) => {
    multipartUploadUsed = true;
    const upload = await originalCreateMultipartUpload(...args);
    const originalUploadPart = upload.uploadPart.bind(upload);
    return {
      async uploadPart(partNumber, value) {
        uploadedPartCount += 1;
        return originalUploadPart(partNumber, value);
      },
      complete: upload.complete.bind(upload),
      abort: upload.abort.bind(upload),
    };
  };

  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=stream-upload.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('chunked-stream-', 'utf8'));
        controller.enqueue(Buffer.from('body', 'utf8'));
        controller.close();
      },
    }),
  });
  assert.equal(uploadResponse.status, 200);
  assert.equal(multipartUploadUsed, true);
  assert.equal(uploadedPartCount, 1);

  const uploaded = parseMxc((await uploadResponse.json()).content_uri);
  const stored = await rig.buckets.media.get(buildLocalMediaObjectKey(uploaded.mediaId));
  assert.ok(stored);
  assert.equal(await stored.text(), 'chunked-stream-body');
});

test('Phase 07 media upload failures fail closed and preserve orphan cleanup state', async (t) => {
  const rig = createGatewayPhase04Rig({
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '8',
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-media-failure-alice' });
  const userDo = rig.getUserDo(alice.user_id);

  const tooLargeResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=too-large.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: '0123456789',
  });
  await expectMatrixError(tooLargeResponse, 413, 'M_TOO_LARGE');

  const revertedGrant = userDo.persistence.pendingUploadGrants.list()
    .find((row) => row.record?.filename === 'too-large.txt');
  assert.ok(revertedGrant);
  assert.equal(revertedGrant.state, 'reverted');
  assert.equal(await rig.buckets.media.get(buildLocalMediaObjectKey(revertedGrant.media_id)), null);

  const originalFinalize = userDo.finalizeMediaUpload.bind(userDo);
  userDo.finalizeMediaUpload = async function finalizeMediaUploadWithSyntheticFailure(request) {
    if (request?.finalize_state === 'completed') {
      return {
        ok: false,
        error: {
          code: 'backpressure',
          message: 'synthetic finalize failure',
          retryable: true,
        },
      };
    }
    return originalFinalize(request);
  };

  const finalizeFailureResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=orphan-after-finalize.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: 'orphan',
  });
  await expectMatrixError(finalizeFailureResponse, 503, 'M_UNKNOWN');

  const orphanedGrant = userDo.persistence.pendingUploadGrants.list()
    .find((row) => row.record?.filename === 'orphan-after-finalize.txt');
  assert.ok(orphanedGrant);
  assert.equal(orphanedGrant.state, 'orphaned');
  assert.ok(await rig.buckets.media.get(buildLocalMediaObjectKey(orphanedGrant.media_id)));
});

test('Phase 07 enforces legacy freeze semantics and remote-media cache-miss guards', async (t) => {
  const rig = createGatewayPhase04Rig({
    FF_MEDIA_REMOTE_FETCH: 'true',
    MATRIX_MEDIA_LEGACY_UNAUTH_FREEZE_AT: '2026-01-01T00:00:00.000Z',
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-remote-alice' });
  let remoteFetchCount = 0;
  rig.env.__REMOTE_MEDIA_FETCH__ = async () => {
    remoteFetchCount += 1;
    return new Response('remote-media-body', {
      status: 200,
      headers: {
        'content-type': 'image/png',
      },
    });
  };

  const currentNoRemote = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/media-no-remote?allow_remote=false',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(currentNoRemote, 404, 'M_NOT_FOUND');
  assert.equal(remoteFetchCount, 0);

  const currentRemote = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/media-after-freeze',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(currentRemote.status, 200);
  assert.equal(await readResponseText(currentRemote), 'remote-media-body');
  assert.equal(remoteFetchCount, 1);

  const remoteObject = await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'media-after-freeze'));
  assert.ok(remoteObject);
  assert.equal(remoteObject.customMetadata?.legacy_unauth_access_flag, 'false');

  const currentThumbnailOnMiss = await rig.gatewayFetch(
    '/_matrix/client/v1/media/thumbnail/remote.example/thumb-first-after-freeze?width=48&height=48&method=scale',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(currentThumbnailOnMiss.status, 200);
  assert.match(await readResponseText(currentThumbnailOnMiss), /^thumbnail:48x48:scale:static\n/);
  assert.equal(remoteFetchCount, 2);
  assert.ok(
    await rig.buckets.media.get(buildThumbnailObjectKey({
      sourceKind: 'remote',
      originServerName: 'remote.example',
      mediaId: 'thumb-first-after-freeze',
      width: 48,
      height: 48,
      method: 'scale',
      animated: false,
    })),
  );
  assert.equal(
    await rig.buckets.media.get(buildThumbnailObjectKey({
      sourceKind: 'local',
      mediaId: 'thumb-first-after-freeze',
      width: 48,
      height: 48,
      method: 'scale',
      animated: false,
    })),
    null,
  );

  const currentRemoteCached = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/media-after-freeze',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(currentRemoteCached.status, 200);
  assert.equal(remoteFetchCount, 2);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/download/remote.example/media-after-freeze'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 2);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/download/remote.example/cache-miss-after-freeze'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 2);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/thumbnail/remote.example/cache-miss-after-freeze?width=32&height=32&method=scale'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 2);

  const currentThumbnail = await rig.gatewayFetch(
    '/_matrix/client/v1/media/thumbnail/remote.example/media-after-freeze?width=32&height=32&method=scale',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(currentThumbnail.status, 200);
  assert.match(await readResponseText(currentThumbnail), /^thumbnail:32x32:scale:static\n/);
  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/thumbnail/remote.example/media-after-freeze?width=32&height=32&method=scale'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 2);
});

test('Phase 07 remote-media fetch failures are deterministic and do not leave cache residue', async (t) => {
  const rig = createGatewayPhase04Rig({
    FF_MEDIA_REMOTE_FETCH: 'true',
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '8',
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-remote-failure-alice' });

  rig.env.__REMOTE_MEDIA_FETCH__ = async () => new Response('0123456789', {
    status: 200,
    headers: {
      'content-type': 'image/png',
    },
  });

  const oversizedDownload = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/oversized-remote-object',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(oversizedDownload, 413, 'M_TOO_LARGE');
  assert.equal(
    await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'oversized-remote-object')),
    null,
  );

  rig.env.__REMOTE_MEDIA_FETCH__ = async () => new Response('upstream-failure', {
    status: 500,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });

  const failedDownload = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/upstream-500',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(failedDownload, 503, 'M_UNKNOWN');
  assert.equal(
    await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'upstream-500')),
    null,
  );

  const failedThumbnail = await rig.gatewayFetch(
    '/_matrix/client/v1/media/thumbnail/remote.example/upstream-500-thumb?width=32&height=32&method=scale',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(failedThumbnail, 503, 'M_UNKNOWN');
  assert.equal(
    await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'upstream-500-thumb')),
    null,
  );
});

test('Phase 07 remote-media fetch cancels unused upstream bodies and normalizes timeout failures', async (t) => {
  const rig = createGatewayPhase04Rig({
    FF_MEDIA_REMOTE_FETCH: 'true',
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-remote-cancel-alice' });
  let notFoundCancelled = false;
  let upstreamCancelled = false;

  rig.env.__REMOTE_MEDIA_FETCH__ = async () => ({
    ok: false,
    status: 404,
    body: {
      async cancel() {
        notFoundCancelled = true;
      },
    },
  });

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v1/media/download/remote.example/upstream-404', {
      headers: rig.authHeaders(alice.access_token),
    }),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(notFoundCancelled, true);
  assert.equal(
    await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'upstream-404')),
    null,
  );

  rig.env.__REMOTE_MEDIA_FETCH__ = async () => ({
    ok: false,
    status: 500,
    body: {
      async cancel() {
        upstreamCancelled = true;
      },
    },
  });

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v1/media/download/remote.example/upstream-500-cancel', {
      headers: rig.authHeaders(alice.access_token),
    }),
    503,
    'M_UNKNOWN',
  );
  assert.equal(upstreamCancelled, true);
  assert.equal(
    await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'upstream-500-cancel')),
    null,
  );

  rig.env.__REMOTE_MEDIA_FETCH__ = async () => {
    const error = new Error('synthetic timeout');
    error.name = 'TimeoutError';
    throw error;
  };

  const timedOutDownload = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/upstream-timeout',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  const timeoutBody = await expectMatrixError(timedOutDownload, 503, 'M_UNKNOWN');
  assert.match(timeoutBody.error, /timed out/i);
  assert.equal(
    await rig.buckets.media.get(buildRemoteMediaObjectKey('remote.example', 'upstream-timeout')),
    null,
  );
});

test('Phase 07 thumbnail backoff failures surface as deterministic Matrix limit errors', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-thumbnail-lock-alice' });
  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=thumb-lock.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: 'thumbnail-lock-source',
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = parseMxc((await uploadResponse.json()).content_uri);

  rig.env.MATRIX_EDGE_CACHE.get = async () => JSON.stringify({
    locked_at: new Date().toISOString(),
  });

  const lockedThumbnail = await rig.gatewayFetch(
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=32&height=32&method=scale`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(lockedThumbnail, 429, 'M_LIMIT_EXCEEDED');
  assert.equal(
    await rig.buckets.media.get(buildThumbnailObjectKey({
      sourceKind: 'local',
      mediaId: uploaded.mediaId,
      width: 32,
      height: 32,
      method: 'scale',
      animated: false,
    })),
    null,
  );
});

test('Phase 07 covers derived queries, alias lookup, hierarchy, and rebuild from truth plus archive', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-derived-alice' });
  const bob = await registerUser(rig, { username: 'phase07-derived-bob' });

  await putJson(
    rig,
    bob.access_token,
    `/_matrix/client/v3/profile/${encodeURIComponent(bob.user_id)}/displayname`,
    { displayname: 'Bob Needle Directory' },
  );

  const publicRoom = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'public',
    preset: 'public_chat',
    room_alias_name: 'phase07-public-room',
    name: 'Phase 07 Public Room',
    topic: 'Needle topic for public rooms',
    initial_state: [
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: {
          history_visibility: 'world_readable',
        },
      },
    ],
  });
  const publicRoomId = publicRoom.room_id;

  await rig.drainJobsQueues();

  const joinByAlias = await rig.gatewayFetch(
    `/_matrix/client/v3/join/${encodeURIComponent(`#phase07-public-room:${rig.env.MATRIX_SERVER_NAME}`)}`,
    {
      method: 'POST',
      headers: rig.authHeaders(bob.access_token),
      json: {},
    },
  );
  assert.equal(joinByAlias.status, 200);
  assert.deepEqual(await joinByAlias.json(), {
    room_id: publicRoomId,
  });

  const messageResponse = await rig.gatewayFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(publicRoomId)}/send/m.room.message/phase07-msg-1`,
    {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        msgtype: 'm.text',
        body: 'phase07 searchable needle from archive',
      },
    },
  );
  assert.equal(messageResponse.status, 200);
  const messageBody = await messageResponse.json();

  const spaceRoom = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'public',
    preset: 'public_chat',
    name: 'Phase 07 Space',
    creation_content: {
      type: 'm.space',
    },
    initial_state: [
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: {
          history_visibility: 'world_readable',
        },
      },
    ],
  });
  const spaceRoomId = spaceRoom.room_id;
  await putJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/state/m.space.child/${encodeURIComponent(publicRoomId)}`,
    {
      via: [rig.env.MATRIX_SERVER_NAME],
    },
  );

  const privateRoom = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'private',
    room_alias_name: 'phase07-private-room',
    name: 'Phase 07 Private Room',
  });
  const privateRoomId = privateRoom.room_id;
  await putJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/state/m.space.child/${encodeURIComponent(privateRoomId)}`,
    {
      via: [rig.env.MATRIX_SERVER_NAME],
    },
  );

  await rig.drainJobsQueues();
  const archivedEventKey = await archiveEventForRebuild(rig, publicRoomId, messageBody.event_id);

  const anonymousPublicRoomsResponse = await rig.gatewayFetch('/_matrix/client/v3/publicRooms?limit=10&search_term=Phase');
  assert.equal(anonymousPublicRoomsResponse.status, 200);
  const anonymousPublicRooms = await anonymousPublicRoomsResponse.json();

  const authenticatedPublicRooms = await postJson(rig, alice.access_token, '/_matrix/client/v3/publicRooms', {
    limit: 10,
    filter: {
      generic_search_term: 'Phase',
    },
  });
  assert.deepEqual(authenticatedPublicRooms, anonymousPublicRooms);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/publicRooms', {
      method: 'POST',
      json: {
        limit: 10,
      },
    }),
    401,
    'M_MISSING_TOKEN',
  );

  await putJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/user/${encodeURIComponent(alice.user_id)}/account_data/${encodeURIComponent('m.ignored_user_list')}`,
    {
      ignored_users: {
        [bob.user_id]: {},
      },
    },
  );
  const ignoredUserDirectory = await postJson(rig, alice.access_token, '/_matrix/client/v3/user_directory/search', {
    search_term: 'Needle',
    limit: 10,
  });
  assert.ok(!ignoredUserDirectory.results.some((entry) => entry.user_id === bob.user_id));

  await putJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/user/${encodeURIComponent(alice.user_id)}/account_data/${encodeURIComponent('m.ignored_user_list')}`,
    {
      ignored_users: {},
    },
  );
  const userDirectory = await postJson(rig, alice.access_token, '/_matrix/client/v3/user_directory/search', {
    search_term: 'Needle',
    limit: 10,
  });
  assert.ok(userDirectory.results.some((entry) => entry.user_id === bob.user_id));

  const searchResponse = await postJson(rig, alice.access_token, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: 'needle',
        filter: {
          rooms: [publicRoomId],
          limit: 10,
        },
      },
    },
  });
  assert.ok(
    searchResponse.search_categories.room_events.results.some(
      (entry) => entry.result.event_id === messageBody.event_id,
    ),
  );

  const hierarchy = await getJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/hierarchy`,
  );
  assert.ok(hierarchy.children.some((entry) => entry.room_id === publicRoomId));
  assert.ok(!hierarchy.children.some((entry) => entry.room_id === privateRoomId));

  const derived = createD1DerivedDataPersistence(rig.d1);
  await derived.ensureSchema();
  const privateTruthEntry = await rig.getRoomDo(privateRoomId).getPublicRoomDirectoryEntry({
    room_id: privateRoomId,
  });
  assert.equal(privateTruthEntry.entry.is_public, false);
  await derived.publicRoomDirectory.put({
    ...privateTruthEntry.entry,
    canonical_alias: `#phase07-private-room:${rig.env.MATRIX_SERVER_NAME}`,
    join_rules: 'public',
    history_visibility: 'world_readable',
    world_readable: true,
    guest_can_join: true,
    is_public: true,
    updated_at: new Date().toISOString(),
    record_json: {
      stale_visibility_injected: true,
    },
  });

  const privateRoomsResponse = await rig.gatewayFetch('/_matrix/client/v3/publicRooms?limit=10&search_term=Private');
  assert.equal(privateRoomsResponse.status, 200);
  const privateRooms = await privateRoomsResponse.json();
  assert.ok(!privateRooms.chunk.some((entry) => entry.room_id === privateRoomId));

  const hierarchyAfterPrivateInjection = await getJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/hierarchy`,
  );
  assert.ok(!hierarchyAfterPrivateInjection.children.some((entry) => entry.room_id === privateRoomId));

  await expectMatrixError(
    await rig.gatewayFetch(
      `/_matrix/client/v3/join/${encodeURIComponent(`#phase07-private-room:${rig.env.MATRIX_SERVER_NAME}`)}`,
      {
        method: 'POST',
        headers: rig.authHeaders(bob.access_token),
        json: {},
      },
    ),
    404,
    'M_NOT_FOUND',
  );

  await derived.publicRoomDirectory.delete({ room_id: publicRoomId });
  const charlie = await registerUser(rig, { username: 'phase07-derived-charlie' });
  const joinByAliasAfterDerivedDelete = await rig.gatewayFetch(
    `/_matrix/client/v3/join/${encodeURIComponent(`#phase07-public-room:${rig.env.MATRIX_SERVER_NAME}`)}`,
    {
      method: 'POST',
      headers: rig.authHeaders(charlie.access_token),
      json: {},
    },
  );
  assert.equal(joinByAliasAfterDerivedDelete.status, 200);
  assert.deepEqual(await joinByAliasAfterDerivedDelete.json(), {
    room_id: publicRoomId,
  });

  const publicRoomsAfterDerivedDelete = await rig.gatewayFetch('/_matrix/client/v3/publicRooms?limit=10&search_term=Public');
  assert.equal(publicRoomsAfterDerivedDelete.status, 200);
  const publicRoomsAfterDelete = await publicRoomsAfterDerivedDelete.json();
  assert.ok(publicRoomsAfterDelete.chunk.some((entry) => entry.room_id === publicRoomId));

  const hierarchyAfterDerivedDelete = await getJson(
    rig,
    alice.access_token,
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/hierarchy`,
  );
  assert.ok(hierarchyAfterDerivedDelete.children.some((entry) => entry.room_id === publicRoomId));

  await rig.drainJobsQueues();

  const expectedSearch = await derived.searchIndex.list();
  const expectedUsers = await derived.userDirectory.list();
  const expectedPublicRooms = await derived.publicRoomDirectory.list();
  assert.ok(expectedSearch.some((row) => row.event_id === messageBody.event_id));
  assert.ok(expectedUsers.some((row) => row.user_id === bob.user_id));
  assert.ok(expectedUsers.some((row) => row.user_id === charlie.user_id));
  assert.ok(expectedPublicRooms.some((row) => row.room_id === publicRoomId));

  await clearDerivedTarget(rig.env, { target: 'all_derived' });
  assert.equal((await derived.searchIndex.list()).length, 0);
  assert.equal((await derived.userDirectory.list()).length, 0);
  assert.equal((await derived.publicRoomDirectory.list()).length, 0);

  const emptySearch = await postJson(rig, alice.access_token, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: 'needle',
        filter: {
          rooms: [publicRoomId],
          limit: 10,
        },
      },
    },
  });
  assert.equal(emptySearch.search_categories.room_events.results.length, 0);

  await derived.searchIndex.put({
    event_id: '$phase07-stale-search',
    room_id: '!stale-room:matrix.example.test',
    event_type: 'm.room.message',
    origin_server_ts: 1,
    sender_user_id: alice.user_id,
    search_vector_text: 'phase07 stale search row',
    visibility_scope: 'shared',
    updated_at: new Date().toISOString(),
    record_json: {
      stale: true,
    },
  });
  await derived.userDirectory.put({
    user_id: '@phase07-stale:matrix.example.test',
    displayname: 'Phase 07 Stale User',
    avatar_url: null,
    profile_version: 1,
    directory_visibility: 'visible',
    discovery_flags_json: {},
    updated_at: new Date().toISOString(),
    record_json: {
      stale: true,
    },
  });
  await derived.publicRoomDirectory.put({
    room_id: '!phase07-stale-room:matrix.example.test',
    canonical_alias: '#phase07-stale:matrix.example.test',
    name: 'Phase 07 Stale Room',
    topic: 'stale derived row',
    avatar_url: null,
    join_rules: 'public',
    history_visibility: 'world_readable',
    world_readable: true,
    guest_can_join: false,
    joined_members: 1,
    room_serial: 1,
    visibility_watermark: 1,
    is_public: true,
    updated_at: new Date().toISOString(),
    record_json: {
      stale: true,
    },
  });

  const opsHarness = await createOpsHarness(rig);
  const rebuildResponse = await opsWorkerModule.fetch(
    opsHarness.makeOpsRequest('/_ops/v1/rebuilds', {
      method: 'POST',
      body: {
        rebuild_target: 'all_derived',
        scope: {
          scope_kind: 'global',
          scope_id: null,
        },
        reason: 'phase07 rebuild validation',
        ticket_id: 'OPS-PHASE07',
        force_full_scan: false,
      },
      headers: {
        'Idempotency-Key': 'phase07-rebuild-idem',
      },
    }),
    opsHarness.opsEnv,
  );
  assert.equal(rebuildResponse.status, 202);
  const rebuildHandle = await rebuildResponse.json();
  assert.equal(rebuildHandle.job_type, 'rebuild');
  assert.ok(rig.queues.rebuild.messages.length >= 1);

  await rig.drainJobsQueues();

  const rebuiltSearch = await derived.searchIndex.list();
  const rebuiltUsers = await derived.userDirectory.list();
  const rebuiltPublicRooms = await derived.publicRoomDirectory.list();
  assert.deepEqual(
    rebuiltSearch.map((row) => row.event_id).sort(),
    expectedSearch.map((row) => row.event_id).sort(),
  );
  assert.deepEqual(
    rebuiltUsers.map((row) => row.user_id).sort(),
    expectedUsers.map((row) => row.user_id).sort(),
  );
  assert.deepEqual(
    rebuiltPublicRooms.map((row) => row.room_id).sort(),
    expectedPublicRooms.map((row) => row.room_id).sort(),
  );
  const rebuiltArchivedRow = rebuiltSearch.find((row) => row.event_id === messageBody.event_id);
  assert.ok(rebuiltArchivedRow);
  assert.equal(rebuiltArchivedRow.record?.archive_object_key_or_segment_id, archivedEventKey);
  assert.match(rebuiltArchivedRow.search_vector_text, /phase07 searchable needle from archive/);
  assert.ok(rebuiltUsers.some((row) => row.user_id === bob.user_id && row.displayname === 'Bob Needle Directory'));
  assert.ok(
    rebuiltPublicRooms.some(
      (row) => row.room_id === publicRoomId
        && row.canonical_alias === `#phase07-public-room:${rig.env.MATRIX_SERVER_NAME}`,
    ),
  );
  assert.equal(rebuiltSearch.find((row) => row.event_id === '$phase07-stale-search'), undefined);
  assert.equal(rebuiltUsers.find((row) => row.user_id === '@phase07-stale:matrix.example.test'), undefined);
  assert.equal(rebuiltPublicRooms.find((row) => row.room_id === '!phase07-stale-room:matrix.example.test'), undefined);

  const rebuiltSearchResponse = await postJson(rig, alice.access_token, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: 'needle',
        filter: {
          rooms: [publicRoomId],
          limit: 10,
        },
      },
    },
  });
  assert.ok(
    rebuiltSearchResponse.search_categories.room_events.results.some(
      (entry) => entry.result.event_id === messageBody.event_id,
    ),
  );

  const rebuiltJob = await opsHarness.persistence.getJob(rebuildHandle.job_id);
  assert.ok(rebuiltJob);
  assert.equal(rebuiltJob.internal_state, 'completed');
  assert.equal(rebuiltJob.progress_completed_units, rebuiltJob.progress_total_units);
  assert.equal(rebuiltJob.result_summary?.terminal_state, 'succeeded');
  assert.equal(rebuiltJob.result_summary?.rebuild_summary?.rebuild_target, 'all_derived');
  assert.ok(rebuiltJob.checkpoint_state?.last_completed_checkpoint_id);
});

test('Phase 07 rebuild checkpoints large room shards across multiple queue invocations within the D1 budget', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());
  const derived = createD1DerivedDataPersistence(rig.d1);

  const alice = await registerUser(rig, { username: 'phase07-budget-alice' });
  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'public',
    preset: 'public_chat',
    room_alias_name: 'phase07-budget-room',
    name: 'Phase 07 Budget Room',
  });
  const roomId = room.room_id;
  await rig.drainJobsQueues();
  const roomDo = rig.getRoomDo(roomId);
  const searchRows = Array.from({ length: 11_000 }, (_, index) => ({
    event_id: `$phase07-budget-${index}`,
    room_id: roomId,
    event_type: 'm.room.message',
    origin_server_ts: index + 1,
    sender_user_id: alice.user_id,
    search_vector_text: `phase07 budget row ${index}`,
    visibility_scope: 'shared',
    updated_at: new Date().toISOString(),
    record_json: {
      room_pos: index + 1,
    },
  }));
  roomDo.exportDerivedShard = async function exportOversizedDerivedShard() {
    const [request = {}] = arguments;
    const offset = Number.isInteger(request.search_row_offset) && request.search_row_offset >= 0
      ? request.search_row_offset
      : 0;
    const limit = Number.isInteger(request.search_limit) && request.search_limit >= 1
      ? request.search_limit
      : searchRows.length;
    const searchChunk = request.include_search_index_rows === false
      ? []
      : searchRows.slice(offset, offset + limit);
    const nextOffset = offset + searchChunk.length < searchRows.length
      ? offset + searchChunk.length
      : null;
    return {
      ok: true,
      room_id: roomId,
      max_room_pos: request.max_room_pos ?? searchRows.length,
      search_row_offset: offset,
      next_search_row_offset: nextOffset,
      total_search_index_rows: request.include_search_index_rows === false ? 0 : searchRows.length,
      has_more_search_index_rows: nextOffset != null,
      search_index_rows: searchChunk,
      public_room_directory_entry: null,
    };
  };

  const opsHarness = await createOpsHarness(rig);
  const rebuildResponse = await opsWorkerModule.fetch(
    opsHarness.makeOpsRequest('/_ops/v1/rebuilds', {
      method: 'POST',
      body: {
        rebuild_target: 'search_index',
        scope: {
          scope_kind: 'global',
          scope_id: null,
        },
        reason: 'phase07 rebuild budget guard',
        ticket_id: 'OPS-PHASE07-BUDGET',
        force_full_scan: false,
      },
      headers: {
        'Idempotency-Key': 'phase07-rebuild-budget-idem',
      },
    }),
    opsHarness.opsEnv,
  );
  assert.equal(rebuildResponse.status, 202);
  const rebuildHandle = await rebuildResponse.json();
  assert.equal(rebuildHandle.job_type, 'rebuild');
  assert.equal(rig.queues.rebuild.messages.length, 1);

  const initialBatch = rig.queues.rebuild.drainBatch();
  const initialMessageBody = structuredClone(initialBatch.messages[0].body);
  await jobsWorkerModule.queue(initialBatch, rig.env);
  assert.ok(rig.queues.rebuild.messages.length >= 1);

  const staleRetryBatch = {
    queue: rig.env.REBUILD_SHARD_QUEUE.queueName,
    messages: [{
      body: initialMessageBody,
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      },
    }],
  };
  await jobsWorkerModule.queue(staleRetryBatch, rig.env);
  assert.equal(staleRetryBatch.messages[0].acked, true);
  assert.equal(staleRetryBatch.messages[0].retried, false);

  await rig.drainJobsQueues();

  const rebuiltSearch = await derived.searchIndex.list();
  assert.equal(rebuiltSearch.length, searchRows.length);
  assert.equal(rebuiltSearch[0].event_id, searchRows[0].event_id);
  assert.equal(rebuiltSearch.at(-1).event_id, searchRows.at(-1).event_id);

  const rebuiltJob = await opsHarness.persistence.getJob(rebuildHandle.job_id);
  assert.ok(rebuiltJob);
  assert.equal(rebuiltJob.internal_state, 'completed');
  assert.equal(rebuiltJob.result_summary?.terminal_state, 'succeeded');
  assert.equal(
    rebuiltJob.checkpoint_state?.rebuild_shard_progress?.search_rows_applied,
    searchRows.length,
  );
  assert.equal(
    rebuiltJob.checkpoint_state?.rebuild_shard_progress?.chunks_completed,
    2,
  );
  assert.equal(
    rebuiltJob.checkpoint_state?.rebuild_shard_progress?.next_chunk_cursor,
    null,
  );
  const checkpoint = await opsHarness.persistence.getJobCheckpoint({
    job_id: rebuildHandle.job_id,
    shard_type: 'RoomDO',
    shard_key: roomId,
  });
  assert.equal(checkpoint.checkpoint.status, 'complete');
  assert.equal(checkpoint.checkpoint.rebuild_progress.search_rows_applied, searchRows.length);
  assert.equal(checkpoint.checkpoint.rebuild_progress.chunks_completed, 2);
});

test('Phase 07 maps derived query validation failures to deterministic Matrix invalid-param errors', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-invalid-query-alice' });

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_term: 'needle',
        limit: -1,
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_term: 'needle',
        limit: '2',
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_categories: {
          room_events: {
            search_term: 'needle',
            filter: {
              limit: -1,
            },
          },
        },
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_categories: {
          room_events: {
            search_term: 'needle',
            filter: {
              limit: '2',
            },
          },
        },
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_categories: {
          room_events: {
            search_term: 'needle',
            filter: {
              rooms: [123],
              limit: 1,
            },
          },
        },
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_categories: {
          room_events: {
            search_term: 'needle',
            filter: {
              rooms: 'not-an-array',
              limit: 1,
            },
          },
        },
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/search', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        search_categories: {
          room_events: {
            search_term: 'needle',
            next_batch: 'not-a-valid-token',
          },
        },
      },
    }),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/publicRooms?since=not-a-valid-token'),
    400,
    'M_INVALID_PARAM',
  );

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/publicRooms?limit=10foo'),
    400,
    'M_INVALID_PARAM',
  );
});

test('Phase 07 search paginates only visible hits and does not leak hidden-result cursors', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-search-visible-alice' });
  const bob = await registerUser(rig, { username: 'phase07-search-visible-bob' });

  const publicRoom = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'public',
    preset: 'public_chat',
    room_alias_name: 'phase07-search-visible-room',
    name: 'Phase 07 Search Visible Room',
  });
  const publicRoomId = publicRoom.room_id;
  const joinVisible = await rig.gatewayFetch(
    `/_matrix/client/v3/join/${encodeURIComponent(`#phase07-search-visible-room:${rig.env.MATRIX_SERVER_NAME}`)}`,
    {
      method: 'POST',
      headers: rig.authHeaders(bob.access_token),
      json: {},
    },
  );
  assert.equal(joinVisible.status, 200);

  const visibleOne = await rig.gatewayFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(publicRoomId)}/send/m.room.message/phase07-visible-1`,
    {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        msgtype: 'm.text',
        body: 'phase07 visible needle one',
      },
    },
  );
  assert.equal(visibleOne.status, 200);
  const visibleOneBody = await visibleOne.json();
  const visibleTwo = await rig.gatewayFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(publicRoomId)}/send/m.room.message/phase07-visible-2`,
    {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        msgtype: 'm.text',
        body: 'phase07 visible needle two',
      },
    },
  );
  assert.equal(visibleTwo.status, 200);
  const visibleTwoBody = await visibleTwo.json();

  const privateRoom = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'private',
    name: 'Phase 07 Search Hidden Room',
  });
  const privateRoomId = privateRoom.room_id;
  const hiddenOne = await rig.gatewayFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(privateRoomId)}/send/m.room.message/phase07-hidden-1`,
    {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        msgtype: 'm.text',
        body: 'phase07 hidden needle one',
      },
    },
  );
  assert.equal(hiddenOne.status, 200);
  const hiddenTwo = await rig.gatewayFetch(
    `/_matrix/client/v3/rooms/${encodeURIComponent(privateRoomId)}/send/m.room.message/phase07-hidden-2`,
    {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        msgtype: 'm.text',
        body: 'phase07 hidden needle two',
      },
    },
  );
  assert.equal(hiddenTwo.status, 200);

  await rig.drainJobsQueues();

  const firstPage = await postJson(rig, bob.access_token, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: 'needle',
        filter: {
          rooms: [publicRoomId],
          limit: 1,
        },
      },
    },
  });
  assert.equal(firstPage.search_categories.room_events.results.length, 1);
  assert.equal(firstPage.search_categories.room_events.results[0].result.event_id, visibleTwoBody.event_id);
  assert.ok(typeof firstPage.search_categories.room_events.next_batch === 'string');

  const secondPage = await postJson(rig, bob.access_token, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: 'needle',
        next_batch: firstPage.search_categories.room_events.next_batch,
        filter: {
          rooms: [publicRoomId],
          limit: 1,
        },
      },
    },
  });
  assert.equal(secondPage.search_categories.room_events.results.length, 1);
  assert.equal(secondPage.search_categories.room_events.results[0].result.event_id, visibleOneBody.event_id);
  assert.ok(!Object.hasOwn(secondPage.search_categories.room_events, 'next_batch'));

  const hiddenPage = await postJson(rig, bob.access_token, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: 'needle',
        filter: {
          rooms: [privateRoomId],
          limit: 1,
        },
      },
    },
  });
  assert.equal(hiddenPage.search_categories.room_events.results.length, 0);
  assert.equal(hiddenPage.search_categories.room_events.count, 0);
  assert.ok(!Object.hasOwn(hiddenPage.search_categories.room_events, 'next_batch'));
});

test('Phase 07 retries shard-registry barriers without duplicating room truth', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-registry-alice' });
  const createRoomBody = {
    visibility: 'public',
    preset: 'public_chat',
    room_alias_name: 'phase07-registry-room',
    name: 'Phase 07 Registry Room',
  };

  const originalPrepare = rig.env.MATRIX_CONTROL_D1.prepare.bind(rig.env.MATRIX_CONTROL_D1);
  let failRoomRegistryUpsert = true;
  rig.env.MATRIX_CONTROL_D1.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('INSERT INTO shard_registry')) {
      return statement;
    }
    return {
      bind(...bindings) {
        const bound = statement.bind(...bindings);
        return {
          run: async () => {
            if (failRoomRegistryUpsert && bindings[0] === 'RoomDO') {
              failRoomRegistryUpsert = false;
              throw new Error('synthetic shard registry failure');
            }
            return bound.run();
          },
          first: async () => bound.first(),
          all: async () => bound.all(),
        };
      },
    };
  };

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: createRoomBody,
    }),
    503,
    'M_UNKNOWN',
  );

  const roomId = [...rig.env.ROOM_DO.instances.keys()][0];
  assert.ok(roomId);
  const roomDo = rig.getRoomDo(roomId);
  const createEvent = roomDo.persistence.eventMetadata.list().find((row) => row.event_type === 'm.room.create');
  assert.ok(createEvent);
  assert.ok(roomDo.getRegistryRetryMarker());

  const controlPlane = createD1ControlPlanePersistence(rig.env.MATRIX_CONTROL_D1);
  await controlPlane.ensureSchema();
  assert.ok(!(await controlPlane.listShardRegistry({})).some((row) => row.shard_type === 'RoomDO' && row.shard_key === roomId));

  const opsHarness = await createOpsHarness(rig);
  const rebuildDuringGapResponse = await opsWorkerModule.fetch(
    opsHarness.makeOpsRequest('/_ops/v1/rebuilds', {
      method: 'POST',
      body: {
        rebuild_target: 'public_room_directory',
        scope: {
          scope_kind: 'global',
          scope_id: null,
        },
        reason: 'phase07 registry gap rebuild validation',
        ticket_id: 'OPS-PHASE07-GAP',
        force_full_scan: false,
      },
      headers: {
        'Idempotency-Key': 'phase07-rebuild-gap-idem',
      },
    }),
    opsHarness.opsEnv,
  );
  assert.equal(rebuildDuringGapResponse.status, 409);
  const rebuildDuringGapBody = await rebuildDuringGapResponse.json();
  assert.equal(rebuildDuringGapBody.code, 'precondition_failed');
  assert.equal(rig.queues.rebuild.messages.length, 0);

  rig.env.MATRIX_CONTROL_D1.prepare = originalPrepare;
  const scheduledAlarm = await rig.env.ROOM_DO.instances.get(roomId).storage.getAlarm();
  assert.equal(typeof scheduledAlarm, 'number');
  await roomDo.alarm({ scheduledTime: scheduledAlarm });

  const registryRows = await controlPlane.listShardRegistry({});
  assert.ok(registryRows.some((row) => row.shard_type === 'RoomDO' && row.shard_key === roomId));
  assert.equal(roomDo.getRegistryRetryMarker(), null);

  const retryResponse = await rig.gatewayFetch('/_matrix/client/v3/createRoom', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: createRoomBody,
  });
  assert.equal(retryResponse.status, 200);
  const retriedPayload = await retryResponse.json();
  assert.equal(retriedPayload.room_id, roomId);

  const createEvents = roomDo.persistence.eventMetadata.list().filter((row) => row.event_type === 'm.room.create');
  assert.equal(createEvents.length, 1);
});

test('Phase 07 global rebuild ignores disabled shard-registry rows', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-disabled-registry-alice' });
  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    visibility: 'public',
    preset: 'public_chat',
    room_alias_name: 'phase07-disabled-registry-room',
    name: 'Phase 07 Disabled Registry Room',
  });
  const roomId = room.room_id;

  const controlPlane = createD1ControlPlanePersistence(rig.env.MATRIX_CONTROL_D1);
  await controlPlane.ensureSchema();
  const disabledAt = new Date().toISOString();
  await controlPlane.upsertShardRegistry({
    shard_type: 'RoomDO',
    shard_key: roomId,
    created_at: disabledAt,
    last_seen_at: disabledAt,
    schema_version: 1,
    disabled_at: disabledAt,
  });

  const opsHarness = await createOpsHarness(rig);
  const rebuildResponse = await opsWorkerModule.fetch(
    opsHarness.makeOpsRequest('/_ops/v1/rebuilds', {
      method: 'POST',
      body: {
        rebuild_target: 'public_room_directory',
        scope: {
          scope_kind: 'global',
          scope_id: null,
        },
        reason: 'phase07 disabled registry rows must not rebuild',
        ticket_id: 'OPS-PHASE07-DISABLED',
        force_full_scan: false,
      },
      headers: {
        'Idempotency-Key': 'phase07-rebuild-disabled-idem',
      },
    }),
    opsHarness.opsEnv,
  );
  assert.equal(rebuildResponse.status, 409);
  const rebuildBody = await rebuildResponse.json();
  assert.equal(rebuildBody.code, 'precondition_failed');
  assert.equal(rig.queues.rebuild.messages.length, 0);
});

test('Phase 07 upload failures do not leave pending grants in a live state', async (t) => {
  const rig = createGatewayPhase04Rig({
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '4',
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-quota-alice' });
  const response = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=oversized.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: 'oversized-body',
  });
  await expectMatrixError(response, 413, 'M_TOO_LARGE');

  const pendingStates = rig.getUserDo(alice.user_id).persistence.pendingUploadGrants.list()
    .map((row) => row.state);
  assert.ok(pendingStates.length >= 1);
  assert.ok(pendingStates.every((state) => state !== 'pending'));
});

test('Phase 07 create reservations respect the effective media upload byte limit', async (t) => {
  const rig = createGatewayPhase04Rig({
    MATRIX_MEDIA_MAX_UPLOAD_BYTES: '20',
    CF_ZONE_BODY_LIMIT_BYTES: '5',
  });
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-create-limit-alice' });
  const config = await getJson(rig, alice.access_token, '/_matrix/client/v1/media/config');
  assert.equal(config['m.upload.size'], 5);

  const createResponse = await rig.gatewayFetch('/_matrix/media/v3/create', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(createResponse.status, 200);
  const reservation = await createResponse.json();
  const reserved = parseMxc(reservation.content_uri);

  const oversizedUpload = await rig.gatewayFetch(
    `/_matrix/media/v3/upload/${encodeURIComponent(reserved.serverName)}/${encodeURIComponent(reserved.mediaId)}?filename=too-large-reserved.txt`,
    {
      method: 'PUT',
      headers: {
        ...rig.authHeaders(alice.access_token),
        'content-type': 'text/plain; charset=utf-8',
      },
      body: '0123456789',
    },
  );
  await expectMatrixError(oversizedUpload, 413, 'M_TOO_LARGE');

  const reservedGrant = rig.getUserDo(alice.user_id).persistence.pendingUploadGrants.list()
    .find((row) => row.media_id === reserved.mediaId);
  assert.ok(reservedGrant);
  assert.equal(reservedGrant.state, 'reverted');
});

test('Phase 07 gateway thumbnails stream source bodies into R2 writes', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-streaming-thumb-gateway-alice' });
  const sourceBodyText = 'gateway-streaming-thumbnail-source';
  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=stream-gateway.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: sourceBodyText,
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = parseMxc((await uploadResponse.json()).content_uri);
  const sourceKey = buildLocalMediaObjectKey(uploaded.mediaId);
  const thumbnailKey = buildThumbnailObjectKey({
    sourceKind: 'local',
    mediaId: uploaded.mediaId,
    width: 40,
    height: 40,
    method: 'scale',
    animated: false,
  });
  const originalGet = rig.env.MATRIX_MEDIA_BUCKET.get.bind(rig.env.MATRIX_MEDIA_BUCKET);
  const originalPut = rig.env.MATRIX_MEDIA_BUCKET.put.bind(rig.env.MATRIX_MEDIA_BUCKET);
  let sawStreamThumbnailWrite = false;

  rig.env.MATRIX_MEDIA_BUCKET.get = async (key) => {
    const object = await originalGet(key);
    if (!object || key !== sourceKey) {
      return object;
    }
    return {
      ...object,
      size: Buffer.byteLength(sourceBodyText),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(sourceBodyText, 'utf8'));
          controller.close();
        },
      }),
      arrayBuffer: async () => {
        throw new Error('gateway thumbnail path must not fall back to arrayBuffer');
      },
    };
  };

  rig.env.MATRIX_MEDIA_BUCKET.put = async (key, value, options) => {
    if (key === thumbnailKey) {
      sawStreamThumbnailWrite = Boolean(value && typeof value.getReader === 'function');
    }
    return originalPut(key, value, options);
  };

  const thumbnailResponse = await rig.gatewayFetch(
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=40&height=40&method=scale`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(thumbnailResponse.status, 200);
  assert.match(await readResponseText(thumbnailResponse), /^thumbnail:40x40:scale:static\n/);
  assert.equal(sawStreamThumbnailWrite, true);
});

test('Phase 07 jobs thumbnails stream source bodies into R2 writes', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-streaming-thumb-jobs-alice' });
  const sourceBodyText = 'jobs-streaming-thumbnail-source';
  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=stream-jobs.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: sourceBodyText,
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = parseMxc((await uploadResponse.json()).content_uri);
  const sourceKey = buildLocalMediaObjectKey(uploaded.mediaId);
  const thumbnailKey = buildThumbnailObjectKey({
    sourceKind: 'local',
    mediaId: uploaded.mediaId,
    width: 96,
    height: 96,
    method: 'scale',
    animated: false,
  });
  const originalGet = rig.env.MATRIX_MEDIA_BUCKET.get.bind(rig.env.MATRIX_MEDIA_BUCKET);
  const originalPut = rig.env.MATRIX_MEDIA_BUCKET.put.bind(rig.env.MATRIX_MEDIA_BUCKET);
  let sawStreamThumbnailWrite = false;

  rig.env.MATRIX_MEDIA_BUCKET.get = async (key) => {
    const object = await originalGet(key);
    if (!object || key !== sourceKey) {
      return object;
    }
    return {
      ...object,
      size: Buffer.byteLength(sourceBodyText),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(sourceBodyText, 'utf8'));
          controller.close();
        },
      }),
      arrayBuffer: async () => {
        throw new Error('jobs thumbnail path must not fall back to arrayBuffer');
      },
    };
  };

  rig.env.MATRIX_MEDIA_BUCKET.put = async (key, value, options) => {
    if (key === thumbnailKey) {
      sawStreamThumbnailWrite = Boolean(value && typeof value.getReader === 'function');
    }
    return originalPut(key, value, options);
  };

  await rig.drainJobsQueues();

  assert.equal(sawStreamThumbnailWrite, true);
  const thumbnailObject = await originalGet(thumbnailKey);
  assert.ok(thumbnailObject);
  assert.match(await thumbnailObject.text(), /^thumbnail:96x96:scale:static\n/);
});

test('Phase 07 jobs thumbnails generate multiple variants from stream sources without stream-lock failure', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-streaming-thumb-jobs-multi-alice' });
  const sourceBodyText = 'jobs-streaming-thumbnail-multi-variant-source';
  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=stream-jobs-multi.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: sourceBodyText,
  });
  assert.equal(uploadResponse.status, 200);
  const uploadBody = await uploadResponse.json();
  const uploaded = parseMxc(uploadBody.content_uri);
  const sourceKey = buildLocalMediaObjectKey(uploaded.mediaId);
  const thumbnail96Key = buildThumbnailObjectKey({
    sourceKind: 'local',
    mediaId: uploaded.mediaId,
    width: 96,
    height: 96,
    method: 'scale',
    animated: false,
  });
  const thumbnail64Key = buildThumbnailObjectKey({
    sourceKind: 'local',
    mediaId: uploaded.mediaId,
    width: 64,
    height: 64,
    method: 'scale',
    animated: false,
  });
  const originalGet = rig.env.MATRIX_MEDIA_BUCKET.get.bind(rig.env.MATRIX_MEDIA_BUCKET);
  const originalPut = rig.env.MATRIX_MEDIA_BUCKET.put.bind(rig.env.MATRIX_MEDIA_BUCKET);
  let sawStreamThumbnailWrites = 0;

  rig.queues.media.messages = [];

  rig.env.MATRIX_MEDIA_BUCKET.get = async (key) => {
    const object = await originalGet(key);
    if (!object || key !== sourceKey) {
      return object;
    }
    return {
      ...object,
      size: Buffer.byteLength(sourceBodyText),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(sourceBodyText, 'utf8'));
          controller.close();
        },
      }),
      arrayBuffer: async () => {
        throw new Error('jobs multi-variant thumbnail path must not fall back to arrayBuffer');
      },
    };
  };

  rig.env.MATRIX_MEDIA_BUCKET.put = async (key, value, options) => {
    if (key === thumbnail96Key || key === thumbnail64Key) {
      sawStreamThumbnailWrites += Boolean(value && typeof value.getReader === 'function') ? 1 : 0;
    }
    return originalPut(key, value, options);
  };

  await rig.queues.media.send({
    schema_version: 1,
    mxc_uri: uploadBody.content_uri,
    source_kind: 'local',
    r2_object_key: sourceKey,
    content_type: 'text/plain; charset=utf-8',
    enqueued_at: new Date().toISOString(),
    variants: [
      { width: 96, height: 96, method: 'scale', animated: false },
      { width: 64, height: 64, method: 'scale', animated: false },
    ],
  });

  await rig.drainJobsQueues();

  assert.equal(sawStreamThumbnailWrites, 2);
  const thumbnail96 = await originalGet(thumbnail96Key);
  const thumbnail64 = await originalGet(thumbnail64Key);
  assert.ok(thumbnail96);
  assert.ok(thumbnail64);
  assert.match(await thumbnail96.text(), /^thumbnail:96x96:scale:static\n/);
  assert.match(await thumbnail64.text(), /^thumbnail:64x64:scale:static\n/);
});

test('Phase 07 degrades animated thumbnails to static for non-animatable media', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase07-static-thumb-alice' });
  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=plain.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: 'plain-thumbnail-source',
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = parseMxc((await uploadResponse.json()).content_uri);

  const staticThumbnail = await rig.gatewayFetch(
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=48&height=48&method=scale&animated=false`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(staticThumbnail.status, 200);
  const staticBody = await readResponseText(staticThumbnail);
  assert.match(staticBody, /^thumbnail:48x48:scale:static\n/);

  const animatedThumbnail = await rig.gatewayFetch(
    `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}?width=48&height=48&method=scale&animated=true`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(animatedThumbnail.status, 200);
  const animatedBody = await readResponseText(animatedThumbnail);
  assert.equal(animatedBody, staticBody);
  assert.match(animatedBody, /^thumbnail:48x48:scale:static\n/);

  const thumbnailKeys = [...rig.buckets.media.objects.keys()]
    .filter((key) => key.includes(`/${uploaded.mediaId}/48x48/scale/`));
  assert.ok(thumbnailKeys.some((key) => key.endsWith('/static')));
  assert.ok(!thumbnailKeys.some((key) => key.endsWith('/animated')));
});
