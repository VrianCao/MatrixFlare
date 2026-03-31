import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTestEnvironmentDefinition,
  skipUnlessEnvironment,
} from '../../packages/testing/src/bootstrap.mjs';
import '../shared/l1-mandatory-suite.mjs';

test('pre-release L1 mandatory suite stays bound to the pre-release layer', (context) => {
  skipUnlessEnvironment(context, 'pre-release');
  assert.equal(getTestEnvironmentDefinition('pre-release').directory, 'tests/pre-release');
});
