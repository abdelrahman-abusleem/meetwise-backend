'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  NotificationDeliveryService,
} = require('../../src/application/notification-delivery.service.ts');
const {
  NOTIFICATION_DELIVERY_CONSUMER,
  NotificationDeliveryPolicy,
  PENDING_STATUS,
  DELIVERED_STATUS,
  RETRYABLE_STATUS,
  PERMANENT_STATUS,
  UNKNOWN_STATUS,
} = require('../../src/domain/notification-delivery.policy.ts');
const {
  NotificationPolicy,
} = require('../../src/domain/notification-create.policy.ts');
const {
  NotificationDeliveryRecoveryService,
} = require('../../src/application/notification-delivery-recovery.service.ts');
const {
  NotificationRecoveryPolicy,
  NOTIFICATION_RECOVERY_DUTY,
} = require('../../src/domain/notification-delivery-recovery.policy.ts');

class InMemoryDeliveryRepository {
  constructor() {
    this.notifications = new Map();
    this.contacts = new Map();
    this.attempts = new Map();
    this.inbox = new Map();
    this.hooks = {};
    this.calls = {
      findInbox: 0,
      writeInbox: 0,
      loadRow: 0,
      loadContact: 0,
      readAttempts: 0,
      reserve: 0,
      settle: 0,
    };
  }

  callCountsTotal() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }

  async findInboxOutcome(consumer, eventId) {
    this.calls.findInbox += 1;
    const found = this.inbox.get(`${consumer}|${eventId}`);
    if (!found) return null;
    return { ...found };
  }

  async writeInboxOutcome(receipt) {
    this.calls.writeInbox += 1;
    if (this.hooks.onBeforeWriteInbox) {
      await this.hooks.onBeforeWriteInbox(receipt, this);
    }
    const key = `${receipt.consumer}|${receipt.eventId}`;
    if (this.inbox.has(key)) {
      const existing = this.inbox.get(key);
      return {
        created: false,
        outcome: existing.outcome,
        existingId: existing.id,
      };
    }
    this.inbox.set(key, { ...receipt });
    return { created: true, outcome: null };
  }

  async loadNotificationRow(notificationId) {
    this.calls.loadRow += 1;
    const found = this.notifications.get(notificationId);
    if (!found) return null;
    return { ...found };
  }

  async loadRecipientContact(recipientUserId) {
    this.calls.loadContact += 1;
    const c = this.contacts.get(recipientUserId);
    return c === undefined ? null : c;
  }

  attemptsFor(notificationId, channel) {
    const rows = [];
    for (const record of this.attempts.values()) {
      if (
        record.notificationId === notificationId &&
        record.channel === channel
      ) {
        rows.push({ ...record });
      }
    }
    rows.sort((a, b) => a.attempt - b.attempt);
    return rows;
  }

  async readChannelAttempts(notificationId, channel) {
    this.calls.readAttempts += 1;
    return this.attemptsFor(notificationId, channel);
  }

  async reserveAttempt(record) {
    this.calls.reserve += 1;
    if (this.hooks.onBeforeReserve) {
      await this.hooks.onBeforeReserve(record, this);
    }
    if (this.attempts.has(record.id)) {
      return { reserved: false, existing: { ...this.attempts.get(record.id) } };
    }
    this.attempts.set(record.id, { ...record });
    return { reserved: true, existing: null };
  }

  async settleAttempt(command) {
    this.calls.settle += 1;
    if (this.hooks.onBeforeSettle) {
      await this.hooks.onBeforeSettle(command, this);
    }
    const row = this.attempts.get(command.id);
    if (!row) {
      throw new Error('settle-target-row-missing');
    }
    if (row.status !== command.expectedStatus) {
      return { settled: false, record: { ...row } };
    }
    const next = { ...row, status: command.nextStatus };
    next.externalMessageId = command.externalMessageId;
    this.attempts.set(command.id, next);
    return { settled: true, record: { ...next } };
  }

  attemptsForChannel(notificationId, channel) {
    return this.attemptsFor(notificationId, channel);
  }

  inboxReceipt(eventId) {
    return this.inbox.get(`${NOTIFICATION_DELIVERY_CONSUMER}|${eventId}`);
  }
}

class FakeSmtpPort {
  constructor(results) {
    this.results = results.slice();
    this.commands = [];
  }

  async sendEmail(command) {
    this.commands.push({ ...command });
    const next = this.results.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next === undefined) {
      throw new Error('fake-provider-exhausted');
    }
    return {
      outcome: next.outcome ?? next,
      externalMessageId: next.externalMessageId ?? null,
    };
  }
}

class FakeQueuePort {
  constructor() {
    this.schedules = [];
    this.throwOnSchedule = null;
  }

  async scheduleRetry(command) {
    if (this.throwOnSchedule !== null) {
      throw this.throwOnSchedule;
    }
    this.schedules.push({ ...command, channels: [...command.channels] });
  }
}

const VALID_INSTANT = '2026-10-27T12:00:00Z';
const EVENT_ID = 'outbox-evt-1';
const NOTIFICATION_ID = 'notif-1';
const RECIPIENT_ID = 'user-1';
const RECIPIENT_EMAIL = 'recipient@example.com';
const BODY_SAFE = 'Team standup was captured';

