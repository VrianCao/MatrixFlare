import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayPhase04Rig } from './support.mjs';

async function expectMatrixError(response, status, errcode) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.errcode, errcode);
  return body;
}

async function registerUser(rig, {
  username,
  password = 'phase06-password',
  deviceId = `${username}-device`,
}) {
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

function roomPath(roomId, suffix = '') {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}${suffix}`;
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

async function createRoom(rig, accessToken, body = {}) {
  return postJson(rig, accessToken, '/_matrix/client/v3/createRoom', body);
}

async function syncRequest(rig, accessToken, query = '') {
  const suffix = query ? `?${query}` : '';
  const response = await rig.gatewayFetch(`/_matrix/client/v3/sync${suffix}`, {
    headers: rig.authHeaders(accessToken),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function findStateEvent(events, eventType, stateKey = '') {
  return events.find((event) => event.type === eventType && (event.state_key ?? '') === stateKey) ?? null;
}

test('Phase 06 covers room send/state/query/redaction surfaces', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase06-alice-a' });
  const bob = await registerUser(rig, { username: 'phase06-bob-a' });

  const create = await createRoom(rig, alice.access_token, {
    name: 'Phase 06 Query Room',
    invite: [bob.user_id],
  });
  const roomId = create.room_id;
  const roomDo = rig.getRoomDo(roomId);
  assert.equal(roomDo.persistence.getRuntimeState().room_version, '12');

  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));

  const firstMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/txn-1'),
    {
      msgtype: 'm.text',
      body: 'hello from phase 06',
    },
  );
  const firstMessageRetry = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/txn-1'),
    {
      msgtype: 'm.text',
      body: 'hello from phase 06',
    },
  );
  assert.equal(firstMessageRetry.event_id, firstMessage.event_id);

  await expectMatrixError(
    await rig.gatewayFetch(roomPath(roomId, '/send/m.room.message/txn-1'), {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        msgtype: 'm.text',
        body: 'different body',
      },
    }),
    409,
    'M_CONFLICT',
  );

  const topicWrite = await putJson(rig, alice.access_token, roomPath(roomId, '/state/m.room.topic'), {
    topic: 'Phase 06 Topic',
  });
  const topicWriteRetry = await putJson(rig, alice.access_token, roomPath(roomId, '/state/m.room.topic'), {
    topic: 'Phase 06 Topic',
  });
  assert.equal(topicWriteRetry.event_id, topicWrite.event_id);
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(roomId, '/state/m.room.topic'), {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        topic: 'Phase 06 Different Topic',
      },
    }),
    409,
    'M_CONFLICT',
  );
  await putJson(rig, alice.access_token, roomPath(roomId, '/state/com.example.flag/primary'), {
    enabled: true,
  });
  const roomVersionFieldState = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/state/com.example.meta/versioned'),
    {
      room_version: '99',
      ok: true,
    },
  );
  assert.equal(
    roomDo.persistence.eventMetadata.get({ event_id: roomVersionFieldState.event_id }).record.room_version,
    '12',
  );

  const topicContent = await getJson(rig, alice.access_token, roomPath(roomId, '/state/m.room.topic'));
  assert.deepEqual(topicContent, {
    topic: 'Phase 06 Topic',
  });

  const keyedStateContent = await getJson(rig, alice.access_token, roomPath(roomId, '/state/com.example.flag/primary'));
  assert.deepEqual(keyedStateContent, {
    enabled: true,
  });

  const allState = await getJson(rig, alice.access_token, roomPath(roomId, '/state'));
  assert.ok(findStateEvent(allState, 'm.room.topic'));
  assert.ok(findStateEvent(allState, 'com.example.flag', 'primary'));

  const reaction = await putJson(
    rig,
    bob.access_token,
    roomPath(roomId, '/send/m.reaction/reaction-1'),
    {
      'm.relates_to': {
        event_id: firstMessage.event_id,
        rel_type: 'm.annotation',
        key: 'ok',
      },
    },
  );

  await putJson(
    rig,
    bob.access_token,
    roomPath(roomId, '/send/m.room.message/thread-1'),
    {
      msgtype: 'm.text',
      body: 'thread reply',
      'm.relates_to': {
        event_id: firstMessage.event_id,
        rel_type: 'm.thread',
      },
    },
  );

  const messages = await getJson(rig, alice.access_token, `${roomPath(roomId, '/messages')}?dir=b&limit=10`);
  assert.ok(messages.chunk.some((event) => event.event_id === firstMessage.event_id));
  assert.ok(typeof messages.start === 'string');
  assert.ok(typeof messages.end === 'string');

  await putJson(rig, alice.access_token, roomPath(roomId, '/state/com.example.context.after'), {
    marker: 'written after anchor event',
  });

  const context = await getJson(
    rig,
    alice.access_token,
    `${roomPath(roomId, `/context/${encodeURIComponent(firstMessage.event_id)}`)}?limit=2`,
  );
  assert.equal(context.event.event_id, firstMessage.event_id);
  assert.ok(context.events_before.length >= 1);
  assert.ok(context.state.some((event) => event.type === 'm.room.member'));
  assert.ok(!context.state.some((event) => event.type === 'com.example.context.after'));

  const eventBody = await getJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/event/${encodeURIComponent(firstMessage.event_id)}`),
  );
  assert.equal(eventBody.content.body, 'hello from phase 06');

  const members = await getJson(rig, alice.access_token, roomPath(roomId, '/members'));
  assert.ok(members.chunk.some((event) => event.state_key === alice.user_id));
  assert.ok(members.chunk.some((event) => event.state_key === bob.user_id));

  const joinedMembers = await getJson(rig, alice.access_token, roomPath(roomId, '/joined_members'));
  assert.ok(joinedMembers.joined[alice.user_id]);
  assert.ok(joinedMembers.joined[bob.user_id]);

  const relations = await getJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/relations/${encodeURIComponent(firstMessage.event_id)}/m.annotation/m.reaction`),
  );
  assert.deepEqual(relations.chunk.map((event) => event.event_id), [reaction.event_id]);

  const threads = await getJson(rig, alice.access_token, roomPath(roomId, '/threads'));
  assert.ok(threads.chunk.some((event) => event.event_id === firstMessage.event_id));

  const timestampLookup = await getJson(
    rig,
    alice.access_token,
    `${roomPath(roomId, '/timestamp_to_event')}?ts=0&dir=f`,
  );
  assert.ok(typeof timestampLookup.event_id === 'string');
  assert.ok(Number.isInteger(timestampLookup.origin_server_ts));

  const redaction = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/redact/${encodeURIComponent(firstMessage.event_id)}/redact-1`),
    {
      reason: 'cleanup',
    },
  );
  const redactionRetry = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/redact/${encodeURIComponent(firstMessage.event_id)}/redact-1`),
    {
      reason: 'cleanup',
    },
  );
  assert.equal(redactionRetry.event_id, redaction.event_id);
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(roomId, `/redact/${encodeURIComponent(firstMessage.event_id)}/redact-1`), {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        reason: 'different cleanup',
      },
    }),
    409,
    'M_CONFLICT',
  );
  const redactedEvent = await getJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/event/${encodeURIComponent(firstMessage.event_id)}`),
  );
  assert.deepEqual(redactedEvent.content, {});
  assert.equal(redactedEvent.unsigned.redacted_because.type, 'm.room.redaction');

  const aliceSync = await syncRequest(rig, alice.access_token);
  assert.ok(aliceSync.rooms.join[roomId]);
});

