const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  NotificationDeliveryPolicy,
} = require('../../libs/meetings/src/domain/notification-delivery.policy.ts');
const {
  BullmqNotificationRetryScheduler,
} = require('../../libs/meetings/src/infrastructure/notification/bullmq-notification-retry-scheduler.ts');
const {
  BullmqOutboxDispatcherPublisher,
} = require('../../libs/meetings/src/infrastructure/outbox/bullmq-outbox-dispatch-publisher.ts');
const { Job } = require('bullmq');
function validateOptions(options) {
  Job.prototype.validateOptions.call(
    { opts: options, name: 'synthetic' },
    { data: '{}' },
  );
}
test('zero-base retry remains finite after exponential overflow', () => {
  const policy = new NotificationDeliveryPolicy();
  const config = {
    maxAttempts: 2001,
    backoffMs: 0,
    multiplier: 2,
    maxDelayMs: 1000,
  };
  assert.equal(policy.validateRetryPolicy(config).ok, true);
  assert.equal(policy.composeNextRetryDelay(config, 2000), 0);
});
test('positive-base retry caps finite overflow without changing bounds', () => {
  const policy = new NotificationDeliveryPolicy();
  assert.equal(
    policy.composeNextRetryDelay(
      { maxAttempts: 2001, backoffMs: 1, multiplier: 2, maxDelayMs: 1000 },
      2000,
    ),
    1000,
  );
});
for (const eventId of ['synthetic:retry:notification:2', '123']) {
  test(`outbox physical queue identity accepts semantic event ID ${eventId}`, async () => {
    let captured;
    const queue = {
      async add(name, data, options) {
        validateOptions(options);
        captured = { name, data, options };
      },
    };
    const publisher = new BullmqOutboxDispatcherPublisher({
      queue,
      jobName: 'synthetic-dispatch',
    });
    const envelope = { eventId };
    await publisher.publish(envelope);
    assert.equal(captured.data, envelope);
    assert.doesNotMatch(captured.options.jobId, /:/);
    assert.equal(
      Buffer.from(captured.options.jobId.slice(3), 'base64url').toString(
        'utf16le',
      ),
      eventId,
    );
  });
}
test('retry scheduler uses a valid physical ID and preserves semantic payload identity', async () => {
  let captured;
  const queue = {
    async add(name, data, options) {
      validateOptions(options);
      captured = { name, data, options };
    },
  };
  const scheduler = new BullmqNotificationRetryScheduler({
    queue,
    jobName: 'synthetic-retry',
  });
  const eventId = 'synthetic:retry:notification:2';
  await scheduler.scheduleRetry({
    eventId,
    notificationId: 'synthetic-notification',
    kind: 'notification.created.v1',
    processedAt: '2026-11-03T00:00:00Z',
    channels: ['SMTP'],
    attemptJustExecuted: 1,
    delayMs: 0,
  });
  assert.equal(captured.data.eventId, eventId);
  assert.equal(captured.options.delay, 0);
  assert.equal(
    Buffer.from(captured.options.jobId.slice(3), 'base64url').toString(
      'utf16le',
    ),
    eventId,
  );
});
