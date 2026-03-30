import {
  assertPlainObject,
  normalizeBoolean,
  normalizeInteger,
  normalizeString,
} from './persistence-common.mjs';

export const MEDIA_THUMBNAIL_METHODS = Object.freeze(['crop', 'scale']);
export const WELL_KNOWN_CACHE_KINDS = Object.freeze(['client', 'server']);
export const REMOTE_CACHE_KINDS = Object.freeze(['discovery', 'capabilities', 'version', 'server-key']);
export const EXPORT_BUNDLE_ARTIFACT_KINDS = Object.freeze([
  'bundle-manifest',
  'shard-manifest',
  'registry-snapshot',
  'checkpoint-manifest',
  'checkpoint-object',
]);
export const EXPORT_COMPLETENESS_STATES = Object.freeze(['pending', 'complete', 'partial', 'incomplete']);

function normalizeTargetScope(scope) {
  const normalized = assertPlainObject(scope, 'scope');
  const scopeKind = normalizeString(normalized.scope_kind, 'scope.scope_kind');
  if (!['global', 'room_id', 'user_id', 'server_name', 'appservice_id'].includes(scopeKind)) {
    throw new RangeError('scope.scope_kind must be one of global, room_id, user_id, server_name, appservice_id');
  }
  const scopeId = normalized.scope_id == null ? null : normalizeString(normalized.scope_id, 'scope.scope_id');
  if (scopeKind === 'global' && scopeId !== null) {
    throw new RangeError('scope.scope_id must be null when scope.scope_kind is global');
  }
  if (scopeKind !== 'global' && scopeId == null) {
    throw new RangeError('scope.scope_id must be non-null when scope.scope_kind is not global');
  }
  return Object.freeze({
    scope_kind: scopeKind,
    scope_id: scopeId,
  });
}

function assertR2Bucket(bucket) {
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
    throw new TypeError('bucket must expose R2-compatible put() and get() methods');
  }
  return bucket;
}

function assertKvNamespace(namespace) {
  if (!namespace || typeof namespace.put !== 'function' || typeof namespace.get !== 'function') {
    throw new TypeError('namespace must expose KV-compatible put() and get() methods');
  }
  return namespace;
}

function stringifyCustomMetadata(metadata) {
  if (!metadata) {
    return undefined;
  }
  const normalized = assertPlainObject(metadata, 'metadata');
  const result = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value == null) {
      continue;
    }
    if (typeof value === 'boolean') {
      result[key] = value ? 'true' : 'false';
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function measureBodyBytes(body) {
  if (typeof body === 'string') {
    return Buffer.byteLength(body, 'utf8');
  }
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return body.byteLength;
  }
  return Buffer.byteLength(String(body), 'utf8');
}

function toBodyBuffer(body) {
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body), 'utf8');
}

async function readR2ObjectBytes(object) {
  if (!object) {
    return null;
  }
  if (typeof object.arrayBuffer === 'function') {
    return Buffer.from(await object.arrayBuffer());
  }
  if (typeof object.text === 'function') {
    return Buffer.from(await object.text(), 'utf8');
  }
  if (typeof object.body === 'string') {
    return Buffer.from(object.body, 'utf8');
  }
  if (object.body instanceof Uint8Array || Buffer.isBuffer(object.body)) {
    return Buffer.from(object.body);
  }
  return null;
}

export function buildLocalMediaObjectKey(mediaId) {
  return `media/local/${normalizeString(mediaId, 'mediaId')}`;
}

export function buildRemoteMediaObjectKey(originServerName, mediaId) {
  return `media/remote/${normalizeString(originServerName, 'originServerName')}/${normalizeString(mediaId, 'mediaId')}`;
}

