import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTestEnvironmentDefinition,
  skipUnlessEnvironment,
} from '../../packages/testing/src/bootstrap.mjs';

test('staging bootstrap stays wired to the staging layer', (context) => {
  skipUnlessEnvironment(context, 'staging');
  assert.equal(getTestEnvironmentDefinition('staging').directory, 'tests/staging');
});