const notificationPolicy = new NotificationPolicy();
const deliveryPolicy = new NotificationDeliveryPolicy();

function seedNotification(repository, overrides = {}) {
  const row = {
    id: NOTIFICATION_ID,
    recipientUserId: RECIPIENT_ID,
    kind: 'meeting.created.v1',
    resourceId: 'meeting-1',
    bodySafe: BODY_SAFE,
    state: 'UNREAD',
    createdAt: '2026-10-27T00:00:00Z',
    seenAt: null,
    ...overrides,
  };
  repository.notifications.set(row.id, row);
  return row;
}

function seedContact(repository, email = RECIPIENT_EMAIL) {
  repository.contacts.set(RECIPIENT_ID, email);
}

function baseTurn(overrides = {}) {
  return {
    kind: 'notification.created.v1',
    eventId: EVENT_ID,
    notificationId: NOTIFICATION_ID,
    channels: ['IN_APP'],
    processedAt: VALID_INSTANT,
    ...overrides,
  };
}

function makeService(
  repository,
  smtp,
  queue,
  retryPolicy = null,
  policy = deliveryPolicy,
  notificationPolicyOverride = notificationPolicy,
) {
  return new NotificationDeliveryService(
    repository,
    smtp,
    queue,
    retryPolicy,
    policy,
    notificationPolicyOverride,
  );
}

const FULL_RETRY_POLICY = {
  maxAttempts: 3,
  backoffMs: 100,
  multiplier: 2,
  maxDelayMs: 1000,
};

test('turn shape gate: non-object fact is refused with INVALID_REQUEST', async () => {
  const repository = new InMemoryDeliveryRepository();
  const smtp = new FakeSmtpPort([{ outcome: 'CONFIRMED' }]);
  const queue = new FakeQueuePort();
  const service = makeService(repository, smtp, queue);
  const outcome = await service.processDeliveryTurn(null);
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.reason, 'INVALID_REQUEST');
  assert.equal(repository.callCountsTotal(), 0);
  assert.equal(smtp.commands.length, 0);
  assert.equal(queue.schedules.length, 0);
});

test('turn shape gate: missing kind fails closed before any store call', async () => {
  const repository = new InMemoryDeliveryRepository();
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn({
    eventId: EVENT_ID,
    notificationId: NOTIFICATION_ID,
    channels: ['IN_APP'],
    processedAt: VALID_INSTANT,
  });
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repository.callCountsTotal(), 0);
});

test('turn shape gate: any kind other than the catalog consumer event is UNKNOWN_KIND', async () => {
  const repository = new InMemoryDeliveryRepository();
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ kind: 'notification.delivered.v1' }),
  );
  assert.equal(outcome.reason, 'UNKNOWN_KIND');
  assert.equal(repository.callCountsTotal(), 0);
});

test('turn shape gate: missing notification id fails closed', async () => {
  const repository = new InMemoryDeliveryRepository();
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const fact = baseTurn();
  const outcome = await service.processDeliveryTurn({
    kind: fact.kind,
    eventId: fact.eventId,
    channels: fact.channels,
    processedAt: fact.processedAt,
  });
  assert.equal(outcome.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repository.callCountsTotal(), 0);
});

test('turn shape gate: malformed processedAt instants fail closed', async () => {
  const repository = new InMemoryDeliveryRepository();
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  for (const bad of [
    '',
    '1719400000000',
    '2026-10-27 12:00:00Z',
    '2026-10-27T12:00:00',
  ]) {
    const outcome = await service.processDeliveryTurn(
      baseTurn({ processedAt: bad }),
    );
    assert.equal(outcome.reason, 'DECISION_FACTS_REQUIRED');
  }
  assert.equal(repository.callCountsTotal(), 0);
});

test('turn shape gate: channels must be a non-empty array of approved channel facts', async () => {
  const repository = new InMemoryDeliveryRepository();
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  for (const channels of [
    'IN_APP',
    [],
    ['SLACK'],
    ['IN_APP', 'IN_APP'],
    ['in_app'],
  ]) {
    const outcome = await service.processDeliveryTurn(baseTurn({ channels }));
    assert.equal(outcome.kind, 'REFUSED');
  }
  assert.equal(repository.callCountsTotal(), 0);
});

test('turn shape gate: a valid fact passes and reaches the store', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(baseTurn());
  assert.equal(outcome.kind, 'COMPLETED');
  assert.ok(repository.calls.findInbox >= 1);
});