export function buildThumbnailObjectKey({
  sourceKind,
  mediaId,
  width,
  height,
  method,
  animated = false,
  originServerName = null,
}) {
  const normalizedSourceKind = normalizeString(sourceKind, 'sourceKind');
  if (!['local', 'remote'].includes(normalizedSourceKind)) {
    throw new RangeError('sourceKind must be local or remote');
  }
  const sourceIdentity = normalizedSourceKind === 'local'
    ? 'self'
    : normalizeString(originServerName, 'originServerName');
  const normalizedMethod = normalizeString(method, 'method');
  if (!MEDIA_THUMBNAIL_METHODS.includes(normalizedMethod)) {
    throw new RangeError(`method must be one of ${MEDIA_THUMBNAIL_METHODS.join(', ')}`);
  }
  return `media/thumb/${normalizedSourceKind}/${sourceIdentity}/${normalizeString(mediaId, 'mediaId')}/${normalizeInteger(width, 'width', { min: 1 })}x${normalizeInteger(height, 'height', { min: 1 })}/${normalizedMethod}/${normalizeBoolean(animated, 'animated') ? 'animated' : 'static'}`;
}

export function buildRoomArchiveObjectKey({
  roomId,
  checkpointId,
  sequence,
  segmentId,
}) {
  return `archive/rooms/${normalizeString(roomId, 'roomId')}/${normalizeString(checkpointId, 'checkpointId')}/${String(normalizeInteger(sequence, 'sequence', { min: 0 })).padStart(12, '0')}/${normalizeString(segmentId, 'segmentId')}`;
}

export function buildExportBundleObjectKey({
  exportEpochOrImportBatch,
  artifactKind,
  scope,
  objectId,
}) {
  const normalizedScope = normalizeTargetScope(scope);
  const normalizedArtifactKind = normalizeString(artifactKind, 'artifactKind');
  if (!EXPORT_BUNDLE_ARTIFACT_KINDS.includes(normalizedArtifactKind)) {
    throw new RangeError(`artifactKind must be one of ${EXPORT_BUNDLE_ARTIFACT_KINDS.join(', ')}`);
  }
  const scopeIdOrGlobal = normalizedScope.scope_kind === 'global' ? 'global' : normalizedScope.scope_id;
  return `exports/${normalizeString(exportEpochOrImportBatch, 'exportEpochOrImportBatch')}/${normalizedArtifactKind}/${normalizedScope.scope_kind}/${scopeIdOrGlobal}/${normalizeString(objectId, 'objectId')}`;
}

export function buildEncryptedBackupSegmentObjectKey({
  userId,
  backupVersion,
  segmentId,
}) {
  return `backup/${normalizeString(userId, 'userId')}/${normalizeString(backupVersion, 'backupVersion')}/${normalizeString(segmentId, 'segmentId')}`;
}

export function buildWellKnownCacheKey({ kind, host }) {
  const normalizedKind = normalizeString(kind, 'kind');
  if (!WELL_KNOWN_CACHE_KINDS.includes(normalizedKind)) {
    throw new RangeError(`kind must be one of ${WELL_KNOWN_CACHE_KINDS.join(', ')}`);
  }
  return `wellknown:${normalizedKind}:${normalizeString(host, 'host')}`;
}

export function buildRemoteCacheKey({
  cacheKind,
  serverName,
  keyId = null,
}) {
  const normalizedCacheKind = normalizeString(cacheKind, 'cacheKind');
  if (!REMOTE_CACHE_KINDS.includes(normalizedCacheKind)) {
    throw new RangeError(`cacheKind must be one of ${REMOTE_CACHE_KINDS.join(', ')}`);
  }
  const normalizedKeyId = keyId == null ? null : normalizeString(keyId, 'keyId');
  if (normalizedCacheKind === 'server-key' && normalizedKeyId == null) {
    throw new TypeError('keyId must be present when cacheKind is server-key');
  }
  const suffix = normalizedKeyId == null ? '' : `:${normalizedKeyId}`;
  return `remote:${normalizedCacheKind}:${normalizeString(serverName, 'serverName')}${suffix}`;
}

