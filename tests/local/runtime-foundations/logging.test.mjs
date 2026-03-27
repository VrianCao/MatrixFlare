import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAsyncTaskContext,
  createRequestContext,
  createStructuredLogger,
} from '../../../packages/runtime-core/src/index.mjs';

test('structured logger emits stable JSON fields', () => {
  const records = [];
  const logger = createStructuredLogger({
    workerName: 'gateway-worker',
    workerVersion: 'build-123',
    routeFamily: 'public-edge',
    sink: (record) => records.push(record),
    now: () => new Date('2026-03-27T00:00:00.000Z'),
    baseFields: { request_id: 'req_fixed' },
  });

  logger.info('request.accepted', { outcome: 'ok', latency_ms: 12 });

  assert.deepEqual(records, [
    {
      timestamp: '2026-03-27T00:00:00.000Z',
      severity: 'info',
      event: 'request.accepted',
      worker_name: 'gateway-worker',
      worker_version: 'build-123',
      route_family: 'public-edge',
      request_id: 'req_fixed',
      outcome: 'ok',
      latency_ms: 12,
    },
  ]);
});

test('request context derives request and causation ids from headers', () => {
  const records = [];
  const request = new Request('https://matrix.example.test/_matrix/client/v3/sync', {
    headers: {
      'x-request-id': 'req_explicit',
      'x-causation-id': 'cause_explicit',
      'x-job-id': 'job_explicit',
      'x-matrix-txn-id': 'txn_explicit',
      'cf-ray': 'cf-ray-123',
    },
  });

  const context = createRequestContext({
    workerName: 'gateway-worker',
    workerVersion: 'build-123',
    request,
    routeFamily: 'sync',
    sink: (record) => records.push(record),
    now: () => new Date('2026-03-27T00:00:00.000Z'),
  });

  context.logger.warn('sync.wait', { outcome: 'waiting' });

  assert.equal(context.requestId, 'req_explicit');
  assert.equal(context.causationId, 'cause_explicit');
  assert.equal(context.jobId, 'job_explicit');
  assert.equal(context.txnId, 'txn_explicit');
  assert.equal(context.cfRay, 'cf-ray-123');
  assert.equal(records[0].request_id, 'req_explicit');
  assert.equal(records[0].causation_id, 'cause_explicit');
});

test('async task context generates job ids when absent', () => {
  const records = [];
  const context = createAsyncTaskContext({
    workerName: 'jobs-worker',
    workerVersion: 'build-123',
    routeFamily: 'jobs-queue',
    sink: (record) => records.push(record),
    now: () => new Date('2026-03-27T00:00:00.000Z'),
  });

  context.logger.info('job.started', { outcome: 'placeholder' });
  assert.match(context.jobId, /^job_/);
  assert.equal(context.causationId, context.jobId);
  assert.equal(records[0].job_id, context.jobId);
});
