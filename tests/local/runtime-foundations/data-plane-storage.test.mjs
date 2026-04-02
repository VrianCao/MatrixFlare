import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArchiveObjectKey } from '../../../packages/control-plane/src/index.mjs';
import {
  RemoteServerDO,
  RoomDO,
  UserDO,
  USER_DO_SCHEMA_VERSION,
  ROOM_DO_SCHEMA_VERSION,
  REMOTE_SERVER_DO_SCHEMA_VERSION,
  DERIVED_DATA_SCHEMA_VERSION,
  buildEncryptedBackupSegmentObjectKey,
  buildExportBundleObjectKey,
  buildLocalMediaObjectKey,
  buildRemoteCacheKey,
  buildRemoteMediaObjectKey,
  buildRoomArchiveObjectKey,
  buildThumbnailObjectKey,
  buildWellKnownCacheKey,
  createD1DerivedDataPersistence,
  createRemoteServerDurableObjectPersistence,
  createRoomDurableObjectPersistence,
  createUserDurableObjectPersistence,
  deleteKvKeysByPrefix,
  getRemoteCacheEntry,
  getR2JsonObject,
  getWellKnownCacheEntry,
  normalizeEncryptedBackupSegmentMetadata,
  normalizeExportBundleObjectMetadata,
  normalizeLocalMediaObjectMetadata,
  normalizeRemoteMediaObjectMetadata,
  normalizeRoomArchiveObjectMetadata,
  normalizeThumbnailObjectMetadata,
  putKvJson,
  putR2JsonObject,
  putRemoteCacheEntry,
  putWellKnownCacheEntry,
} from '../../../packages/runtime-core/src/index.mjs';
import { createD1ControlPlanePersistence } from '../../../packages/control-plane/src/index.mjs';
import { markCloudflareKnownLengthStream } from '../../../packages/runtime-core/src/media-domain.mjs';
import { R2_MULTIPART_MIN_PART_BYTES } from '../../../packages/runtime-core/src/media-domain.mjs';
import {
  FakeKvNamespace,
  FakeR2Bucket,
  createFakeD1Database,
  createFakeSqlStorage,
} from './support.mjs';

const TEST_ENV = {
  ENVIRONMENT_NAME: 'local',
  MATRIX_SERVER_NAME: 'matrix.example.test',
  RELEASE_PROFILE: 'L1',
  MATRIX_PUBLIC_BASE_URL: 'https://matrix.example.test',
  MANAGEMENT_API_BASE_URL: 'https://ops.example.test',
  ACCESS_TEAM_DOMAIN: 'matrix.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'aud',
  HOMESERVER_SIGNING_KEY_RING: 'hs',
  SESSION_ROOT_KEY_RING: 'session',
  UIA_ROOT_KEY_RING: 'uia',
  APPSERVICE_TOKEN_SET: 'appservices',
};