test('Phase 06 rejects malformed room-query and typing inputs with deterministic 4xx', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase06-alice-inputs' });
  const room = await createRoom(rig, alice.access_token, {});
  const roomId = room.room_id;

  await expectMatrixError(
    await rig.gatewayFetch(`${roomPath(roomId, '/messages')}?limit=abc`, {
      headers: rig.authHeaders(alice.access_token),
    }),
    400,
    'M_INVALID_PARAM',
  );
  await expectMatrixError(
    await rig.gatewayFetch(`${roomPath(roomId, '/messages')}?from=oops`, {
      headers: rig.authHeaders(alice.access_token),
    }),
    400,
    'M_INVALID_PARAM',
  );
  await expectMatrixError(
    await rig.gatewayFetch(`${roomPath(roomId, '/timestamp_to_event')}?ts=nope&dir=f`, {
      headers: rig.authHeaders(alice.access_token),
    }),
    400,
    'M_INVALID_PARAM',
  );
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(roomId, `/typing/${encodeURIComponent(alice.user_id)}`), {
      method: 'PUT',
      headers: rig.authHeaders(alice.access_token),
      json: {
        typing: true,
        timeout: 'oops',
      },
    }),
    400,
    'M_INVALID_PARAM',
  );
  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/join/%23missing-room%3Amatrix.example.test', {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {},
    }),
    404,
    'M_NOT_FOUND',
  );
});