export function normalizeLocalMediaObjectMetadata(value) {
  const normalized = assertPlainObject(value, 'LocalMediaObjectMetadata');
  return Object.freeze({
    first_ingested_at: normalizeString(normalized.first_ingested_at, 'first_ingested_at'),
    legacy_unauth_access_flag: normalizeBoolean(normalized.legacy_unauth_access_flag, 'legacy_unauth_access_flag'),
    content_type: normalized.content_type == null ? null : normalizeString(normalized.content_type, 'content_type'),
    byte_size: normalized.byte_size == null ? null : normalizeInteger(normalized.byte_size, 'byte_size', { min: 0 }),
    content_hash: normalized.content_hash == null ? null : normalizeString(normalized.content_hash, 'content_hash'),
  });
}

export function normalizeRemoteMediaObjectMetadata(value) {
  const normalized = assertPlainObject(value, 'RemoteMediaObjectMetadata');
  return Object.freeze({
    first_cached_at: normalizeString(normalized.first_cached_at, 'first_cached_at'),
    legacy_unauth_access_flag: normalizeBoolean(normalized.legacy_unauth_access_flag, 'legacy_unauth_access_flag'),
    origin_server_name: normalizeString(normalized.origin_server_name, 'origin_server_name'),
    content_type: normalized.content_type == null ? null : normalizeString(normalized.content_type, 'content_type'),
    byte_size: normalized.byte_size == null ? null : normalizeInteger(normalized.byte_size, 'byte_size', { min: 0 }),
    content_hash: normalized.content_hash == null ? null : normalizeString(normalized.content_hash, 'content_hash'),
  });
}

export function normalizeThumbnailObjectMetadata(value) {
  const normalized = assertPlainObject(value, 'ThumbnailObjectMetadata');
  const method = normalizeString(normalized.method, 'method');
  if (!MEDIA_THUMBNAIL_METHODS.includes(method)) {
    throw new RangeError(`method must be one of ${MEDIA_THUMBNAIL_METHODS.join(', ')}`);
  }
  return Object.freeze({
    source_kind: normalizeString(normalized.source_kind, 'source_kind'),
    source_origin_server_name: normalized.source_origin_server_name == null
      ? null
      : normalizeString(normalized.source_origin_server_name, 'source_origin_server_name'),
    source_media_id: normalizeString(normalized.source_media_id, 'source_media_id'),
    width: normalizeInteger(normalized.width, 'width', { min: 1 }),
    height: normalizeInteger(normalized.height, 'height', { min: 1 }),
    method,
    animated: normalizeBoolean(normalized.animated, 'animated'),
    legacy_unauth_access_flag: normalizeBoolean(normalized.legacy_unauth_access_flag, 'legacy_unauth_access_flag'),
    created_at: normalizeString(normalized.created_at, 'created_at'),
  });
}

export function normalizeRoomArchiveObjectMetadata(value) {
  const normalized = assertPlainObject(value, 'RoomArchiveObjectMetadata');
  return Object.freeze({
    room_id: normalizeString(normalized.room_id, 'room_id'),
    checkpoint_id: normalizeString(normalized.checkpoint_id, 'checkpoint_id'),
    sequence: normalizeInteger(normalized.sequence, 'sequence', { min: 0 }),
    segment_kind: normalizeString(normalized.segment_kind, 'segment_kind'),
    content_hash: normalizeString(normalized.content_hash, 'content_hash'),
    signing_key_version: normalizeString(normalized.signing_key_version, 'signing_key_version'),
    export_epoch: normalized.export_epoch == null ? null : normalizeString(normalized.export_epoch, 'export_epoch'),
  });
}