test('UserDO persistence lands DATA-USER-001 through DATA-USER-017 and exposes schema version', async () => {
  const storage = createFakeSqlStorage();
  const persistence = createUserDurableObjectPersistence(storage.sql);
  await persistence.ensureSchema('2026-03-30T00:00:00.000Z');
  assert.equal(await persistence.isSchemaReady(), true);

  persistence.setRuntimeIdentity({
    user_id: '@alice:test',
    updated_at: '2026-03-30T00:00:01.000Z',
  });
  assert.equal(persistence.getRuntimeState().schema_version, USER_DO_SCHEMA_VERSION);

  persistence.userPrincipal.put({
    user_id: '@alice:test',
    localpart: 'alice',
    user_type: 'human',
    password_hash_or_null: 'pw-hash',
    password_login_enabled: true,
    created_at: '2026-03-30T00:00:02.000Z',
    deactivated_at_or_null: null,
    erase_requested_flag: false,
    auth_version: 1,
    registration_source: 'password',
    record: { mxid: '@alice:test' },
  });
  persistence.userPrincipal.put({
    user_id: '@alice:test',
    localpart: 'alice',
    user_type: 'human',
    password_hash_or_null: 'pw-hash-2',
    password_login_enabled: true,
    created_at: '2026-03-30T00:00:30.000Z',
    deactivated_at_or_null: null,
    erase_requested_flag: false,
    auth_version: 2,
    registration_source: 'password-reset',
    record: { mxid: '@alice:test', rotated: true },
  });
  persistence.sessions.put({
    session_id: 'sess-1',
    access_token_hash: 'access-hash-1',
    refresh_token_hash: 'refresh-hash-1',
    device_id: 'DEVICE1',
    auth_version: 1,
    session_epoch: 0,
    is_guest: false,
    created_at: '2026-03-30T00:00:03.000Z',
    updated_at: '2026-03-30T00:00:03.000Z',
    expires_at: '2026-04-01T00:00:00.000Z',
    refresh_expires_at: '2026-05-01T00:00:00.000Z',
    revoked_at: null,
    record_json: { ip: '127.0.0.1' },
  });
  persistence.devices.put({
    device_id: 'DEVICE1',
    display_name: 'Alice iPhone',
    created_at: '2026-03-30T00:00:03.000Z',
    updated_at: '2026-03-30T00:00:03.000Z',
    last_seen_at: '2026-03-30T00:00:03.000Z',
    last_seen_ip: '127.0.0.1',
    deleted_at: null,
    record_json: { device_type: 'mobile' },
  });
  persistence.deviceKeys.put({
    device_id: 'DEVICE1',
    key_id: 'ed25519:DEVICE1',
    key_type: 'device_key',
    version: 1,
    updated_at: '2026-03-30T00:00:03.000Z',
    record_json: { key: 'abc' },
  });
  persistence.oneTimeKeys.put({
    device_id: 'DEVICE1',
    algorithm: 'signed_curve25519',
    key_id: 'otk-1',
    published_at: '2026-03-30T00:00:03.000Z',
    claimed_at: null,
    claim_context_json: null,
    record_json: { key: 'otk' },
  });
  persistence.fallbackKeys.put({
    device_id: 'DEVICE1',
    algorithm: 'signed_curve25519',
    key_id: 'fb-1',
    published_at: '2026-03-30T00:00:03.000Z',
    used_at: null,
    record_json: { fallback: true },
  });
  persistence.globalAccountData.put({
    type: 'm.ignored_user_list',
    content_hash: 'content-hash-1',
    updated_at: '2026-03-30T00:00:04.000Z',
    content_json: { ignored_users: {} },
  });
  persistence.roomAccountData.put({
    room_id: '!room:test',
    type: 'm.tag',
    content_hash: 'content-hash-2',
    updated_at: '2026-03-30T00:00:04.000Z',
    content_json: { work: { order: 0.1 } },
  });
  const userStreamEntry = persistence.appendUserStream({
    stream_kind: 'account_data',
    room_id: '!room:test',
    event_id: '$event1',
    dedupe_key: 'stream-1',
    created_at: '2026-03-30T00:00:05.000Z',
    payload: { type: 'm.tag' },
    record: { source: 'test' },
    user_id: '@alice:test',
  });
  const queuedToDevice = persistence.enqueueToDevice({
    target_device_id: 'DEVICE1',
    sender_user_id: '@alice:test',
    event_type: 'm.room_key',
    enqueued_at: '2026-03-30T00:00:06.000Z',
    expires_at: '2026-04-01T00:00:00.000Z',
    payload: { body: 'ciphertext' },
    record: { batch: 'td-1' },
    user_id: '@alice:test',
  });
  persistence.presence.put({
    user_id: '@alice:test',
    presence: 'online',
    status_msg: 'Working',
    currently_active: true,
    last_active_at: '2026-03-30T00:00:06.000Z',
    presence_version: 3,
    updated_at: '2026-03-30T00:00:06.000Z',
    record_json: { source: 'manual' },
  });
  persistence.roomKeyBackupManifests.put({
    backup_version: '1',
    algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
    etag: 'etag-1',
    backup_state: 'ready',
    chunk_count: 1,
    byte_count: 32,
    created_at: '2026-03-30T00:00:07.000Z',
    updated_at: '2026-03-30T00:00:07.000Z',
    auth_data_json: { public_key: 'abc' },
    record_json: { checksum: 'ok' },
  });
  persistence.profileDocument.put({
    key_name: 'displayname',
    profile_version: 2,
    updated_at: '2026-03-30T00:00:08.000Z',
    value_json: 'Alice',
    record_json: { visible: true },
  });
  assert.throws(
    () => persistence.profileDocument.put({
      key_name: 'displayname',
      profile_version: 1,
      updated_at: '2026-03-30T00:00:08.500Z',
      value_json: 'Alice (stale)',
      record_json: { visible: true },
    }),
    /profile_version must not decrease/,
  );
  persistence.pushRules.put({
    scope: 'global',
    kind: 'override',
    rule_id: 'rule.alice.1',
    enabled: true,
    priority_class: 'user',
    priority_index: 0,
    updated_at: '2026-03-30T00:00:09.000Z',
    actions_json: ['notify'],
    conditions_json: [{ kind: 'event_match', key: 'content.body', pattern: 'alice' }],
    record_json: { source: 'custom' },
  });
  persistence.storedFilters.put({
    filter_id: 'filter-1',
    filter_hash: 'filter-hash-1',
    schema_version: 1,
    created_at: '2026-03-30T00:00:10.000Z',
    filter_json: { room: { timeline: { limit: 10 } } },
    record_json: { created_by: 'test' },
  });
  persistence.pendingUploadGrants.put({
    pending_upload_id: 'upload-1',
    media_id: 'media-1',
    content_type: 'image/png',
    max_bytes: 1024,
    state: 'pending',
    granted_at: '2026-03-30T00:00:11.000Z',
    expires_at: '2026-03-30T00:10:11.000Z',
    finalized_at: null,
    record_json: { mime_allowlist: ['image/png'] },
  });
  persistence.toDeviceTxnDedupe.put({
    txn_dedupe_key: 'dedupe-1',
    sender_user_id: '@alice:test',
    event_type: 'm.room_key',
    txn_id: 'txn-1',
    request_fingerprint: 'fingerprint-1',
    terminal_state: 'succeeded',
    created_at: '2026-03-30T00:00:12.000Z',
    updated_at: '2026-03-30T00:00:12.000Z',
    result_json: { delivered: 1 },
    record_json: { request_hash: 'fingerprint-1' },
  });
  assert.throws(
    () => persistence.toDeviceTxnDedupe.put({
      txn_dedupe_key: 'dedupe-2',
      sender_user_id: '@alice:test',
      event_type: 'm.room_key',
      txn_id: 'txn-1',
      request_fingerprint: 'fingerprint-2',
      terminal_state: 'succeeded',
      created_at: '2026-03-30T00:00:12.500Z',
      updated_at: '2026-03-30T00:00:12.500Z',
      result_json: { delivered: 2 },
      record_json: { request_hash: 'fingerprint-2' },
    }),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => persistence.userPrincipal.put({
      user_id: '@alice:test',
      localpart: 'alice',
      user_type: 'human',
      password_hash_or_null: 'pw-hash-3',
      password_login_enabled: true,
      deactivated_at_or_null: null,
      erase_requested_flag: false,
      auth_version: 1,
      registration_source: 'stale-replay',
      record: { mxid: '@alice:test', regressed: true },
    }),
    /auth_version must not decrease/,
  );

  const claimedKey = persistence.claimOneTimeKey({
    device_id: 'DEVICE1',
    algorithm: 'signed_curve25519',
    key_id: 'otk-1',
    claimed_at: '2026-03-30T00:00:13.000Z',
    claim_context: { by: '@bob:test' },
  });

  assert.equal(persistence.sessions.list().length, 1);
  assert.equal(persistence.devices.list().length, 1);
  assert.equal(persistence.deviceKeys.list().length, 1);
  assert.equal(persistence.oneTimeKeys.list()[0].claimed_at, '2026-03-30T00:00:13.000Z');
  assert.equal(persistence.fallbackKeys.list().length, 1);
  assert.equal(persistence.globalAccountData.list().length, 1);
  assert.equal(persistence.roomAccountData.list().length, 1);
  assert.equal(persistence.listUserStreamSince(0).length, 1);
  assert.equal(persistence.listToDeviceForDevice('DEVICE1').length, 1);
  assert.equal(persistence.presence.list().length, 1);
  assert.equal(persistence.roomKeyBackupManifests.list().length, 1);
  assert.equal(persistence.profileDocument.list().length, 1);
  assert.equal(persistence.pushRules.list().length, 1);
  assert.equal(persistence.storedFilters.list().length, 1);
  assert.equal(persistence.pendingUploadGrants.list().length, 1);
  assert.equal(persistence.toDeviceTxnDedupe.list().length, 1);
  assert.equal(persistence.userPrincipal.get().user_id, '@alice:test');
  assert.equal(persistence.userPrincipal.get().created_at, '2026-03-30T00:00:02.000Z');
  assert.equal(persistence.userPrincipal.get().auth_version, 2);
  assert.equal(userStreamEntry.stream_pos, 1);
  assert.equal(queuedToDevice.stream_pos, 2);
  assert.equal(claimedKey.claim_context.by, '@bob:test');
  assert.throws(
    () => persistence.appendUserStream({
      stream_pos: 1,
      stream_kind: 'presence',
      created_at: '2026-03-30T00:00:13.500Z',
      payload: { presence: 'offline' },
      record: { source: 'duplicate' },
      user_id: '@alice:test',
    }),
    /already exists/,
  );

  const userDo = new UserDO({ storage }, TEST_ENV);
  const schemaState = await userDo.ensureSchema();
  assert.equal(schemaState.schema_version, USER_DO_SCHEMA_VERSION);
  storage.close();
});

