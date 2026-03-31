import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

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
    await rig.gatewayFetch('/_matrix/media/v3/config'),
    401,
    'M_MISSING_TOKEN',
  );

  const uploadResponse = await rig.gatewayFetch('/_matrix/media/v3/upload?filename=phase07.txt', {
    method: 'POST',
    headers: {
      ...rig.authHeaders(alice.access_token),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: 'phase07-local-media',
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
  assert.equal(await readResponseText(currentDownload), 'phase07-local-media');
  assert.match(currentDownload.headers.get('content-disposition') ?? '', /phase07\.txt/);

  const legacyDownload = await rig.gatewayFetch(
    `/_matrix/media/v3/download/${encodeURIComponent(uploaded.serverName)}/${encodeURIComponent(uploaded.mediaId)}/phase07.txt`,
  );
  assert.equal(legacyDownload.status, 200);
  assert.equal(await readResponseText(legacyDownload), 'phase07-local-media');

  await rig.drainJobsQueues();
  const catalogRow = await derived.mediaCatalog.get({ mxc_uri: uploadBody.content_uri });
  assert.ok(catalogRow);
  assert.equal(catalogRow.origin_kind, 'local');
  assert.equal(catalogRow.legacy_unauth_access_flag, true);

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

  const currentRemoteCached = await rig.gatewayFetch(
    '/_matrix/client/v1/media/download/remote.example/media-after-freeze',
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  assert.equal(currentRemoteCached.status, 200);
  assert.equal(remoteFetchCount, 1);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/download/remote.example/media-after-freeze'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 1);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/download/remote.example/cache-miss-after-freeze'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 1);

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/media/v3/thumbnail/remote.example/cache-miss-after-freeze?width=32&height=32&method=scale'),
    404,
    'M_NOT_FOUND',
  );
  assert.equal(remoteFetchCount, 1);

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
  assert.equal(remoteFetchCount, 1);
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

  const derived = createD1DerivedDataPersistence(rig.d1);
  await derived.ensureSchema();
  const expectedSearch = await derived.searchIndex.list();
  const expectedUsers = await derived.userDirectory.list();
  const expectedPublicRooms = await derived.publicRoomDirectory.list();
  assert.ok(expectedSearch.some((row) => row.event_id === messageBody.event_id));
  assert.ok(expectedUsers.some((row) => row.user_id === bob.user_id));
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
