import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTestEnvironmentDefinition,
  skipUnlessEnvironment,
} from '../../packages/testing/src/bootstrap.mjs';
import '../shared/l1-mandatory-suite.mjs';

test('staging L1 mandatory suite stays bound to the staging layer', (context) => {
  skipUnlessEnvironment(context, 'staging');
  assert.equal(getTestEnvironmentDefinition('staging').directory, 'tests/staging');
});
