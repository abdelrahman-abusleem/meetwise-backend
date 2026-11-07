'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  NotificationDeliveryRecoveryService,
} = require('../../src/application/notification-delivery-recovery.service.ts');
const {
  NotificationRecoveryPolicy,
  NOTIFICATION_RECOVERY_DUTY,
} = require('../../src/domain/notification-delivery-recovery.policy.ts');
const {
  PENDING_STATUS,
  DELIVERED_STATUS,
  RETRYABLE_STATUS,
  UNKNOWN_STATUS,
} = require('../../src/domain/notification-delivery.policy.ts');

class FakeDeliveryRepository {
  constructor() {
    this.calls = { read: 0, loadRow: 0, contact: 0, settle: 0 };
    this.sections = new Map();
    this.notificationRow = null;
    this.contact = null;
    this.nextSettle = { settled: true };
    this.settleCommands = [];
  }

  async readChannelAttempts(notificationId, channel) {
    this.calls.read += 1;
    return this.sections.get(`${notificationId}|${channel}`) ?? [];
  }

  async loadNotificationRow(id) {
    this.calls.loadRow += 1;
    return this.notificationRow;
  }

  async loadRecipientContact() {
    this.calls.contact += 1;
    return this.contact;
  }

  async findInboxOutcome() {
    throw new Error('recovery lane must never consult event receipts');
  }

  async writeInboxOutcome() {
    throw new Error('recovery lane must never write event receipts');
  }

  async reserveAttempt() {
    throw new Error('recovery lane must never reserve new attempts');
  }

  async settleAttempt(command) {
    this.calls.settle += 1;
    this.settleCommands.push(command);
    if (this.nextSettle.settled !== true) {
      return { settled: false, record: { ...this.nextSettle.record } };
    }
    for (const rows of this.sections.values()) {
      const row = rows.find((r) => r.id === command.id);
      if (row) {
        return {
          settled: true,
          record: {
            ...row,
            status: command.nextStatus,
            externalMessageId: command.externalMessageId,
          },
        };
      }
    }
    throw new Error('fake has no row matching the settled command id');
  }
}

function attemptRow(overrides = {}) {
  return {
    id: 'att-in-app-1',
    notificationId: 'n-1',
    channel: 'IN_APP',
    attempt: 1,
    status: PENDING_STATUS,
    externalMessageId: null,
    ...overrides,
  };
}

function notificationRow(overrides = {}) {
  return {
    id: 'n-1',
    recipientUserId: 'u-1',
    kind: 'meeting.created.v1',
    resourceId: 'r-1',
    bodySafe: 'body-text',
    state: 'UNREAD',
    createdAt: '2026-10-27T09:00:00Z',
    seenAt: null,
    ...overrides,
  };
}

const TURN_IN_APP = {
  duty: NOTIFICATION_RECOVERY_DUTY,
  notificationId: 'n-1',
  channel: 'IN_APP',
  attempt: 1,
};

function buildHarness({
  section = null,
  notificationRow = null,
  nextSettle = { settled: true },
} = {}) {
  const repo = new FakeDeliveryRepository();
  if (section !== null) {
    repo.sections.set('n-1|' + section[0].channel, section);
  }
  repo.notificationRow = notificationRow;
  repo.nextSettle = nextSettle;
  const service = new NotificationDeliveryRecoveryService(
    repo,
    new NotificationRecoveryPolicy(),
  );
  return { repo, service };
}

test('shape gate: non-object turn is refused before any repository effect', async () => {
  const { repo, service } = buildHarness();
  for (const bad of [null, undefined, 'turn', 42, []]) {
    const outcome = await service.processRecoveryTurn(bad);
    assert.equal(outcome.kind, 'REFUSED');
    assert.equal(outcome.reason, 'INVALID_REQUEST');
    assert.equal(repo.calls.read, 0);
  }
});

