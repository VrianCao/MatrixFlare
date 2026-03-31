import {
  createOpsWorkerFetchHandler,
} from '../../../packages/control-plane/src/index.mjs';
import {
  ensureDeploymentRecord,
  instrumentEnvironmentBindings,
  loadWorkerRuntimeConfig,
  startRequestMetrics,
} from '../../../packages/runtime-core/src/index.mjs';

const controlPlaneFetch = createOpsWorkerFetchHandler();

const fetch = async (request, env) => {
  instrumentEnvironmentBindings(env);
  const config = loadWorkerRuntimeConfig('ops-worker', env);
  ensureDeploymentRecord(env, {
    workerName: 'ops-worker',
    config,
  });
  const requestMetrics = startRequestMetrics(env, {
    workerName: 'ops-worker',
    workerVersion: config.text.WORKER_VERSION_ID,
    routeFamily: 'ops-control-plane',
  });
  try {
    const response = await controlPlaneFetch(request, env);
    requestMetrics.finish({
      status: response.status,
    });
    return response;
  } catch (error) {
    requestMetrics.finish({
      status: 500,
      error,
    });
    throw error;
  }
};

export default {
  fetch,
};
