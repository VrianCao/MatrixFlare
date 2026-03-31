import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTestEnvironmentDefinition,
  skipUnlessEnvironment,
} from '../../packages/testing/src/bootstrap.mjs';
import '../shared/l1-mandatory-suite.mjs';

test('CI integration L1 mandatory suite stays bound to the integration layer', (context) => {
  skipUnlessEnvironment(context, 'ci-integration');
  assert.equal(getTestEnvironmentDefinition('ci-integration').directory, 'tests/integration');
});