test('Phase 06 covers membership transitions including invite, kick, ban, unban, knock, and forget', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase06-alice-b' });
  const bob = await registerUser(rig, { username: 'phase06-bob-b' });
  const carol = await registerUser(rig, { username: 'phase06-carol-b' });

  const publicRoomRequest = {
    preset: 'public_chat',
  };
  const publicRoom = await createRoom(rig, alice.access_token, publicRoomRequest);
  const publicRoomId = publicRoom.room_id;
  const publicRoomDo = rig.getRoomDo(publicRoomId);
  const bobUserDo = rig.getUserDo(bob.user_id);
  const publicRoomEventCount = publicRoomDo.persistence.eventMetadata.list().length;
  const publicRoomRetry = await createRoom(rig, alice.access_token, publicRoomRequest);
  assert.equal(publicRoomRetry.room_id, publicRoomId);
  assert.equal(publicRoomDo.persistence.eventMetadata.list().length, publicRoomEventCount);

  await postJson(rig, bob.access_token, roomPath(publicRoomId, '/join'));
  const joinedEventCount = publicRoomDo.persistence.eventMetadata.list().length;
  const joinedRetry = await postJson(rig, bob.access_token, roomPath(publicRoomId, '/join'));
  assert.equal(joinedRetry.room_id, publicRoomId);
  assert.equal(publicRoomDo.persistence.eventMetadata.list().length, joinedEventCount);
  await postJson(rig, alice.access_token, roomPath(publicRoomId, '/invite'), {
    user_id: carol.user_id,
  });
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/messages'), {
      headers: rig.authHeaders(carol.access_token),
    }),
    403,
    'M_FORBIDDEN',
  );
  const inviteEventCount = publicRoomDo.persistence.eventMetadata.list().length;
  await postJson(rig, alice.access_token, roomPath(publicRoomId, '/invite'), {
    user_id: carol.user_id,
  });
  assert.equal(publicRoomDo.persistence.eventMetadata.list().length, inviteEventCount);
  assert.equal(
    publicRoomDo.persistence.membershipProjection.get({ user_id: carol.user_id }).membership,
    'invite',
  );
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/invite'), {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        user_id: bob.user_id,
      },
    }),
    403,
    'M_FORBIDDEN',
  );
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/unban'), {
      method: 'POST',
      headers: rig.authHeaders(alice.access_token),
      json: {
        user_id: bob.user_id,
      },
    }),
    403,
    'M_FORBIDDEN',
  );

  await postJson(rig, alice.access_token, roomPath(publicRoomId, '/kick'), {
    user_id: bob.user_id,
    reason: 'kicked once',
  });
  assert.equal(
    publicRoomDo.persistence.membershipProjection.get({ user_id: bob.user_id }).membership,
    'leave',
  );

  await postJson(rig, bob.access_token, roomPath(publicRoomId, '/join'));
  assert.equal(
    publicRoomDo.persistence.membershipProjection.get({ user_id: bob.user_id }).membership,
    'join',
  );

  await postJson(rig, alice.access_token, roomPath(publicRoomId, '/ban'), {
    user_id: bob.user_id,
  });
  assert.equal(
    publicRoomDo.persistence.membershipProjection.get({ user_id: bob.user_id }).membership,
    'ban',
  );

  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/join'), {
      method: 'POST',
      headers: rig.authHeaders(bob.access_token),
      json: {},
    }),
    403,
    'M_FORBIDDEN',
  );

  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/unban'), {
      method: 'POST',
      headers: rig.authHeaders(bob.access_token),
      json: {
        user_id: bob.user_id,
      },
    }),
    403,
    'M_FORBIDDEN',
  );

  await postJson(rig, alice.access_token, roomPath(publicRoomId, '/unban'), {
    user_id: bob.user_id,
  });
  await postJson(rig, bob.access_token, roomPath(publicRoomId, '/join'));
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/forget'), {
      method: 'POST',
      headers: rig.authHeaders(bob.access_token),
      json: {},
    }),
    403,
    'M_FORBIDDEN',
  );
  assert.equal(
    publicRoomDo.persistence.membershipProjection.get({ user_id: bob.user_id }).membership,
    'join',
  );
  await postJson(rig, bob.access_token, roomPath(publicRoomId, '/leave'));
  await postJson(rig, bob.access_token, roomPath(publicRoomId, '/forget'));

  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/members'), {
      headers: rig.authHeaders(bob.access_token),
    }),
    403,
    'M_FORBIDDEN',
  );
  assert.equal(
    publicRoomDo.persistence.membershipProjection.get({ user_id: bob.user_id }).membership,
    'leave',
  );

  const bobPostForgetSync = await syncRequest(rig, bob.access_token);
  assert.ok(!bobPostForgetSync.rooms?.join?.[publicRoomId]);
  assert.ok(!bobPostForgetSync.rooms?.leave?.[publicRoomId]);

  const postForgetMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(publicRoomId, '/send/m.room.message/post-forget'),
    {
      msgtype: 'm.text',
      body: 'still hidden after forget',
    },
  );
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/messages'), {
      headers: rig.authHeaders(bob.access_token),
    }),
    403,
    'M_FORBIDDEN',
  );
  const postForgetMetadata = publicRoomDo.persistence.eventMetadata.get({ event_id: postForgetMessage.event_id });
  publicRoomDo.persistence.fanoutOutbox.delete({
    room_pos: postForgetMetadata.room_pos,
    user_id: bob.user_id,
  });
  const repairResult = await publicRoomDo.reconcileFanout({
    target_user_id: bob.user_id,
  });
  assert.equal(repairResult.ok, true);
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/messages'), {
      headers: rig.authHeaders(bob.access_token),
    }),
    403,
    'M_FORBIDDEN',
  );
  const bobAfterRepairSync = await syncRequest(rig, bob.access_token);
  assert.ok(!bobAfterRepairSync.rooms?.join?.[publicRoomId]);
  assert.ok(!bobAfterRepairSync.rooms?.leave?.[publicRoomId]);
  const historicalJoinMetadata = [...publicRoomDo.persistence.eventMetadata.list()]
    .sort((left, right) => right.room_pos - left.room_pos)
    .find((entry) => {
      const event = publicRoomDo.loadRoomEventById(entry.event_id).event;
      return (
        event.type === 'm.room.member'
        && event.state_key === bob.user_id
        && event.content?.membership === 'join'
      );
    });
  assert.ok(historicalJoinMetadata);
  const historicalJoinFanout = bobUserDo.persistence.userStream.list().find((entry) => (
    entry.stream_kind === 'room_fanout'
    && entry.payload?.room_id === publicRoomId
    && entry.payload?.room_pos === historicalJoinMetadata.room_pos
  ));
  assert.ok(historicalJoinFanout);
  bobUserDo.persistence.userStream.delete({ stream_pos: historicalJoinFanout.stream_pos });
  publicRoomDo.persistence.fanoutOutbox.delete({
    room_pos: historicalJoinMetadata.room_pos,
    user_id: bob.user_id,
  });
  const historicalJoinRepair = await publicRoomDo.reconcileFanout({
    target_user_id: bob.user_id,
  });
  assert.equal(historicalJoinRepair.ok, true);
  const historicalJoinAfterRepair = await bobUserDo.inspectRoomFanout({
    room_id: publicRoomId,
    room_pos: historicalJoinMetadata.room_pos,
    user_id: bob.user_id,
  });
  assert.equal(historicalJoinAfterRepair.entry, null);
  const bobAfterHistoricalRepairSync = await syncRequest(rig, bob.access_token);
  assert.ok(!bobAfterHistoricalRepairSync.rooms?.join?.[publicRoomId]);
  assert.ok(!bobAfterHistoricalRepairSync.rooms?.leave?.[publicRoomId]);
  const bobPrincipal = bobUserDo.persistence.userPrincipal.get();
  bobUserDo.persistence.userPrincipal.put({
    ...bobPrincipal,
    record: {
      ...(bobPrincipal.record ?? {}),
      forgotten_room_tombstones: {
        ...(bobPrincipal.record?.forgotten_room_tombstones ?? {}),
        [publicRoomId]: {
          ...(bobPrincipal.record?.forgotten_room_tombstones?.[publicRoomId] ?? {}),
          room_id: publicRoomId,
          room_pos: 0,
        },
      },
    },
  });
  publicRoomDo.persistence.fanoutOutbox.delete({
    room_pos: historicalJoinMetadata.room_pos,
    user_id: bob.user_id,
  });
  const legacyTombstoneRepair = await publicRoomDo.reconcileFanout({
    target_user_id: bob.user_id,
  });
  assert.equal(legacyTombstoneRepair.ok, true);
  const historicalJoinAfterLegacyRepair = await bobUserDo.inspectRoomFanout({
    room_id: publicRoomId,
    room_pos: historicalJoinMetadata.room_pos,
    user_id: bob.user_id,
  });
  assert.equal(historicalJoinAfterLegacyRepair.entry, null);
  const bobAfterLegacyRepairSync = await syncRequest(rig, bob.access_token);
  assert.ok(!bobAfterLegacyRepairSync.rooms?.join?.[publicRoomId]);
  assert.ok(!bobAfterLegacyRepairSync.rooms?.leave?.[publicRoomId]);

  const dave = await registerUser(rig, { username: 'phase06-dave-b' });
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/leave'), {
      method: 'POST',
      headers: rig.authHeaders(dave.access_token),
      json: {},
    }),
    403,
    'M_FORBIDDEN',
  );
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(publicRoomId, '/messages'), {
      headers: rig.authHeaders(dave.access_token),
    }),
    403,
    'M_FORBIDDEN',
  );

  const knockRoom = await createRoom(rig, alice.access_token, {
    initial_state: [
      {
        type: 'm.room.join_rules',
        content: {
          join_rule: 'knock',
        },
      },
    ],
  });
  const knockRoomId = knockRoom.room_id;
  await postJson(
    rig,
    carol.access_token,
    `/_matrix/client/v3/knock/${encodeURIComponent(knockRoomId)}`,
  );
  assert.equal(
    rig.getRoomDo(knockRoomId).persistence.membershipProjection.get({ user_id: carol.user_id }).membership,
    'knock',
  );
  await expectMatrixError(
    await rig.gatewayFetch(roomPath(knockRoomId, '/state'), {
      headers: rig.authHeaders(carol.access_token),
    }),
    403,
    'M_FORBIDDEN',
  );
  await postJson(rig, alice.access_token, roomPath(knockRoomId, '/invite'), {
    user_id: bob.user_id,
  });
  await postJson(rig, bob.access_token, roomPath(knockRoomId, '/join'));
  await expectMatrixError(
    await rig.gatewayFetch(`/_matrix/client/v3/knock/${encodeURIComponent(knockRoomId)}`, {
      method: 'POST',
      headers: rig.authHeaders(bob.access_token),
      json: {},
    }),
    403,
    'M_FORBIDDEN',
  );
});

