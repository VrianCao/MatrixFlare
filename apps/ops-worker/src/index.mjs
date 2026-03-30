import { createOpsWorkerFetchHandler } from '../../../packages/control-plane/src/index.mjs';

const fetch = createOpsWorkerFetchHandler();

export default {
  fetch,
};