test('shape gate: malformed identity / unknown channel / bad ordinal / foreign duty fail closed', async () => {
  for (const [bad, reason] of [
    [{ ...TURN_IN_APP, notificationId: '' }, 'DECISION_FACTS_REQUIRED'],
    [{ ...TURN_IN_APP, notificationId: 3 }, 'DECISION_FACTS_REQUIRED'],
    [{ ...TURN_IN_APP, attempt: 0 }, 'DECISION_FACTS_REQUIRED'],
    [{ ...TURN_IN_APP, attempt: 1.5 }, 'DECISION_FACTS_REQUIRED'],
    [{ ...TURN_IN_APP, attempt: '1' }, 'DECISION_FACTS_REQUIRED'],
    [{ ...TURN_IN_APP, channel: 'SMS' }, 'UNKNOWN_CHANNEL'],
    [{ ...TURN_IN_APP, channel: '' }, 'UNKNOWN_CHANNEL'],
    [
      { ...TURN_IN_APP, duty: 'reconcile.notification.batch.v1' },
      'UNKNOWN_DUTY',
    ],
    [{ ...TURN_IN_APP, duty: 7 }, 'UNKNOWN_DUTY'],
  ]) {
    const { repo, service } = buildHarness();
    const outcome = await service.processRecoveryTurn(bad);
    assert.equal(outcome.kind, 'REFUSED', JSON.stringify(bad));
    assert.equal(outcome.reason, reason);

    assert.equal(outcome.preventEnumeration, false);
    assert.equal(repo.calls.read, 0, 'refusals never read the store');
  }
});

test('IN_APP orphan: durable-pending row CAS-settles to SENT with zero side effects', async () => {
  const { repo, service } = buildHarness({
    section: [attemptRow()],
    notificationRow: notificationRow(),
  });
  const outcome = await service.processRecoveryTurn(TURN_IN_APP);
  assert.deepEqual(outcome, {
    kind: 'RESOLVED',
    attemptId: 'att-in-app-1',
    channel: 'IN_APP',
    attempt: 1,
    nextStatus: DELIVERED_STATUS,
    externalMessageId: null,
    resolution: 'IN_APP_REACCEPT',
  });
  assert.deepEqual(repo.settleCommands, [
    {
      id: 'att-in-app-1',
      expectedStatus: PENDING_STATUS,
      nextStatus: DELIVERED_STATUS,
      externalMessageId: null,
    },
  ]);
  assert.equal(repo.calls.loadRow, 1, 'durable deliverable proved first');
  assert.equal(repo.calls.contact, 0, 'no contact facts are ever needed');
});

test('SMTP orphan: durable PENDING claim is NOT auto-resolved — zero-write UNRESOLVABLE', async () => {
  const turn = {
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'SMTP',
    attempt: 1,
  };
  const sectionRow = attemptRow({ id: 'att-smtp-1', channel: 'SMTP' });
  const { repo, service } = buildHarness({ section: [sectionRow] });
  const outcome = await service.processRecoveryTurn(turn);
  assert.deepEqual(outcome, {
    kind: 'UNRESOLVABLE',
    attemptId: 'att-smtp-1',
    channel: 'SMTP',
    attempt: 1,
    cause: 'SMTP_EFFECT_UNPROVEN',
  });
  assert.equal(
    repo.calls.settle,
    0,
    'the automated lane writes NOTHING for an SMTP PENDING claim',
  );
  assert.equal(repo.calls.loadRow, 0, 'no content loads on the SMTP path');
  assert.equal(repo.calls.read, 1, 'the durable section is read once');
  assert.deepEqual(
    sectionRow.status,
    PENDING_STATUS,
    'durable row untouched (still the live-eligible claim)',
  );
});

test('recovery racing a live SMTP worker: no durable write while the provider response is in flight', async () => {
  const turn = {
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'SMTP',
    attempt: 1,
  };
  const sectionRow = attemptRow({ id: 'att-smtp-1', channel: 'SMTP' });
  const { repo, service } = buildHarness({ section: [sectionRow] });
  const outcome = await service.processRecoveryTurn(turn);
  assert.equal(outcome.kind, 'UNRESOLVABLE');
  assert.equal(repo.calls.settle, 0);

  const settledAfter = await repo.settleAttempt({
    id: 'att-smtp-1',
    expectedStatus: PENDING_STATUS,
    nextStatus: 'SENT',
    externalMessageId: null,
  });
  assert.equal(settledAfter.settled, true);
});

test('already-settled attempt is surfaced NOT_PENDING, never rewritten', async () => {
  const turn = {
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'IN_APP',
    attempt: 1,
  };
  const { repo, service } = buildHarness({
    section: [attemptRow({ status: RETRYABLE_STATUS })],
  });
  const outcome = await service.processRecoveryTurn(turn);
  assert.deepEqual(outcome, {
    kind: 'NOT_PENDING',
    attemptId: 'att-in-app-1',
    channel: 'IN_APP',
    attempt: 1,
    durableStatus: RETRYABLE_STATUS,
    resolution: null,
  });
  assert.equal(repo.calls.settle, 0);
});

