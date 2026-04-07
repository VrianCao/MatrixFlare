import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoredFilterEnvelope } from '../../../packages/runtime-core/src/client-domain.mjs';
import { createGatewayPhase04Rig } from './support.mjs';

async function expectMatrixError(response, status, errcode) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.errcode, errcode);
  return body;
}

async function registerUser(rig, {
  username,
  password,
  deviceId,
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

async function syncRequest(rig, accessToken, query = '') {
  const suffix = query ? `?${query}` : '';
  const response = await rig.gatewayFetch(`/_matrix/client/v3/sync${suffix}`, {
    headers: rig.authHeaders(accessToken),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function loginWithPassword(rig, {
  user,
  password,
  deviceId,
}) {
  const response = await rig.gatewayFetch('/_matrix/client/v3/login', {
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
  assert.equal(response.status, 200);
  return response.json();
}

test('Phase 05 browser-origin /sync keeps auth, CORS, preflight, and long-poll truth aligned', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const registration = await registerUser(rig, {
    username: 'browser-sync-user',
    password: 'phase05-browser-sync-password',
    deviceId: 'BROWSERSYNC',
  });

  const browserOrigin = 'https://app.element.io';
  const browserSyncWithoutToken = await rig.gatewayFetch('/_matrix/client/v3/sync?timeout=0', {
    headers: {
      origin: browserOrigin,
    },
  });
  await expectMatrixError(browserSyncWithoutToken, 401, 'M_MISSING_TOKEN');
  assert.equal(browserSyncWithoutToken.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserSyncWithoutToken.headers.get('vary') ?? '', /Origin/i);

  const browserSync = await rig.gatewayFetch('/_matrix/client/v3/sync?timeout=0', {
    headers: {
      ...rig.authHeaders(registration.access_token),
      origin: browserOrigin,
    },
  });
  assert.equal(browserSync.status, 200);
  assert.equal(browserSync.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserSync.headers.get('vary') ?? '', /Origin/i);
  const browserSyncBody = await browserSync.json();
  assert.equal(typeof browserSyncBody.next_batch, 'string');

  const browserSyncPreflight = await rig.gatewayFetch('/_matrix/client/v3/sync?timeout=0', {
    method: 'OPTIONS',
    headers: {
      origin: browserOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(browserSyncPreflight.status, 204);
  assert.equal(browserSyncPreflight.headers.get('access-control-allow-origin'), browserOrigin);
  assert.equal(browserSyncPreflight.headers.get('access-control-allow-headers'), 'authorization');
  assert.match(browserSyncPreflight.headers.get('access-control-allow-methods') ?? '', /\bGET\b/);
  assert.match(browserSyncPreflight.headers.get('vary') ?? '', /Origin/i);
  assert.match(browserSyncPreflight.headers.get('vary') ?? '', /Access-Control-Request-Headers/i);

  const pendingBrowserSync = rig.gatewayFetch(
    `/_matrix/client/v3/sync?since=${encodeURIComponent(browserSyncBody.next_batch)}&timeout=1000`,
    {
      headers: {
        ...rig.authHeaders(registration.access_token),
        origin: browserOrigin,
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const wakeWrite = await rig.gatewayFetch(
    `/_matrix/client/v3/user/${encodeURIComponent('@browser-sync-user:matrix.example.test')}/account_data/com.example.browser.syncwake`,
    {
      method: 'PUT',
      headers: rig.authHeaders(registration.access_token),
      json: {
        tick: 1,
      },
    },
  );
  assert.equal(wakeWrite.status, 200);
  const browserLongPollResponse = await pendingBrowserSync;
  assert.equal(browserLongPollResponse.status, 200);
  assert.equal(browserLongPollResponse.headers.get('access-control-allow-origin'), browserOrigin);
  assert.match(browserLongPollResponse.headers.get('vary') ?? '', /Origin/i);
  const browserLongPollBody = await browserLongPollResponse.json();
  assert.notEqual(browserLongPollBody.next_batch, browserSyncBody.next_batch);
  assert.deepEqual(browserLongPollBody.account_data?.events, [
    {
      type: 'com.example.browser.syncwake',
      content: {
        tick: 1,
      },
    },
  ]);
});

function roomPath(roomId, suffix = '') {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}${suffix}`;
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

async function getJson(rig, accessToken, pathname) {
  const response = await rig.gatewayFetch(pathname, {
    headers: rig.authHeaders(accessToken),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function seedJoinedRoom(rig, {
  roomId = '!phase05:matrix.example.test',
  userId = '@alice:matrix.example.test',
  displayname = 'Alice Before Refresh',
  avatarUrl = 'mxc://matrix.example.test/alice-before',
  profileVersion = 1,
} = {}) {
  const roomDo = rig.getRoomDo(roomId);
  await roomDo.ensureSchema();
  roomDo.persistence.setRuntimeIdentity({
    room_id: roomId,
    room_version: '12',
    updated_at: '2026-03-30T00:00:00.000Z',
  });
  roomDo.persistence.stateSnapshots.put({
    snapshot_id: 'snapshot-1',
    snapshot_hash: 'snapshot-hash-1',
    extremity_set_hash: 'extremity-hash-1',
    created_at: '2026-03-30T00:00:00.000Z',
    record_json: {},
  });
  roomDo.persistence.updateCurrentSnapshot({
    snapshot_id: 'snapshot-1',
    snapshot_hash: 'snapshot-hash-1',
    updated_at: '2026-03-30T00:00:00.000Z',
  });
  const roomPos = roomDo.persistence.allocateRoomPos({
    room_id: roomId,
    room_version: '12',
    updated_at: '2026-03-30T00:00:01.000Z',
  });
  const eventId = '$phase05-seed-join';
  const memberEvent = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    origin_server_ts: Date.parse('2026-03-30T00:00:01.000Z'),
    content: {
      membership: 'join',
      displayname,
      avatar_url: avatarUrl,
    },
  };
  roomDo.persistence.eventMetadata.put({
    event_id: eventId,
    room_pos: roomPos,
    origin_server_ts: memberEvent.origin_server_ts,
    depth: roomPos,
    archive_object_key_or_segment_id: null,
    archive_offset_or_index: null,
    event_type: 'm.room.member',
    state_key_or_null: userId,
    sender_user_id: userId,
    contains_url_flag: false,
    soft_failed_flag: false,
    waiting_missing_flag: false,
    redacts_event_id_or_null: null,
    membership_target_user_id_or_null: userId,
    history_visibility_class: 'shared',
    membership_visibility_class: 'joined',
    relates_to_event_id_or_null: null,
    relation_type_or_null: null,
    aggregation_event_type_or_null: null,
    thread_root_event_id_or_null: null,
    record_json: {},
  });
  roomDo.persistence.hotEventJson.put({
    event_id: eventId,
    content_hash: null,
    stored_at: '2026-03-30T00:00:01.000Z',
    canonical_json: JSON.stringify(memberEvent),
    record_json: {},
  });
  roomDo.persistence.stateEntries.put({
    snapshot_id: 'snapshot-1',
    event_type: 'm.room.member',
    state_key: userId,
    event_id: eventId,
    sender_user_id: userId,
    membership: 'join',
    event_room_pos: roomPos,
    content_json: structuredClone(memberEvent.content),
    record_json: { profile_version: profileVersion },
  });
  roomDo.persistence.membershipProjection.put({
    user_id: userId,
    membership: 'join',
    event_id: eventId,
    room_pos: roomPos,
    displayname,
    avatar_url: avatarUrl,
    profile_version: profileVersion,
    membership_visibility_class: 'joined',
    updated_at: '2026-03-30T00:00:01.000Z',
    record_json: {},
  });
  roomDo.persistence.fanoutOutbox.put({
    room_pos: roomPos,
    user_id: userId,
    event_id: eventId,
    status: 'pending',
    last_attempt_at: null,
    attempt_count: 0,
    acked_stream_pos: null,
    acked_at: null,
    delta_json: {
      room_id: roomId,
      room_pos: roomPos,
      user_id: userId,
      membership_bucket: 'join',
      event_id: eventId,
      state_event_ids: [eventId],
      summary: {
        joined_member_count: 1,
        invited_member_count: 0,
      },
    },
    last_error_json: null,
    created_at: '2026-03-30T00:00:01.000Z',
    record_json: {},
  });
  const delivered = await roomDo.deliverPendingFanout({ limit: 10 });
  assert.equal(delivered.ok, true);
  return {
    roomDo,
    roomId,
    roomPos,
    eventId,
  };
}

async function appendRoomMessageDelta(roomDo, {
  roomId,
  userId,
  sender = '@bob:matrix.example.test',
  body = 'phase 05 room delta',
  eventId = '$phase05-message',
  notificationCount = 0,
  highlightCount = 0,
  unreadThreadNotifications = null,
} = {}) {
  const roomPos = roomDo.persistence.allocateRoomPos({
    room_id: roomId,
    room_version: '12',
    updated_at: '2026-03-30T00:10:00.000Z',
  });
  const messageEvent = {
    event_id: eventId,
    room_id: roomId,
    sender,
    type: 'm.room.message',
    origin_server_ts: Date.parse('2026-03-30T00:10:00.000Z'),
    content: {
      msgtype: 'm.text',
      body,
    },
  };
  roomDo.persistence.eventMetadata.put({
    event_id: eventId,
    room_pos: roomPos,
    origin_server_ts: messageEvent.origin_server_ts,
    depth: roomPos,
    archive_object_key_or_segment_id: null,
    archive_offset_or_index: null,
    event_type: 'm.room.message',
    state_key_or_null: null,
    sender_user_id: sender,
    contains_url_flag: false,
    soft_failed_flag: false,
    waiting_missing_flag: false,
    redacts_event_id_or_null: null,
    membership_target_user_id_or_null: null,
    history_visibility_class: 'shared',
    membership_visibility_class: 'joined',
    relates_to_event_id_or_null: null,
    relation_type_or_null: null,
    aggregation_event_type_or_null: null,
    thread_root_event_id_or_null: null,
    record_json: {},
  });
  roomDo.persistence.hotEventJson.put({
    event_id: eventId,
    content_hash: null,
    stored_at: '2026-03-30T00:10:00.000Z',
    canonical_json: JSON.stringify(messageEvent),
    record_json: {},
  });
  roomDo.persistence.fanoutOutbox.put({
    room_pos: roomPos,
    user_id: userId,
    event_id: eventId,
    status: 'pending',
    last_attempt_at: null,
    attempt_count: 0,
    acked_stream_pos: null,
    acked_at: null,
    delta_json: {
      room_id: roomId,
      room_pos: roomPos,
      user_id: userId,
      membership_bucket: 'join',
      event_id: eventId,
      timeline_event_ids: [eventId],
      notification_count: notificationCount,
      highlight_count: highlightCount,
      unread_thread_notifications: unreadThreadNotifications,
      summary: {
        joined_member_count: 1,
        invited_member_count: 0,
      },
    },
    last_error_json: null,
    created_at: '2026-03-30T00:10:00.000Z',
    record_json: {},
  });
  const delivered = await roomDo.deliverPendingFanout({ limit: 10 });
  assert.equal(delivered.ok, true);
  return {
    roomPos,
    eventId,
  };
}

function getJoinedRoomEntry(syncBody, roomId) {
  return syncBody.rooms?.join?.[roomId] ?? null;
}

function getLeftRoomEntry(syncBody, roomId) {
  return syncBody.rooms?.leave?.[roomId] ?? null;
}

function getStateEvent(roomEntry, {
  type,
  stateKey = undefined,
} = {}) {
  const events = roomEntry?.state?.events ?? roomEntry?.state_after?.events ?? [];
  return events.find((event) => (
    event?.type === type
    && (stateKey === undefined || event?.state_key === stateKey)
  )) ?? null;
}

test('Phase 05 profile, presence, and sync propagation are wired end-to-end', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const aliceUserId = '@alice:matrix.example.test';
  const roomId = '!phase05:matrix.example.test';

  await seedJoinedRoom(rig, {
    roomId,
    userId: aliceUserId,
  });

  const initialProfile = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test');
  assert.equal(initialProfile.status, 200);
  assert.deepEqual(await initialProfile.json(), {});

  const setDisplayName = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/displayname', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      displayname: 'Alice Liddell',
    },
  });
  assert.equal(setDisplayName.status, 200);

  const setAvatar = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/avatar_url', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      avatar_url: 'mxc://matrix.example.test/alice-avatar',
    },
  });
  assert.equal(setAvatar.status, 200);

  const setTimeZone = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/m.tz', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      'm.tz': 'America/Los_Angeles',
    },
  });
  assert.equal(setTimeZone.status, 200);

  const setCustomField = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/com.example.theme', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      'com.example.theme': {
        palette: 'copper',
      },
    },
  });
  assert.equal(setCustomField.status, 200);

  const fullProfile = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test');
  assert.equal(fullProfile.status, 200);
  assert.deepEqual(await fullProfile.json(), {
    displayname: 'Alice Liddell',
    avatar_url: 'mxc://matrix.example.test/alice-avatar',
    'm.tz': 'America/Los_Angeles',
    'com.example.theme': {
      palette: 'copper',
    },
  });

  const displayNameField = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/displayname');
  assert.equal(displayNameField.status, 200);
  assert.deepEqual(await displayNameField.json(), {
    displayname: 'Alice Liddell',
  });

  const firstSync = await syncRequest(rig, alice.access_token);
  assert.equal(typeof firstSync.next_batch, 'string');
  const firstRoomEntry = getJoinedRoomEntry(firstSync, roomId);
  assert.ok(firstRoomEntry);
  assert.deepEqual(firstSync.account_data?.events ?? [], [
    {
      type: 'm.push_rules',
      content: {
        global: firstSync.account_data.events[0].content.global,
      },
    },
  ]);
  assert.equal(firstSync.presence.events.length, 1);
  assert.equal(firstSync.presence.events[0].content.displayname, 'Alice Liddell');
  assert.equal(firstSync.presence.events[0].content.avatar_url, 'mxc://matrix.example.test/alice-avatar');
  const initialMemberEvent = getStateEvent(firstRoomEntry, {
    type: 'm.room.member',
    stateKey: aliceUserId,
  });
  assert.ok(initialMemberEvent);
  assert.equal(initialMemberEvent.content.displayname, 'Alice Liddell');
  assert.equal(initialMemberEvent.content.avatar_url, 'mxc://matrix.example.test/alice-avatar');
  assert.deepEqual(firstRoomEntry.summary, {
    joined_member_count: 1,
    invited_member_count: 0,
  });

  const presenceWrite = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      presence: 'online',
      status_msg: 'reading spec ids',
    },
  });
  assert.equal(presenceWrite.status, 200);

  const presenceRead = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(presenceRead.status, 200);
  assert.deepEqual(await presenceRead.json(), {
    presence: 'online',
    currently_active: true,
    status_msg: 'reading spec ids',
    last_active_at: (await rig.getUserDo('alice').getPresence({ user_id: '@alice:matrix.example.test' })).content.last_active_at,
    displayname: 'Alice Liddell',
    avatar_url: 'mxc://matrix.example.test/alice-avatar',
  });

  const incrementalSync = await syncRequest(rig, alice.access_token, `since=${encodeURIComponent(firstSync.next_batch)}`);
  assert.equal(incrementalSync.presence.events.length, 1);
  assert.equal(incrementalSync.presence.events[0].content.status_msg, 'reading spec ids');

  const deleteAvatar = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/avatar_url', {
    method: 'DELETE',
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(deleteAvatar.status, 200);

  const postDeleteSync = await syncRequest(rig, alice.access_token, `since=${encodeURIComponent(incrementalSync.next_batch)}`);
  assert.equal(postDeleteSync.presence.events.length, 1);
  assert.equal('avatar_url' in postDeleteSync.presence.events[0].content, false);
  const refreshedRoomEntry = getJoinedRoomEntry(postDeleteSync, roomId);
  assert.ok(refreshedRoomEntry);
  const refreshedMemberEvent = getStateEvent(refreshedRoomEntry, {
    type: 'm.room.member',
    stateKey: aliceUserId,
  });
  assert.ok(refreshedMemberEvent);
  assert.equal(refreshedMemberEvent.content.displayname, 'Alice Liddell');
  assert.equal('avatar_url' in refreshedMemberEvent.content, false);

  const avatarFieldAfterDelete = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/avatar_url');
  await expectMatrixError(avatarFieldAfterDelete, 404, 'M_NOT_FOUND');
});

test('Phase 05 profile refreshes re-enter room admission and fan out to other joined users', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'phase05-profile-alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const bob = await registerUser(rig, {
    username: 'phase05-profile-bob',
    password: 'correct horse battery staple',
    deviceId: 'BOBPHONE',
  });

  const createResponse = await rig.gatewayFetch('/_matrix/client/v3/createRoom', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      invite: [bob.user_id],
    },
  });
  assert.equal(createResponse.status, 200);
  const { room_id: roomId } = await createResponse.json();
  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));

  const bobBaselineSync = await syncRequest(rig, bob.access_token);
  const setDisplayName = await rig.gatewayFetch(`/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id)}/displayname`, {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      displayname: 'Alice Through Admission',
    },
  });
  assert.equal(setDisplayName.status, 200);

  const bobIncrementalSync = await syncRequest(rig, bob.access_token, `since=${encodeURIComponent(bobBaselineSync.next_batch)}`);
  const bobRoomEntry = getJoinedRoomEntry(bobIncrementalSync, roomId);
  assert.ok(bobRoomEntry);
  const refreshedMemberEvent = getStateEvent(bobRoomEntry, {
    type: 'm.room.member',
    stateKey: alice.user_id,
  });
  assert.ok(refreshedMemberEvent);
  assert.equal(refreshedMemberEvent.content.displayname, 'Alice Through Admission');

  const roomDo = rig.getRoomDo(roomId);
  const refreshedMetadata = roomDo.persistence.eventMetadata.list()
    .filter((row) => row.event_type === 'm.room.member' && row.state_key_or_null === alice.user_id)
    .sort((left, right) => left.room_pos - right.room_pos)
    .at(-1);
  const refreshedEvent = roomDo.loadRoomEventById(refreshedMetadata.event_id).event;
  assert.equal(refreshedMetadata.record.request_kind, 'client');
  assert.equal(refreshedMetadata.record.propagation_kind, 'profile_refresh');
  assert.ok(Array.isArray(refreshedEvent.prev_events));
  assert.ok(refreshedEvent.prev_events.length >= 1);
});

test('Phase 05 profile field read rejects malformed path encoding deterministically', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const malformedRead = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test/%ZZ');
  await expectMatrixError(malformedRead, 400, 'M_INVALID_PARAM');

  const healthyRead = await rig.gatewayFetch('/_matrix/client/v3/profile/@alice:matrix.example.test');
  assert.equal(healthyRead.status, 200);
  assert.deepEqual(await healthyRead.json(), {});
});

test('Phase 05 /sync defaults mark clients online and return immediately without timeout', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const initialSync = await syncRequest(rig, alice.access_token);
  assert.equal(initialSync.presence.events[0].content.presence, 'online');
  assert.equal(initialSync.presence.events[0].content.currently_active, true);

  const presenceAfterInitialSync = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(presenceAfterInitialSync.status, 200);
  assert.equal((await presenceAfterInitialSync.json()).presence, 'online');

  const explicitPresence = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      presence: 'online',
      status_msg: 'focus mode',
    },
  });
  assert.equal(explicitPresence.status, 200);

  const afterExplicitPresence = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(initialSync.next_batch)}`,
  );
  assert.equal(afterExplicitPresence.presence.events[0].content.status_msg, 'focus mode');

  const offlineSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(afterExplicitPresence.next_batch)}&set_presence=offline`,
  );
  assert.equal(offlineSync.presence.events[0].content.presence, 'offline');
  assert.equal(offlineSync.presence.events[0].content.status_msg, 'focus mode');

  const presenceAfterOffline = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(presenceAfterOffline.status, 200);
  assert.deepEqual(await presenceAfterOffline.json(), {
    presence: 'offline',
    currently_active: false,
    status_msg: 'focus mode',
    last_active_at: (await rig.getUserDo('alice').getPresence({ user_id: '@alice:matrix.example.test' })).content.last_active_at,
  });
  const tamperedToken = `${offlineSync.next_batch.slice(0, -1)}${offlineSync.next_batch.endsWith('A') ? 'B' : 'A'}`;
  const tamperedSync = await rig.gatewayFetch(`/_matrix/client/v3/sync?since=${encodeURIComponent(tamperedToken)}`, {
    headers: rig.authHeaders(alice.access_token),
  });
  await expectMatrixError(tamperedSync, 400, 'M_INVALID_PARAM');
  const presenceAfterTamperedSync = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(presenceAfterTamperedSync.status, 200);
  assert.deepEqual(await presenceAfterTamperedSync.json(), {
    presence: 'offline',
    currently_active: false,
    status_msg: 'focus mode',
    last_active_at: (await rig.getUserDo('alice').getPresence({ user_id: '@alice:matrix.example.test' })).content.last_active_at,
  });

  const backOnlineSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(offlineSync.next_batch)}`,
  );
  assert.equal(backOnlineSync.presence.events[0].content.presence, 'online');
  assert.equal(backOnlineSync.presence.events[0].content.status_msg, 'focus mode');

  const emptySyncStart = Date.now();
  const emptySync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(backOnlineSync.next_batch)}`,
  );
  const emptySyncElapsedMs = Date.now() - emptySyncStart;
  assert.ok(
    emptySyncElapsedMs < 1000,
    `Expected /sync without timeout to return immediately, got ${emptySyncElapsedMs}ms`,
  );
  assert.equal(emptySync.next_batch, backOnlineSync.next_batch);
});

test('Phase 05 /sync rejects invalid set_presence before mutating session sync metadata', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const initialSync = await syncRequest(rig, alice.access_token);
  const sessionId = rig.getUserDo('alice').persistence.sessions.list()[0].session_id;
  const sessionBefore = structuredClone(rig.getUserDo('alice').persistence.sessions.get(sessionId));

  const invalidSync = await rig.gatewayFetch(
    `/_matrix/client/v3/sync?since=${encodeURIComponent(initialSync.next_batch)}&set_presence=bogus`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await expectMatrixError(invalidSync, 400, 'M_INVALID_PARAM');

  const sessionAfter = rig.getUserDo('alice').persistence.sessions.get(sessionId);
  assert.equal(sessionAfter.record.last_seen_sync_pos, sessionBefore.record.last_seen_sync_pos);
  assert.equal(sessionAfter.record.last_sync_at, sessionBefore.record.last_sync_at);

  const presenceAfterInvalidSync = await rig.gatewayFetch('/_matrix/client/v3/presence/@alice:matrix.example.test/status', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(presenceAfterInvalidSync.status, 200);
  assert.equal((await presenceAfterInvalidSync.json()).presence, 'online');
});

test('Phase 05 account data, filters, sync waiting, and room account-data deltas are surfaced', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const aliceUserId = '@alice:matrix.example.test';
  const roomId = '!abc123:matrix.example.test';

  await seedJoinedRoom(rig, {
    roomId,
    userId: aliceUserId,
  });

  const storeFilter = await rig.gatewayFetch('/_matrix/client/v3/user/@alice:matrix.example.test/filter', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      account_data: {
        types: ['m.direct', 'm.push_rules'],
      },
      room: {
        include_leave: false,
      },
    },
  });
  assert.equal(storeFilter.status, 200);
  const storedFilter = await storeFilter.json();
  assert.equal(typeof storedFilter.filter_id, 'string');

  const storedFilterRetry = await rig.gatewayFetch('/_matrix/client/v3/user/@alice:matrix.example.test/filter', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      account_data: {
        types: ['m.direct', 'm.push_rules'],
      },
      room: {
        include_leave: false,
      },
    },
  });
  assert.equal(storedFilterRetry.status, 200);
  assert.deepEqual(await storedFilterRetry.json(), storedFilter);

  const fetchedFilter = await rig.gatewayFetch(`/_matrix/client/v3/user/@alice:matrix.example.test/filter/${storedFilter.filter_id}`, {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(fetchedFilter.status, 200);
  assert.deepEqual(await fetchedFilter.json(), {
    account_data: {
      types: ['m.direct', 'm.push_rules'],
    },
    room: {
      include_leave: false,
    },
  });

  const initialSync = await syncRequest(
    rig,
    alice.access_token,
    `filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  assert.equal(typeof initialSync.next_batch, 'string');

  const putGlobalAccountData = await rig.gatewayFetch('/_matrix/client/v3/user/@alice:matrix.example.test/account_data/m.direct', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      '@bob:matrix.example.test': [roomId],
    },
  });
  assert.equal(putGlobalAccountData.status, 200);

  const getGlobalAccountData = await rig.gatewayFetch('/_matrix/client/v3/user/@alice:matrix.example.test/account_data/m.direct', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(getGlobalAccountData.status, 200);
  assert.deepEqual(await getGlobalAccountData.json(), {
    '@bob:matrix.example.test': [roomId],
  });

  const putRoomAccountData = await rig.gatewayFetch(`/_matrix/client/v3/user/@alice:matrix.example.test/rooms/${encodeURIComponent(roomId)}/account_data/com.example.layout`, {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      density: 'compact',
    },
  });
  assert.equal(putRoomAccountData.status, 200);

  const putTag = await rig.gatewayFetch(`/_matrix/client/v3/user/@alice:matrix.example.test/rooms/${encodeURIComponent(roomId)}/tags/u.work`, {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      order: 0.1,
    },
  });
  assert.equal(putTag.status, 200);

  const getTags = await rig.gatewayFetch(`/_matrix/client/v3/user/@alice:matrix.example.test/rooms/${encodeURIComponent(roomId)}/tags`, {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(getTags.status, 200);
  assert.deepEqual(await getTags.json(), {
    tags: {
      'u.work': {
        order: 0.1,
      },
    },
  });

  const readMarkers = await rig.gatewayFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`, {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: {
      'm.fully_read': '$event0',
      'm.marked_unread': true,
    },
  });
  assert.equal(readMarkers.status, 200);

  const incrementalSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(initialSync.next_batch)}&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  assert.deepEqual(incrementalSync.account_data.events, [
    {
      type: 'm.direct',
      content: {
        '@bob:matrix.example.test': [roomId],
      },
    },
  ]);
  assert.deepEqual(getJoinedRoomEntry(incrementalSync, roomId)?.account_data?.events, [
    {
      room_id: roomId,
      type: 'com.example.layout',
      content: {
        density: 'compact',
      },
    },
    {
      room_id: roomId,
      type: 'm.tag',
      content: {
        'u.work': {
          order: 0.1,
        },
      },
    },
    {
      room_id: roomId,
      type: 'm.fully_read',
      content: {
        event_id: '$event0',
      },
    },
    {
      room_id: roomId,
      type: 'm.marked_unread',
      content: {
        unread: true,
      },
    },
  ]);

  const collectSince = await rig.getUserDo('alice').collectSince({
    user_id: '@alice:matrix.example.test',
    session_id: rig.getUserDo('alice').persistence.sessions.list()[0].session_id,
    since_token: initialSync.next_batch,
    filter_json: {
      account_data: {
        types: ['m.direct', 'm.push_rules'],
      },
      room: {
        include_leave: false,
      },
    },
    filter_hash: storedFilter.filter_id.replace(/^f_/, ''),
  });
  assert.equal(collectSince.ok, true);
  assert.deepEqual(collectSince.batch.room_account_data_deltas.map((delta) => delta.event), [
    {
      room_id: roomId,
      type: 'com.example.layout',
      content: {
        density: 'compact',
      },
    },
    {
      room_id: roomId,
      type: 'm.tag',
      content: {
        'u.work': {
          order: 0.1,
        },
      },
    },
    {
      room_id: roomId,
      type: 'm.fully_read',
      content: {
        event_id: '$event0',
      },
    },
    {
      room_id: roomId,
      type: 'm.marked_unread',
      content: {
        unread: true,
      },
    },
  ]);

  const timedOutSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(incrementalSync.next_batch)}&timeout=10&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  assert.equal(timedOutSync.next_batch, incrementalSync.next_batch);

  const pendingSync = rig.gatewayFetch(
    `/_matrix/client/v3/sync?since=${encodeURIComponent(incrementalSync.next_batch)}&timeout=1000&filter=${encodeURIComponent(storedFilter.filter_id)}`,
    {
      headers: rig.authHeaders(alice.access_token),
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const wakeWrite = await rig.gatewayFetch('/_matrix/client/v3/user/@alice:matrix.example.test/account_data/com.example.syncwake', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      tick: 1,
    },
  });
  assert.equal(wakeWrite.status, 200);
  const wokenSyncResponse = await pendingSync;
  assert.equal(wokenSyncResponse.status, 200);
  const wokenSync = await wokenSyncResponse.json();
  assert.equal('account_data' in wokenSync, false);
  assert.notEqual(wokenSync.next_batch, incrementalSync.next_batch);
});

test('Phase 05 /sync since tokens remain valid when the caller switches between inline and stored filters', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const inlineFilter = {
    room: {
      state: {
        lazy_load_members: true,
      },
      timeline: {
        limit: 8,
      },
    },
  };
  const inlineSync = await syncRequest(
    rig,
    alice.access_token,
    `filter=${encodeURIComponent(JSON.stringify(inlineFilter))}`,
  );

  const storedFilter = createStoredFilterEnvelope(inlineFilter);
  const storeFilter = await rig.gatewayFetch('/_matrix/client/v3/user/@alice:matrix.example.test/filter', {
    method: 'POST',
    headers: rig.authHeaders(alice.access_token),
    json: inlineFilter,
  });
  assert.equal(storeFilter.status, 200);
  assert.deepEqual(await storeFilter.json(), {
    filter_id: storedFilter.filter_id,
  });

  const storedSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(inlineSync.next_batch)}&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  assert.equal(typeof storedSync.next_batch, 'string');

  const inlineRetry = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(storedSync.next_batch)}&filter=${encodeURIComponent(JSON.stringify(inlineFilter))}`,
  );
  assert.equal(typeof inlineRetry.next_batch, 'string');

  const broaderFilter = {
    room: {
      timeline: {
        limit: 16,
      },
    },
  };
  const switchedFilterSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(inlineRetry.next_batch)}&filter=${encodeURIComponent(JSON.stringify(broaderFilter))}`,
  );
  assert.equal(typeof switchedFilterSync.next_batch, 'string');
});

test('Phase 05 initial /sync on a new device includes recent joined-room timeline and keeps later filter switching incremental', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice-history',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    name: 'Phase 05 History Room',
  });
  const roomId = room.room_id;
  const preTokenMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-history-pretoken'),
    {
      msgtype: 'm.text',
      body: 'phase05 initial sync history pre-token',
    },
  );

  const laptop = await loginWithPassword(rig, {
    user: alice.user_id,
    password: 'correct horse battery staple',
    deviceId: 'ALICELAPTOP',
  });

  const cinnyInlineFilter = {
    room: {
      state: {
        lazy_load_members: true,
      },
      timeline: {
        limit: 8,
      },
    },
  };
  const cinnyStoredFilter = createStoredFilterEnvelope({
    room: {
      state: {
        lazy_load_members: true,
      },
    },
  });
  const storeFilter = await rig.gatewayFetch(`/_matrix/client/v3/user/${encodeURIComponent(alice.user_id)}/filter`, {
    method: 'POST',
    headers: rig.authHeaders(laptop.access_token),
    json: {
      room: {
        state: {
          lazy_load_members: true,
        },
      },
    },
  });
  assert.equal(storeFilter.status, 200);
  assert.deepEqual(await storeFilter.json(), {
    filter_id: cinnyStoredFilter.filter_id,
  });

  const cinnyInitialSync = await syncRequest(
    rig,
    laptop.access_token,
    `filter=${encodeURIComponent(JSON.stringify(cinnyInlineFilter))}&use_state_after=true`,
  );
  const initialRoom = getJoinedRoomEntry(cinnyInitialSync, roomId);
  assert.ok(initialRoom);
  assert.equal(typeof cinnyInitialSync.next_batch, 'string');
  assert.equal(initialRoom.timeline.events.at(-1).event_id, preTokenMessage.event_id);
  assert.ok(initialRoom.timeline.events.some((event) => event.event_id === preTokenMessage.event_id));
  assert.equal(typeof initialRoom.timeline.prev_batch, 'string');
  assert.ok(!('state' in initialRoom));
  assert.ok(Array.isArray(initialRoom.state_after?.events));

  const postTokenMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-history-posttoken'),
    {
      msgtype: 'm.text',
      body: 'phase05 initial sync history post-token',
    },
  );
  const cinnyStoredSync = await syncRequest(
    rig,
    laptop.access_token,
    `since=${encodeURIComponent(cinnyInitialSync.next_batch)}&filter=${encodeURIComponent(cinnyStoredFilter.filter_id)}&use_state_after=true`,
  );
  const storedRoom = getJoinedRoomEntry(cinnyStoredSync, roomId);
  assert.ok(storedRoom);
  assert.deepEqual(
    storedRoom.timeline?.events?.map((event) => event.event_id),
    [postTokenMessage.event_id],
  );
  assert.equal(
    storedRoom.timeline?.events?.some((event) => event.event_id === preTokenMessage.event_id),
    false,
  );
});

test('Phase 05 initial /sync recent-timeline bootstrap respects the collected room snapshot boundary', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice-snapshot-history',
    password: 'correct horse battery staple',
    deviceId: 'ALICESNAPSHOTPHONE',
  });
  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    name: 'Phase 05 Snapshot Boundary Room',
  });
  const roomId = room.room_id;
  const roomDo = rig.getRoomDo(roomId);

  const preSnapshotMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-snapshot-pre'),
    {
      msgtype: 'm.text',
      body: 'phase05 snapshot boundary before collectSince',
    },
  );
  const laptop = await loginWithPassword(rig, {
    user: alice.user_id,
    password: 'correct horse battery staple',
    deviceId: 'ALICESNAPSHOTLAPTOP',
  });

  const originalProjectForSync = roomDo.projectForSync.bind(roomDo);
  let injectedPostSnapshotDelta = null;
  roomDo.projectForSync = async function projectForSyncWithInjectedDelta(request = {}) {
    if (injectedPostSnapshotDelta == null) {
      injectedPostSnapshotDelta = await appendRoomMessageDelta(roomDo, {
        roomId,
        userId: alice.user_id,
        eventId: '$phase05-snapshot-post',
        body: 'phase05 snapshot boundary after collectSince',
      });
    }
    return originalProjectForSync(request);
  };
  t.after(() => {
    roomDo.projectForSync = originalProjectForSync;
  });

  const filter = encodeURIComponent(JSON.stringify({
    room: {
      timeline: {
        limit: 8,
      },
    },
  }));
  const initialSync = await syncRequest(rig, laptop.access_token, `filter=${filter}`);
  const initialRoom = getJoinedRoomEntry(initialSync, roomId);
  assert.ok(initialRoom);
  assert.ok(initialRoom.timeline.events.some((event) => event.event_id === preSnapshotMessage.event_id));
  assert.equal(
    initialRoom.timeline.events.some((event) => event.event_id === injectedPostSnapshotDelta.eventId),
    false,
  );

  roomDo.projectForSync = originalProjectForSync;

  const incrementalSync = await syncRequest(
    rig,
    laptop.access_token,
    `since=${encodeURIComponent(initialSync.next_batch)}&filter=${filter}`,
  );
  const incrementalRoom = getJoinedRoomEntry(incrementalSync, roomId);
  assert.ok(incrementalRoom);
  assert.deepEqual(
    incrementalRoom.timeline?.events?.map((event) => event.event_id),
    [injectedPostSnapshotDelta.eventId],
  );
});

test('Phase 05 room fanout projections surface timeline and unread counts through /sync', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const aliceUserId = '@alice:matrix.example.test';
  const roomId = '!fanout:matrix.example.test';

  const { roomDo } = await seedJoinedRoom(rig, {
    roomId,
    userId: aliceUserId,
  });

  const initialSync = await syncRequest(rig, alice.access_token);
  assert.equal(typeof initialSync.next_batch, 'string');

  const delta = await appendRoomMessageDelta(roomDo, {
    roomId,
    userId: aliceUserId,
    eventId: '$phase05-message-1',
    notificationCount: 3,
    highlightCount: 1,
    unreadThreadNotifications: {
      '$thread-root': {
        notification_count: 2,
        highlight_count: 1,
      },
    },
  });

  const incrementalSync = await syncRequest(rig, alice.access_token, `since=${encodeURIComponent(initialSync.next_batch)}`);
  const joinedRoom = getJoinedRoomEntry(incrementalSync, roomId);
  assert.ok(joinedRoom);
  assert.equal(joinedRoom.timeline.events.length, 1);
  assert.equal(joinedRoom.timeline.events[0].event_id, '$phase05-message-1');
  assert.equal(joinedRoom.timeline.events[0].type, 'm.room.message');
  assert.equal(joinedRoom.timeline.events[0].content.body, 'phase 05 room delta');
  assert.deepEqual(joinedRoom.unread_notifications, {
    highlight_count: 1,
    notification_count: 3,
  });
  assert.equal('unread_thread_notifications' in joinedRoom, false);
  assert.deepEqual(joinedRoom.summary, {
    joined_member_count: 1,
    invited_member_count: 0,
  });
  assert.equal(roomDo.persistence.fanoutOutbox.get({ room_pos: delta.roomPos, user_id: aliceUserId }).status, 'acked');

  const unreadThreadFilter = encodeURIComponent(JSON.stringify({
    room: {
      unread_thread_notifications: true,
    },
  }));
  const filteredInitialSync = await syncRequest(
    rig,
    alice.access_token,
    `filter=${unreadThreadFilter}`,
  );
  const filteredDelta = await appendRoomMessageDelta(roomDo, {
    roomId,
    userId: aliceUserId,
    eventId: '$phase05-message-2',
    notificationCount: 4,
    highlightCount: 0,
    unreadThreadNotifications: {
      '$thread-root-2': {
        notification_count: 1,
        highlight_count: 0,
      },
    },
  });
  const filteredIncrementalSync = await syncRequest(
    rig,
    alice.access_token,
    `since=${encodeURIComponent(filteredInitialSync.next_batch)}&filter=${unreadThreadFilter}`,
  );
  const filteredJoinedRoom = getJoinedRoomEntry(filteredIncrementalSync, roomId);
  assert.ok(filteredJoinedRoom);
  assert.equal(filteredJoinedRoom.timeline.events.at(-1).event_id, '$phase05-message-2');
  assert.deepEqual(filteredJoinedRoom.unread_notifications, {
    highlight_count: 0,
    notification_count: 4,
  });
  assert.deepEqual(filteredJoinedRoom.unread_thread_notifications, {
    '$thread-root-2': {
      notification_count: 1,
      highlight_count: 0,
    },
  });
  assert.equal(roomDo.persistence.fanoutOutbox.get({ room_pos: filteredDelta.roomPos, user_id: aliceUserId }).status, 'acked');
});

test('Phase 05 initial /sync on a newly logged-in device returns recent room timeline plus prev_batch', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'phase05-history-alice',
    password: 'correct horse battery staple',
    deviceId: 'HISTORYPHONE',
  });
  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    name: 'Phase 05 Initial Sync History Room',
  });
  const roomId = room.room_id;

  const firstMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-history-1'),
    {
      msgtype: 'm.text',
      body: 'phase05 initial sync history one',
    },
  );
  const secondMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-history-2'),
    {
      msgtype: 'm.text',
      body: 'phase05 initial sync history two',
    },
  );
  const thirdMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-history-3'),
    {
      msgtype: 'm.text',
      body: 'phase05 initial sync history three',
    },
  );

  const laptop = await loginWithPassword(rig, {
    user: alice.user_id,
    password: 'correct horse battery staple',
    deviceId: 'HISTORYLAPTOP',
  });
  const filter = encodeURIComponent(JSON.stringify({
    room: {
      timeline: {
        limit: 2,
      },
      state: {
        lazy_load_members: true,
      },
    },
  }));
  const initialSync = await syncRequest(
    rig,
    laptop.access_token,
    `filter=${filter}&use_state_after=true`,
  );
  const initialRoom = getJoinedRoomEntry(initialSync, roomId);
  assert.ok(initialRoom);
  assert.deepEqual(
    initialRoom.timeline?.events?.map((event) => event.event_id),
    [secondMessage.event_id, thirdMessage.event_id],
  );
  assert.equal(initialRoom.timeline?.limited, true);
  assert.equal(typeof initialRoom.timeline?.prev_batch, 'string');
  assert.ok(!('state' in initialRoom));
  assert.ok(Array.isArray(initialRoom.state_after?.events));

  const backfill = await getJson(
    rig,
    laptop.access_token,
    `${roomPath(roomId, '/messages')}?from=${encodeURIComponent(initialRoom.timeline.prev_batch)}&dir=b&limit=1`,
  );
  assert.deepEqual(backfill.chunk.map((event) => event.event_id), [firstMessage.event_id]);
});

test('Phase 05 initial /sync on a newly logged-in device includes recent leave-room timeline when include_leave is enabled', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'phase05-leave-alice',
    password: 'correct horse battery staple',
    deviceId: 'LEAVEALICE',
  });
  const bob = await registerUser(rig, {
    username: 'phase05-leave-bob',
    password: 'correct horse battery staple',
    deviceId: 'LEAVEBOB',
  });

  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    invite: [bob.user_id],
    name: 'Phase 05 Leave History Room',
  });
  const roomId = room.room_id;
  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));

  const leaveBackfillMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-leave-backfill'),
    {
      msgtype: 'm.text',
      body: 'phase05 leave backfill message',
    },
  );
  const leaveInlineMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-leave-inline'),
    {
      msgtype: 'm.text',
      body: 'phase05 leave inline message',
    },
  );
  await postJson(rig, bob.access_token, roomPath(roomId, '/leave'));

  const relogin = await loginWithPassword(rig, {
    user: bob.user_id,
    password: 'correct horse battery staple',
    deviceId: 'LEAVEBOB2',
  });
  const filter = encodeURIComponent(JSON.stringify({
    room: {
      include_leave: true,
      timeline: {
        limit: 2,
      },
    },
  }));
  const initialSync = await syncRequest(rig, relogin.access_token, `filter=${filter}`);
  const leaveRoom = getLeftRoomEntry(initialSync, roomId);
  assert.ok(leaveRoom);
  assert.ok(leaveRoom.timeline.events.some((event) => event.event_id === leaveInlineMessage.event_id));
  assert.ok(leaveRoom.timeline.events.some((event) => (
    event.type === 'm.room.member'
    && event.state_key === bob.user_id
    && event.content?.membership === 'leave'
  )));
  assert.equal(typeof leaveRoom.timeline.prev_batch, 'string');

  const backfill = await getJson(
    rig,
    relogin.access_token,
    `${roomPath(roomId, '/messages')}?from=${encodeURIComponent(leaveRoom.timeline.prev_batch)}&dir=b&limit=1`,
  );
  assert.deepEqual(backfill.chunk.map((event) => event.event_id), [leaveBackfillMessage.event_id]);
});

test('Phase 05 /sync applies timeline limits plus full_state, use_state_after, lazy-load members, and include_leave semantics', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'phase05-sync-alice',
    password: 'correct horse battery staple',
    deviceId: 'SYNCALICE',
  });
  const bob = await registerUser(rig, {
    username: 'phase05-sync-bob',
    password: 'correct horse battery staple',
    deviceId: 'SYNCBOB',
  });
  const carol = await registerUser(rig, {
    username: 'phase05-sync-carol',
    password: 'correct horse battery staple',
    deviceId: 'SYNCCAROL',
  });

  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    invite: [bob.user_id, carol.user_id],
    name: 'Phase 05 Sync Room',
  });
  const roomId = room.room_id;
  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));
  await postJson(rig, carol.access_token, roomPath(roomId, '/join'));

  const syncFilter = encodeURIComponent(JSON.stringify({
    room: {
      include_leave: true,
      timeline: {
        limit: 1,
      },
      state: {
        lazy_load_members: true,
      },
    },
  }));
  const baselineSync = await syncRequest(
    rig,
    bob.access_token,
    `filter=${syncFilter}`,
  );

  const firstMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-limit-1'),
    {
      msgtype: 'm.text',
      body: 'phase05 limited first',
    },
  );
  const secondMessage = await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-limit-2'),
    {
      msgtype: 'm.text',
      body: 'phase05 limited second',
    },
  );

  const limitedSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(baselineSync.next_batch)}&filter=${syncFilter}`,
  );
  const limitedRoom = getJoinedRoomEntry(limitedSync, roomId);
  assert.ok(limitedRoom);
  assert.equal(limitedRoom.timeline.events.length, 1);
  assert.equal(limitedRoom.timeline.events[0].event_id, secondMessage.event_id);
  assert.equal(limitedRoom.timeline.limited, true);
  assert.equal(typeof limitedRoom.timeline.prev_batch, 'string');
  const limitedBackfill = await getJson(
    rig,
    bob.access_token,
    `${roomPath(roomId, '/messages')}?from=${encodeURIComponent(limitedRoom.timeline.prev_batch)}&dir=b&limit=1`,
  );
  assert.deepEqual(limitedBackfill.chunk.map((event) => event.event_id), [firstMessage.event_id]);

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/state/m.room.topic'),
    {
      topic: 'phase05 use_state_after topic',
    },
  );
  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-state-after'),
    {
      msgtype: 'm.text',
      body: 'phase05 state after sender',
    },
  );

  const useStateAfterSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(limitedSync.next_batch)}&use_state_after=true&filter=${syncFilter}`,
  );
  const useStateAfterRoom = getJoinedRoomEntry(useStateAfterSync, roomId);
  assert.ok(useStateAfterRoom);
  assert.ok(!('state' in useStateAfterRoom));
  assert.ok(Array.isArray(useStateAfterRoom.state_after?.events));
  const stateAfterTopic = getStateEvent(useStateAfterRoom, {
    type: 'm.room.topic',
    stateKey: '',
  });
  assert.ok(stateAfterTopic);
  assert.equal(stateAfterTopic.content.topic, 'phase05 use_state_after topic');
  const stateAfterAliceMembership = getStateEvent(useStateAfterRoom, {
    type: 'm.room.member',
    stateKey: alice.user_id,
  });
  assert.ok(stateAfterAliceMembership);
  const stateAfterBobMembership = getStateEvent(useStateAfterRoom, {
    type: 'm.room.member',
    stateKey: bob.user_id,
  });
  assert.ok(stateAfterBobMembership);
  const stateAfterCarolMembership = getStateEvent(useStateAfterRoom, {
    type: 'm.room.member',
    stateKey: carol.user_id,
  });
  assert.equal(stateAfterCarolMembership, null);

  const fullStateSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(useStateAfterSync.next_batch)}&full_state=true&filter=${syncFilter}`,
  );
  const fullStateRoom = getJoinedRoomEntry(fullStateSync, roomId);
  assert.ok(fullStateRoom);
  assert.ok(Array.isArray(fullStateRoom.state?.events));
  assert.ok(!('state_after' in fullStateRoom));
  const fullStateTopic = getStateEvent(fullStateRoom, {
    type: 'm.room.topic',
    stateKey: '',
  });
  assert.ok(fullStateTopic);
  const fullStateBobMembership = getStateEvent(fullStateRoom, {
    type: 'm.room.member',
    stateKey: bob.user_id,
  });
  assert.ok(fullStateBobMembership);
  const fullStateCarolMembership = getStateEvent(fullStateRoom, {
    type: 'm.room.member',
    stateKey: carol.user_id,
  });
  assert.equal(fullStateCarolMembership, null);

  await postJson(rig, bob.access_token, roomPath(roomId, '/leave'));
  const leaveSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(fullStateSync.next_batch)}&filter=${syncFilter}`,
  );
  assert.ok(leaveSync.rooms?.leave?.[roomId]);
  assert.ok(leaveSync.rooms.leave[roomId].timeline.events.some((event) => (
    event.type === 'm.room.member'
    && event.state_key === bob.user_id
    && event.content?.membership === 'leave'
  )));

  assert.notEqual(firstMessage.event_id, secondMessage.event_id);
});

test('Phase 05 room fanout notification counts follow the current push-rules snapshot', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'phase05-notify-alice',
    password: 'correct horse battery staple',
    deviceId: 'NOTIFYALICE',
  });
  const bob = await registerUser(rig, {
    username: 'phase05-notify-bob',
    password: 'correct horse battery staple',
    deviceId: 'NOTIFYBOB',
  });

  const room = await postJson(rig, alice.access_token, '/_matrix/client/v3/createRoom', {
    invite: [bob.user_id],
  });
  const roomId = room.room_id;
  await postJson(rig, bob.access_token, roomPath(roomId, '/join'));

  const baselineSync = await syncRequest(rig, bob.access_token);

  const suppressRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.suppress-message', {
    method: 'PUT',
    headers: rig.authHeaders(bob.access_token),
    json: {
      conditions: [
        {
          kind: 'event_match',
          key: 'type',
          pattern: 'm.room.message',
        },
      ],
      actions: [],
    },
  });
  assert.equal(suppressRule.status, 200);

  const afterSuppressRuleSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(baselineSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterSuppressRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-suppressed'),
    {
      msgtype: 'm.text',
      body: 'phase05 suppressed message',
    },
  );
  const suppressedMessageSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(afterSuppressRuleSync.next_batch)}&timeout=0`,
  );
  const suppressedRoom = getJoinedRoomEntry(suppressedMessageSync, roomId);
  assert.ok(suppressedRoom);
  assert.deepEqual(suppressedRoom.unread_notifications, {
    highlight_count: 0,
    notification_count: 0,
  });

  const enableHighlightRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.suppress-message/actions', {
    method: 'PUT',
    headers: rig.authHeaders(bob.access_token),
    json: {
      actions: ['notify', { set_tweak: 'highlight', value: true }],
    },
  });
  assert.equal(enableHighlightRule.status, 200);

  const afterHighlightRuleSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(suppressedMessageSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterHighlightRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-highlighted'),
    {
      msgtype: 'm.text',
      body: 'phase05 highlighted message',
    },
  );
  const highlightedMessageSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(afterHighlightRuleSync.next_batch)}&timeout=0`,
  );
  const highlightedRoom = getJoinedRoomEntry(highlightedMessageSync, roomId);
  assert.ok(highlightedRoom);
  assert.deepEqual(highlightedRoom.unread_notifications, {
    highlight_count: 1,
    notification_count: 1,
  });

  const disableCustomRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.suppress-message/enabled', {
    method: 'PUT',
    headers: rig.authHeaders(bob.access_token),
    json: {
      enabled: false,
    },
  });
  assert.equal(disableCustomRule.status, 200);

  const afterDisableRuleSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(highlightedMessageSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterDisableRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-room-mention'),
    {
      msgtype: 'm.text',
      body: 'phase05 room mention message',
      'm.mentions': {
        room: true,
      },
    },
  );
  const roomMentionSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(afterDisableRuleSync.next_batch)}&timeout=0`,
  );
  const roomMentionRoom = getJoinedRoomEntry(roomMentionSync, roomId);
  assert.ok(roomMentionRoom);
  assert.deepEqual(roomMentionRoom.unread_notifications, {
    highlight_count: 2,
    notification_count: 2,
  });

  const enableMasterRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled', {
    method: 'PUT',
    headers: rig.authHeaders(bob.access_token),
    json: {
      enabled: true,
    },
  });
  assert.equal(enableMasterRule.status, 200);

  const afterMasterRuleSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(roomMentionSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterMasterRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  await putJson(
    rig,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/phase05-master-muted'),
    {
      msgtype: 'm.text',
      body: 'phase05 master rule muted message',
    },
  );
  const masterSuppressedSync = await syncRequest(
    rig,
    bob.access_token,
    `since=${encodeURIComponent(afterMasterRuleSync.next_batch)}&timeout=0`,
  );
  const masterSuppressedRoom = getJoinedRoomEntry(masterSuppressedSync, roomId);
  assert.ok(masterSuppressedRoom);
  assert.deepEqual(masterSuppressedRoom.unread_notifications, {
    highlight_count: 2,
    notification_count: 2,
  });
});