test('policy: inbox receipt id is deterministic and collision-differentiated', () => {
  const first = deliveryPolicy.composeInboxReceiptId(
    NOTIFICATION_DELIVERY_CONSUMER,
    EVENT_ID,
    NOTIFICATION_ID,
  );
  const second = deliveryPolicy.composeInboxReceiptId(
    NOTIFICATION_DELIVERY_CONSUMER,
    EVENT_ID,
    NOTIFICATION_ID,
  );
  const otherConsumer = deliveryPolicy.composeInboxReceiptId(
    'transcript-ingest',
    EVENT_ID,
    NOTIFICATION_ID,
  );
  const otherEvent = deliveryPolicy.composeInboxReceiptId(
    NOTIFICATION_DELIVERY_CONSUMER,
    'outbox-evt-2',
    NOTIFICATION_ID,
  );
  const otherNotification = deliveryPolicy.composeInboxReceiptId(
    NOTIFICATION_DELIVERY_CONSUMER,
    EVENT_ID,
    'notif-2',
  );
  assert.equal(first, second);
  assert.notEqual(first, otherConsumer);
  assert.notEqual(first, otherEvent);
  assert.notEqual(first, otherNotification);
  assert.ok(first.startsWith('fnv1a64:'));
});

test('policy: retry-turn event ids are deterministic per attempt and delimiter-injection hardened', () => {
  const first = deliveryPolicy.composeRetryJobEventId(EVENT_ID, 1);
  const again = deliveryPolicy.composeRetryJobEventId(EVENT_ID, 1);
  const attemptTwo = deliveryPolicy.composeRetryJobEventId(EVENT_ID, 2);
  const otherEvent = deliveryPolicy.composeRetryJobEventId('outbox-evt-11', 1);
  assert.equal(first, again);
  assert.notEqual(first, attemptTwo);
  assert.notEqual(first, otherEvent);

  const crafted = deliveryPolicy.composeRetryJobEventId('a|retry:1', 1);
  const lookalike = deliveryPolicy.composeRetryJobEventId('a', 1);
  assert.notEqual(crafted, lookalike);
});

test('policy: retry configuration validation rejects present-but-invalid facts', () => {
  assert.equal(deliveryPolicy.validateRetryPolicy(null).ok, true);
  for (const bad of [
    {},
    { maxAttempts: 0, backoffMs: 1, multiplier: 1.5, maxDelayMs: 10 },
    { maxAttempts: 1.5, backoffMs: 1, multiplier: 2, maxDelayMs: 10 },
    { maxAttempts: 2, backoffMs: -1, multiplier: 2, maxDelayMs: 10 },
    { maxAttempts: 2, backoffMs: 1, multiplier: 0.5, maxDelayMs: 10 },
    { maxAttempts: 2, backoffMs: 1, multiplier: Infinity, maxDelayMs: 10 },
    { maxAttempts: 2, backoffMs: 200, multiplier: 2, maxDelayMs: 100 },
  ]) {
    assert.equal(deliveryPolicy.validateRetryPolicy(bad).ok, false);
  }
});

test('policy: bounded delay is config-derived, monotonic until the cap, and exhausts bounds', () => {
  const policy = {
    maxAttempts: 4,
    backoffMs: 100,
    multiplier: 2,
    maxDelayMs: 1500,
  };
  assert.equal(deliveryPolicy.composeNextRetryDelay(policy, 0), null);
  assert.equal(deliveryPolicy.composeNextRetryDelay(policy, 1), 100);
  assert.equal(deliveryPolicy.composeNextRetryDelay(policy, 2), 200);
  assert.equal(deliveryPolicy.composeNextRetryDelay(policy, 3), 400);
  assert.equal(deliveryPolicy.composeNextRetryDelay(policy, 4), null);
  const capped = {
    maxAttempts: 5,
    backoffMs: 1000,
    multiplier: 3,
    maxDelayMs: 1500,
  };
  assert.equal(deliveryPolicy.composeNextRetryDelay(capped, 2), 1500);
  const unconfigured = null;
  assert.equal(unconfigured, null);
});

test('IN_APP turn: durable row verified, PENDING attempt reserved and settled SENT', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(baseTurn());
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].kind, 'DELIVERED');
  assert.equal(outcome.results[0].channel, 'IN_APP');
  assert.equal(outcome.results[0].attempt, 1);
  assert.equal(outcome.results[0].externalMessageId, null);

  assert.equal(repository.calls.loadRow, 1);
  assert.equal(repository.calls.loadContact, 0);
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'IN_APP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, DELIVERED_STATUS);
  assert.equal(rows[0].attempt, 1);

  const receipt = repository.inboxReceipt(EVENT_ID);
  assert.ok(receipt);
  assert.equal(receipt.consumer, NOTIFICATION_DELIVERY_CONSUMER);
  assert.equal(receipt.processedAt, VALID_INSTANT);
  assert.equal(
    receipt.id,
    deliveryPolicy.composeInboxReceiptId(
      NOTIFICATION_DELIVERY_CONSUMER,
      EVENT_ID,
      NOTIFICATION_ID,
    ),
  );
});

test('IN_APP re-delivery turn (fresh event id): ALREADY_DELIVERED on the durable SENT fact', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await service.processDeliveryTurn(baseTurn());
  const outcome = await service.processDeliveryTurn(
    baseTurn({ eventId: 'outbox-evt-2' }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'ALREADY_DELIVERED');
  assert.equal(outcome.results[0].channel, 'IN_APP');

  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'IN_APP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, DELIVERED_STATUS);

  assert.ok(repository.inboxReceipt('outbox-evt-2'));
});

