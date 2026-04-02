import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUniqueAliasLocalpart,
  createRoom,
  expectMatrixError,
  eventually,
  getAuthenticated,
  joinRoom,
  makeTxnId,
  postAuthenticated,
  putAuthenticated,
  registerUser,
  request,
  requestOpsAuthorized,
  requireRemoteHarnessContext,
  roomPath,
  sleep,
} from './support.mjs';

function normalizePublicRoomsResponse(payload) {
  return {
    room_ids: Array.isArray(payload?.chunk)
      ? payload.chunk.map((entry) => entry?.room_id).filter(Boolean).sort()
      : [],
    next_batch: payload?.next_batch ?? null,
    prev_batch: payload?.prev_batch ?? null,
    total_room_count_estimate: payload?.total_room_count_estimate ?? null,
  };
}

function normalizeHierarchyResponse(payload) {
  return Array.isArray(payload?.children)
    ? payload.children.map((entry) => entry?.room_id).filter(Boolean).sort()
    : [];
}

function summarizeOpsPayload(payload) {
  if (payload == null) {
    return 'null';
  }
  if (typeof payload === 'string') {
    return payload.slice(0, 512);
  }
  try {
    return JSON.stringify(payload).slice(0, 2048);
  } catch {
    return String(payload).slice(0, 512);
  }
}

async function fetchAnonymousPublicRooms(harness, searchToken) {
  const result = await request(
    harness,
    `/_matrix/client/v3/publicRooms?limit=10&search_term=${encodeURIComponent(searchToken)}`,
  );
  assert.equal(result.response.status, 200);
  return result.payload;
}

async function fetchAuthenticatedPublicRooms(harness, accessToken, searchToken) {
  const result = await postAuthenticated(harness, accessToken, '/_matrix/client/v3/publicRooms', {
    limit: 10,
    filter: {
      generic_search_term: searchToken,
    },
  });
  assert.equal(result.response.status, 200);
  return result.payload;
}

async function fetchUserDirectory(harness, accessToken, searchToken) {
  const result = await postAuthenticated(harness, accessToken, '/_matrix/client/v3/user_directory/search', {
    search_term: searchToken,
    limit: 10,
  });
  assert.equal(result.response.status, 200);
  return result.payload;
}

async function fetchSearch(harness, accessToken, roomId, searchToken) {
  const result = await postAuthenticated(harness, accessToken, '/_matrix/client/v3/search', {
    search_categories: {
      room_events: {
        search_term: searchToken,
        filter: {
          rooms: [roomId],
          limit: 10,
        },
      },
    },
  });
  assert.equal(result.response.status, 200);
  return result.payload;
}

async function fetchHierarchy(harness, accessToken, spaceRoomId) {
  const result = await getAuthenticated(
    harness,
    accessToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/hierarchy`,
  );
  assert.equal(result.response.status, 200);
  return result.payload;
}

async function waitForRebuildSuccess(harness, jobId) {
  let lastJob = null;
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    const result = await requestOpsAuthorized(harness, `/_ops/v1/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(result.response.status, 200);
    const job = result.payload?.job;
    assert.equal(job?.job_id, jobId);
    lastJob = job;
    if (job?.state === 'succeeded') {
      return job;
    }
    if (job?.state === 'failed' || job?.state === 'canceled') {
      assert.fail(
        `rebuild job ${jobId} entered terminal state ${job.state}: ${summarizeOpsPayload(job.last_error ?? job.result_summary ?? job)}`,
      );
    }
    await sleep(1000);
  }
  assert.fail(
    `rebuild job ${jobId} did not reach succeeded within the polling window: ${summarizeOpsPayload(lastJob)}`,
  );
}