test('Phase 05 stale profile refreshes do not overwrite newer room membership or fan out', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const aliceUserId = '@alice:matrix.example.test';
  const roomId = '!profile-refresh:matrix.example.test';

  const { roomDo } = await seedJoinedRoom(rig, {
    roomId,
    userId: aliceUserId,
    profileVersion: 1,
  });

  const currentRefresh = await roomDo.enqueueProfileRefresh({
    room_id: roomId,
    user_id: aliceUserId,
    profile_version: 3,
    displayname: 'Alice Current',
    avatar_url: 'mxc://matrix.example.test/alice-current',
    now: '2026-03-30T00:00:02.000Z',
  });
  assert.equal(currentRefresh.ok, true);
  assert.equal(currentRefresh.delivered, true);

  const staleRefresh = await roomDo.enqueueProfileRefresh({
    room_id: roomId,
    user_id: aliceUserId,
    profile_version: 2,
    displayname: 'Alice Stale',
    avatar_url: 'mxc://matrix.example.test/alice-stale',
    now: '2026-03-30T00:00:03.000Z',
  });
  assert.equal(staleRefresh.ok, true);
  assert.equal(staleRefresh.delivered, false);
  assert.equal(staleRefresh.reason, 'stale_profile_version');

  const membership = roomDo.persistence.membershipProjection.get({ user_id: aliceUserId });
  assert.equal(membership.profile_version, 3);
  assert.equal(membership.displayname, 'Alice Current');
  assert.equal(membership.avatar_url, 'mxc://matrix.example.test/alice-current');

  const staleRoomPos = 999;
  roomDo.persistence.fanoutOutbox.put({
    room_pos: staleRoomPos,
    user_id: aliceUserId,
    event_id: '$profile-refresh-stale',
    status: 'pending',
    last_attempt_at: null,
    attempt_count: 0,
    acked_stream_pos: null,
    acked_at: null,
    delta_json: {
      room_id: roomId,
      room_pos: staleRoomPos,
      user_id: aliceUserId,
      membership_bucket: 'join',
      event_id: '$profile-refresh-stale',
      state_event_ids: ['$profile-refresh-stale'],
    },
    last_error_json: null,
    created_at: '2026-03-30T00:00:04.000Z',
    record_json: {
      profile_version: 2,
      propagation_kind: 'profile_refresh',
    },
  });
  const roomFanoutCountBefore = rig.getUserDo('alice').persistence.userStream.list()
    .filter((entry) => entry.stream_kind === 'room_fanout').length;
  const repairDelivery = await roomDo.deliverPendingFanout({
    limit: 10,
    now: '2026-03-30T00:00:05.000Z',
  });
  assert.equal(repairDelivery.ok, true);
  assert.equal(repairDelivery.results.find((entry) => entry.room_pos === staleRoomPos)?.status, 'skipped_stale');
  assert.equal(
    rig.getUserDo('alice').persistence.userStream.list().filter((entry) => entry.stream_kind === 'room_fanout').length,
    roomFanoutCountBefore,
  );
  assert.equal(roomDo.persistence.fanoutOutbox.get({ room_pos: staleRoomPos, user_id: aliceUserId }).status, 'acked');
});

