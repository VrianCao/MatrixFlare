import { createSkeletonFetchHandler } from '../../../packages/runtime-core/src/index.mjs';

const fetch = createSkeletonFetchHandler('ops-worker', {
  routeFamily: 'ops-control-plane',
  message: 'ops-worker runtime skeleton placeholder',
});

export default {
  fetch,
};