export function normalizeExportBundleObjectMetadata(value) {
  const normalized = assertPlainObject(value, 'ExportBundleObjectMetadata');
  const artifactKind = normalizeString(normalized.artifact_kind, 'artifact_kind');
  if (!EXPORT_BUNDLE_ARTIFACT_KINDS.includes(artifactKind)) {
    throw new RangeError(`artifact_kind must be one of ${EXPORT_BUNDLE_ARTIFACT_KINDS.join(', ')}`);
  }
  const completenessState = normalizeString(normalized.completeness_state, 'completeness_state');
  if (!EXPORT_COMPLETENESS_STATES.includes(completenessState)) {
    throw new RangeError(`completeness_state must be one of ${EXPORT_COMPLETENESS_STATES.join(', ')}`);
  }
  return Object.freeze({
    artifact_kind: artifactKind,
    scope: normalizeTargetScope(normalized.scope),
    schema_version: normalizeInteger(normalized.schema_version ?? 1, 'schema_version', { min: 1 }),
    content_hash: normalizeString(normalized.content_hash, 'content_hash'),
    signing_key_version: normalized.signing_key_version == null ? null : normalizeString(normalized.signing_key_version, 'signing_key_version'),
    encryption_key_version: normalized.encryption_key_version == null ? null : normalizeString(normalized.encryption_key_version, 'encryption_key_version'),
    completeness_state: completenessState,
  });
}

export function normalizeEncryptedBackupSegmentMetadata(value) {
  const normalized = assertPlainObject(value, 'EncryptedBackupSegmentMetadata');
  return Object.freeze({
    user_id: normalizeString(normalized.user_id, 'user_id'),
    backup_version: normalizeString(normalized.backup_version, 'backup_version'),
    segment_id: normalizeString(normalized.segment_id, 'segment_id'),
    content_hash: normalizeString(normalized.content_hash, 'content_hash'),
  });
}

export async function putR2Object(bucket, key, body, {
  metadata = null,
  httpMetadata = null,
} = {}) {
  const r2 = assertR2Bucket(bucket);
  const normalizedKey = normalizeString(key, 'key');
  const normalizedBody = typeof body === 'string' || body instanceof Uint8Array || Buffer.isBuffer(body)
    ? body
    : String(body);
  const existingObject = await r2.get(normalizedKey);
  if (existingObject) {
    const existingBytes = await readR2ObjectBytes(existingObject);
    const nextBytes = toBodyBuffer(normalizedBody);
    if (!existingBytes || !existingBytes.equals(nextBytes)) {
      throw new Error(`R2 object key conflict for ${normalizedKey}`);
    }
    return {
      key: normalizedKey,
      byte_size: nextBytes.byteLength,
    };
  }
  await r2.put(normalizedKey, normalizedBody, {
    customMetadata: stringifyCustomMetadata(metadata),
    httpMetadata: httpMetadata ?? undefined,
  });
  return {
    key: normalizedKey,
    byte_size: measureBodyBytes(normalizedBody),
  };
}

export async function putR2JsonObject(bucket, key, value, options = {}) {
  return putR2Object(bucket, key, JSON.stringify(value), {
    ...options,
    httpMetadata: options.httpMetadata ?? {
      contentType: 'application/json; charset=utf-8',
    },
  });
}

export async function getR2TextObject(bucket, key) {
  const r2 = assertR2Bucket(bucket);
  const object = await r2.get(normalizeString(key, 'key'));
  if (!object) {
    return null;
  }
  if (typeof object.text === 'function') {
    return object.text();
  }
  if (typeof object.body === 'string') {
    return object.body;
  }
  if (object.body instanceof Uint8Array || Buffer.isBuffer(object.body)) {
    return Buffer.from(object.body).toString('utf8');
  }
  return null;
}

export async function getR2JsonObject(bucket, key) {
  const rawText = await getR2TextObject(bucket, key);
  if (rawText == null) {
    return null;
  }
  return JSON.parse(rawText);
}

export async function putKvJson(namespace, key, value, {
  metadata = null,
  expirationTtl = null,
} = {}) {
  const kv = assertKvNamespace(namespace);
  const options = {};
  if (metadata != null) {
    options.metadata = metadata;
  }
  if (expirationTtl != null) {
    options.expirationTtl = expirationTtl;
  }
  await kv.put(normalizeString(key, 'key'), JSON.stringify(value), options);
}

