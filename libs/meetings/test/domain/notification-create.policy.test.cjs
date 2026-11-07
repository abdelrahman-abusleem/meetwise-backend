'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  NotificationPolicy,
  NOTIFICATION_KINDS,
  NOTIFICATION_CHANNELS,
} = require('../../src/domain/notification-create.policy.ts');

const policy = new NotificationPolicy();

function event(overrides) {
  return {
    outboxEventId: 'outbox-0001',
    kind: 'meeting.cancelled.v1',
    resourceId: 'meeting-9',
    recipientUserId: 'user-7',
    bodySafe: 'Meeting was cancelled.',
    createdAt: '2026-10-25T10:00:00Z',
    ...overrides,
  };
}

function expectFail(decision, reason, preventEnumeration = false) {
  assert.equal(decision.ok, false);
  assert.deepEqual({ ...decision }, { ok: false, reason, preventEnumeration });
  assert.ok(Object.isFrozen(decision));
}

function row(overrides) {
  return {
    id: 'n-1',
    recipientUserId: 'user-7',
    kind: 'meeting.cancelled.v1',
    resourceId: 'meeting-9',
    bodySafe: 'b',
    state: 'UNREAD',
    createdAt: '2026-10-25T10:00:00Z',
    seenAt: null,
    ...overrides,
  };
}

test('the kind vocabulary is exactly the catalog rows that target Notification', () => {
  assert.deepEqual(
    [...NOTIFICATION_KINDS],
    [
      'meeting.created.v1',
      'meeting.cancelled.v1',
      'meeting.manager_transferred.v1',
      'analysis.finished.v1',
      'execution.unknown.v1',
      'execution.succeeded.v1',
    ],
  );
  assert.ok(Object.isFrozen(NOTIFICATION_KINDS));
});

test('the channel vocabulary is in-app mandatory plus optional SMTP (MW-035)', () => {
  assert.deepEqual([...NOTIFICATION_CHANNELS], ['IN_APP', 'SMTP']);
  assert.ok(Object.isFrozen(NOTIFICATION_CHANNELS));
});

test('create accepts a well-formed catalog-grounded event', () => {
  assert.deepEqual({ ...policy.authorizeCreate(event({})) }, { ok: true });
});

test('create fails closed on malformed or non-catalog events', () => {
  expectFail(policy.authorizeCreate(null), 'INVALID_REQUEST');
  expectFail(policy.authorizeCreate('event'), 'INVALID_REQUEST');
  for (const mutation of [
    { outboxEventId: '' },
    { kind: undefined },
    { resourceId: 42 },
    { recipientUserId: '   ' },
    { bodySafe: null },
    { createdAt: '' },
  ]) {
    expectFail(
      policy.authorizeCreate(event(mutation)),
      'DECISION_FACTS_REQUIRED',
    );
  }
  expectFail(
    policy.authorizeCreate(event({ kind: 'cancellation.decided.v1' })),
    'UNKNOWN_KIND',
  );
  expectFail(
    policy.authorizeCreate(event({ kind: 'meeting.SCHEDULED.v1' })),
    'UNKNOWN_KIND',
  );
});

