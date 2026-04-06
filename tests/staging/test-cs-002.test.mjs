import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  findStateEvent,
  getAuthenticated,
  getJoinedRoomEntry,
  joinRoom,
  postAuthenticated,
  putAuthenticated,
  registerUser,
  requireRemoteHarnessContext,
  roomPath,
  syncRequest,
  uploadFilter,
} from './support.mjs';

test('TEST-CS-002 staging covers filter lifecycle plus /sync limited, full_state, use_state_after, include_leave, and lazy-load semantics', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs2-staging-alice',
    password: 'phase08-cs2-staging-password-1',
    deviceId: 'CS2STGALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'cs2-staging-bob',
    password: 'phase08-cs2-staging-password-1',
    deviceId: 'CS2STGBOB',
  });
  const carol = await registerUser(harness, {
    usernamePrefix: 'cs2-staging-carol',
    password: 'phase08-cs2-staging-password-1',
    deviceId: 'CS2STGCAROL',
  });

  const room = await createRoom(harness, alice.access_token, {
    invite: [bob.user_id, carol.user_id],
    name: 'Phase 08 TEST-CS-002 staging room',
  });
  const roomId = room.room_id;
  await joinRoom(harness, bob.access_token, roomId);
  await joinRoom(harness, carol.access_token, roomId);
  const preTokenMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-cinny-pretoken'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging cinny pre-token',
    },
  );
  assert.equal(preTokenMessage.response.status, 200);

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
  const cinnyStoredFilter = await uploadFilter(harness, bob.access_token, bob.user_id, {
    room: {
      state: {
        lazy_load_members: true,
      },
    },
  });
  const cinnyInitialSync = await syncRequest(
    harness,
    bob.access_token,
    `filter=${encodeURIComponent(JSON.stringify(cinnyInlineFilter))}&use_state_after=true`,
  );
  assert.equal(typeof cinnyInitialSync.next_batch, 'string');
  const postTokenMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-cinny-posttoken'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging cinny post-token',
    },
  );
  assert.equal(postTokenMessage.response.status, 200);
  const cinnyStoredSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(cinnyInitialSync.next_batch)}&filter=${encodeURIComponent(cinnyStoredFilter.filter_id)}&use_state_after=true`,
  );
  assert.equal(typeof cinnyStoredSync.next_batch, 'string');
  const cinnyStoredRoom = getJoinedRoomEntry(cinnyStoredSync, roomId);
  assert.ok(cinnyStoredRoom);
  assert.deepEqual(
    cinnyStoredRoom.timeline?.events?.map((event) => event.event_id),
    [postTokenMessage.payload.event_id],
  );
  assert.equal(
    cinnyStoredRoom.timeline?.events?.some((event) => event.event_id === preTokenMessage.payload.event_id),
    false,
  );
  assert.ok(!('state' in cinnyStoredRoom));

  const storedFilter = await uploadFilter(harness, bob.access_token, bob.user_id, {
    account_data: {
      types: ['m.direct', 'm.push_rules'],
    },
    room: {
      include_leave: true,
      timeline: {
        limit: 1,
      },
      state: {
        lazy_load_members: true,
      },
    },
  });
  const storedFilterRetry = await uploadFilter(harness, bob.access_token, bob.user_id, {
    account_data: {
      types: ['m.direct', 'm.push_rules'],
    },
    room: {
      include_leave: true,
      timeline: {
        limit: 1,
      },
      state: {
        lazy_load_members: true,
      },
    },
  });
  assert.deepEqual(storedFilterRetry, storedFilter);

  const fetchedFilter = await getAuthenticated(
    harness,
    bob.access_token,
    `/_matrix/client/v3/user/${encodeURIComponent(bob.user_id)}/filter/${storedFilter.filter_id}`,
  );
  assert.equal(fetchedFilter.response.status, 200);
  assert.deepEqual(fetchedFilter.payload, {
    account_data: {
      types: ['m.direct', 'm.push_rules'],
    },
    room: {
      include_leave: true,
      timeline: {
        limit: 1,
      },
      state: {
        lazy_load_members: true,
      },
    },
  });

  const baselineSync = await syncRequest(
    harness,
    bob.access_token,
    `filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  assert.equal(typeof baselineSync.next_batch, 'string');

  const directAccountData = await putAuthenticated(
    harness,
    bob.access_token,
    `/_matrix/client/v3/user/${encodeURIComponent(bob.user_id)}/account_data/m.direct`,
    {
      [alice.user_id]: [roomId],
    },
  );
  assert.equal(directAccountData.response.status, 200);

  const firstMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-1'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging first',
    },
  );
  assert.equal(firstMessage.response.status, 200);
  const secondMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-2'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging second',
    },
  );
  assert.equal(secondMessage.response.status, 200);

  const limitedSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(baselineSync.next_batch)}&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  assert.deepEqual(limitedSync.account_data?.events, [
    {
      type: 'm.direct',
      content: {
        [alice.user_id]: [roomId],
      },
    },
  ]);
  const limitedRoom = getJoinedRoomEntry(limitedSync, roomId);
  assert.ok(limitedRoom);
  assert.equal(limitedRoom.timeline.events.length, 1);
  assert.equal(limitedRoom.timeline.events[0].event_id, secondMessage.payload.event_id);
  assert.equal(limitedRoom.timeline.limited, true);
  assert.equal(typeof limitedRoom.timeline.prev_batch, 'string');
  const limitedBackfill = await getAuthenticated(
    harness,
    bob.access_token,
    `${roomPath(roomId, '/messages')}?from=${encodeURIComponent(limitedRoom.timeline.prev_batch)}&dir=b&limit=1`,
  );
  assert.equal(limitedBackfill.response.status, 200);
  assert.deepEqual(limitedBackfill.payload?.chunk?.map((event) => event.event_id), [firstMessage.payload.event_id]);

  const setTopic = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/state/m.room.topic'),
    {
      topic: 'phase08 cs2 staging topic',
    },
  );
  assert.equal(setTopic.response.status, 200);
  const stateAfterMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-3'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging sender for lazy-load',
    },
  );
  assert.equal(stateAfterMessage.response.status, 200);

  const useStateAfterSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(limitedSync.next_batch)}&use_state_after=true&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  const useStateAfterRoom = getJoinedRoomEntry(useStateAfterSync, roomId);
  assert.ok(useStateAfterRoom);
  assert.ok(!('state' in useStateAfterRoom));
  assert.ok(Array.isArray(useStateAfterRoom.state_after?.events));
  const stateAfterTopic = findStateEvent(useStateAfterRoom, {
    type: 'm.room.topic',
    stateKey: '',
  });
  assert.ok(stateAfterTopic);
  assert.equal(stateAfterTopic.content.topic, 'phase08 cs2 staging topic');
  const stateAfterAliceMembership = findStateEvent(useStateAfterRoom, {
    type: 'm.room.member',
    stateKey: alice.user_id,
  });
  assert.ok(stateAfterAliceMembership);
  const stateAfterBobMembership = findStateEvent(useStateAfterRoom, {
    type: 'm.room.member',
    stateKey: bob.user_id,
  });
  assert.ok(stateAfterBobMembership);
  const stateAfterCarolMembership = findStateEvent(useStateAfterRoom, {
    type: 'm.room.member',
    stateKey: carol.user_id,
  });
  assert.equal(stateAfterCarolMembership, null);

  const fullStateSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(useStateAfterSync.next_batch)}&full_state=true&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  const fullStateRoom = getJoinedRoomEntry(fullStateSync, roomId);
  assert.ok(fullStateRoom);
  assert.ok(Array.isArray(fullStateRoom.state?.events));
  assert.ok(!('state_after' in fullStateRoom));
  const fullStateTopic = findStateEvent(fullStateRoom, {
    type: 'm.room.topic',
    stateKey: '',
  });
  assert.ok(fullStateTopic);
  const fullStateBobMembership = findStateEvent(fullStateRoom, {
    type: 'm.room.member',
    stateKey: bob.user_id,
  });
  assert.ok(fullStateBobMembership);
  const fullStateCarolMembership = findStateEvent(fullStateRoom, {
    type: 'm.room.member',
    stateKey: carol.user_id,
  });
  assert.equal(fullStateCarolMembership, null);

  const leave = await postAuthenticated(harness, bob.access_token, roomPath(roomId, '/leave'), {});
  assert.equal(leave.response.status, 200);
  const leaveSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(fullStateSync.next_batch)}&filter=${encodeURIComponent(storedFilter.filter_id)}`,
  );
  const leaveRoom = leaveSync.rooms?.leave?.[roomId];
  assert.ok(leaveRoom);
  assert.ok(leaveRoom.timeline.events.some((event) => (
    event.type === 'm.room.member'
    && event.state_key === bob.user_id
    && event.content?.membership === 'leave'
  )));

  assert.notEqual(firstMessage.payload.event_id, secondMessage.payload.event_id);
  assert.notEqual(secondMessage.payload.event_id, stateAfterMessage.payload.event_id);
});

test('TEST-CS-002 staging covers push-rules sync propagation and notification-count truth', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'staging');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'cs2-staging-notify-alice',
    password: 'phase08-cs2-staging-password-2',
    deviceId: 'CS2STGNALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'cs2-staging-notify-bob',
    password: 'phase08-cs2-staging-password-2',
    deviceId: 'CS2STGNBOB',
  });

  const room = await createRoom(harness, alice.access_token, {
    invite: [bob.user_id],
  });
  const roomId = room.room_id;
  await joinRoom(harness, bob.access_token, roomId);

  const baselineSync = await syncRequest(harness, bob.access_token);

  const suppressRule = await putAuthenticated(
    harness,
    bob.access_token,
    '/_matrix/client/v3/pushrules/global/override/com.example.suppress-message',
    {
      conditions: [
        {
          kind: 'event_match',
          key: 'type',
          pattern: 'm.room.message',
        },
      ],
      actions: [],
    },
  );
  assert.equal(suppressRule.response.status, 200);

  const afterSuppressRuleSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(baselineSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterSuppressRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  const suppressedMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-suppressed'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging suppressed message',
    },
  );
  assert.equal(suppressedMessage.response.status, 200);
  const suppressedSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(afterSuppressRuleSync.next_batch)}&timeout=0`,
  );
  const suppressedRoom = getJoinedRoomEntry(suppressedSync, roomId);
  assert.ok(suppressedRoom);
  assert.deepEqual(suppressedRoom.unread_notifications, {
    highlight_count: 0,
    notification_count: 0,
  });

  const highlightRule = await putAuthenticated(
    harness,
    bob.access_token,
    '/_matrix/client/v3/pushrules/global/override/com.example.suppress-message/actions',
    {
      actions: ['notify', { set_tweak: 'highlight', value: true }],
    },
  );
  assert.equal(highlightRule.response.status, 200);

  const afterHighlightRuleSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(suppressedSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterHighlightRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  const highlightedMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-highlighted'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging highlighted message',
    },
  );
  assert.equal(highlightedMessage.response.status, 200);
  const highlightedSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(afterHighlightRuleSync.next_batch)}&timeout=0`,
  );
  const highlightedRoom = getJoinedRoomEntry(highlightedSync, roomId);
  assert.ok(highlightedRoom);
  assert.deepEqual(highlightedRoom.unread_notifications, {
    highlight_count: 1,
    notification_count: 1,
  });

  const disableCustomRule = await putAuthenticated(
    harness,
    bob.access_token,
    '/_matrix/client/v3/pushrules/global/override/com.example.suppress-message/enabled',
    {
      enabled: false,
    },
  );
  assert.equal(disableCustomRule.response.status, 200);

  const afterDisableRuleSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(highlightedSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterDisableRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  const roomMentionMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-room-mention'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging room mention message',
      'm.mentions': {
        room: true,
      },
    },
  );
  assert.equal(roomMentionMessage.response.status, 200);
  const roomMentionSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(afterDisableRuleSync.next_batch)}&timeout=0`,
  );
  const roomMentionRoom = getJoinedRoomEntry(roomMentionSync, roomId);
  assert.ok(roomMentionRoom);
  assert.deepEqual(roomMentionRoom.unread_notifications, {
    highlight_count: 2,
    notification_count: 2,
  });

  const enableMasterRule = await putAuthenticated(
    harness,
    bob.access_token,
    '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
    {
      enabled: true,
    },
  );
  assert.equal(enableMasterRule.response.status, 200);

  const afterMasterRuleSync = await syncRequest(
    harness,
    bob.access_token,
    `since=${encodeURIComponent(roomMentionSync.next_batch)}&timeout=0`,
  );
  assert.ok(afterMasterRuleSync.account_data?.events?.some((event) => event.type === 'm.push_rules'));

  const mutedMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(roomId, '/send/m.room.message/cs2-staging-master-muted'),
    {
      msgtype: 'm.text',
      body: 'phase08 cs2 staging master muted message',
    },
  );
  assert.equal(mutedMessage.response.status, 200);
  const masterSuppressedSync = await syncRequest(
    harness,
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
