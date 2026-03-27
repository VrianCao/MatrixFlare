import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTestEnvironmentDefinition,
  skipUnlessEnvironment,
} from '../../packages/testing/src/bootstrap.mjs';

test('pre-release bootstrap stays wired to the pre-release layer', (context) => {
  skipUnlessEnvironment(context, 'pre-release');
  assert.equal(getTestEnvironmentDefinition('pre-release').directory, 'tests/pre-release');
});