export async function getKvJson(namespace, key) {
  const kv = assertKvNamespace(namespace);
  const normalizedKey = normalizeString(key, 'key');
  if (typeof kv.getWithMetadata === 'function') {
    const result = await kv.getWithMetadata(normalizedKey, 'text');
    if (!result || result.value == null) {
      return null;
    }
    return {
      value: JSON.parse(result.value),
      metadata: result.metadata ?? null,
    };
  }
  const rawText = await kv.get(normalizedKey);
  if (rawText == null) {
    return null;
  }
  return {
    value: JSON.parse(rawText),
    metadata: null,
  };
}

export async function deleteKvKeysByPrefix(namespace, prefix) {
  const kv = assertKvNamespace(namespace);
  if (typeof kv.list !== 'function' || typeof kv.delete !== 'function') {
    throw new TypeError('namespace must expose list() and delete() to delete by prefix');
  }
  const normalizedPrefix = normalizeString(prefix, 'prefix');
  let deletedCount = 0;
  let cursor = null;
  while (true) {
    const listed = await kv.list(cursor == null
      ? { prefix: normalizedPrefix }
      : { prefix: normalizedPrefix, cursor });
    const keys = listed?.keys ?? [];
    for (const key of keys) {
      await kv.delete(key.name);
      deletedCount += 1;
    }
    if (listed?.list_complete !== false || listed?.cursor == null) {
      return deletedCount;
    }
    cursor = listed.cursor;
  }
}

export async function putWellKnownCacheEntry(namespace, entry, {
  expirationTtl = null,
} = {}) {
  const normalized = assertPlainObject(entry, 'entry');
  const key = buildWellKnownCacheKey({
    kind: normalized.kind,
    host: normalized.host,
  });
  await putKvJson(namespace, key, {
    response_json: normalized.response_json ?? null,
    cached_at: normalizeString(normalized.cached_at, 'cached_at'),
    expires_at: normalized.expires_at ?? null,
    schema_version: normalizeInteger(normalized.schema_version ?? 1, 'schema_version', { min: 1 }),
  }, {
    expirationTtl,
    metadata: {
      cache_kind: normalized.kind,
      host: normalized.host,
    },
  });
  return key;
}

export async function getWellKnownCacheEntry(namespace, {
  kind,
  host,
}) {
  const key = buildWellKnownCacheKey({ kind, host });
  const result = await getKvJson(namespace, key);
  if (!result) {
    return null;
  }
  return {
    key,
    metadata: result.metadata,
    ...result.value,
  };
}

export async function putRemoteCacheEntry(namespace, entry, {
  expirationTtl = null,
} = {}) {
  const normalized = assertPlainObject(entry, 'entry');
  const key = buildRemoteCacheKey({
    cacheKind: normalized.cache_kind,
    serverName: normalized.server_name,
    keyId: normalized.key_id ?? null,
  });
  await putKvJson(namespace, key, {
    payload: normalized.payload ?? null,
    cached_at: normalizeString(normalized.cached_at, 'cached_at'),
    expires_at: normalized.expires_at ?? null,
    schema_version: normalizeInteger(normalized.schema_version ?? 1, 'schema_version', { min: 1 }),
  }, {
    expirationTtl,
    metadata: {
      cache_kind: normalized.cache_kind,
      server_name: normalized.server_name,
      key_id: normalized.key_id ?? null,
    },
  });
  return key;
}

export async function getRemoteCacheEntry(namespace, {
  cacheKind,
  serverName,
  keyId = null,
}) {
  const key = buildRemoteCacheKey({
    cacheKind,
    serverName,
    keyId,
  });
  const result = await getKvJson(namespace, key);
  if (!result) {
    return null;
  }
  return {
    key,
    metadata: result.metadata,
    ...result.value,
  };
}
