import {
  RemoteServerDO,
  RoomDO,
  UserDO,
  createSkeletonFetchHandler,
} from '../../../packages/runtime-core/src/index.mjs';

const fetch = createSkeletonFetchHandler('gateway-worker', {
  routeFamily: 'public-edge',
  message: 'gateway-worker runtime skeleton placeholder',
});

export { RemoteServerDO, RoomDO, UserDO };

export default {
  fetch,
};