test('FakeR2 multipart completion rejects out-of-order and duplicate uploaded parts', async () => {
  const bucket = new FakeR2Bucket();
  const multipart = await bucket.createMultipartUpload('phase08/multipart-ordering');
  const first = await multipart.uploadPart(1, Buffer.alloc(R2_MULTIPART_MIN_PART_BYTES, 'a'));
  const second = await multipart.uploadPart(2, Buffer.alloc(R2_MULTIPART_MIN_PART_BYTES, 'b'));

  await assert.rejects(
    multipart.complete([second, first]),
    /strictly increasing and unique/,
  );

  await assert.rejects(
    multipart.complete([first, first]),
    /strictly increasing and unique/,
  );
});

test('RoomDO persistence lands DATA-ROOM-001 through DATA-ROOM-012 with query indices and outbox helpers', async () => {
  const storage = createFakeSqlStorage();
  const persistence = createRoomDurableObjectPersistence(storage.sql);
  await persistence.ensureSchema('2026-03-30T01:00:00.000Z');
  assert.equal(await persistence.isSchemaReady(), true);

  persistence.setRuntimeIdentity({
    room_id: '!room:test',
    room_version: '12',
    updated_at: '2026-03-30T01:00:01.000Z',
  });
  const eventMetadata = persistence.appendEventMetadata({
    event_id: '$event1',
    origin_server_ts: 1000,
    depth: 1,
    archive_object_key_or_segment_id: 'archive/segment/1',
    archive_offset_or_index: 0,
    event_type: 'm.room.message',
    state_key_or_null: null,
    sender_user_id: '@alice:test',
    contains_url_flag: false,
    soft_failed_flag: false,
    waiting_missing_flag: false,
    redacts_event_id_or_null: null,
    membership_target_user_id_or_null: null,
    history_visibility_class: 'shared',
    membership_visibility_class: 'joined',
    relates_to_event_id_or_null: '$root',
    relation_type_or_null: 'm.annotation',
    aggregation_event_type_or_null: 'm.reaction',
    thread_root_event_id_or_null: '$thread-root',
    record: { body: 'hello' },
    room_id: '!room:test',
    room_version: '12',
  });
  persistence.hotEventJson.put({
    event_id: '$event1',
    content_hash: 'event-hash-1',
    stored_at: '2026-03-30T01:00:02.000Z',
    canonical_json: '{"type":"m.room.message"}',
    record_json: { size: 24 },
  });
  persistence.prevEdges.put({
    event_id: '$event1',
    prev_event_id: '$prev1',
    record_json: {},
  });
  persistence.authEdges.put({
    event_id: '$event1',
    auth_event_id: '$auth1',
    record_json: {},
  });
  persistence.stateSnapshots.put({
    snapshot_id: 'snapshot-1',
    snapshot_hash: 'snapshot-hash-1',
    extremity_set_hash: 'ext-hash-1',
    created_at: '2026-03-30T01:00:03.000Z',
    record_json: { extremities: ['$event1'] },
  });
  persistence.stateEntries.put({
    snapshot_id: 'snapshot-1',
    event_type: 'm.room.member',
    state_key: '@alice:test',
    event_id: '$member1',
    sender_user_id: '@alice:test',
    membership: 'join',
    event_room_pos: 1,
    content_json: { membership: 'join' },
    record_json: { profile_version: 2 },
  });
  persistence.membershipProjection.put({
    user_id: '@alice:test',
    membership: 'join',
    event_id: '$member1',
    room_pos: 1,
    displayname: 'Alice',
    avatar_url: 'mxc://matrix.example.test/alice',
    profile_version: 2,
    membership_visibility_class: 'joined',
    updated_at: '2026-03-30T01:00:03.000Z',
    record_json: { source: 'profile-propagation' },
  });
  persistence.forwardExtremities.put({
    event_id: '$event1',
    room_pos: 1,
    updated_at: '2026-03-30T01:00:04.000Z',
    record_json: {},
  });
  persistence.receipts.put({
    receipt_type: 'm.read',
    user_id: '@alice:test',
    thread_id: null,
    event_id: '$event1',
    room_pos: 1,
    receipt_ts: 1001,
    updated_at: '2026-03-30T01:00:04.000Z',
    record_json: { hidden: false },
  });
  persistence.typing.put({
    user_id: '@alice:test',
    typing: true,
    expires_at: '2026-03-30T01:01:00.000Z',
    updated_at: '2026-03-30T01:00:05.000Z',
    record_json: { timeout_ms: 60000 },
  });
  persistence.fanoutOutbox.put({
    room_pos: 1,
    user_id: '@alice:test',
    event_id: '$event1',
    status: 'pending',
    last_attempt_at: null,
    attempt_count: 0,
    acked_stream_pos: null,
    acked_at: null,
    delta_json: { room_id: '!room:test', room_pos: 1 },
    last_error_json: null,
    created_at: '2026-03-30T01:00:06.000Z',
    record_json: { batch: 'fanout-1' },
  });
  persistence.clientTxnDedupe.put({
    txn_dedupe_key: 'txn-room-1',
    user_id: '@alice:test',
    device_id: 'DEVICE1',
    room_id: '!room:test',
    route_template: '/_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}',
    txn_id_or_request_hash: 'txn-1',
    request_fingerprint: 'fingerprint-room-1',
    terminal_state: 'succeeded',
    result_event_id: '$event1',
    error_json: null,
    created_at: '2026-03-30T01:00:07.000Z',
    updated_at: '2026-03-30T01:00:07.000Z',
    record_json: { route_kind: 'timeline' },
  });
  assert.throws(
    () => persistence.clientTxnDedupe.put({
      txn_dedupe_key: 'txn-room-2',
      user_id: '@alice:test',
      device_id: 'DEVICE1',
      room_id: '!room:test',
      route_template: '/_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}',
      txn_id_or_request_hash: 'txn-1',
      request_fingerprint: 'fingerprint-room-2',
      terminal_state: 'conflict',
      result_event_id: null,
      error_json: { errcode: 'M_DUPLICATE_ANNOTATION' },
      created_at: '2026-03-30T01:00:07.500Z',
      updated_at: '2026-03-30T01:00:07.500Z',
      record_json: { route_kind: 'timeline' },
    }),
    /UNIQUE constraint failed/,
  );

  const indexedEvent = persistence.getEventMetadataByRoomPos(1);
  const pendingOutbox = persistence.listPendingFanoutOutbox();
  const ackedOutbox = persistence.acknowledgeFanoutOutbox({
    room_pos: 1,
    user_id: '@alice:test',
    acked_stream_pos: 9,
    acked_at: '2026-03-30T01:00:08.000Z',
  });
  const metadataIndexes = storage.sql.exec(`PRAGMA index_list('room_events_metadata')`);

  assert.equal(persistence.getRuntimeState().schema_version, ROOM_DO_SCHEMA_VERSION);
  assert.equal(eventMetadata.room_pos, 1);
  assert.equal(indexedEvent.event_id, '$event1');
  assert.equal(persistence.hotEventJson.list().length, 1);
  assert.equal(persistence.prevEdges.list().length, 1);
  assert.equal(persistence.authEdges.list().length, 1);
  assert.equal(persistence.stateSnapshots.list().length, 1);
  assert.equal(persistence.stateEntries.list().length, 1);
  assert.equal(persistence.membershipProjection.list().length, 1);
  assert.equal(persistence.forwardExtremities.list().length, 1);
  assert.equal(persistence.receipts.list()[0].thread_id, null);
  assert.equal(persistence.typing.list().length, 1);
  assert.equal(pendingOutbox.length, 1);
  assert.equal(ackedOutbox.status, 'acked');
  assert.equal(persistence.clientTxnDedupe.list().length, 1);
  assert.ok(metadataIndexes.some((index) => index.name === 'idx_room_events_metadata_timestamp_room_pos'));
  assert.ok(metadataIndexes.some((index) => index.name === 'idx_room_events_metadata_room_pos'));
  assert.ok(metadataIndexes.some((index) => index.name === 'idx_room_events_metadata_relations'));
  assert.ok(metadataIndexes.some((index) => index.name === 'idx_room_events_metadata_threads'));
  assert.ok(metadataIndexes.some((index) => index.name === 'idx_room_events_metadata_membership_target'));

  const roomDo = new RoomDO({ storage }, TEST_ENV);
  const schemaState = await roomDo.ensureSchema();
  assert.equal(schemaState.schema_version, ROOM_DO_SCHEMA_VERSION);
  storage.close();
});

