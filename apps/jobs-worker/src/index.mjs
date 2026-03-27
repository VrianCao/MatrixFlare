import {
  createSkeletonFetchHandler,
  createSkeletonQueueHandler,
} from '../../../packages/runtime-core/src/index.mjs';

const fetch = createSkeletonFetchHandler('jobs-worker', {
  routeFamily: 'internal-jobs',
  message: 'jobs-worker runtime skeleton placeholder',
});

const queue = createSkeletonQueueHandler('jobs-worker', {
  routeFamily: 'jobs-queue',
});

export default {
  fetch,
  queue,
};