test('already-settled SMTP attempt is surfaced NOT_PENDING before any resolution logic', async () => {
  const turn = {
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'SMTP',
    attempt: 1,
  };
  const { repo, service } = buildHarness({
    section: [
      attemptRow({ id: 'att-smtp-1', channel: 'SMTP', status: UNKNOWN_STATUS }),
    ],
  });
  const outcome = await service.processRecoveryTurn(turn);
  assert.deepEqual(outcome, {
    kind: 'NOT_PENDING',
    attemptId: 'att-smtp-1',
    channel: 'SMTP',
    attempt: 1,
    durableStatus: UNKNOWN_STATUS,
    resolution: null,
  });
  assert.equal(repo.calls.settle, 0);
  assert.equal(repo.calls.loadRow, 0);
});

test('CAS race (IN_APP): refuses gracefully with the durable post-refusal row surfaced', async () => {
  const turn = {
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'IN_APP',
    attempt: 1,
  };
  const winner = attemptRow({
    id: 'att-in-app-1',
    status: DELIVERED_STATUS,
    externalMessageId: null,
  });
  const { service } = buildHarness({
    section: [attemptRow()],
    notificationRow: notificationRow(),
    nextSettle: { settled: false, record: winner },
  });
  const outcome = await service.processRecoveryTurn(turn);
  assert.deepEqual(outcome, {
    kind: 'CAS_REFUSED',
    attemptId: 'att-in-app-1',
    channel: 'IN_APP',
    attempt: 1,
    resolution: 'IN_APP_REACCEPT',
    durable: {
      id: 'att-in-app-1',
      notificationId: 'n-1',
      channel: 'IN_APP',
      attempt: 1,
      status: DELIVERED_STATUS,
      externalMessageId: null,
    },
  });
});

test('two concurrent recovery turns on one PENDING seat: first RESOLVED, second CAS_REFUSED', async () => {
  const turn = {
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'IN_APP',
    attempt: 1,
  };
  const { repo, service } = buildHarness({
    section: [attemptRow()],
    notificationRow: notificationRow(),
  });
  const first = await service.processRecoveryTurn(turn);
  assert.equal(first.kind, 'RESOLVED', 'the first winner lands the CAS');

  repo.nextSettle = {
    settled: false,
    record: attemptRow({ status: DELIVERED_STATUS, externalMessageId: null }),
  };
  const second = await service.processRecoveryTurn(turn);
  assert.equal(second.kind, 'CAS_REFUSED');
  assert.equal(second.durable.status, DELIVERED_STATUS);
});

test('non-durable attempt ordinal: NOT_PRESENT with the durable series end', async () => {
  const { repo, service } = buildHarness({
    section: [
      attemptRow(),
      attemptRow({
        id: 'att-in-app-2',
        attempt: 2,
        status: DELIVERED_STATUS,
      }),
    ],
  });
  const outcome = await service.processRecoveryTurn({
    ...TURN_IN_APP,
    attempt: 5,
  });
  assert.deepEqual(outcome, {
    kind: 'NOT_PRESENT',
    notificationId: 'n-1',
    channel: 'IN_APP',
    attempt: 5,
    durableSeriesEnd: 2,
  });
  assert.equal(repo.calls.settle, 0);
});

test('non-array section read is a loud repository-port violation', async () => {
  const { repo, service } = buildHarness();
  repo.sections.set('n-1|IN_APP', 42);
  await assert.rejects(
    service.processRecoveryTurn(TURN_IN_APP),
    /notification-delivery-repository-port-violation/,
  );
  assert.equal(repo.calls.settle, 0);
});

