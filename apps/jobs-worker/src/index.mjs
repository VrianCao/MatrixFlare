import {
  applyMediaCatalogProjection,
  applyPublicRoomDirectoryProjection,
  applySearchIndexProjection,
  applyUserDirectoryProjection,
  buildThumbnailDescriptor,
  clearDerivedTarget,
  createThumbnailBodyInput,
  createDefaultThumbnailJob,
  INTERNAL_RUNTIME_DERIVED_WORK_PATH,
  normalizeDerivedWorkBatch,
  parseLegacyUnauthFreezeAt,
  resolveThumbnailAnimationPreference,
  RUNTIME_JOB_SCHEMA_VERSION,
} from '../../../packages/runtime-core/src/index.mjs';
import { createSkeletonQueueHandler } from '../../../packages/runtime-core/src/index.mjs';
import {
  createJobsWorkerFetchHandler,
  createJobsWorkerQueueHandler,
  QUEUE_NAMES,
} from '../../../packages/control-plane/src/index.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function getUserDoStub(env, userId) {
  return env.USER_DO.get(env.USER_DO.idFromName(userId));
}

function getRoomDoStub(env, roomId) {
  return env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
}

function parseMxcUri(mxcUri) {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUri);
  if (!match) {
    throw new TypeError('mxc_uri must be a valid Matrix content URI');
  }
  return {
    server_name: match[1],
    media_id: match[2],
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function withMediaKeyBackoff(env, objectKey, operation) {
  const cache = env.MATRIX_EDGE_CACHE;
  const cacheKey = `media_write_backoff:${objectKey}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = cache && typeof cache.get === 'function'
      ? await cache.get(cacheKey)
      : null;
    if (!existing) {
      try {
        if (cache && typeof cache.put === 'function') {
          await cache.put(cacheKey, JSON.stringify({ locked_at: new Date().toISOString() }), {
            expirationTtl: 5,
          });
        }
        return await operation();
      } finally {
        await cache?.delete?.(cacheKey);
      }
    }
    await sleep(10 + Math.floor(Math.random() * 25));
  }
  throw Object.assign(new Error(`Media object ${objectKey} is busy; retry later`), {
    code: 'quota_exceeded',
    retryable: true,
  });
}

function resolveConfiguredMaxMediaBytes(env) {
  const configured = Number.parseInt(env.MATRIX_MEDIA_MAX_UPLOAD_BYTES, 10);
  return Number.isInteger(configured) && configured >= 1
    ? configured
    : Number.POSITIVE_INFINITY;
}

async function handleRuntimeDerivedFetch(request, env) {
  let body;
  try {
    body = normalizeDerivedWorkBatch(await request.json());
  } catch (error) {
    return jsonResponse({
      error: error.message,
    }, 400);
  }
  for (const item of body.work_items) {
    if (item.work_type === 'search_index') {
      await env.SEARCH_INDEX_QUEUE.send({
        schema_version: RUNTIME_JOB_SCHEMA_VERSION,
        event_id: item.source_refs.event_id,
        room_id: item.source_refs.room_id,
        room_pos: item.source_refs.room_pos,
        visibility_watermark: item.source_refs.visibility_watermark,
        redaction_watermark: item.source_refs.redaction_watermark,
        enqueued_at: item.enqueued_at,
      });
      continue;
    }
    if (item.work_type === 'user_directory') {
      const result = await getUserDoStub(env, item.source_refs.user_id).getUserDirectoryEntry({
        user_id: item.source_refs.user_id,
        updated_at: item.enqueued_at,
      });
      if (result?.ok && result.entry) {
        await applyUserDirectoryProjection(env, result.entry);
      } else if (result?.ok) {
        await clearDerivedTarget(env, {
          target: 'user_directory',
          userId: item.source_refs.user_id,
        });
      }
      continue;
    }
    if (item.work_type === 'public_room_directory') {
      const result = await getRoomDoStub(env, item.source_refs.room_id).getPublicRoomDirectoryEntry({
        room_id: item.source_refs.room_id,
        updated_at: item.enqueued_at,
      });
      if (result?.ok && result.entry) {
        await applyPublicRoomDirectoryProjection(env, result.entry);
      }
      continue;
    }
    if (item.work_type === 'media_thumbnail') {
      await env.MEDIA_THUMBNAIL_QUEUE.send(createDefaultThumbnailJob({
        mxcUri: item.source_refs.mxc_uri,
        sourceKind: item.source_refs.source_kind,
        r2ObjectKey: item.source_refs.r2_object_key,
        contentType: item.source_refs.content_type,
        byteSize: item.source_refs.byte_size ?? null,
        contentHash: item.source_refs.content_hash ?? null,
        enqueuedAt: item.enqueued_at,
        variants: item.source_refs.variants,
      }));
    }
  }
  return jsonResponse({
    accepted: body.work_items.length,
  }, 202);
}

async function processSearchIndexMessage(messageBody, env) {
  const roomDo = getRoomDoStub(env, messageBody.room_id);
  const projection = await roomDo.getDerivedEventProjection({
    event_id: messageBody.event_id,
    updated_at: messageBody.enqueued_at,
  });
  if (projection?.ok && projection.search_index) {
    await applySearchIndexProjection(env, projection.search_index);
    const redactedTargetEventId = projection.search_index.record_json?.redacts_event_id_or_null ?? null;
    if (typeof redactedTargetEventId === 'string' && redactedTargetEventId.length > 0) {
      const redactedProjection = await roomDo.getDerivedEventProjection({
        event_id: redactedTargetEventId,
        updated_at: messageBody.enqueued_at,
      });
      if (redactedProjection?.ok && redactedProjection.search_index) {
        await applySearchIndexProjection(env, redactedProjection.search_index);
      }
    }
  }
  const roomEntry = await roomDo.getPublicRoomDirectoryEntry({
    room_id: messageBody.room_id,
    updated_at: messageBody.enqueued_at,
  });
  if (roomEntry?.ok && roomEntry.entry) {
    await applyPublicRoomDirectoryProjection(env, roomEntry.entry);
  }
}

async function processMediaThumbnailMessage(messageBody, env) {
  const source = await env.MATRIX_MEDIA_BUCKET.get(messageBody.r2_object_key);
  if (!source) {
    throw Object.assign(new Error(`Source media object ${messageBody.r2_object_key} is missing`), {
      retryable: true,
    });
  }
  const sourceMetadata = source.customMetadata ?? {};
  const freezeAt = parseLegacyUnauthFreezeAt(env.MATRIX_MEDIA_LEGACY_UNAUTH_FREEZE_AT);
  const { server_name: originServerName, media_id: mediaId } = parseMxcUri(messageBody.mxc_uri);
  const legacyFlag = sourceMetadata.legacy_unauth_access_flag === 'true';
  const sourceHasStreamBody = source?.body && typeof source.body.getReader === 'function';
  for (let variantIndex = 0; variantIndex < (messageBody.variants ?? []).length; variantIndex += 1) {
    const variant = messageBody.variants[variantIndex];
    const effectiveAnimated = resolveThumbnailAnimationPreference(
      variant.animated === true,
      sourceMetadata.content_type ?? messageBody.content_type,
    );
    const descriptor = buildThumbnailDescriptor({
      sourceKind: messageBody.source_kind === 'remote_cache' ? 'remote' : 'local',
      originServerName: messageBody.source_kind === 'remote_cache' ? originServerName : null,
      mediaId,
      width: variant.width,
      height: variant.height,
      method: variant.method,
      animated: effectiveAnimated,
    });
    const variantSource = sourceHasStreamBody && variantIndex > 0
      ? await env.MATRIX_MEDIA_BUCKET.get(messageBody.r2_object_key)
      : source;
    if (!variantSource) {
      throw Object.assign(new Error(`Source media object ${messageBody.r2_object_key} disappeared while generating thumbnails`), {
        retryable: true,
      });
    }
    const thumbnailBody = await createThumbnailBodyInput(variantSource, {
      ...variant,
      animated: effectiveAnimated,
    }, {
      maxBytes: resolveConfiguredMaxMediaBytes(env),
    });
    await withMediaKeyBackoff(env, descriptor.key, () => env.MATRIX_MEDIA_BUCKET.put(descriptor.key, thumbnailBody, {
      customMetadata: {
        ...descriptor.metadata,
        created_at: messageBody.enqueued_at,
        legacy_unauth_access_flag: legacyFlag ? 'true' : 'false',
      },
      httpMetadata: {
        contentType: messageBody.content_type,
      },
    }));
  }
  await applyMediaCatalogProjection(env, {
    mxc_uri: messageBody.mxc_uri,
    origin_kind: messageBody.source_kind === 'remote_cache' ? 'remote' : 'local',
    origin_server_name: messageBody.source_kind === 'remote_cache' ? originServerName : null,
    media_id: mediaId,
    content_type: messageBody.content_type,
    byte_size: Number.parseInt(
      messageBody.byte_size
        ?? sourceMetadata.byte_size
        ?? String(source.size ?? 0),
      10,
    ),
    content_hash: typeof messageBody.content_hash === 'string'
      ? messageBody.content_hash
      : (sourceMetadata.content_hash ?? null),
    legacy_unauth_access_flag: legacyFlag,
    source_object_key: messageBody.r2_object_key,
    created_at: messageBody.enqueued_at,
    updated_at: messageBody.enqueued_at,
    record_json: {
      variants_generated: (messageBody.variants ?? []).length,
      freeze_at: freezeAt?.iso ?? null,
    },
  });
}

function normalizeRuntimeQueueMessage(queueName, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError(`Queue ${queueName} body must be an object`);
  }
  return body;
}

function createRuntimeQueueHandler() {
  const placeholderQueue = createSkeletonQueueHandler('jobs-worker', {
    routeFamily: 'jobs-queue',
  });
  return async function runtimeQueue(batch, env) {
    if (batch.queue !== 'matrix-search-index-job' && batch.queue !== 'matrix-media-thumbnail-job') {
      return placeholderQueue(batch, env);
    }
    for (const message of batch.messages) {
      try {
        const body = normalizeRuntimeQueueMessage(batch.queue, message.body);
        if (batch.queue === 'matrix-search-index-job') {
          await processSearchIndexMessage(body, env);
        } else {
          await processMediaThumbnailMessage(body, env);
        }
        message.ack?.();
      } catch (error) {
        if (error.retryable === true) {
          message.retry?.();
        } else {
          message.ack?.();
        }
      }
    }
  };
}

const controlPlaneFetch = createJobsWorkerFetchHandler();
const controlPlaneQueue = createJobsWorkerQueueHandler();
const runtimeQueue = createRuntimeQueueHandler();
const CONTROL_PLANE_QUEUES = new Set(Object.values(QUEUE_NAMES));

const fetch = async (request, env) => {
  const pathname = new URL(request.url).pathname;
  if (pathname === INTERNAL_RUNTIME_DERIVED_WORK_PATH) {
    return handleRuntimeDerivedFetch(request, env);
  }
  return controlPlaneFetch(request, env);
};

const queue = async (batch, env) => (
  CONTROL_PLANE_QUEUES.has(batch.queue)
    ? controlPlaneQueue(batch, env)
    : runtimeQueue(batch, env)
);

export default {
  fetch,
  queue,
};
