'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  BullmqOutboxDispatcherPublisher,
} = require('../../src/infrastructure/outbox/bullmq-outbox-dispatch-publisher.ts');

class RecordingQueue {
  constructor({ throws = null } = {}) {
    this.calls = [];
    this.scriptedThrow = throws;
  }
  async add(name, data, options) {
    this.calls.push({ name, data, options });
    if (this.scriptedThrow !== null) {
      throw this.scriptedThrow;
    }
    return { id: `job-${this.calls.length}` };
  }
}

function envelope() {
  return Object.freeze({
    eventId: 'evt-demo-1',
    type: 'meeting.created.v1',
    version: 1,
    aggregateType: 'MeetingSummary',
    aggregateId: 'ms-1',
    aggregateVersion: 3,
    occurredAt: '2026-10-30T00:00:00.000Z',
    correlationId: 'corr-1',
    causationId: null,
    payload: { meetingId: 'm-1', summaryId: 'ms-1' },
  });
}

function publisher(queue, overrides = {}) {
  return new BullmqOutboxDispatcherPublisher({
    queue,
    jobName: 'outbox-event',
    ...overrides,
  });
}

test('constructor fails closed: missing/non-shape queue and blank job name', () => {
  for (const bad of [
    null,
    undefined,
    {},
    { queue: null, jobName: 'outbox-event' },
    { queue: { add: 42 }, jobName: 'outbox-event' },
    { queue: { add: () => {} } },
    { queue: { add: () => {} }, jobName: '' },
    { queue: { add: () => {} }, jobName: '   ' },
  ]) {
    assert.throws(
      () => new BullmqOutboxDispatcherPublisher(bad),
      /outbox-publisher-(queue|job-name)-required/,
    );
  }
});

test('publish passes the frozen envelope VERBATIM (same reference, no augmentation) as job data', async () => {
  const queue = new RecordingQueue();
  const env = envelope();
  await publisher(queue).publish(env);
  assert.equal(queue.calls.length, 1);
  const { name, data, options } = queue.calls[0];
  assert.equal(name, 'outbox-event');

  assert.deepEqual(data, env);
  assert.deepEqual(options, { jobId: 'mw_ZQB2AHQALQBkAGUAbQBvAC0AMQA' });

  for (const key of Object.keys(env)) {
    assert.ok(key in data, `${key} present in job data`);
  }
});

test('jobId is a stable physical encoding of the durable semantic event id (deterministic identity knob, no exactly-once claim)', async () => {
  const queue = new RecordingQueue();
  const adapt = publisher(queue);
  await adapt.publish(envelope());
  await adapt.publish(arrayVariantEnvelope());
  const ids = queue.calls.map((c) => c.options.jobId);
  assert.deepEqual(ids, [
    'mw_ZQB2AHQALQBkAGUAbQBvAC0AMQA',
    'mw_ZQB2AHQALQBkAGUAbQBvAC0AMgA',
  ]);
});

function arrayVariantEnvelope() {
  const env = envelope();
  return { ...env, eventId: 'evt-demo-2' };
}

test('enqueue uncertainty/refusal propagates VERBATIM: same error object, no retry, no swallow (FM-03)', async () => {
  const cause = new Error('redis-outage-illustration');
  cause.command = 'queue-add';
  const queue = new RecordingQueue({ throws: cause });
  const adapt = publisher(queue);
  await assert.rejects(adapt.publish(envelope()), (err) => {
    assert.strictEqual(err, cause, 'the transport cause object is preserved');
    return true;
  });
  assert.equal(
    queue.calls.length,
    1,
    'no internal retry exists in the adapter',
  );
});

test('a non-envelope publish fact fails closed BEFORE any queue call', async () => {
  const queue = new RecordingQueue();
  await assert.rejects(
    publisher(queue).publish(null),
    /outbox-publisher-envelope-required/,
  );
  assert.equal(queue.calls.length, 0);
});

test('REAL bullmq job-id dedup is NOT load-bearing here: duplicate publishes stay SAFE (docblock pin)', async () => {
  const queue = new RecordingQueue();
  const env = envelope();
  const adapt = publisher(queue);
  await adapt.publish(env);
  await adapt.publish(env);
  for (const call of queue.calls) {
    assert.deepEqual(call.data, env);
    assert.deepEqual(call.options, { jobId: 'mw_ZQB2AHQALQBkAGUAbQBvAC0AMQA' });
  }
  assert.equal(queue.calls.length, 2);
});