test('viewer facts are shape-checked before anything else', () => {
  expectFail(policy.authorizeView(null), 'INVALID_REQUEST');
  expectFail(policy.authorizeView({}), 'DECISION_FACTS_REQUIRED');
  expectFail(
    policy.authorizeView({ viewerUserId: '', notificationId: 'n1' }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.authorizeView({ viewerUserId: 'u1', notificationId: '   ' }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('list-view facts: unread flag, cursor and limit are validated', () => {
  assert.deepEqual(
    { ...policy.authorizeView({ viewerUserId: 'u1' }) },
    { ok: true },
  );
  expectFail(
    policy.authorizeView({ viewerUserId: 'u1', unreadOnly: 'yes' }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.authorizeView({ viewerUserId: 'u1', cursor: 1 }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.authorizeView({ viewerUserId: 'u1', limit: -1 }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.authorizeView({ viewerUserId: 'u1', limit: 1.5 }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.authorizeView({
      viewerUserId: 'u1',
      limit: Number.POSITIVE_INFINITY,
    }),
    'DECISION_FACTS_REQUIRED',
  );
  assert.deepEqual(
    {
      ...policy.authorizeView({
        viewerUserId: 'u1',
        unreadOnly: false,
        cursor: '',
        limit: 0,
      }),
    },
    { ok: true },
  );
  assert.deepEqual(
    {
      ...policy.authorizeView({
        viewerUserId: 'u1',
        limit: Number.MAX_SAFE_INTEGER,
      }),
    },
    { ok: true },
  );
});

test('recipient match decides reading someone else\u2019s notification', () => {
  assert.deepEqual(
    { ...policy.authorizeRecipient('user-7', 'user-7') },
    { ok: true },
  );
  const denied = policy.authorizeRecipient('user-1', 'user-7');
  expectFail(denied, 'ACCESS_NOT_AUTHORIZED', true);
});

test('channel authorization accepts exactly IN_APP and SMTP', () => {
  assert.deepEqual({ ...policy.authorizeChannel('IN_APP') }, { ok: true });
  assert.deepEqual({ ...policy.authorizeChannel('SMTP') }, { ok: true });
  expectFail(policy.authorizeChannel('SLACK'), 'UNKNOWN_CHANNEL');
  expectFail(policy.authorizeChannel(''), 'DECISION_FACTS_REQUIRED');
  expectFail(policy.authorizeChannel(7), 'DECISION_FACTS_REQUIRED');
});

test('notification id/dedupe key is deterministic and collision-hardened across part boundaries', () => {
  const a = policy.composeNotificationId(
    'evt-1',
    'meeting.cancelled.v1',
    'user-7',
  );
  const b = policy.composeNotificationId(
    'evt-1',
    'meeting.cancelled.v1',
    'user-7',
  );
  assert.equal(a, b);
  assert.match(a, /^fnv1a64:[0-9a-f]{16}$/);

  const variants = [
    policy.composeNotificationId('evt-11', 'meeting.cancelled.v1', 'user-7'),
    policy.composeNotificationId('evt-1', 'meeting.created.v1', 'user-7'),
    policy.composeNotificationId('evt-1', 'meeting.cancelled.v1', 'user-77'),
    policy.composeNotificationId('evt-1|meeting.cancelled.v1', 'x', 'user-7'),
    policy.composeNotificationId('evt-1', 'meeting.cancelled.v1|x0:user-7', ''),
  ];
  const set = new Set([a, ...variants]);
  assert.equal(set.size, 6);
});

test('delivery row id is deterministic over its (notification, channel, attempt) triple', () => {
  const a = policy.composeDeliveryId('n-1', 'SMTP', 2);
  assert.equal(a, policy.composeDeliveryId('n-1', 'SMTP', 2));
  assert.match(a, /^fnv1a64:[0-9a-f]{16}$/);
  const variants = [
    policy.composeDeliveryId('n-1', 'IN_APP', 2),
    policy.composeDeliveryId('n-1', 'SMTP', 3),
    policy.composeDeliveryId('n-2', 'SMTP', 2),
    policy.composeDeliveryId('n-1|SMTP', 'x', 2),
  ];
  assert.equal(new Set([a, ...variants]).size, 5);
});

test('fanout to distinct recipients of one event yields distinct stable rows', () => {
  const old = policy.composeNotificationId(
    'evt-2',
    'meeting.manager_transferred.v1',
    'old-mgr',
  );
  const neu = policy.composeNotificationId(
    'evt-2',
    'meeting.manager_transferred.v1',
    'new-mgr',
  );
  assert.notEqual(old, neu);
  assert.equal(
    old,
    policy.composeNotificationId(
      'evt-2',
      'meeting.manager_transferred.v1',
      'old-mgr',
    ),
  );
});

test('state derives deterministically from the authoritative seenAt', () => {
  assert.equal(policy.stateFor(null), 'UNREAD');
  assert.equal(policy.stateFor('2026-10-25T10:00:00Z'), 'READ');
});

test('validateStoredRow accepts a correct row for its viewer and pins shape violations', () => {
  assert.equal(policy.validateStoredRow(row({ seenAt: null }), 'user-7'), null);
  assert.equal(
    policy.validateStoredRow(
      row({ seenAt: '2026-10-25T11:00:00Z', state: 'READ' }),
      'user-7',
    ),
    null,
  );
  expectFail(
    policy.validateStoredRow(null, 'user-7'),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.validateStoredRow('row', 'user-7'),
    'DECISION_FACTS_REQUIRED',
  );
  for (const mutation of [
    { id: undefined },
    { recipientUserId: 7 },
    { kind: '' },
    { bodySafe: null },
    { state: false },
    { createdAt: undefined },
    { seenAt: 5 },
    { seenAt: true },
  ]) {
    expectFail(
      policy.validateStoredRow(row(mutation), 'user-7'),
      'DECISION_FACTS_REQUIRED',
    );
  }
  const foreign = policy.validateStoredRow(
    row({ recipientUserId: 'user-8' }),
    'user-7',
  );
  expectFail(foreign, 'ACCESS_NOT_AUTHORIZED', true);
});

test('failure decisions are frozen and carry exactly the three contract keys', () => {
  const decision = policy.authorizeChannel('SLACK');
  expectFail(decision, 'UNKNOWN_CHANNEL');
  assert.deepEqual(Object.keys(decision).sort(), [
    'ok',
    'preventEnumeration',
    'reason',
  ]);
});
