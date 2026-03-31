import { Buffer } from 'node:buffer';

import { createD1DerivedDataPersistence } from './derived-d1-persistence.mjs';
import { assertPlainObject, normalizeInteger, normalizeString } from './persistence-common.mjs';

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (value == null || value === '') {
    return null;
  }
  return JSON.parse(Buffer.from(normalizeString(value, 'cursor'), 'base64url').toString('utf8'));
}

export function getDerivedPersistence(env) {
  if (!env?.MATRIX_CONTROL_D1) {
    throw new TypeError('env.MATRIX_CONTROL_D1 must be present');
  }
  if (!env.__DERIVED_PERSISTENCE__) {
    env.__DERIVED_PERSISTENCE__ = createD1DerivedDataPersistence(env.MATRIX_CONTROL_D1);
  }
  return env.__DERIVED_PERSISTENCE__;
}

export async function ensureDerivedSchema(env) {
  const derived = getDerivedPersistence(env);
  await derived.ensureSchema();
  return derived;
}

export async function applySearchIndexProjection(env, record) {
  const derived = await ensureDerivedSchema(env);
  if (!record) {
    return null;
  }
  return derived.searchIndex.put(record);
}

export async function applyUserDirectoryProjection(env, record) {
  const derived = await ensureDerivedSchema(env);
  if (!record) {
    return null;
  }
  return derived.userDirectory.put(record);
}

export async function applyPublicRoomDirectoryProjection(env, record) {
  const derived = await ensureDerivedSchema(env);
  if (!record) {
    return null;
  }
  return derived.publicRoomDirectory.put(record);
}

export async function applyMediaCatalogProjection(env, record) {
  const derived = await ensureDerivedSchema(env);
  if (!record) {
    return null;
  }
  return derived.mediaCatalog.put(record);
}