test('IN_APP receipt replay (same event id): REPLAYED with zero extra effects', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const first = await service.processDeliveryTurn(baseTurn());
  assert.equal(first.kind, 'COMPLETED');
  const baseline = repository.callCountsTotal();
  const receipt = repository.inboxReceipt(EVENT_ID);
  const replay = await service.processDeliveryTurn(baseTurn());
  assert.equal(replay.kind, 'REPLAYED');
  assert.equal(replay.outcome, receipt.outcome);
  assert.equal(replay.processedAt, VALID_INSTANT);
  assert.equal(repository.callCountsTotal(), baseline + 1);
});

test('SMTP CONFIRMED: durable contact/body facts only, SENT settle with message id', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = new FakeSmtpPort([
    { outcome: 'CONFIRMED', externalMessageId: 'smtp-msg-7' },
  ]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'DELIVERED');
  assert.equal(outcome.results[0].channel, 'SMTP');
  assert.equal(outcome.results[0].externalMessageId, 'smtp-msg-7');
  assert.equal(smtp.commands.length, 1);
  assert.equal(smtp.commands[0].to, RECIPIENT_EMAIL);
  assert.equal(smtp.commands[0].kind, 'meeting.created.v1');
  assert.equal(smtp.commands[0].bodySafe, BODY_SAFE);
  assert.equal(smtp.commands[0].attempt, 1);
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, DELIVERED_STATUS);
  assert.equal(rows[0].externalMessageId, 'smtp-msg-7');
});

test('SMTP RETRYABLE with configured policy: bounded scheduleRetry with deterministic retry identity', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = new FakeSmtpPort([{ outcome: 'RETRYABLE_NO_EFFECT' }]);
  const queue = new FakeQueuePort();
  const service = makeService(repository, smtp, queue, FULL_RETRY_POLICY);
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'SCHEDULED_RETRY');
  assert.equal(outcome.results[0].attempt, 1);
  assert.equal(outcome.results[0].delayMs, 100);
  assert.equal(
    outcome.results[0].retryJobEventId,
    deliveryPolicy.composeRetryJobEventId(EVENT_ID, 1),
  );
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, RETRYABLE_STATUS);
  assert.equal(queue.schedules.length, 1);
  assert.equal(queue.schedules[0].notificationId, NOTIFICATION_ID);
  assert.deepEqual(queue.schedules[0].channels, ['SMTP']);
  assert.equal(queue.schedules[0].attemptJustExecuted, 1);
  assert.equal(queue.schedules[0].delayMs, 100);

  assert.equal(queue.schedules[0].kind, 'notification.created.v1');
  assert.equal(queue.schedules[0].processedAt, VALID_INSTANT);
});

test('retry turn identity is a consumable turn: SMTP ordinal 2 completes the series', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = new FakeSmtpPort([
    { outcome: 'RETRYABLE_NO_EFFECT' },
    { outcome: 'CONFIRMED', externalMessageId: 'smtp-msg-42' },
  ]);
  const queue = new FakeQueuePort();
  const service = makeService(repository, smtp, queue, FULL_RETRY_POLICY);
  await service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] }));

  const scheduled = queue.schedules[0];
  const retryTurn = {
    kind: scheduled.kind,
    eventId: scheduled.eventId,
    notificationId: scheduled.notificationId,
    channels: scheduled.channels,
    processedAt: scheduled.processedAt,
  };
  const outcome = await service.processDeliveryTurn(retryTurn);
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'DELIVERED');
  assert.equal(outcome.results[0].attempt, 2);
  assert.equal(smtp.commands.length, 2);
  assert.equal(smtp.commands[1].attempt, 2);
  assert.ok(repository.inboxReceipt(scheduled.eventId));

  assert.ok(scheduled.eventId.startsWith('fnv1a64:'));
});

test('SMTP RETRYABLE at the bounds: NO_RETRY with BOUNDS_EXHAUSTED and no scheduling', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = new FakeSmtpPort([{ outcome: 'RETRYABLE_NO_EFFECT' }]);
  const queue = new FakeQueuePort();
  const service = makeService(repository, smtp, queue, {
    ...FULL_RETRY_POLICY,
    maxAttempts: 1,
  });
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'BOUNDS_EXHAUSTED');
  assert.equal(outcome.results[0].status, RETRYABLE_STATUS);
  assert.equal(queue.schedules.length, 0);
});

test('quota gate BEFORE reservation: an out-of-bounds re-drive never reserves and never sends', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);

  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const id = notificationPolicy.composeDeliveryId(
      NOTIFICATION_ID,
      'SMTP',
      ordinal,
    );
    repository.attempts.set(id, {
      id,
      notificationId: NOTIFICATION_ID,
      channel: 'SMTP',
      attempt: ordinal,
      status: RETRYABLE_STATUS,
      externalMessageId: null,
    });
  }
  const smtp = new FakeSmtpPort([{ outcome: 'CONFIRMED' }]);
  const createReserveCalls = repository.calls.reserve;
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'BOUNDS_EXHAUSTED');

  assert.equal(outcome.results[0].status, null);
  assert.equal(outcome.results[0].attempt, 4);

  assert.equal(smtp.commands.length, 0);
  assert.equal(repository.calls.reserve, createReserveCalls);
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows.length, 3);
});