test('Phase 06 covers typing, receipts, typing expiry, and fanout repair hooks', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase06-alice-c' });
  const bob = await registerUser(rig, { username: 'phase06-bob-c' });

  const create = await createRoom(rig, alice.access_token, {
    invite: [bob.user_id],
  });
  const roomId = create.room_id;
  const roomDo = rig.getRoomDo(roomId);
  const bobUserDo = rig.getUserDo(bob.user_id);

  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));
  const message = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/receipt-target'),
    {
      msgtype: 'm.text',
      body: 'fanout and ephemeral target',
    },
  );

  const bobBaselineSync = await syncRequest(rig, bob.access_token);
  const typingMetadataCount = roomDo.persistence.eventMetadata.list().length;
  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/typing/${encodeURIComponent(alice.user_id)}`),
    {
      typing: true,
      timeout: 1_000,
    },
  );
  const typingRow = roomDo.persistence.typing.get({ user_id: alice.user_id });
  assert.ok(typingRow);
  assert.equal(await roomDo.ctx.storage.getAlarm(), Date.parse(typingRow.expires_at));
  const originalBobAppendRoomEphemeral = bobUserDo.appendRoomEphemeral.bind(bobUserDo);
  bobUserDo.appendRoomEphemeral = async (request) => {
    if (request?.event?.type === 'm.receipt') {
      throw new Error('ephemeral delivery failed');
    }
    return originalBobAppendRoomEphemeral(request);
  };
  await postJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/receipt/m.read/${encodeURIComponent(message.event_id)}`),
    {
      ts: 123,
    },
  );
  bobUserDo.appendRoomEphemeral = originalBobAppendRoomEphemeral;
  assert.equal(roomDo.persistence.eventMetadata.list().length, typingMetadataCount);
  assert.equal(
    roomDo.persistence.receipts.get({
      receipt_type: 'm.read',
      user_id: alice.user_id,
      thread_id: '',
    }).event_id,
    message.event_id,
  );

  const bobEphemeralSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobBaselineSync.next_batch)}`,
  );
  const ephemeralEntry = bobEphemeralSync.rooms.join[roomId];
  const typingEvent = ephemeralEntry.ephemeral.events.find((event) => event.type === 'm.typing');
  const receiptEvent = ephemeralEntry.ephemeral.events.find((event) => event.type === 'm.receipt');
  assert.deepEqual(typingEvent.content.user_ids, [alice.user_id]);
  assert.equal(receiptEvent, undefined);

  await roomDo.alarm({
    scheduledTime: Date.now() + 5_000,
  });
  assert.equal(await roomDo.ctx.storage.getAlarm(), null);
  const bobTypingExpiredSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobEphemeralSync.next_batch)}`,
  );
  const clearedTypingEvent = bobTypingExpiredSync.rooms.join[roomId].ephemeral.events.find(
    (event) => event.type === 'm.typing',
  );
  assert.deepEqual(clearedTypingEvent.content.user_ids, []);
  const receiptVisibleMessage = await putJson(
    rig,
    bob.access_token,
    roomPath(roomId, '/send/m.room.message/receipt-visible'),
    {
      msgtype: 'm.text',
      body: 'receipt visible target',
    },
  );
  await postJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/receipt/m.read/${encodeURIComponent(receiptVisibleMessage.event_id)}`),
    {
      ts: 456,
    },
  );
  const bobReceiptSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(bobTypingExpiredSync.next_batch)}`,
  );
  const deliveredReceiptEvent = bobReceiptSync.rooms.join[roomId].ephemeral.events.find(
    (event) => event.type === 'm.receipt',
  );
  assert.equal(deliveredReceiptEvent.content[receiptVisibleMessage.event_id]['m.read'][alice.user_id].ts, 456);

  const repairMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/repair-target'),
    {
      msgtype: 'm.text',
      body: 'repair target',
    },
  );
  const repairMetadata = roomDo.persistence.eventMetadata.get({ event_id: repairMessage.event_id });
  const existingFanout = await bobUserDo.inspectRoomFanout({
    room_id: roomId,
    room_pos: repairMetadata.room_pos,
    user_id: bob.user_id,
  });
  assert.ok(existingFanout.entry);

  bobUserDo.persistence.userStream.delete({ stream_pos: existingFanout.entry.stream_pos });
  roomDo.persistence.fanoutOutbox.delete({
    room_pos: repairMetadata.room_pos,
    user_id: bob.user_id,
  });

  const dryRun = await roomDo.reconcileFanout({
    limit: 20,
    target_user_id: bob.user_id,
    dry_run: true,
  });
  assert.ok(dryRun.results.some((entry) => entry.status === 'would_recreate_outbox'));

  const reconcile = await roomDo.reconcileFanout({ limit: 20, target_user_id: bob.user_id });
  assert.ok(reconcile.results.some((entry) => entry.status === 'recreated_outbox'));
  assert.ok(reconcile.results.some((entry) => entry.status === 'acked'));

  const repairedFanout = await bobUserDo.inspectRoomFanout({
    room_id: roomId,
    room_pos: repairMetadata.room_pos,
    user_id: bob.user_id,
  });
  assert.ok(repairedFanout.entry);
  assert.equal(
    roomDo.persistence.fanoutOutbox.get({
      room_pos: repairMetadata.room_pos,
      user_id: bob.user_id,
    }).status,
    'acked',
  );
});

