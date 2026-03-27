import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTestEnvironmentDefinition,
  skipUnlessEnvironment,
} from '../../packages/testing/src/bootstrap.mjs';

test('CI integration bootstrap stays wired to the integration layer', (context) => {
  skipUnlessEnvironment(context, 'ci-integration');
  assert.equal(getTestEnvironmentDefinition('ci-integration').directory, 'tests/integration');
});
