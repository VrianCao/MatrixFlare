import { createAsyncTaskContext, createRequestContext } from './structured-logging.mjs';
import { loadWorkerRuntimeConfig } from './runtime-manifest.mjs';
import { resolveRuntimeWorkerVersionId } from './version-metadata.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

export function createSkeletonFetchHandler(workerName, {
  routeFamily = 'runtime-skeleton',
  message = `${workerName} runtime skeleton placeholder`,
} = {}) {
  return async function skeletonFetch(request, env) {
    const config = loadWorkerRuntimeConfig(workerName, env);
    const requestContext = createRequestContext({
      workerName,
      workerVersion: resolveRuntimeWorkerVersionId(env, config.text.WORKER_VERSION_ID),
      request,
      routeFamily,
    });

    requestContext.logger.warn('worker.placeholder.fetch', {
      method: request.method,
      path: new URL(request.url).pathname,
      outcome: 'placeholder',
    });

    return jsonResponse(
      {
        error: message,
        request_id: requestContext.requestId,
        compatibility_date: config.compatibilityDate,
        release_profile: config.releaseProfile,
      },
      503,
    );
  };
}

export function createSkeletonQueueHandler(workerName, {
  routeFamily = 'queue-skeleton',
} = {}) {
  return async function skeletonQueue(batch, env) {
    const config = loadWorkerRuntimeConfig(workerName, env);
    const asyncContext = createAsyncTaskContext({
      workerName,
      workerVersion: resolveRuntimeWorkerVersionId(env, config.text.WORKER_VERSION_ID),
      routeFamily,
    });
    asyncContext.logger.info('worker.placeholder.queue', {
      queue_name: batch.queue,
      message_count: batch.messages.length,
      outcome: 'placeholder',
    });
  };
}