test('Phase 06 typing alarm reschedules and clears on explicit typing=false', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, { username: 'phase06-alice-typing' });
  const bob = await registerUser(rig, { username: 'phase06-bob-typing' });

  const room = await createRoom(rig, alice.access_token, {
    invite: [bob.user_id],
  });
  const roomId = room.room_id;
  const roomDo = rig.getRoomDo(roomId);

  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));
  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/typing/${encodeURIComponent(alice.user_id)}`),
    {
      typing: true,
      timeout: 1_000,
    },
  );
  const firstTypingRow = roomDo.persistence.typing.get({ user_id: alice.user_id });
  const firstAlarm = await roomDo.ctx.storage.getAlarm();
  assert.ok(firstTypingRow);
  assert.equal(firstAlarm, Date.parse(firstTypingRow.expires_at));

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/typing/${encodeURIComponent(alice.user_id)}`),
    {
      typing: true,
      timeout: 5_000,
    },
  );
  const rescheduledTypingRow = roomDo.persistence.typing.get({ user_id: alice.user_id });
  const rescheduledAlarm = await roomDo.ctx.storage.getAlarm();
  assert.ok(rescheduledTypingRow);
  assert.ok(rescheduledAlarm > firstAlarm);
  assert.equal(rescheduledAlarm, Date.parse(rescheduledTypingRow.expires_at));

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, `/typing/${encodeURIComponent(alice.user_id)}`),
    {
      typing: false,
    },
  );
  assert.equal(roomDo.persistence.typing.get({ user_id: alice.user_id }) ?? null, null);
  assert.equal(await roomDo.ctx.storage.getAlarm(), null);
});

