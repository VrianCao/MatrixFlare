import { assertPlainObject, normalizeInteger, normalizeString } from './persistence-common.mjs';

export const RUNTIME_JOB_SCHEMA_VERSION = 1;
export const INTERNAL_RUNTIME_DERIVED_WORK_PATH = '/_internal/runtime/derived-work';
export const RUNTIME_DERIVED_WORK_TYPES = Object.freeze([
  'search_index',
  'user_directory',
  'public_room_directory',
  'media_thumbnail',
]);

function normalizeScope(scope) {
  const normalized = assertPlainObject(scope, 'scope');
  const scopeKind = normalizeString(normalized.scope_kind, 'scope.scope_kind');
  const scopeId = normalized.scope_id == null ? null : normalizeString(normalized.scope_id, 'scope.scope_id');
  if (!['global', 'room_id', 'user_id'].includes(scopeKind)) {
    throw new RangeError('scope.scope_kind must be one of global, room_id, or user_id');
  }
  if (scopeKind === 'global' && scopeId != null) {
    throw new RangeError('scope.scope_id must be null when scope.scope_kind is global');
  }
  if (scopeKind !== 'global' && scopeId == null) {
    throw new RangeError('scope.scope_id must be present when scope.scope_kind is not global');
  }
  return Object.freeze({
    scope_kind: scopeKind,
    scope_id: scopeId,
  });
}

function normalizeWorkItem(value, index) {
  const normalized = assertPlainObject(value, `work_items[${index}]`);
  const workType = normalizeString(normalized.work_type, `work_items[${index}].work_type`);
  if (!RUNTIME_DERIVED_WORK_TYPES.includes(workType)) {
    throw new RangeError(`work_items[${index}].work_type must be one of ${RUNTIME_DERIVED_WORK_TYPES.join(', ')}`);
  }
  const sourceRefs = assertPlainObject(normalized.source_refs ?? {}, `work_items[${index}].source_refs`);
  const item = {
    work_type: workType,
    idempotency_key: normalizeString(normalized.idempotency_key, `work_items[${index}].idempotency_key`),
    scope: normalizeScope(normalized.scope ?? {
      scope_kind: 'global',
      scope_id: null,
    }),
    source_refs: sourceRefs,
    enqueued_at: normalized.enqueued_at == null
      ? new Date().toISOString()
      : normalizeString(normalized.enqueued_at, `work_items[${index}].enqueued_at`),
  };
  if (workType === 'search_index') {
    item.source_refs.room_id = normalizeString(sourceRefs.room_id, `work_items[${index}].source_refs.room_id`);
    item.source_refs.event_id = normalizeString(sourceRefs.event_id, `work_items[${index}].source_refs.event_id`);
    item.source_refs.room_pos = normalizeInteger(sourceRefs.room_pos, `work_items[${index}].source_refs.room_pos`, { min: 1 });
    item.source_refs.visibility_watermark = normalizeInteger(
      sourceRefs.visibility_watermark ?? sourceRefs.room_pos,
      `work_items[${index}].source_refs.visibility_watermark`,
      { min: 1 },
    );
    item.source_refs.redaction_watermark = normalizeInteger(
      sourceRefs.redaction_watermark ?? sourceRefs.room_pos,
      `work_items[${index}].source_refs.redaction_watermark`,
      { min: 1 },
    );
  }
  if (workType === 'user_directory') {
    item.source_refs.user_id = normalizeString(sourceRefs.user_id, `work_items[${index}].source_refs.user_id`);
  }
  if (workType === 'public_room_directory') {
    item.source_refs.room_id = normalizeString(sourceRefs.room_id, `work_items[${index}].source_refs.room_id`);
  }
  if (workType === 'media_thumbnail') {
    item.source_refs.mxc_uri = normalizeString(sourceRefs.mxc_uri, `work_items[${index}].source_refs.mxc_uri`);
    item.source_refs.source_kind = normalizeString(sourceRefs.source_kind, `work_items[${index}].source_refs.source_kind`);
    item.source_refs.r2_object_key = normalizeString(sourceRefs.r2_object_key, `work_items[${index}].source_refs.r2_object_key`);
    item.source_refs.content_type = normalizeString(sourceRefs.content_type, `work_items[${index}].source_refs.content_type`);
    item.source_refs.variants = Array.isArray(sourceRefs.variants) ? sourceRefs.variants : [];
  }
  return Object.freeze(item);
}

export function normalizeDerivedWorkBatch(value) {
  const normalized = assertPlainObject(value, 'DerivedWorkBatch');
  const workItems = Array.isArray(normalized.work_items) ? normalized.work_items : null;
  if (!workItems) {
    throw new TypeError('work_items must be an array');
  }
  return Object.freeze({
    schema_version: normalizeInteger(
      normalized.schema_version ?? RUNTIME_JOB_SCHEMA_VERSION,
      'schema_version',
      { min: 1 },
    ),
    batch_id: normalizeString(normalized.batch_id, 'batch_id'),
    requested_by: normalizeString(normalized.requested_by, 'requested_by'),
    work_items: Object.freeze(workItems.map((item, index) => normalizeWorkItem(item, index))),
  });
}

export async function enqueueDerivedWork(env, batch) {
  const normalizedBatch = normalizeDerivedWorkBatch(batch);
  const jobsWorker = env?.JOBS_WORKER;
  if (jobsWorker && typeof jobsWorker.fetch === 'function') {
    const response = await jobsWorker.fetch(new Request(`https://jobs-worker${INTERNAL_RUNTIME_DERIVED_WORK_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(normalizedBatch),
    }));
    if (!response.ok) {
      throw new Error(`jobs-worker rejected derived work batch ${normalizedBatch.batch_id} with status ${response.status}`);
    }
    return response.json();
  }
  throw new TypeError('env.JOBS_WORKER must expose a fetch() method for derived work delivery');
}