test('RemoteServerDO persistence lands DATA-FED-001 through DATA-FED-006 and enforces two-phase finalize ordering', async () => {
  const storage = createFakeSqlStorage();
  const persistence = createRemoteServerDurableObjectPersistence(storage.sql);
  await persistence.ensureSchema('2026-03-30T02:00:00.000Z');
  assert.equal(await persistence.isSchemaReady(), true);

  persistence.setRuntimeIdentity({
    server_name: 'remote.example',
    updated_at: '2026-03-30T02:00:01.000Z',
  });
  const outbound = persistence.enqueueOutboundTransaction({
    txn_id: 'txn-out-1',
    payload_hash: 'payload-hash-1',
    created_at: '2026-03-30T02:00:02.000Z',
    payload: { pdus: ['$event1'], edus: [] },
    record: { source: 'RoomDO' },
    server_name: 'remote.example',
  });
  assert.throws(
    () => persistence.enqueueOutboundTransaction({
      txn_id: 'txn-out-1',
      payload_hash: 'payload-hash-2',
      created_at: '2026-03-30T02:00:02.100Z',
      payload: { pdus: ['$event2'], edus: [] },
      record: { source: 'retry' },
      server_name: 'remote.example',
    }),
    /payload is immutable once queued/,
  );
  persistence.retrySchedule.put({
    txn_id: 'txn-out-1',
    attempt_count: 1,
    next_retry_at: '2026-03-30T02:05:00.000Z',
    last_error_code: 'timeout',
    last_error_at: '2026-03-30T02:01:00.000Z',
    record_json: { jitter_ms: 250 },
  });
  persistence.putInboundTxnMarker({
    origin: 'remote.example',
    txn_id: 'txn-in-1',
    dedupe_request_hash: 'request-hash-1',
    state: 'in_progress',
    first_seen_at: '2026-03-30T02:00:03.000Z',
    finalized_at: null,
    conflict_reason: null,
    record: { pdu_count: 1 },
  });
  persistence.gapRepairBacklog.put({
    repair_job_id: 'repair-1',
    room_id: '!room:test',
    missing_kind: 'prev_events',
    trigger_event_id: '$event1',
    state: 'queued',
    scheduled_at: '2026-03-30T02:00:04.000Z',
    updated_at: '2026-03-30T02:00:04.000Z',
    record_json: { server: 'remote.example' },
  });
  persistence.putCacheEntry({
    cache_kind: 'discovery',
    fetched_at: '2026-03-30T02:00:05.000Z',
    expires_at: '2026-03-30T03:00:05.000Z',
    etag: 'etag-discovery',
    record: { delegate: 'remote.example:443' },
  });
  assert.throws(
    () => persistence.finalizeInboundTxn({
      origin: 'remote.example',
      txn_id: 'txn-missing',
      dedupe_request_hash: 'request-hash-missing',
      canonical_response_text: '{"pdus":{}}',
      canonical_response_bytes_base64: Buffer.from('{"pdus":{}}', 'utf8').toString('base64'),
      pdu_results: {},
      created_at: '2026-03-30T02:00:05.500Z',
    }),
    /must exist before finalization/,
  );
  persistence.putInboundTxnMarker({
    origin: 'remote.example',
    txn_id: 'txn-in-conflict',
    dedupe_request_hash: 'request-hash-original',
    state: 'in_progress',
    first_seen_at: '2026-03-30T02:00:05.250Z',
    finalized_at: null,
    conflict_reason: null,
    record: { phase: 'initial' },
  });
  const conflicted = persistence.markInboundTxnConflict({
    origin: 'remote.example',
    txn_id: 'txn-in-conflict',
    dedupe_request_hash: 'request-hash-conflicting',
    conflict_reason: 'hash_mismatch',
    finalized_at: '2026-03-30T02:00:05.750Z',
    record: { phase: 'conflict' },
  });
  assert.throws(
    () => persistence.putInboundTxnMarker({
      origin: 'remote.example',
      txn_id: 'txn-invalid-state',
      dedupe_request_hash: 'request-hash-invalid',
      state: 'poison',
      first_seen_at: '2026-03-30T02:00:05.500Z',
    }),
    /state must be one of/,
  );
  const finalized = persistence.finalizeInboundTxn({
    origin: 'remote.example',
    txn_id: 'txn-in-1',
    dedupe_request_hash: 'request-hash-1',
    canonical_response_text: '{"pdus":{"$event1":{}}}',
    canonical_response_bytes_base64: Buffer.from('{"pdus":{"$event1":{}}}', 'utf8').toString('base64'),
    pdu_results: { '$event1': {} },
    created_at: '2026-03-30T02:00:06.000Z',
    record: { finalized_by: 'gateway-worker' },
  });
  assert.throws(
    () => persistence.finalizeInboundTxn({
      origin: 'remote.example',
      txn_id: 'txn-in-1',
      dedupe_request_hash: 'request-hash-mismatch',
      canonical_response_text: '{"pdus":{"$event1":{}}}',
      canonical_response_bytes_base64: Buffer.from('{"pdus":{"$event1":{}}}', 'utf8').toString('base64'),
      pdu_results: { '$event1': {} },
      created_at: '2026-03-30T02:00:06.100Z',
    }),
    /dedupe_request_hash mismatch/,
  );
  assert.throws(
    () => persistence.markInboundTxnConflict({
      origin: 'remote.example',
      txn_id: 'txn-in-1',
      dedupe_request_hash: 'request-hash-different',
      conflict_reason: 'hash_mismatch',
      finalized_at: '2026-03-30T02:00:06.200Z',
    }),
    /already finalized/,
  );
  assert.throws(
    () => persistence.putCacheEntry({
      cache_kind: 'server-key',
      fetched_at: '2026-03-30T02:00:05.100Z',
      record: { key: 'missing-id' },
    }),
    /keyId must be present/,
  );

  assert.equal(persistence.getRuntimeState().schema_version, REMOTE_SERVER_DO_SCHEMA_VERSION);
  assert.equal(outbound.txn_sequence, 1);
  assert.equal(persistence.outboundTransactions.list().length, 1);
  assert.equal(persistence.retrySchedule.list().length, 1);
  assert.equal(finalized.marker.state, 'finalized');
  assert.equal(conflicted.state, 'conflict');
  assert.equal(conflicted.dedupe_request_hash, 'request-hash-original');
  assert.equal(conflicted.first_seen_at, '2026-03-30T02:00:05.250Z');
  assert.equal(conflicted.finalized_at, '2026-03-30T02:00:05.750Z');
  assert.equal(persistence.inboundResults.list().length, 1);
  assert.equal(persistence.gapRepairBacklog.list().length, 1);
  assert.equal(persistence.getCacheEntry({ cache_kind: 'discovery' }).etag, 'etag-discovery');

  const remoteDo = new RemoteServerDO({ storage }, TEST_ENV);
  const schemaState = await remoteDo.ensureSchema();
  assert.equal(schemaState.schema_version, REMOTE_SERVER_DO_SCHEMA_VERSION);
  storage.close();
});

