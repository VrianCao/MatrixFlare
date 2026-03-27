import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInternalErrorEnvelope,
  createMatrixUnknownTokenErrorBody,
  createMatrixUnrecognizedErrorBody,
  createOpsErrorResponse,
  getOpsErrorHttpStatus,
  parseInternalErrorEnvelope,
  parseMatrixErrorBody,
  parseOpsErrorResponse,
  serializeJsonBody,
} from '../../../packages/contracts/src/index.mjs';

test('matrix fixed error bodies serialize and parse predictably', () => {
  const unrecognized = createMatrixUnrecognizedErrorBody();
  const unknownToken = createMatrixUnknownTokenErrorBody();

  assert.deepEqual(parseMatrixErrorBody(serializeJsonBody(unrecognized)), unrecognized);
  assert.deepEqual(parseMatrixErrorBody(unknownToken), unknownToken);
});

test('ops error responses preserve request correlation metadata', () => {
  const response = createOpsErrorResponse({
    code: 'idempotency_conflict',
    message: 'request fingerprint mismatch',
    requestId: 'req_123',
    retryable: false,
    details: { field: 'Idempotency-Key' },
  });

  assert.deepEqual(parseOpsErrorResponse(serializeJsonBody(response)), response);
  assert.equal(getOpsErrorHttpStatus(response.code, { retryable: response.retryable }), 409);
});

test('retryable internal ops errors map to 503', () => {
  assert.equal(getOpsErrorHttpStatus('internal', { retryable: true }), 503);
});

test('internal error envelopes validate canonical baseline codes', () => {
  const envelope = createInternalErrorEnvelope({
    code: 'not_current',
    message: 'Durable Object currentness probe failed',
    retryable: true,
    details: { class_name: 'UserDO' },
  });

  assert.deepEqual(parseInternalErrorEnvelope(serializeJsonBody(envelope)), envelope);
  assert.throws(
    () => createInternalErrorEnvelope({ code: 'made_up_code', message: 'nope' }),
    /Unsupported InternalErrorEnvelope.code/,
  );
});