test('quota gate stays inside the bound: the final in-bounds ordinal still executes', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
    const id = notificationPolicy.composeDeliveryId(
      NOTIFICATION_ID,
      'SMTP',
      ordinal,
    );
    repository.attempts.set(id, {
      id,
      notificationId: NOTIFICATION_ID,
      channel: 'SMTP',
      attempt: ordinal,
      status: RETRYABLE_STATUS,
      externalMessageId: null,
    });
  }
  const smtp = new FakeSmtpPort([
    { outcome: 'CONFIRMED', externalMessageId: 'smtp-msg-11' },
  ]);
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'DELIVERED');
  assert.equal(outcome.results[0].attempt, 3);
  assert.equal(smtp.commands.length, 1);
  assert.equal(smtp.commands[0].attempt, 3);
});

test('SMTP RETRYABLE without a configured policy: NO_RETRY with RETRY_UNCONFIGURED (fail closed)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const queue = new FakeQueuePort();
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'RETRYABLE_NO_EFFECT' }]),
    queue,
    null,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'RETRY_UNCONFIGURED');
  assert.equal(queue.schedules.length, 0);
});

test('SMTP PERMANENT_DENIED: PERMANENTLY_FAILED attempt, surfaced, never retried', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const queue = new FakeQueuePort();
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'PERMANENT_DENIED' }]),
    queue,
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].status, PERMANENT_STATUS);
  assert.equal(outcome.results[0].cause, 'PERMANENT');
  assert.equal(queue.schedules.length, 0);

  assert.equal(repository.notifications.get(NOTIFICATION_ID).state, 'UNREAD');
});

test('SMTP UNKNOWN_EFFECT: recorded honestly, never blindly retried', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const queue = new FakeQueuePort();
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'UNKNOWN_EFFECT' }]),
    queue,
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].status, UNKNOWN_STATUS);
  assert.equal(outcome.results[0].cause, 'UNKNOWN');
  assert.equal(queue.schedules.length, 0);
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows[0].status, UNKNOWN_STATUS);
  assert.equal(rows[0].externalMessageId, null);
});

test('channel independence: SMTP permanent failure still completes the IN_APP channel', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'PERMANENT_DENIED' }]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['IN_APP', 'SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].kind, 'DELIVERED');
  assert.equal(outcome.results[0].channel, 'IN_APP');
  assert.equal(outcome.results[1].kind, 'NO_RETRY');
  assert.equal(outcome.results[1].channel, 'SMTP');
});

test('SMTP-only turn never touches the IN_APP channel and never reads contact facts for it', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'CONFIRMED' }]),
    new FakeQueuePort(),
  );
  await service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] }));
  assert.equal(repository.calls.loadContact, 1);
  const inAppRows = repository.attemptsForChannel(NOTIFICATION_ID, 'IN_APP');
  assert.equal(inAppRows.length, 0);
});

test('privacy: receipt outcome JSON carries only id-shaped facts (no contact, no bodySafe)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'CONFIRMED' }]),
    new FakeQueuePort(),
  );
  await service.processDeliveryTurn(baseTurn({ channels: ['IN_APP', 'SMTP'] }));
  const receipt = repository.inboxReceipt(EVENT_ID);
  assert.ok(!receipt.outcome.includes('example.com'));
  assert.ok(!receipt.outcome.includes(BODY_SAFE));
  assert.ok(!receipt.outcome.includes('to='));
});

test('port violation: out-of-union outcome is a loud defect and the attempt stays PENDING', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = new FakeSmtpPort([{ outcome: 'SOMEHOW_DELIVERED' }]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /notification-delivery-provider-port-violation/,
  );
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, PENDING_STATUS);
});

test('port violation: malformed result shape (undefined message id) fails loudly', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = {
    commands: [],
    async sendEmail() {
      this.commands.push({});
      return { outcome: 'CONFIRMED', externalMessageId: undefined };
    },
  };
  const service = makeService(repository, smtp, new FakeQueuePort());
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /notification-delivery-provider-port-violation/,
  );
});

test('queue scheduling failure propagates after the durable settle (no lost state)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const queue = new FakeQueuePort();
  queue.throwOnSchedule = new Error('redis-connection-lost');
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'RETRYABLE_NO_EFFECT' }]),
    queue,
    FULL_RETRY_POLICY,
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /redis-connection-lost/,
  );
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, RETRYABLE_STATUS);
});

test('unsettled PENDING claim is never advanced past: honest refusal, no send, no reservation', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const notificationPolicy = new NotificationPolicy();
  const orphanId = notificationPolicy.composeDeliveryId(
    NOTIFICATION_ID,
    'SMTP',
    1,
  );
  repository.attempts.set(orphanId, {
    id: orphanId,
    notificationId: NOTIFICATION_ID,
    channel: 'SMTP',
    attempt: 1,
    status: PENDING_STATUS,
    externalMessageId: null,
  });
  const smtp = new FakeSmtpPort([]);
  const createReserveCalls = repository.calls.reserve;
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'UNSETTLED_CLAIM');
  assert.equal(outcome.results[0].status, PENDING_STATUS);
  assert.equal(outcome.results[0].attempt, 1);

  assert.equal(smtp.commands.length, 0);

  assert.equal(repository.calls.reserve, createReserveCalls);

  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, PENDING_STATUS);
});