export async function clearDerivedTarget(env, {
  target,
  roomId = null,
  userId = null,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedTarget = normalizeString(target, 'target');
  if (!['search_index', 'user_directory', 'public_room_directory', 'all_derived'].includes(normalizedTarget)) {
    throw new RangeError('target must be search_index, user_directory, public_room_directory, or all_derived');
  }
  if (normalizedTarget === 'search_index' || normalizedTarget === 'all_derived') {
    for (const row of await derived.searchIndex.list()) {
      if (roomId == null || row.room_id === roomId) {
        await derived.searchIndex.delete({ event_id: row.event_id });
      }
    }
  }
  if (normalizedTarget === 'user_directory' || normalizedTarget === 'all_derived') {
    for (const row of await derived.userDirectory.list()) {
      if (userId == null || row.user_id === userId) {
        await derived.userDirectory.delete({ user_id: row.user_id });
      }
    }
  }
  if (normalizedTarget === 'public_room_directory' || normalizedTarget === 'all_derived') {
    for (const row of await derived.publicRoomDirectory.list()) {
      if (roomId == null || row.room_id === roomId) {
        await derived.publicRoomDirectory.delete({ room_id: row.room_id });
      }
    }
  }
}

export async function lookupRoomAlias(env, alias) {
  const derived = await ensureDerivedSchema(env);
  const normalizedAlias = normalizeString(alias, 'alias');
  const rows = await derived.publicRoomDirectory.list();
  return rows.find((row) => row.canonical_alias === normalizedAlias) ?? null;
}

export async function queryUserDirectory(env, {
  searchTerm,
  limit = 10,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedLimit = normalizeInteger(limit, 'limit', { min: 1 });
  const normalizedSearchTerm = normalizeString(searchTerm ?? '', 'searchTerm');
  const lowered = normalizedSearchTerm.toLowerCase();
  const results = (await derived.userDirectory.list())
    .filter((row) => row.directory_visibility !== 'hidden')
    .filter((row) => (
      lowered.length === 0
        || row.user_id.toLowerCase().includes(lowered)
        || (row.displayname ?? '').toLowerCase().includes(lowered)
    ))
    .sort((left, right) => (
      (left.displayname ?? left.user_id).localeCompare(right.displayname ?? right.user_id)
      || left.user_id.localeCompare(right.user_id)
    ))
    .slice(0, normalizedLimit)
    .map((row) => ({
      user_id: row.user_id,
      display_name: row.displayname ?? undefined,
      avatar_url: row.avatar_url ?? undefined,
    }));
  return {
    results,
    limited: results.length >= normalizedLimit,
  };
}

export async function querySearchIndex(env, {
  searchTerm,
  roomIds = null,
  limit = 10,
  nextBatch = null,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedLimit = normalizeInteger(limit, 'limit', { min: 1 });
  const lowered = normalizeString(searchTerm, 'searchTerm').toLowerCase();
  const cursor = decodeCursor(nextBatch);
  const offset = cursor?.offset == null ? 0 : normalizeInteger(cursor.offset, 'cursor.offset', { min: 0 });
  const roomIdSet = roomIds == null ? null : new Set(roomIds.map((roomId) => normalizeString(roomId, 'roomId')));
  const rows = (await derived.searchIndex.list())
    .filter((row) => lowered.length === 0 || row.search_vector_text.toLowerCase().includes(lowered))
    .filter((row) => roomIdSet == null || roomIdSet.has(row.room_id))
    .sort((left, right) => right.origin_server_ts - left.origin_server_ts || right.event_id.localeCompare(left.event_id));
  const page = rows.slice(offset, offset + normalizedLimit);
  return {
    rows: page,
    next_batch: offset + normalizedLimit < rows.length ? encodeCursor({ offset: offset + normalizedLimit }) : null,
    count: rows.length,
  };
}

export async function queryPublicRooms(env, {
  limit = 10,
  since = null,
  searchTerm = null,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedLimit = normalizeInteger(limit, 'limit', { min: 1 });
  const cursor = decodeCursor(since);
  const offset = cursor?.offset == null ? 0 : normalizeInteger(cursor.offset, 'cursor.offset', { min: 0 });
  const loweredSearchTerm = searchTerm == null ? '' : normalizeString(searchTerm, 'searchTerm').toLowerCase();
  const rows = (await derived.publicRoomDirectory.list())
    .filter((row) => row.is_public === true)
    .filter((row) => loweredSearchTerm.length === 0 || (
      (row.name ?? '').toLowerCase().includes(loweredSearchTerm)
      || (row.topic ?? '').toLowerCase().includes(loweredSearchTerm)
      || (row.canonical_alias ?? '').toLowerCase().includes(loweredSearchTerm)
      || row.room_id.toLowerCase().includes(loweredSearchTerm)
    ))
    .sort((left, right) => right.joined_members - left.joined_members || left.room_id.localeCompare(right.room_id));
  const page = rows.slice(offset, offset + normalizedLimit);
  return {
    chunk: page.map((row) => ({
      room_id: row.room_id,
      name: row.name ?? undefined,
      topic: row.topic ?? undefined,
      canonical_alias: row.canonical_alias ?? undefined,
      avatar_url: row.avatar_url ?? undefined,
      num_joined_members: row.joined_members,
      world_readable: row.world_readable === true,
      guest_can_join: row.guest_can_join === true,
      join_rule: row.join_rules ?? 'invite',
    })),
    next_batch: offset + normalizedLimit < rows.length ? encodeCursor({ offset: offset + normalizedLimit }) : undefined,
    prev_batch: offset > 0 ? encodeCursor({ offset: Math.max(0, offset - normalizedLimit) }) : undefined,
    total_room_count_estimate: rows.length,
  };
}

export function extractPublicRoomsQuery(value) {
  const normalized = value == null ? {} : assertPlainObject(value, 'publicRoomsQuery');
  return {
    limit: normalized.limit == null ? 10 : normalizeInteger(normalized.limit, 'limit', { min: 1 }),
    since: normalized.since == null ? null : normalizeString(normalized.since, 'since'),
    searchTerm: typeof normalized.filter?.generic_search_term === 'string'
      ? normalized.filter.generic_search_term
      : (typeof normalized.search_term === 'string' ? normalized.search_term : null),
  };
}