test('derived D1 persistence lands DATA-D1-001 through DATA-D1-004 and composes with existing control-plane DATA-D1-005 and DATA-D1-006', async () => {
  const d1 = createFakeD1Database();
  const derived = createD1DerivedDataPersistence(d1);
  const controlPlane = createD1ControlPlanePersistence(d1);
  const appserviceDescriptor = {
    appservice_id: 'as-1',
    url: 'https://appservice.example.test',
    sender_localpart: 'bridgebot',
    hs_token_secret_ref: 'secret://hs-token',
    as_token_secret_ref: 'secret://as-token',
    namespaces: {
      users: [],
      aliases: [],
      rooms: [],
    },
    protocols: ['irc'],
    rate_limited: true,
    receive_ephemeral: false,
    healthcheck_enabled: true,
    disabled_at: null,
    delivery_state: {
      last_success_at: null,
      backlog_depth: 0,
      retry_state: 'idle',
      last_error: null,
    },
  };

  await controlPlane.ensureSchema();
  await derived.ensureSchema('2026-03-30T03:00:00.000Z');

  assert.equal(await controlPlane.isSchemaReady(), true);
  assert.equal(await derived.isSchemaReady(), true);

  await derived.searchIndex.put({
    event_id: '$event1',
    room_id: '!room:test',
    event_type: 'm.room.message',
    origin_server_ts: 1000,
    sender_user_id: '@alice:test',
    search_vector_text: 'hello world',
    visibility_scope: 'local-visible',
    updated_at: '2026-03-30T03:00:01.000Z',
    record_json: { terms: ['hello', 'world'] },
  });
  await derived.userDirectory.put({
    user_id: '@alice:test',
    displayname: 'Alice',
    avatar_url: 'mxc://matrix.example.test/alice',
    profile_version: 2,
    directory_visibility: 'discoverable',
    discovery_flags_json: { searchable: true },
    updated_at: '2026-03-30T03:00:02.000Z',
    record_json: { source: 'profile' },
  });
  await derived.publicRoomDirectory.put({
    room_id: '!room:test',
    canonical_alias: '#test:matrix.example.test',
    name: 'Test Room',
    topic: 'Testing',
    avatar_url: null,
    join_rules: 'public',
    history_visibility: 'world_readable',
    world_readable: true,
    guest_can_join: false,
    joined_members: 5,
    room_serial: 12,
    visibility_watermark: 12,
    is_public: true,
    updated_at: '2026-03-30T03:00:03.000Z',
    record_json: { from_rebuild: false },
  });
  await derived.mediaCatalog.put({
    mxc_uri: 'mxc://matrix.example.test/media1',
    origin_kind: 'local',
    origin_server_name: 'matrix.example.test',
    media_id: 'media1',
    content_type: 'image/png',
    byte_size: 1024,
    content_hash: 'sha256-1',
    legacy_unauth_access_flag: true,
    source_object_key: 'media/local/media1',
    created_at: '2026-03-30T03:00:04.000Z',
    updated_at: '2026-03-30T03:00:04.000Z',
    record_json: { thumbnail_count: 1 },
  });
  await controlPlane.upsertOperatorPolicy({
    principal_id: 'ops-alice',
    principal_type: 'human',
    access_issuer: 'https://matrix.cloudflareaccess.com',
    access_audience: 'aud',
    access_subject_binding: { mode: 'sub' },
    access_subject_value: 'alice-subject',
    allowed_scopes: ['ops.read'],
    target_scope_constraints: { global: true },
    expires_at: null,
    disabled_at: null,
    require_reason: false,
    require_ticket: false,
    created_at: '2026-03-30T03:00:05.000Z',
    updated_at: '2026-03-30T03:00:05.000Z',
  });
  await controlPlane.upsertAppserviceConfig({
    appservice_id: 'as-1',
    descriptor: appserviceDescriptor,
    created_at: '2026-03-30T03:00:06.000Z',
    updated_at: '2026-03-30T03:00:06.000Z',
  });
  await assert.rejects(
    () => derived.publicRoomDirectory.put({
      room_id: '!room-missing:test',
      canonical_alias: null,
      name: 'Incomplete',
      topic: null,
      avatar_url: null,
      join_rules: 'public',
      history_visibility: 'shared',
      world_readable: false,
      guest_can_join: false,
      joined_members: 0,
      room_serial: null,
      visibility_watermark: 99,
      is_public: false,
      updated_at: '2026-03-30T03:00:07.000Z',
      record_json: {},
    }),
    /record\.room_serial must be present/,
  );

  assert.equal((await derived.getSchemaState()).schema_version, DERIVED_DATA_SCHEMA_VERSION);
  assert.equal((await derived.searchIndex.list()).length, 1);
  assert.equal((await derived.userDirectory.list()).length, 1);
  assert.equal((await derived.publicRoomDirectory.list()).length, 1);
  assert.equal((await derived.mediaCatalog.list()).length, 1);
  assert.equal((await controlPlane.getAppserviceConfig('as-1')).descriptor.delivery_state.retry_state, 'idle');
  assert.equal((await controlPlane.listAppserviceConfigs()).length, 1);
  assert.equal((await controlPlane.listActiveOperatorPolicies({
    issuer: 'https://matrix.cloudflareaccess.com',
    audience: 'aud',
    now: '2026-03-30T03:00:06.000Z',
  })).length, 1);
  d1.close();
});