function seedAttemptRow(
  repository,
  channel,
  attempt,
  status,
  externalMessageId = null,
) {
  const id = notificationPolicy.composeDeliveryId(
    NOTIFICATION_ID,
    channel,
    attempt,
  );
  repository.attempts.set(id, {
    id,
    notificationId: NOTIFICATION_ID,
    channel,
    attempt,
    status,
    externalMessageId,
  });
  return id;
}

test('BLOCKED_TERMINAL: a settled UNKNOWN attempt refuses every future ordinal (no send, no reservation)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  seedAttemptRow(repository, 'SMTP', 1, UNKNOWN_STATUS);
  const smtp = new FakeSmtpPort([]);
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  const channelOutcome = outcome.results[0];
  assert.deepEqual(
    {
      kind: channelOutcome.kind,
      channel: channelOutcome.channel,
      attempt: channelOutcome.attempt,
      status: channelOutcome.status,
      cause: channelOutcome.cause,
    },
    {
      kind: 'NO_RETRY',
      channel: 'SMTP',
      attempt: 1,
      status: UNKNOWN_STATUS,
      cause: 'UNKNOWN',
    },
  );
  assert.equal(smtp.commands.length, 0, 'zero provider credit consumed');
  assert.equal(repository.calls.reserve, 0, 'no ordinal ever reserved');
  assert.equal(repository.calls.settle, 0);
});

test('BLOCKED_TERMINAL: a settled PERMANENTLY_FAILED attempt blocks future ordinals (cause PERMANENT)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  seedAttemptRow(repository, 'SMTP', 1, PERMANENT_STATUS);
  const smtp = new FakeSmtpPort([]);
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].status, PERMANENT_STATUS);
  assert.equal(outcome.results[0].cause, 'PERMANENT');
  assert.equal(smtp.commands.length, 0);
  assert.equal(repository.calls.reserve, 0);
});

test('a DELIVERED channel short-circuits the terminal block (UNKNOWN then SENT => ALREADY_DELIVERED)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  seedAttemptRow(repository, 'SMTP', 1, UNKNOWN_STATUS);
  const sentId = seedAttemptRow(repository, 'SMTP', 2, DELIVERED_STATUS);
  const smtp = new FakeSmtpPort([]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'ALREADY_DELIVERED');
  assert.equal(outcome.results[0].settledAttemptId, sentId);
  assert.equal(smtp.commands.length, 0);
});

test('a RETRYABLE attempt does not neutralize the block (RETRYABLE + UNKNOWN => NO_RETRY UNKNOWN)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  seedAttemptRow(repository, 'SMTP', 1, RETRYABLE_STATUS);
  seedAttemptRow(repository, 'SMTP', 2, UNKNOWN_STATUS);
  const smtp = new FakeSmtpPort([]);
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'UNKNOWN');
  assert.equal(outcome.results[0].attempt, 2);
  assert.equal(smtp.commands.length, 0);
});

test('guard precedence: BLOCKED_TERMINAL wins over UNSETTLED_CLAIM for [UNKNOWN, PENDING] (recovery-QA QA-7B-02 pin)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  seedAttemptRow(repository, 'SMTP', 1, UNKNOWN_STATUS);
  seedAttemptRow(repository, 'SMTP', 2, PENDING_STATUS);
  const smtp = new FakeSmtpPort([]);
  const service = makeService(
    repository,
    smtp,
    new FakeQueuePort(),
    FULL_RETRY_POLICY,
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'UNKNOWN', 'terminal block first');
  assert.equal(outcome.results[0].status, UNKNOWN_STATUS);
  assert.equal(outcome.results[0].attempt, 1);
  assert.equal(smtp.commands.length, 0);
  assert.equal(repository.calls.reserve, 0);
});

test('recovery-wins-then-worker-settles race: the true cross-service interleaving refuses the loser settle loudly', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const recovery = new NotificationDeliveryRecoveryService(
    repository,
    new NotificationRecoveryPolicy(),
  );
  let reservedRecord = null;
  repository.hooks.onBeforeReserve = async (record) => {
    reservedRecord = { ...record };
  };

  let recoveryInjectionInFlight = false;
  repository.hooks.onBeforeSettle = async () => {
    if (recoveryInjectionInFlight) {
      return;
    }
    recoveryInjectionInFlight = true;
    try {
      await recovery.processRecoveryTurn({
        duty: NOTIFICATION_RECOVERY_DUTY,
        notificationId: reservedRecord.notificationId,
        channel: reservedRecord.channel,
        attempt: reservedRecord.attempt,
      });
    } finally {
      recoveryInjectionInFlight = false;
    }
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    service.processDeliveryTurn(baseTurn()),
    /notification-delivery-settlement-conflict/,
  );
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'IN_APP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, DELIVERED_STATUS);
  assert.equal(rows[0].externalMessageId, null);
});

