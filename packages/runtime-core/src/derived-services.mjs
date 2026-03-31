import { Buffer } from 'node:buffer';

import { createD1DerivedDataPersistence } from './derived-d1-persistence.mjs';
import { assertPlainObject, normalizeInteger, normalizeString } from './persistence-common.mjs';

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function createInvalidQueryParamError(message) {
  return Object.assign(new TypeError(message), {
    code: 'invalid_query_param',
  });
}

function normalizeDerivedLimit(value) {
  try {
    return normalizeInteger(value, 'limit', { min: 1 });
  } catch {
    throw createInvalidQueryParamError('limit must be an integer >= 1');
  }
}

function normalizeDerivedOffset(value, label) {
  try {
    return normalizeInteger(value, label, { min: 0 });
  } catch {
    throw createInvalidQueryParamError(`${label} must be an integer >= 0`);
  }
}

function normalizeSearchRoomIds(roomIds) {
  if (roomIds == null) {
    return null;
  }
  if (!Array.isArray(roomIds)) {
    throw createInvalidQueryParamError('filter.rooms must be an array of room IDs');
  }
  try {
    return new Set(roomIds.map((roomId, index) => normalizeString(roomId, `roomIds[${index}]`)));
  } catch {
    throw createInvalidQueryParamError('filter.rooms entries must be strings');
  }
}

function decodeCursor(value, label = 'cursor') {
  if (value == null || value === '') {
    return null;
  }
  try {
    const decoded = Buffer.from(normalizeString(value, label), 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError(`${label} must decode to an object`);
    }
    return parsed;
  } catch {
    throw createInvalidQueryParamError(`${label} must be a valid pagination token`);
  }
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

export async function applySearchIndexProjectionBatch(env, records) {
  const derived = await ensureDerivedSchema(env);
  await derived.putSearchIndexBatch(records ?? []);
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
    if (roomId == null) {
      await derived.clearAllSearchIndex();
    } else {
      await derived.clearSearchIndexByRoomId(roomId);
    }
  }
  if (normalizedTarget === 'user_directory' || normalizedTarget === 'all_derived') {
    if (userId == null) {
      await derived.clearAllUserDirectory();
    } else {
      await derived.clearUserDirectoryByUserId(userId);
    }
  }
  if (normalizedTarget === 'public_room_directory' || normalizedTarget === 'all_derived') {
    if (roomId == null) {
      await derived.clearAllPublicRoomDirectory();
    } else {
      await derived.clearPublicRoomDirectoryByRoomId(roomId);
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
  ignoredUserIds = null,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedLimit = normalizeDerivedLimit(limit);
  const normalizedSearchTerm = normalizeString(searchTerm ?? '', 'searchTerm');
  const lowered = normalizedSearchTerm.toLowerCase();
  const ignoredUserIdSet = ignoredUserIds == null
    ? null
    : new Set([...ignoredUserIds].map((userId) => normalizeString(userId, 'ignoredUserId')));
  const matchedRows = (await derived.userDirectory.list())
    .filter((row) => row.directory_visibility !== 'hidden')
    .filter((row) => ignoredUserIdSet == null || !ignoredUserIdSet.has(row.user_id))
    .filter((row) => (
      lowered.length === 0
        || row.user_id.toLowerCase().includes(lowered)
        || (row.displayname ?? '').toLowerCase().includes(lowered)
    ))
    .sort((left, right) => (
      (left.displayname ?? left.user_id).localeCompare(right.displayname ?? right.user_id)
      || left.user_id.localeCompare(right.user_id)
    ));
  const results = matchedRows
    .slice(0, normalizedLimit)
    .map((row) => ({
      user_id: row.user_id,
      display_name: row.displayname ?? undefined,
      avatar_url: row.avatar_url ?? undefined,
    }));
  return {
    results,
    limited: matchedRows.length > normalizedLimit,
  };
}

export async function querySearchIndex(env, {
  searchTerm,
  roomIds = null,
  limit = 10,
  nextBatch = null,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedLimit = normalizeDerivedLimit(limit);
  const lowered = normalizeString(searchTerm, 'searchTerm').toLowerCase();
  const cursor = decodeCursor(nextBatch, 'next_batch');
  const offset = cursor?.offset == null ? 0 : normalizeDerivedOffset(cursor.offset, 'next_batch.offset');
  const roomIdSet = normalizeSearchRoomIds(roomIds);
  const rows = (await derived.searchIndex.list())
    .filter((row) => lowered.length === 0 || row.search_vector_text.toLowerCase().includes(lowered))
    .filter((row) => roomIdSet == null || roomIdSet.has(row.room_id))
    .sort((left, right) => right.origin_server_ts - left.origin_server_ts || right.event_id.localeCompare(left.event_id));
  return {
    rows: rows.slice(offset),
    offset,
    limit: normalizedLimit,
  };
}

export async function queryPublicRooms(env, {
  limit = 10,
  since = null,
  searchTerm = null,
} = {}) {
  const derived = await ensureDerivedSchema(env);
  const normalizedLimit = normalizeDerivedLimit(limit);
  const cursor = decodeCursor(since, 'since');
  const offset = cursor?.offset == null ? 0 : normalizeDerivedOffset(cursor.offset, 'since.offset');
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