test('derived D1 schema bootstrap avoids exec() so non-local publicRooms does not fail on newline-delimited D1 exec semantics', async () => {
  const d1 = createFakeD1Database();
  let execCalls = 0;
  d1.exec = async () => {
    execCalls += 1;
    throw new Error('D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS derived_schema_state (: incomplete input: SQLITE_ERROR');
  };

  const derived = createD1DerivedDataPersistence(d1);
  await derived.ensureSchema('2026-04-01T15:00:00.000Z');

  assert.equal(execCalls, 0);
  assert.equal(await derived.isSchemaReady(), true);
  const schemaState = await derived.getSchemaState();
  assert.equal(schemaState.schema_version, DERIVED_DATA_SCHEMA_VERSION);
  d1.close();
});

test('control-plane D1 schema bootstrap avoids exec() so non-local publicRooms does not fail on newline-delimited D1 exec semantics', async () => {
  const d1 = createFakeD1Database();
  let execCalls = 0;
  d1.exec = async () => {
    execCalls += 1;
    throw new Error('D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS operator_authz_policies (: incomplete input: SQLITE_ERROR');
  };

  const controlPlane = createD1ControlPlanePersistence(d1);
  await controlPlane.ensureSchema();

  assert.equal(execCalls, 0);
  assert.equal(await controlPlane.isSchemaReady(), true);
  await controlPlane.upsertOperatorPolicy({
    principal_id: 'ops-alice',
    principal_type: 'human',
    access_issuer: 'https://matrix.cloudflareaccess.com',
    access_audience: 'aud',
    access_subject_binding: { mode: 'sub' },
    access_subject_value: 'alice-subject',
    allowed_scopes: ['ops.read'],
    target_scope_constraints: { global: true },
    expires_at: null,
    disabled_at: null,
    require_reason: false,
    require_ticket: false,
    created_at: '2026-04-01T15:00:00.000Z',
    updated_at: '2026-04-01T15:00:00.000Z',
  });
  const activePolicies = await controlPlane.listActiveOperatorPolicies({
    issuer: 'https://matrix.cloudflareaccess.com',
    audience: 'aud',
    now: '2026-04-01T15:00:01.000Z',
  });
  assert.equal(activePolicies.length, 1);
  d1.close();
});