test('Phase 05 push rules and to-device idempotency are enforced through routes', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });
  const bob = await registerUser(rig, {
    username: 'bob',
    password: 'hunter2 horse battery staple',
    deviceId: 'BOBPHONE',
  });

  const initialPushRules = await rig.gatewayFetch('/_matrix/client/v3/pushrules', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(initialPushRules.status, 200);
  const pushRulesBody = await initialPushRules.json();
  assert.deepEqual(pushRulesBody.global.override.map((rule) => rule.rule_id), [
    '.m.rule.master',
    '.m.rule.suppress_notices',
    '.m.rule.invite_for_me',
    '.m.rule.member_event',
    '.m.rule.is_user_mention',
    '.m.rule.is_room_mention',
    '.m.rule.tombstone',
    '.m.rule.reaction',
    '.m.rule.room.server_acl',
    '.m.rule.suppress_edits',
  ]);
  assert.deepEqual(pushRulesBody.global.underride.map((rule) => rule.rule_id), [
    '.m.rule.call',
    '.m.rule.encrypted_room_one_to_one',
    '.m.rule.room_one_to_one',
    '.m.rule.message',
    '.m.rule.encrypted',
  ]);
  assert.equal(pushRulesBody.global.sender.length, 0);
  assert.equal(pushRulesBody.global.room.length, 0);
  assert.equal(pushRulesBody.global.content.length, 0);

  const globalPushRules = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(globalPushRules.status, 200);
  assert.deepEqual(await globalPushRules.json(), pushRulesBody.global);

  const customPushRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      conditions: [
        {
          kind: 'event_match',
          key: 'type',
          pattern: 'm.room.message',
        },
      ],
      actions: ['notify'],
    },
  });
  assert.equal(customPushRule.status, 200);

  const orderedPushRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule.head?before=com.example.rule', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      conditions: [
        {
          kind: 'event_match',
          key: 'type',
          pattern: 'm.room.message',
        },
      ],
      actions: ['dont_notify'],
    },
  });
  assert.equal(orderedPushRule.status, 200);

  const readCustomPushRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(readCustomPushRule.status, 200);
  assert.deepEqual(await readCustomPushRule.json(), {
    rule_id: 'com.example.rule',
    default: false,
    enabled: true,
    actions: ['notify'],
    conditions: [
      {
        kind: 'event_match',
        key: 'type',
        pattern: 'm.room.message',
      },
    ],
  });

  const orderedPushRules = await rig.gatewayFetch('/_matrix/client/v3/pushrules', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(orderedPushRules.status, 200);
  const orderedPushRulesBody = await orderedPushRules.json();
  assert.deepEqual(orderedPushRulesBody.global.override.slice(0, 4).map((rule) => rule.rule_id), [
    '.m.rule.master',
    'com.example.rule.head',
    'com.example.rule',
    '.m.rule.suppress_notices',
  ]);

  const updateCustomActions = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule.head/actions', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      actions: ['notify', { set_tweak: 'highlight', value: true }],
    },
  });
  assert.equal(updateCustomActions.status, 200);

  const readCustomActions = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule.head/actions', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(readCustomActions.status, 200);
  assert.deepEqual(await readCustomActions.json(), {
    actions: ['notify', { set_tweak: 'highlight', value: true }],
  });

  const disableCustomPushRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule/enabled', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      enabled: false,
    },
  });
  assert.equal(disableCustomPushRule.status, 200);

  const readCustomEnabled = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/com.example.rule/enabled', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(readCustomEnabled.status, 200);
  assert.deepEqual(await readCustomEnabled.json(), { enabled: false });

  const disableDefaultReactionRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/.m.rule.reaction/enabled', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      enabled: false,
    },
  });
  assert.equal(disableDefaultReactionRule.status, 200);

  const readDefaultReactionEnabled = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/.m.rule.reaction/enabled', {
    headers: rig.authHeaders(alice.access_token),
  });
  assert.equal(readDefaultReactionEnabled.status, 200);
  assert.deepEqual(await readDefaultReactionEnabled.json(), { enabled: false });

  const invalidContentPushRule = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/content/com.example.content-rule', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      actions: ['notify'],
    },
  });
  await expectMatrixError(invalidContentPushRule, 400, 'M_INVALID_PARAM');

  const sendToDevice = await rig.gatewayFetch('/_matrix/client/v3/sendToDevice/m.test.phase05/txn-001', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      messages: {
        '@bob:matrix.example.test': {
          BOBPHONE: {
            body: 'first delivery',
          },
        },
      },
    },
  });
  assert.equal(sendToDevice.status, 200);

  const bobSync = await syncRequest(rig, bob.access_token);
  assert.deepEqual(bobSync.to_device.events, [
    {
      sender: '@alice:matrix.example.test',
      type: 'm.test.phase05',
      content: {
        body: 'first delivery',
      },
    },
  ]);

  const retrySameTxn = await rig.gatewayFetch('/_matrix/client/v3/sendToDevice/m.test.phase05/txn-001', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      messages: {
        '@bob:matrix.example.test': {
          BOBPHONE: {
            body: 'first delivery',
          },
        },
      },
    },
  });
  assert.equal(retrySameTxn.status, 200);

  const bobNoDuplicateSync = await syncRequest(rig, bob.access_token, `since=${encodeURIComponent(bobSync.next_batch)}&timeout=0`);
  assert.equal(bobNoDuplicateSync.next_batch, bobSync.next_batch);
  assert.equal((bobNoDuplicateSync.to_device?.events ?? []).length, 0);

  const retryDifferentPayload = await rig.gatewayFetch('/_matrix/client/v3/sendToDevice/m.test.phase05/txn-001', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      messages: {
        '@bob:matrix.example.test': {
          BOBPHONE: {
            body: 'conflicting payload',
          },
        },
      },
    },
  });
  await expectMatrixError(retryDifferentPayload, 409, 'M_CONFLICT');
});

test('Phase 05 push rule action updates enforce storage limits', async (t) => {
  const rig = createGatewayPhase04Rig();
  t.after(() => rig.close());

  const alice = await registerUser(rig, {
    username: 'alice',
    password: 'correct horse battery staple',
    deviceId: 'ALICEPHONE',
  });

  const response = await rig.gatewayFetch('/_matrix/client/v3/pushrules/global/override/.m.rule.reaction/actions', {
    method: 'PUT',
    headers: rig.authHeaders(alice.access_token),
    json: {
      actions: Array.from({ length: 9000 }, () => 'notify'),
    },
  });
  await expectMatrixError(response, 400, 'M_LIMIT_EXCEEDED');
  assert.equal(
    rig.getUserDo('alice').persistence.pushRules.get({ scope: 'global', kind: 'override', rule_id: '.m.rule.reaction' }),
    null,
  );
});