test('Phase 06 covers room version defaults, unsupported versions, and 11/12 redaction differences', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const defaultUser = await registerUser(rig, { username: 'phase06-roomv-default' });
  const defaultRoom = await createRoom(rig, defaultUser.access_token, {});
  const defaultRoomDo = rig.getRoomDo(defaultRoom.room_id);
  assert.equal(defaultRoomDo.persistence.getRuntimeState().room_version, '12');

  await expectMatrixError(
    await rig.gatewayFetch('/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: rig.authHeaders(defaultUser.access_token),
      json: {
        room_version: '99',
      },
    }),
    400,
    'M_UNSUPPORTED_ROOM_VERSION',
  );

  const v11User = await registerUser(rig, { username: 'phase06-roomv-11' });
  const v11Room = await createRoom(rig, v11User.access_token, {
    room_version: '11',
  });
  assert.match(v11Room.room_id, /:matrix\.example\.test$/);
  const v11RoomDo = rig.getRoomDo(v11Room.room_id);
  assert.equal(v11RoomDo.persistence.getRuntimeState().room_version, '11');
  const v11CreateEntry = v11RoomDo.persistence.stateEntries.list().find(
    (row) => row.event_type === 'm.room.create' && row.state_key === '',
  );
  const v11CreateEvent = v11RoomDo.loadRoomEventById(v11CreateEntry.event_id).event;
  assert.equal(v11CreateEvent.room_id, v11Room.room_id);

  const v11PowerEntry = v11RoomDo.persistence.stateEntries.list().find(
    (row) => row.event_type === 'm.room.power_levels' && row.state_key === '',
  );
  await putJson(
    rig,
    v11User.access_token,
    roomPath(v11Room.room_id, `/redact/${encodeURIComponent(v11PowerEntry.event_id)}/rv11-redact`),
    {},
  );
  const v11RedactedPower = v11RoomDo.loadRoomEventById(v11PowerEntry.event_id).event;
  assert.deepEqual(v11RedactedPower.content, {
    invite: 0,
  });

  const v12PowerEntry = defaultRoomDo.persistence.stateEntries.list().find(
    (row) => row.event_type === 'm.room.power_levels' && row.state_key === '',
  );
  const v12CreateEntry = defaultRoomDo.persistence.stateEntries.list().find(
    (row) => row.event_type === 'm.room.create' && row.state_key === '',
  );
  const v12CreateEvent = defaultRoomDo.loadRoomEventById(v12CreateEntry.event_id).event;
  assert.equal(v12CreateEvent.room_id, undefined);

  await putJson(
    rig,
    defaultUser.access_token,
    roomPath(defaultRoom.room_id, `/redact/${encodeURIComponent(v12PowerEntry.event_id)}/rv12-redact`),
    {},
  );
  const v12RedactedPower = defaultRoomDo.loadRoomEventById(v12PowerEntry.event_id).event;
  assert.deepEqual(v12RedactedPower.content, {});
});
