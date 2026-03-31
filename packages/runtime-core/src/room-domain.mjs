import { canonicalJsonHash } from './fingerprints.mjs';
import { normalizeInteger, normalizeString } from './persistence-common.mjs';

export const DEFAULT_ROOM_VERSION = '12';
export const SUPPORTED_ROOM_VERSIONS = Object.freeze(['11', '12']);

function cloneJson(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeRoomVersion(value) {
  return normalizeString(value, 'roomVersion');
}

export function isSupportedRoomVersion(value) {
  if (value == null) {
    return false;
  }
  return SUPPORTED_ROOM_VERSIONS.includes(normalizeRoomVersion(value));
}

export function resolveRequestedRoomVersion(value) {
  if (value == null || value === '') {
    return DEFAULT_ROOM_VERSION;
  }
  const normalized = normalizeRoomVersion(value);
  if (!SUPPORTED_ROOM_VERSIONS.includes(normalized)) {
    throw new RangeError(`Unsupported room version: ${normalized}`);
  }
  return normalized;
}

export function buildRoomStateTupleKey(eventType, stateKey = '') {
  return `${normalizeString(eventType, 'eventType')}\u0000${typeof stateKey === 'string' ? stateKey : ''}`;
}

export function deriveDeterministicEventId(seed) {
  return `$${canonicalJsonHash(seed)}`;
}

export function deriveCreateRoomIdentity({
  creator_user_id,
  room_version,
  request_fingerprint,
  server_name,
}) {
  const resolvedRoomVersion = resolveRequestedRoomVersion(room_version);
  const createEventId = deriveDeterministicEventId({
    kind: 'create_room',
    creator_user_id: normalizeString(creator_user_id, 'creator_user_id'),
    room_version: resolvedRoomVersion,
    request_fingerprint: normalizeString(request_fingerprint, 'request_fingerprint'),
    server_name: normalizeString(server_name, 'server_name'),
  });
  if (resolvedRoomVersion === '12') {
    return {
      room_version: resolvedRoomVersion,
      create_event_id: createEventId,
      room_id: `!${createEventId.slice(1)}`,
    };
  }
  return {
    room_version: resolvedRoomVersion,
    create_event_id: createEventId,
    room_id: `!${canonicalJsonHash({
      kind: 'room_id',
      creator_user_id: creator_user_id,
      room_version: resolvedRoomVersion,
      request_fingerprint,
      server_name,
    })}:${normalizeString(server_name, 'server_name')}`,
  };
}

export function encodeRoomCursor(roomPos) {
  return `rp:${normalizeInteger(roomPos, 'roomPos', { min: 0 })}`;
}

export function decodeRoomCursor(cursor, { allowNull = true } = {}) {
  if (cursor == null || cursor === '') {
    if (allowNull) {
      return null;
    }
    throw new TypeError('cursor must be present');
  }
  const normalized = normalizeString(cursor, 'cursor');
  const match = /^rp:(\d+)$/.exec(normalized);
  if (!match) {
    throw new TypeError('cursor must use rp:<room_pos> format');
  }
  return normalizeInteger(Number.parseInt(match[1], 10), 'cursor.room_pos', { min: 0 });
}

const REDACTION_TOP_LEVEL_PRESERVE = Object.freeze([
  'event_id',
  'type',
  'room_id',
  'sender',
  'state_key',
  'origin_server_ts',
  'unsigned',
  'prev_events',
  'auth_events',
  'depth',
  'hashes',
  'signatures',
  'redacts',
  'content',
]);

function getV11RedactedContent(event) {
  const content = event?.content && typeof event.content === 'object' && !Array.isArray(event.content)
    ? cloneJson(event.content)
    : {};
  if (event?.type === 'm.room.create') {
    return content;
  }
  if (event?.type === 'm.room.redaction') {
    return content.redacts == null ? {} : { redacts: content.redacts };
  }
  if (event?.type === 'm.room.power_levels') {
    return content.invite == null ? {} : { invite: content.invite };
  }
  if (event?.type === 'm.room.member') {
    const signed = content.third_party_invite?.signed;
    return signed == null ? {} : { third_party_invite: { signed: cloneJson(signed) } };
  }
  return {};
}

function getV12RedactedContent(event) {
  const content = event?.content && typeof event.content === 'object' && !Array.isArray(event.content)
    ? cloneJson(event.content)
    : {};
  if (event?.type === 'm.room.create') {
    return content;
  }
  return {};
}

export function redactEventForRoomVersion(roomVersion, event, redactedBy = null) {
  const resolvedRoomVersion = resolveRequestedRoomVersion(roomVersion);
  const source = event && typeof event === 'object' && !Array.isArray(event)
    ? cloneJson(event)
    : {};
  const redacted = {};
  for (const fieldName of REDACTION_TOP_LEVEL_PRESERVE) {
    if (!(fieldName in source)) {
      continue;
    }
    if (fieldName === 'content') {
      continue;
    }
    if (resolvedRoomVersion === '11' && ['origin', 'membership', 'prev_state'].includes(fieldName)) {
      continue;
    }
    redacted[fieldName] = cloneJson(source[fieldName]);
  }
  redacted.content = resolvedRoomVersion === '11'
    ? getV11RedactedContent(source)
    : getV12RedactedContent(source);
  redacted.unsigned = {
    ...(source.unsigned && typeof source.unsigned === 'object' && !Array.isArray(source.unsigned)
      ? cloneJson(source.unsigned)
      : {}),
    redacted_because: redactedBy == null ? null : cloneJson(redactedBy),
  };
  return redacted;
}