test('concurrent duplicate restore: reserve sees the settled SENT row and reports ALREADY_DELIVERED', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.hooks.onBeforeReserve = async (record, repo) => {
    if (record.attempt === 1 && repo.attempts.size === 0) {
      repo.attempts.set(record.id, { ...record, status: DELIVERED_STATUS });
    }
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(baseTurn());
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'ALREADY_DELIVERED');
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'IN_APP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, DELIVERED_STATUS);
});

test('concurrent duplicate loses the single-winner claim CAS on the same unsettled ordinal', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  repository.hooks.onBeforeReserve = async (record, repo) => {
    if (!repo.attempts.has(record.id)) {
      repo.attempts.set(record.id, { ...record });
    }
  };
  const smtp = new FakeSmtpPort([]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  const outcome = await service.processDeliveryTurn(baseTurn());
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'UNSETTLED_CLAIM');
  assert.equal(outcome.results[0].status, PENDING_STATUS);
  assert.equal(outcome.results[0].attempt, 1);

  assert.equal(smtp.commands.length, 0);
  const rows = repository.attemptsForChannel(NOTIFICATION_ID, 'IN_APP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, PENDING_STATUS);
});

test('a claim loser whose concurrent winner already settled the ordinal reports that durable fact', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.hooks.onBeforeReserve = async (record, repo) => {
    if (!repo.attempts.has(record.id)) {
      repo.attempts.set(record.id, { ...record, status: RETRYABLE_STATUS });
    }
  };
  const smtp = new FakeSmtpPort([]);
  const queue = new FakeQueuePort();
  const service = makeService(repository, smtp, queue, FULL_RETRY_POLICY);
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['SMTP'] }),
  );
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.results[0].kind, 'NO_RETRY');
  assert.equal(outcome.results[0].cause, 'CLAIM_HELD');
  assert.equal(outcome.results[0].status, RETRYABLE_STATUS);
  assert.equal(outcome.results[0].attempt, 1);

  assert.equal(smtp.commands.length, 0);

  assert.equal(queue.schedules.length, 0);
});

test('a refused reservation without a durable row is the loud claim-conflict defect', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);

  repository.reserveAttempt = async () => ({
    reserved: false,
    existing: null,
  });
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-claim-conflict/,
  );
});

test('settlement race is loud and leaves the durable row visible', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.hooks.onBeforeSettle = async (command, repo) => {
    repo.attempts.set(command.id, {
      ...repo.attempts.get(command.id),
      status: DELIVERED_STATUS,
    });
    repo.hooks.onBeforeSettle = undefined;
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'CONFIRMED' }]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /notification-delivery-settlement-conflict/,
  );
});

test('lost receipt race: the concurrent duplicate wins; this turn returns its durable outcome', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.hooks.onBeforeWriteInbox = async (receipt, repo) => {
    repo.hooks.onBeforeWriteInbox = undefined;
    repo.inbox.set(`${receipt.consumer}|${receipt.eventId}`, {
      ...receipt,
      outcome:
        '[{"kind":"DELIVERED","channel":"IN_APP","attempt":1,"externalMessageId":null}]',
    });
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(baseTurn());
  assert.equal(outcome.kind, 'REPLAYED');
  assert.ok(outcome.outcome.includes('DELIVERED'));
  assert.equal(outcome.processedAt, null);
});

test('a durably-found receipt belonging to a foreign notification is a loud identity defect', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const foreignId = deliveryPolicy.composeInboxReceiptId(
    NOTIFICATION_DELIVERY_CONSUMER,
    EVENT_ID,
    'notif-foreign',
  );
  repository.inbox.set(`${NOTIFICATION_DELIVERY_CONSUMER}|${EVENT_ID}`, {
    id: foreignId,
    consumer: NOTIFICATION_DELIVERY_CONSUMER,
    eventId: EVENT_ID,
    processedAt: VALID_INSTANT,
    outcome: '[{"kind":"DELIVERED","channel":"IN_APP","attempt":1}]',
  });
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-receipt-identity-mismatch/,
  );

  assert.equal(repository.calls.loadRow, 0);
});

test('a lost receipt race against a foreign-notification winner is a loud identity defect', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.hooks.onBeforeWriteInbox = async (receipt, repo) => {
    repo.hooks.onBeforeWriteInbox = undefined;

    repo.inbox.set(`${receipt.consumer}|${receipt.eventId}`, {
      ...receipt,
      id: deliveryPolicy.composeInboxReceiptId(
        receipt.consumer,
        receipt.eventId,
        'notif-foreign',
      ),
      outcome:
        '[{"kind":"DELIVERED","channel":"IN_APP","attempt":1,"externalMessageId":null}]',
    });
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-receipt-identity-mismatch/,
  );
});

test('repository defects are never swallowed', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.hooks.onBeforeReserve = async () => {
    throw new Error('connection-reset');
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'CONFIRMED' }]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /connection-reset/,
  );
});

test('missing durable notification row is corruption, never an outcome', async () => {
  const repository = new InMemoryDeliveryRepository();
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(repository.calls.readAttempts, 0);
});

