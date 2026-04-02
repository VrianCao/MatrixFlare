import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoom,
  eventually,
  expectMatrixError,
  getAuthenticated,
  getJoinedRoomEntry,
  joinRoom,
  makeTxnId,
  putAuthenticated,
  registerUser,
  requireRemoteHarnessContext,
  roomPath,
  syncRequest,
} from './support.mjs';

test('TEST-ROOM-001 ci-integration covers room creation, membership, send, redaction, receipts, and typing', async (context) => {
  const harness = requireRemoteHarnessContext(context, 'ci-integration');
  if (harness == null) {
    return;
  }

  const alice = await registerUser(harness, {
    usernamePrefix: 'room1-ci-alice',
    deviceId: 'ROOM1CIALICE',
  });
  const bob = await registerUser(harness, {
    usernamePrefix: 'room1-ci-bob',
    deviceId: 'ROOM1CIBOB',
  });

  const createdRoom = await createRoom(harness, alice.access_token, {
    invite: [bob.user_id],
    name: 'Phase 08 Room 001 CI',
  });
  await joinRoom(harness, bob.access_token, createdRoom.room_id);

  const messageTxnId = makeTxnId('room1-ci-send');
  const firstMessage = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, `/send/m.room.message/${messageTxnId}`),
    {
      msgtype: 'm.text',
      body: 'room one integration message',
    },
  );
  assert.equal(firstMessage.response.status, 200);
  assert.equal(typeof firstMessage.payload?.event_id, 'string');

  const firstMessageRetry = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, `/send/m.room.message/${messageTxnId}`),
    {
      msgtype: 'm.text',
      body: 'room one integration message',
    },
  );
  assert.equal(firstMessageRetry.response.status, 200);
  assert.equal(firstMessageRetry.payload?.event_id, firstMessage.payload.event_id);

  const conflictingRetry = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, `/send/m.room.message/${messageTxnId}`),
    {
      msgtype: 'm.text',
      body: 'room one integration conflict',
    },
  );
  await expectMatrixError(conflictingRetry, 409, 'M_CONFLICT');

  const topicWrite = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, '/state/m.room.topic'),
    {
      topic: 'Phase 08 Integration Topic',
    },
  );
  assert.equal(topicWrite.response.status, 200);

  const topicRead = await getAuthenticated(harness, alice.access_token, roomPath(createdRoom.room_id, '/state/m.room.topic'));
  assert.equal(topicRead.response.status, 200);
  assert.deepEqual(topicRead.payload, {
    topic: 'Phase 08 Integration Topic',
  });

  const aliceBaselineSync = await syncRequest(harness, alice.access_token);

  const typing = await putAuthenticated(
    harness,
    bob.access_token,
    roomPath(createdRoom.room_id, `/typing/${encodeURIComponent(bob.user_id)}`),
    {
      typing: true,
      timeout: 30_000,
    },
  );
  assert.equal(typing.response.status, 200);

  const receipt = await putAuthenticated(
    harness,
    bob.access_token,
    roomPath(createdRoom.room_id, `/receipt/m.read/${encodeURIComponent(firstMessage.payload.event_id)}`),
    {
      ts: 123,
    },
  );
  assert.equal(receipt.response.status, 200);

  const aliceEphemeralSync = await eventually(async () => {
    const nextSync = await syncRequest(
      harness,
      alice.access_token,
      `since=${encodeURIComponent(aliceBaselineSync.next_batch)}&timeout=0`,
    );
    const roomEntry = getJoinedRoomEntry(nextSync, createdRoom.room_id);
    assert.ok(roomEntry);
    const ephemeralEvents = roomEntry.ephemeral?.events ?? [];
    const typingEvent = ephemeralEvents.find((event) => event.type === 'm.typing');
    const receiptEvent = ephemeralEvents.find((event) => event.type === 'm.receipt');
    const receiptContent = receiptEvent?.content?.[firstMessage.payload.event_id];
    const readReceipts = receiptContent?.['m.read'];
    const bobReceipt = readReceipts?.[bob.user_id];
    assert.deepEqual(typingEvent?.content?.user_ids, [bob.user_id]);
    assert.equal(bobReceipt?.ts, 123);
    return nextSync;
  });
  assert.notEqual(aliceEphemeralSync.next_batch, aliceBaselineSync.next_batch);

  const messages = await getAuthenticated(
    harness,
    alice.access_token,
    `${roomPath(createdRoom.room_id, '/messages')}?dir=b&limit=10`,
  );
  assert.equal(messages.response.status, 200);
  assert.ok(messages.payload?.chunk?.some((event) => event.event_id === firstMessage.payload.event_id));

  const eventBeforeRedaction = await getAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, `/event/${encodeURIComponent(firstMessage.payload.event_id)}`),
  );
  assert.equal(eventBeforeRedaction.response.status, 200);
  assert.equal(eventBeforeRedaction.payload?.content?.body, 'room one integration message');

  const redact = await putAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, `/redact/${encodeURIComponent(firstMessage.payload.event_id)}/${makeTxnId('room1-ci-redact')}`),
    {
      reason: 'cleanup',
    },
  );
  assert.equal(redact.response.status, 200);

  const eventAfterRedaction = await getAuthenticated(
    harness,
    alice.access_token,
    roomPath(createdRoom.room_id, `/event/${encodeURIComponent(firstMessage.payload.event_id)}`),
  );
  assert.equal(eventAfterRedaction.response.status, 200);
  assert.deepEqual(eventAfterRedaction.payload?.content, {});
});
