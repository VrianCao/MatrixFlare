import {
  createJobsWorkerFetchHandler,
  createJobsWorkerQueueHandler,
  QUEUE_NAMES,
} from '../../../packages/control-plane/src/index.mjs';
import { createSkeletonQueueHandler } from '../../../packages/runtime-core/src/index.mjs';

const fetch = createJobsWorkerFetchHandler();
const controlPlaneQueue = createJobsWorkerQueueHandler();
const placeholderQueue = createSkeletonQueueHandler('jobs-worker', {
  routeFamily: 'jobs-queue',
});
const CONTROL_PLANE_QUEUES = new Set(Object.values(QUEUE_NAMES));

const queue = async (batch, env) => (
  CONTROL_PLANE_QUEUES.has(batch.queue)
    ? controlPlaneQueue(batch, env)
    : placeholderQueue(batch, env)
);

export default {
  fetch,
  queue,
};