test('foreign-channel row inside the section is a corruption defect', async () => {
  const { repo, service } = buildHarness();
  repo.sections.set('n-1|IN_APP', [attemptRow({ channel: 'SMTP' })]);
  await assert.rejects(
    service.processRecoveryTurn(TURN_IN_APP),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(repo.calls.settle, 0);
});

test('non-contiguous ordinals are a corruption defect', async () => {
  const { repo, service } = buildHarness({
    section: [attemptRow(), attemptRow({ id: 'att-in-app-3', attempt: 3 })],
  });
  await assert.rejects(
    service.processRecoveryTurn({ ...TURN_IN_APP, attempt: 3 }),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(repo.calls.settle, 0);
});

test('IN_APP re-acceptance proves the durable Notification row first: missing row is corruption, pre-CAS', async () => {
  const { repo, service } = buildHarness({ section: [attemptRow()] });
  await assert.rejects(
    service.processRecoveryTurn(TURN_IN_APP),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(repo.calls.settle, 0, 'a corrupt row never resolves');
});

test('IN_APP row under a foreign durable id is corruption, pre-CAS', async () => {
  const { repo, service } = buildHarness({
    section: [attemptRow()],
    notificationRow: notificationRow({ id: 'n-2' }),
  });
  await assert.rejects(
    service.processRecoveryTurn(TURN_IN_APP),
    /notification-delivery-row-mapping-corrupt/,
  );
  assert.equal(repo.calls.settle, 0);
});

test('outcomes are frozen with whitelisted key sets', async () => {
  const refused = await buildHarness().service.processRecoveryTurn(null);
  assert.ok(Object.isFrozen(refused));
  assert.deepEqual(Object.keys(refused).sort(), [
    'kind',
    'preventEnumeration',
    'reason',
  ]);

  const resolvedHarness = buildHarness({
    section: [attemptRow()],
    notificationRow: notificationRow(),
  });
  const resolved =
    await resolvedHarness.service.processRecoveryTurn(TURN_IN_APP);
  assert.ok(Object.isFrozen(resolved));
  assert.deepEqual(Object.keys(resolved).sort(), [
    'attempt',
    'attemptId',
    'channel',
    'externalMessageId',
    'kind',
    'nextStatus',
    'resolution',
  ]);

  const notPending = await buildHarness({
    section: [attemptRow({ status: UNKNOWN_STATUS })],
    notificationRow: notificationRow(),
  }).service.processRecoveryTurn(TURN_IN_APP);
  assert.ok(Object.isFrozen(notPending));
  assert.deepEqual(Object.keys(notPending).sort(), [
    'attempt',
    'attemptId',
    'channel',
    'durableStatus',
    'kind',
    'resolution',
  ]);

  const unresolvedHarness = buildHarness({
    section: [attemptRow({ id: 'att-smtp-1', channel: 'SMTP' })],
  });
  const unresolvable = await unresolvedHarness.service.processRecoveryTurn({
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'SMTP',
    attempt: 1,
  });
  assert.ok(Object.isFrozen(unresolvable));
  assert.deepEqual(Object.keys(unresolvable).sort(), [
    'attempt',
    'attemptId',
    'cause',
    'channel',
    'kind',
  ]);
});

test('policy: the automated resolution matrix covers ONLY IN_APP (SMTP resolved by operator duty, never automated)', async () => {
  const {
    NotificationRecoveryPolicy: PolicyClass,
    RECOVERY_RESOLUTIONS,
  } = require('../../src/domain/notification-delivery-recovery.policy.ts');
  assert.deepEqual(Object.keys(RECOVERY_RESOLUTIONS), ['IN_APP']);
  const policy = new PolicyClass();
  assert.throws(
    () => policy.resolveTarget('SMTP'),
    /notification-recovery-channel-resolution-defect/,
  );
});

test('recovery lane structurally cannot send, schedule, or write receipts', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(
      __dirname,
      '../../src/application/notification-delivery-recovery.service.ts',
    ),
    'utf8',
  );
  assert.ok(!src.includes('sendEmail'));
  assert.ok(!src.includes('scheduleRetry'));
  assert.ok(!src.includes('writeInboxOutcome'));
  assert.ok(!src.includes('SmtpEmailDeliveryCommand'));

  const inApp = buildHarness({
    section: [attemptRow()],
    notificationRow: notificationRow(),
  });
  await inApp.service.processRecoveryTurn(TURN_IN_APP);
  assert.equal(inApp.repo.calls.read, 1);
  const smtp = buildHarness({
    section: [attemptRow({ id: 'att-smtp-1', channel: 'SMTP' })],
  });
  const smtpOutcome = await smtp.service.processRecoveryTurn({
    duty: NOTIFICATION_RECOVERY_DUTY,
    notificationId: 'n-1',
    channel: 'SMTP',
    attempt: 1,
  });
  assert.equal(smtpOutcome.kind, 'UNRESOLVABLE');
  assert.equal(smtp.repo.calls.settle, 0);
});