test('FakeR2Bucket fail-closes generic readable streams unless they model Cloudflare known-length bodies', async () => {
  const bucket = new FakeR2Bucket();
  const encoder = new TextEncoder();

  await assert.rejects(
    bucket.put('generic-stream', new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('generic-stream'));
        controller.close();
      },
    })),
    /exact known byte length/u,
  );

  await bucket.put('marked-stream', markCloudflareKnownLengthStream(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('known-length-stream'));
      controller.close();
    },
  }), 'fixed-length-stream', {
    knownByteLength: Buffer.byteLength('known-length-stream'),
  }));

  const stored = await bucket.get('marked-stream');
  assert.ok(stored);
  assert.equal(typeof stored.body?.getReader, 'function');
  assert.equal(await stored.text(), 'known-length-stream');
  assert.equal(
    Buffer.from(await stored.arrayBuffer()).toString('utf8'),
    'known-length-stream',
  );

  await assert.rejects(
    bucket.put('mismatched-stream', markCloudflareKnownLengthStream(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('size-mismatch'));
        controller.close();
      },
    }), 'fixed-length-stream', {
      knownByteLength: Buffer.byteLength('size-mismatch') + 1,
    })),
    /declared 14 bytes but produced 13/u,
  );
});

test('R2 and KV keyspace builders plus wrappers cover DATA-R2-001 through DATA-R2-006 and DATA-KV-001 through DATA-KV-002', async () => {
  const bucket = new FakeR2Bucket();
  const kv = new FakeKvNamespace({ pageSize: 1 });

  const localMediaKey = buildLocalMediaObjectKey('media-1');
  const remoteMediaKey = buildRemoteMediaObjectKey('remote.example', 'media-2');
  const thumbnailKey = buildThumbnailObjectKey({
    sourceKind: 'remote',
    originServerName: 'remote.example',
    mediaId: 'media-2',
    width: 320,
    height: 240,
    method: 'scale',
    animated: false,
  });
  const roomArchiveKey = buildRoomArchiveObjectKey({
    roomId: '!room:test',
    checkpointId: 'checkpoint-1',
    sequence: 7,
    segmentId: 'events-0007.jsonl.gz',
  });
  const exportBundleKey = buildExportBundleObjectKey({
    exportEpochOrImportBatch: 'export-epoch-1',
    artifactKind: 'bundle-manifest',
    scope: { scope_kind: 'global', scope_id: null },
    objectId: 'bundle-1',
  });
  const backupKey = buildEncryptedBackupSegmentObjectKey({
    userId: '@alice:test',
    backupVersion: '1',
    segmentId: 'segment-1',
  });
  const wellKnownKey = buildWellKnownCacheKey({
    kind: 'client',
    host: 'matrix.example.test',
  });
  const remoteCacheKey = buildRemoteCacheKey({
    cacheKind: 'capabilities',
    serverName: 'remote.example',
  });

  const localMetadata = normalizeLocalMediaObjectMetadata({
    first_ingested_at: '2026-03-30T04:00:00.000Z',
    legacy_unauth_access_flag: false,
    content_type: 'image/png',
    byte_size: 1024,
    content_hash: 'sha256-local',
  });
  const remoteMetadata = normalizeRemoteMediaObjectMetadata({
    first_cached_at: '2026-03-30T04:00:01.000Z',
    legacy_unauth_access_flag: true,
    origin_server_name: 'remote.example',
    content_type: 'image/jpeg',
    byte_size: 2048,
    content_hash: 'sha256-remote',
  });
  const thumbMetadata = normalizeThumbnailObjectMetadata({
    source_kind: 'remote',
    source_origin_server_name: 'remote.example',
    source_media_id: 'media-2',
    width: 320,
    height: 240,
    method: 'scale',
    animated: false,
    legacy_unauth_access_flag: true,
    created_at: '2026-03-30T04:00:02.000Z',
  });
  const archiveMetadata = normalizeRoomArchiveObjectMetadata({
    room_id: '!room:test',
    checkpoint_id: 'checkpoint-1',
    sequence: 7,
    segment_kind: 'room-events-metadata-segment',
    content_hash: 'sha256-archive',
    signing_key_version: 'sig-v1',
    export_epoch: null,
  });
  const exportMetadata = normalizeExportBundleObjectMetadata({
    artifact_kind: 'bundle-manifest',
    scope: { scope_kind: 'global', scope_id: null },
    schema_version: 1,
    content_hash: 'sha256-export',
    signing_key_version: 'sig-v1',
    encryption_key_version: 'enc-v1',
    completeness_state: 'complete',
  });
  const backupMetadata = normalizeEncryptedBackupSegmentMetadata({
    user_id: '@alice:test',
    backup_version: '1',
    segment_id: 'segment-1',
    content_hash: 'sha256-backup',
  });

  await putR2JsonObject(bucket, localMediaKey, { hello: 'local' }, { metadata: localMetadata });
  await putR2JsonObject(bucket, remoteMediaKey, { hello: 'remote' }, { metadata: remoteMetadata });
  await putR2JsonObject(bucket, thumbnailKey, { hello: 'thumb' }, { metadata: thumbMetadata });
  await putR2JsonObject(bucket, roomArchiveKey, { hello: 'archive' }, { metadata: archiveMetadata });
  await putR2JsonObject(bucket, exportBundleKey, { hello: 'export' }, { metadata: exportMetadata });
  await putR2JsonObject(bucket, backupKey, { hello: 'backup' }, {
    metadata: backupMetadata,
  });
  await assert.rejects(
    () => putR2JsonObject(bucket, exportBundleKey, { hello: 'tampered' }, { metadata: exportMetadata }),
    /R2 object key conflict/,
  );

  await putKvJson(kv, 'wellknown:raw:test', { value: 1 }, { metadata: { raw: true } });
  await putKvJson(kv, 'wellknown:raw:extra', { value: 2 }, { metadata: { raw: 'extra' } });
  await putWellKnownCacheEntry(kv, {
    kind: 'client',
    host: 'matrix.example.test',
    response_json: { 'm.homeserver': { base_url: 'https://matrix.example.test' } },
    cached_at: '2026-03-30T04:00:03.000Z',
    expires_at: '2026-03-30T05:00:03.000Z',
  });
  await putRemoteCacheEntry(kv, {
    cache_kind: 'capabilities',
    server_name: 'remote.example',
    payload: { version: 'v1.17' },
    cached_at: '2026-03-30T04:00:04.000Z',
    expires_at: '2026-03-30T05:00:04.000Z',
  });

  assert.equal(localMediaKey, 'media/local/media-1');
  assert.equal(remoteMediaKey, 'media/remote/remote.example/media-2');
  assert.equal(thumbnailKey, 'media/thumb/remote/remote.example/media-2/320x240/scale/static');
  assert.equal(roomArchiveKey, 'archive/rooms/!room:test/checkpoint-1/000000000007/events-0007.jsonl.gz');
  assert.equal(exportBundleKey, 'exports/export-epoch-1/bundle-manifest/global/global/bundle-1');
  assert.equal(exportBundleKey, buildArchiveObjectKey({
    exportEpochOrImportBatch: 'export-epoch-1',
    artifactKind: 'bundle-manifest',
    scope: { scope_kind: 'global', scope_id: null },
    objectId: 'bundle-1',
  }));
  assert.equal(backupKey, 'backup/@alice:test/1/segment-1');
  assert.equal(wellKnownKey, 'wellknown:client:matrix.example.test');
  assert.equal(remoteCacheKey, 'remote:capabilities:remote.example');
  assert.throws(
    () => buildRemoteCacheKey({
      cacheKind: 'server-key',
      serverName: 'remote.example',
    }),
    /keyId must be present/,
  );
  assert.deepEqual(await getR2JsonObject(bucket, localMediaKey), { hello: 'local' });
  assert.deepEqual(await getR2JsonObject(bucket, exportBundleKey), { hello: 'export' });
  assert.equal((await bucket.get(localMediaKey)).customMetadata.first_ingested_at, '2026-03-30T04:00:00.000Z');
  assert.equal((await bucket.get(remoteMediaKey)).customMetadata.legacy_unauth_access_flag, 'true');
  assert.equal((await bucket.get(backupKey)).customMetadata.segment_id, 'segment-1');
  assert.equal((await getWellKnownCacheEntry(kv, { kind: 'client', host: 'matrix.example.test' })).response_json['m.homeserver'].base_url, 'https://matrix.example.test');
  assert.equal((await getRemoteCacheEntry(kv, { cacheKind: 'capabilities', serverName: 'remote.example' })).payload.version, 'v1.17');
  assert.equal(await deleteKvKeysByPrefix(kv, 'wellknown:'), 3);
  assert.equal((await kv.list({ prefix: 'wellknown:' })).keys.length, 0);
});