test('TEST-DER-001 staging covers derived query semantics and Access-authenticated rebuild consistency', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const token = makeTxnId('derstg');
  const aliasLocalpart = buildUniqueAliasLocalpart(`der-stg-${token}`);
  const publicRoomName = `Derived staging public ${token}`;
  const privateRoomName = `Derived staging private ${token}`;
  const spaceRoomName = `Derived staging space ${token}`;
  const directoryNeedle = `Directory-${token}`;
  const messageNeedle = `message-${token}`;

  const healthz = await requestOpsAuthorized(harness, '/_ops/v1/healthz');
  assert.equal(healthz.response.status, 200);
  assert.equal(healthz.payload?.service, 'ops-worker');

  const alice = await registerUser(harness, {
    usernamePrefix: `der-stg-alice-${token}`,
    deviceId: 'DERSTGALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: `der-stg-bob-${token}`,
    deviceId: 'DERSTGBOB',
  });

  const displaynameResult = await putAuthenticated(
    harness,
    bob.access_token,
    `/_matrix/client/v3/profile/${encodeURIComponent(bob.user_id)}/displayname`,
    { displayname: directoryNeedle },
  );
  assert.equal(displaynameResult.response.status, 200);

  const publicRoom = await createRoom(harness, alice.access_token, {
    visibility: 'public',
    preset: 'public_chat',
    room_alias_name: aliasLocalpart,
    name: publicRoomName,
    topic: `Public rooms search ${token}`,
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

  const joinByAlias = await joinRoom(harness, bob.access_token, `#${aliasLocalpart}:${harness.serverName}`);
  assert.equal(joinByAlias.room_id, publicRoomId);

  const messageResult = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(publicRoomId, `/send/m.room.message/${encodeURIComponent(makeTxnId('dermsg'))}`),
    {
      msgtype: 'm.text',
      body: `Searchable ${messageNeedle}`,
    },
  );
  assert.equal(messageResult.response.status, 200);
  const messageEventId = messageResult.payload?.event_id;
  assert.equal(typeof messageEventId, 'string');

  const spaceRoom = await createRoom(harness, alice.access_token, {
    visibility: 'public',
    preset: 'public_chat',
    name: spaceRoomName,
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
  const addPublicChild = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(spaceRoomId, `/state/m.space.child/${encodeURIComponent(publicRoomId)}`),
    { via: [harness.serverName] },
  );
  assert.equal(addPublicChild.response.status, 200);

  const privateRoom = await createRoom(harness, alice.access_token, {
    visibility: 'private',
    name: privateRoomName,
  });
  const privateRoomId = privateRoom.room_id;
  const addPrivateChild = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(spaceRoomId, `/state/m.space.child/${encodeURIComponent(privateRoomId)}`),
    { via: [harness.serverName] },
  );
  assert.equal(addPrivateChild.response.status, 200);

  const ignoredDirectory = await putAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/user/${encodeURIComponent(alice.user_id)}/account_data/${encodeURIComponent('m.ignored_user_list')}`,
    {
      ignored_users: {
        [bob.user_id]: {},
      },
    },
  );
  assert.equal(ignoredDirectory.response.status, 200);

  await eventually(async () => {
    const payload = await fetchUserDirectory(harness, alice.access_token, directoryNeedle);
    assert.ok(!payload.results?.some((entry) => entry?.user_id === bob.user_id));
  }, {
    attempts: 20,
    delayMs: 500,
  });

  const unignoredDirectory = await putAuthenticated(
    harness,
    alice.access_token,
    `/_matrix/client/v3/user/${encodeURIComponent(alice.user_id)}/account_data/${encodeURIComponent('m.ignored_user_list')}`,
    {
      ignored_users: {},
    },
  );
  assert.equal(unignoredDirectory.response.status, 200);

  const anonymousPublicRooms = await eventually(async () => {
    const payload = await fetchAnonymousPublicRooms(harness, token);
    const roomIds = normalizePublicRoomsResponse(payload).room_ids;
    assert.ok(roomIds.includes(publicRoomId));
    assert.ok(!roomIds.includes(privateRoomId));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });

  const authenticatedPublicRooms = await eventually(async () => {
    const payload = await fetchAuthenticatedPublicRooms(harness, alice.access_token, token);
    const roomIds = normalizePublicRoomsResponse(payload).room_ids;
    assert.ok(roomIds.includes(publicRoomId));
    assert.ok(!roomIds.includes(privateRoomId));
    assert.deepEqual(
      normalizePublicRoomsResponse(payload),
      normalizePublicRoomsResponse(anonymousPublicRooms),
    );
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });

  const unauthenticatedPublicRoomsPost = await request(harness, '/_matrix/client/v3/publicRooms', {
    method: 'POST',
    json: {
      limit: 10,
      filter: {
        generic_search_term: token,
      },
    },
  });
  await expectMatrixError(unauthenticatedPublicRoomsPost, 401, 'M_MISSING_TOKEN');

  const directoryBeforeRebuild = await eventually(async () => {
    const payload = await fetchUserDirectory(harness, alice.access_token, directoryNeedle);
    assert.ok(payload.results?.some((entry) => entry?.user_id === bob.user_id));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });

  const searchBeforeRebuild = await eventually(async () => {
    const payload = await fetchSearch(harness, alice.access_token, publicRoomId, messageNeedle);
    const resultIds = payload.search_categories?.room_events?.results?.map((entry) => entry?.result?.event_id) ?? [];
    assert.ok(resultIds.includes(messageEventId));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });

  const hierarchyBeforeRebuild = await eventually(async () => {
    const payload = await fetchHierarchy(harness, alice.access_token, spaceRoomId);
    const children = normalizeHierarchyResponse(payload);
    assert.ok(children.includes(publicRoomId));
    assert.ok(!children.includes(privateRoomId));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });

  const rebuild = await requestOpsAuthorized(harness, '/_ops/v1/rebuilds', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `test-der-001-staging-${token}`,
    },
    json: {
      rebuild_target: 'all_derived',
      scope: {
        scope_kind: 'global',
        scope_id: null,
      },
      reason: `TEST-DER-001 staging rebuild ${token}`,
      ticket_id: `OPS-DER-STG-${token}`,
      force_full_scan: false,
    },
  });
  assert.equal(
    rebuild.response.status,
    202,
    `expected rebuild start to return 202, received ${rebuild.response.status}: ${summarizeOpsPayload(rebuild.payload)}`,
  );
  assert.equal(rebuild.payload?.job_type, 'rebuild');
  const rebuildJob = await waitForRebuildSuccess(harness, rebuild.payload.job_id);
  assert.equal(rebuildJob.state, 'succeeded');
  assert.deepEqual(rebuildJob.scope, {
    scope_kind: 'global',
    scope_id: null,
  });

  const anonymousAfterRebuild = await eventually(async () => {
    const payload = await fetchAnonymousPublicRooms(harness, token);
    const roomIds = normalizePublicRoomsResponse(payload).room_ids;
    assert.ok(roomIds.includes(publicRoomId));
    assert.ok(!roomIds.includes(privateRoomId));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });
  assert.deepEqual(
    normalizePublicRoomsResponse(anonymousAfterRebuild),
    normalizePublicRoomsResponse(anonymousPublicRooms),
  );

  const authenticatedAfterRebuild = await eventually(async () => {
    const payload = await fetchAuthenticatedPublicRooms(harness, alice.access_token, token);
    assert.deepEqual(
      normalizePublicRoomsResponse(payload),
      normalizePublicRoomsResponse(authenticatedPublicRooms),
    );
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });
  assert.deepEqual(
    normalizePublicRoomsResponse(authenticatedAfterRebuild),
    normalizePublicRoomsResponse(authenticatedPublicRooms),
  );

  const directoryAfterRebuild = await eventually(async () => {
    const payload = await fetchUserDirectory(harness, alice.access_token, directoryNeedle);
    assert.ok(payload.results?.some((entry) => entry?.user_id === bob.user_id));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });
  assert.deepEqual(
    directoryAfterRebuild.results.map((entry) => entry.user_id).sort(),
    directoryBeforeRebuild.results.map((entry) => entry.user_id).sort(),
  );

  const searchAfterRebuild = await eventually(async () => {
    const payload = await fetchSearch(harness, alice.access_token, publicRoomId, messageNeedle);
    const resultIds = payload.search_categories?.room_events?.results?.map((entry) => entry?.result?.event_id) ?? [];
    assert.ok(resultIds.includes(messageEventId));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });
  assert.deepEqual(
    searchAfterRebuild.search_categories.room_events.results.map((entry) => entry.result.event_id).sort(),
    searchBeforeRebuild.search_categories.room_events.results.map((entry) => entry.result.event_id).sort(),
  );

  const hierarchyAfterRebuild = await eventually(async () => {
    const payload = await fetchHierarchy(harness, alice.access_token, spaceRoomId);
    const children = normalizeHierarchyResponse(payload);
    assert.ok(children.includes(publicRoomId));
    assert.ok(!children.includes(privateRoomId));
    return payload;
  }, {
    attempts: 30,
    delayMs: 500,
  });
  assert.deepEqual(
    normalizeHierarchyResponse(hierarchyAfterRebuild),
    normalizeHierarchyResponse(hierarchyBeforeRebuild),
  );
});