test('corrupted notification facts (foreign kind) fail loud before any attempt write', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository, { kind: 'kind.not.in.catalog.v1' });
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(repository.calls.readAttempts, 0);
});

test('addressed-row identity: a loaded row under a foreign durable id is corruption', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const seeded = repository.notifications.get(NOTIFICATION_ID);
  const misresolved = { ...seeded, id: 'a-foreign-notification-row' };
  repository.loadNotificationRow = async () => ({ ...misresolved });
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-row-mapping-corrupt/,
  );

  assert.equal(repository.calls.readAttempts, 0);
  assert.equal(repository.calls.writeInbox, 0);
});

test('a non-array attempts result from the repository is a port violation, never an empty section', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  repository.readChannelAttempts = async () => 'corrupted-shape';
  const smtp = new FakeSmtpPort([{ outcome: 'CONFIRMED' }]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /notification-delivery-repository-port-violation/,
  );

  assert.equal(smtp.commands.length, 0);
  assert.equal(repository.calls.settle, 0);
});

test('derived-state invariant: state must equal stateFor(seenAt)', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository, { state: 'READ', seenAt: null });
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-row-mapping-corrupt/,
  );
});

test('unreadable recipient contact fails loud WITHOUT a PENDING reservation', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  const smtp = new FakeSmtpPort([{ outcome: 'CONFIRMED' }]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /notification-delivery-recipient-unresolvable/,
  );
  assert.equal(repository.calls.reserve, 0);
  assert.equal(smtp.commands.length, 0);
  assert.equal(
    repository.attemptsForChannel(NOTIFICATION_ID, 'SMTP').length,
    0,
  );
});

test('corrupted attempt history fails loud before any provider call', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const smtp = new FakeSmtpPort([{ outcome: 'CONFIRMED' }]);
  const corruptId = notificationPolicy.composeDeliveryId(
    NOTIFICATION_ID,
    'SMTP',
    1,
  );
  repository.attempts.set(corruptId, {
    id: corruptId,
    notificationId: NOTIFICATION_ID,
    channel: 'SMTP',
    attempt: 1,
    status: 'SOMEHOW_SENT',
    externalMessageId: null,
  });
  const service = makeService(repository, smtp, new FakeQueuePort());
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn({ channels: ['SMTP'] })),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(smtp.commands.length, 0);
});

test('non-contiguous ordinals are a store defect, not an outcome', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const idOne = notificationPolicy.composeDeliveryId(
    NOTIFICATION_ID,
    'IN_APP',
    1,
  );
  const idThree = notificationPolicy.composeDeliveryId(
    NOTIFICATION_ID,
    'IN_APP',
    3,
  );
  repository.attempts.set(idOne, {
    id: idOne,
    notificationId: NOTIFICATION_ID,
    channel: 'IN_APP',
    attempt: 1,
    status: PERMANENT_STATUS,
    externalMessageId: null,
  });
  repository.attempts.set(idThree, {
    id: idThree,
    notificationId: NOTIFICATION_ID,
    channel: 'IN_APP',
    attempt: 3,
    status: PERMANENT_STATUS,
    externalMessageId: null,
  });
  const smtp = new FakeSmtpPort([]);
  const service = makeService(repository, smtp, new FakeQueuePort());
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(smtp.commands.length, 0);
});

test('adapter leak test: a foreign-channel row inside a section read is corruption', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  repository.readChannelAttempts = async () => {
    return [
      {
        id: 'leaky',
        notificationId: NOTIFICATION_ID,
        channel: 'SMTP',
        attempt: 1,
        status: DELIVERED_STATUS,
        externalMessageId: null,
      },
    ];
  };
  const service = makeService(
    repository,
    new FakeSmtpPort([]),
    new FakeQueuePort(),
  );
  await assert.rejects(
    () => service.processDeliveryTurn(baseTurn()),
    /notification-delivery-row-mapping-corrupt/,
  );
});

test('invalid retry policy fails fast at construction', () => {
  const repository = new InMemoryDeliveryRepository();
  assert.throws(
    () =>
      makeService(repository, new FakeSmtpPort([]), new FakeQueuePort(), {
        maxAttempts: 0,
        backoffMs: 1,
        multiplier: 1,
        maxDelayMs: 10,
      }),
    /notification-delivery-invalid-retry-policy/,
  );
});

test('turn outcomes are frozen with whitelisted shapes', async () => {
  const repository = new InMemoryDeliveryRepository();
  seedNotification(repository);
  seedContact(repository);
  const service = makeService(
    repository,
    new FakeSmtpPort([{ outcome: 'CONFIRMED' }]),
    new FakeQueuePort(),
  );
  const outcome = await service.processDeliveryTurn(
    baseTurn({ channels: ['IN_APP', 'SMTP'] }),
  );
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.results), true);
  const allowedKeys = new Set([
    'kind',
    'channel',
    'attempt',
    'externalMessageId',
    'settledAttemptId',
    'delayMs',
    'retryJobEventId',
    'status',
    'cause',
  ]);
  for (const result of outcome.results) {
    assert.equal(Object.isFrozen(result), true);
    for (const key of Object.keys(result)) {
      assert.equal(allowedKeys.has(key), true);
    }
  }
});
