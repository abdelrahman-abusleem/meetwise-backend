'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  NotificationRegistryService,
} = require('../../src/application/notification.service.ts');
const {
  NotificationPolicy,
} = require('../../src/domain/notification-create.policy.ts');

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

function fakeRepository() {
  const rows = new Map();
  const attempts = new Map();
  const calls = [];
  return {
    calls,
    rows,
    async insertNotification(record) {
      calls.push({ op: 'insertNotification', id: record.id });
      if (rows.has(record.id)) {
        const existing = rows.get(record.id);
        if (
          existing.kind !== record.kind ||
          existing.recipientUserId !== record.recipientUserId
        ) {
          throw new Error('contract: digest collision across triples');
        }
        return { record: { ...existing }, created: false };
      }
      rows.set(record.id, { ...record });
      return { record: { ...record }, created: true };
    },
    async findNotification(id) {
      calls.push({ op: 'findNotification', id });
      const rowRow = rows.get(id);
      return rowRow ? { ...rowRow } : null;
    },
    async listForRecipient(recipientUserId, unreadOnly, cursor, limit) {
      calls.push({
        op: 'listForRecipient',
        recipientUserId,
        unreadOnly,
        cursor,
        limit,
      });
      const items = [...rows.values()]
        .filter((r) => r.recipientUserId === recipientUserId)
        .filter((r) => (unreadOnly ? r.seenAt === null : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => ({ ...r }));
      const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
      const capped =
        typeof limit === 'number' && limit >= 0
          ? items.slice(start, start + limit)
          : items.slice(start);
      const end = start + capped.length;
      return {
        items: capped,
        nextCursor: end < items.length ? String(end) : null,
      };
    },
    async markSeen(id, seenAt) {
      calls.push({ op: 'markSeen', id, seenAt });
      const rowRow = rows.get(id);
      if (rowRow === undefined) {
        throw new Error('contract: row must exist');
      }
      if (rowRow.seenAt !== null) {
        return { seenAt: rowRow.seenAt, updated: false };
      }
      rowRow.seenAt = seenAt;
      rowRow.state = 'READ';
      return { seenAt: rowRow.seenAt, updated: true };
    },
    async nextAttemptNumber(notificationId, channel) {
      calls.push({ op: 'nextAttemptNumber', notificationId, channel });
      let max = 0;
      for (const key of attempts.keys()) {
        const [n, c, a] = key.split('|');
        if (n === notificationId && c === channel) {
          max = Math.max(max, Number.parseInt(a, 10));
        }
      }
      return max + 1;
    },
    async recordDeliveryAttempt(attempt) {
      calls.push({ op: 'recordDeliveryAttempt', attempt: { ...attempt } });
      const key = `${attempt.notificationId}|${attempt.channel}|${attempt.attempt}`;
      if (attempts.has(key)) {
        throw new Error(
          'contract: unique (notificationId,channel,attempt) violated',
        );
      }
      attempts.set(key, { ...attempt });
      return { ...attempt };
    },
  };
}

function svc() {
  const repo = fakeRepository();
  return { repo, service: new NotificationRegistryService(repo) };
}

test('createNotification persists a durable in-app row (durable-first, no delivery claim)', async () => {
  const { repo, service } = svc();
  const result = await service.createNotification({ event: event({}) });
  assert.equal(result.ok, true);
  assert.match(result.notificationId, /^fnv1a64:[0-9a-f]{16}$/);
  assert.deepEqual(
    { ...repo.rows.get(result.notificationId) },
    {
      id: result.notificationId,
      recipientUserId: 'user-7',
      kind: 'meeting.cancelled.v1',
      resourceId: 'meeting-9',
      bodySafe: 'Meeting was cancelled.',
      state: 'UNREAD',
      createdAt: '2026-10-25T10:00:00Z',
      seenAt: null,
    },
  );
});

test('replaying the same event+recipient resolves to the SAME row (idempotent duplicate delivery)', async () => {
  const { repo, service } = svc();
  const first = await service.createNotification({ event: event({}) });
  const replay = await service.createNotification({ event: event({}) });
  assert.deepEqual(
    { ...replay },
    {
      ok: true,
      notificationId: first.notificationId,
      created: false,
    },
  );
  assert.equal(repo.rows.size, 1, 'no duplicate row was persisted');
});

test('fanout: same event to old and new manager creates two independent rows', async () => {
  const { repo, service } = svc();
  await service.createNotification({
    event: event({ recipientUserId: 'old-mgr' }),
  });
  await service.createNotification({
    event: event({ recipientUserId: 'new-mgr' }),
  });
  assert.equal(repo.rows.size, 2);
});

test('repository failures propagate without silent suppression', async () => {
  const repo = {
    async insertNotification() {
      throw new Error('db-lost');
    },
  };
  const service = new NotificationRegistryService(repo);
  await assert.rejects(
    () => service.createNotification({ event: event({}) }),
    (error) => error instanceof Error && error.message === 'db-lost',
  );
});

test('a digest collision across DIFFERENT triples propagates as the contract defect it is', async () => {
  const repo = {
    async insertNotification() {
      throw new Error('contract: digest collision across triples');
    },
  };
  const service = new NotificationRegistryService(repo);
  await assert.rejects(
    () => service.createNotification({ event: event({}) }),
    (error) => error instanceof Error && /digest collision/.test(error.message),
  );
});

test('listForRecipient returns ONLY the viewer\u2019s rows, every row policy-validated', async () => {
  const { repo, service } = svc();
  await service.createNotification({
    event: event({ recipientUserId: 'user-7' }),
  });
  await service.createNotification({
    event: event({
      outboxEventId: 'outbox-0002',
      recipientUserId: 'user-8',
      bodySafe: 'other user row',
    }),
  });
  const page = await service.listForRecipient({ viewerUserId: 'user-7' });
  assert.equal(page.ok, true);
  assert.equal(page.notifications.length, 1);
  assert.equal(page.notifications[0].recipientUserId, 'user-7');
  assert.equal(page.notifications[0].bodySafe, 'Meeting was cancelled.');
  assert.ok(Object.isFrozen(page));
  assert.ok(Object.isFrozen(page.notifications));
  assert.ok(page.notifications.every((r) => Object.isFrozen(r)));
});

test('a genuinely leaky adapter (foreign row in page) fails the whole listing loudly', async () => {
  const ownRow = row({ id: 'n-own' });
  const foreignRow = row({ id: 'n-foreign', recipientUserId: 'user-8' });
  const leakyRepo = {
    async listForRecipient() {
      return { items: [ownRow, foreignRow], nextCursor: null };
    },
  };
  const service = new NotificationRegistryService(leakyRepo);
  const leaky = await service.listForRecipient({ viewerUserId: 'user-7' });
  assert.deepEqual(
    { ...leaky },
    {
      ok: false,
      reason: 'ACCESS_NOT_AUTHORIZED',
      preventEnumeration: true,
    },
  );
});

test('a contract-breaking adapter (garbage row shape) fails closed, never silently filtered', async () => {
  for (const mutation of [
    { id: undefined },
    { kind: 7 },
    { state: null },
    { createdAt: 42 },
    { seenAt: 5 },
    { bodySafe: undefined },
  ]) {
    const brokenRepo = {
      async listForRecipient() {
        return { items: [row(mutation)], nextCursor: null };
      },
    };
    const service = new NotificationRegistryService(brokenRepo);
    const denied = await service.listForRecipient({ viewerUserId: 'user-7' });
    assert.deepEqual(
      { ...denied },
      {
        ok: false,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      },
    );
  }
  const nullRowRepo = {
    async listForRecipient() {
      return { items: [null], nextCursor: null };
    },
  };
  const service = new NotificationRegistryService(nullRowRepo);
  const denied = await service.listForRecipient({ viewerUserId: 'user-7' });
  assert.deepEqual(
    { ...denied },
    {
      ok: false,
      reason: 'DECISION_FACTS_REQUIRED',
      preventEnumeration: false,
    },
  );
});

test('unreadOnly + cursor/limit pass through (API row 122 params); unread filters seen rows', async () => {
  const { repo, service } = svc();
  await service.createNotification({ event: event({}) });
  const second = await service.createNotification({
    event: event({ outboxEventId: 'outbox-0003' }),
  });
  const seen = await service.markRead({
    viewerUserId: 'user-7',
    notificationId: second.notificationId,
    seenAt: '2026-10-25T11:00:00Z',
  });
  assert.equal(seen.ok, true);
  const unreadPage = await service.listForRecipient({
    viewerUserId: 'user-7',
    unreadOnly: true,
  });
  assert.equal(unreadPage.ok, true);
  assert.equal(unreadPage.notifications.length, 1);
  assert.equal(unreadPage.notifications[0].seenAt, null);
  const first = await service.listForRecipient({
    viewerUserId: 'user-7',
    unreadOnly: false,
    cursor: '0',
    limit: 1,
  });
  assert.equal(first.notifications.length, 1);
  assert.equal(first.nextCursor, '1');
  const secondPage = await service.listForRecipient({
    viewerUserId: 'user-7',
    unreadOnly: false,
    cursor: '1',
    limit: 1,
  });
  assert.equal(secondPage.notifications.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.notEqual(
    first.notifications[0].seenAt,
    secondPage.notifications[0].seenAt,
  );
  const lastCall = repo.calls[repo.calls.length - 1];
  assert.deepEqual(lastCall, {
    op: 'listForRecipient',
    recipientUserId: 'user-7',
    unreadOnly: false,
    cursor: '1',
    limit: 1,
  });
});

test('list facts fail closed before repository access', async () => {
  for (const query of [
    null,
    { unreadOnly: 'yes', viewerUserId: 'u1' },
    { limit: -5, viewerUserId: 'u1' },
    { limit: Number.NaN, viewerUserId: 'u1' },
  ]) {
    const { repo, service } = svc();
    const page = await service.listForRecipient(query);
    assert.equal(page.ok, false);
    assert.equal(page.reason, 'DECISION_FACTS_REQUIRED');
    assert.equal(page.preventEnumeration, false);
    assert.equal(repo.calls.length, 0);
  }
});

test('markRead: first write wins, replay keeps the FIRST timestamp', async () => {
  const { service } = svc();
  const created = await service.createNotification({ event: event({}) });
  const first = await service.markRead({
    viewerUserId: 'user-7',
    notificationId: created.notificationId,
    seenAt: '2026-10-25T11:00:00Z',
  });
  assert.deepEqual(
    { ...first },
    {
      ok: true,
      alreadySeen: false,
      seenAt: '2026-10-25T11:00:00Z',
    },
  );
  const replay = await service.markRead({
    viewerUserId: 'user-7',
    notificationId: created.notificationId,
    seenAt: '2026-10-25T12:00:00Z',
  });
  assert.deepEqual(
    { ...replay },
    {
      ok: true,
      alreadySeen: true,
      seenAt: '2026-10-25T11:00:00Z',
    },
  );
});

test('markRead exposes the shared anti-probing denial for missing AND foreign ids', async () => {
  const { service } = svc();
  await service.createNotification({ event: event({}) });
  const foreign = await service.createNotification({
    event: event({ recipientUserId: 'user-other' }),
  });
  for (const id of ['does-not-exist', foreign.notificationId]) {
    const denied = await service.markRead({
      viewerUserId: 'user-7',
      notificationId: id,
      seenAt: '2026-10-25T11:00:00Z',
    });
    assert.deepEqual(
      { ...denied },
      {
        ok: false,
        reason: 'ACCESS_NOT_AUTHORIZED',
        preventEnumeration: true,
      },
    );
  }
});

test('markRead requires a durable seenAt fact and valid viewer shape first', async () => {
  const { repo, service } = svc();
  for (const query of [
    null,
    { viewerUserId: '', notificationId: 'n', seenAt: 'x' },
    { viewerUserId: 'user-7', notificationId: 'n', seenAt: '   ' },
  ]) {
    const result = await service.markRead(query);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'DECISION_FACTS_REQUIRED');
    assert.equal(repo.calls.length, 0);
  }
});

test('a concurrent first-writer between find and write is reported as alreadySeen (race-aware)', async () => {
  const racingRepo = {
    async findNotification() {
      return row({ id: 'n-race', seenAt: null, state: 'UNREAD' });
    },
    async markSeen() {
      return { seenAt: '2026-10-25T10:59:59Z', updated: false };
    },
  };
  const service = new NotificationRegistryService(racingRepo);
  const result = await service.markRead({
    viewerUserId: 'user-7',
    notificationId: 'n-race',
    seenAt: '2026-10-25T11:00:00Z',
  });
  assert.deepEqual(
    { ...result },
    {
      ok: true,
      alreadySeen: true,
      seenAt: '2026-10-25T10:59:59Z',
    },
  );
});

test('delivery attempts are numbered + identified per channel (tracked independently)', async () => {
  const { repo, service } = svc();
  const created = await service.createNotification({ event: event({}) });
  const inApp = await service.recordDeliveryAttempt({
    notificationId: created.notificationId,
    channel: 'IN_APP',
    status: 'SUCCEEDED',
  });
  assert.equal(inApp.ok, true);
  assert.deepEqual(
    { ...inApp.attempt },
    {
      id: inApp.attempt.id,
      notificationId: created.notificationId,
      channel: 'IN_APP',
      attempt: 1,
      status: 'SUCCEEDED',
      externalMessageId: null,
    },
  );
  assert.match(inApp.attempt.id, /^fnv1a64:[0-9a-f]{16}$/);
  const smtpFail = await service.recordDeliveryAttempt({
    notificationId: created.notificationId,
    channel: 'SMTP',
    status: 'FAILED',
  });
  assert.equal(smtpFail.attempt.attempt, 1);
  assert.equal(smtpFail.attempt.channel, 'SMTP');
  const smtpRetry = await service.recordDeliveryAttempt({
    notificationId: created.notificationId,
    channel: 'SMTP',
    status: 'SUCCEEDED',
    externalMessageId: 'smtp-msg-1',
  });
  assert.equal(smtpRetry.attempt.attempt, 2);
  assert.equal(smtpRetry.attempt.externalMessageId, 'smtp-msg-1');
  assert.notEqual(smtpFail.attempt.id, smtpRetry.attempt.id);
  assert.equal(inApp.attempt.id === smtpFail.attempt.id, false);
  const stored = repo.rows.get(created.notificationId);
  assert.equal(stored.seenAt, null);
  assert.equal(stored.state, 'UNREAD');
});

test('a failed SMTP attempt never mutates the durable in-app row (FM-25)', async () => {
  const { repo, service } = svc();
  const created = await service.createNotification({ event: event({}) });
  await service.recordDeliveryAttempt({
    notificationId: created.notificationId,
    channel: 'SMTP',
    status: 'FAILED',
  });
  const storedRow = repo.rows.get(created.notificationId);
  assert.equal(storedRow.state, 'UNREAD');
  assert.equal(storedRow.seenAt, null);
  assert.equal(storedRow.bodySafe, 'Meeting was cancelled.');
});

test('delivery attempts fail closed on unknown channels, unknown notifications, garbage facts', async () => {
  const { service } = svc();
  const created = await service.createNotification({ event: event({}) });
  for (const [query, expected] of [
    [{ channel: 7, status: 'SUCCEEDED' }, 'DECISION_FACTS_REQUIRED'],
    [{ channel: '', status: 'SUCCEEDED' }, 'DECISION_FACTS_REQUIRED'],
    [{ channel: 'SLACK', status: 'SUCCEEDED' }, 'UNKNOWN_CHANNEL'],
    [{ status: '   ', channel: 'SMTP' }, 'DECISION_FACTS_REQUIRED'],
    [
      { externalMessageId: 5, status: 'SUCCEEDED', channel: 'SMTP' },
      'DECISION_FACTS_REQUIRED',
    ],
  ]) {
    const denied = await service.recordDeliveryAttempt({
      notificationId: created.notificationId,
      ...query,
    });
    assert.deepEqual(
      { ...denied },
      {
        ok: false,
        reason: expected,
        preventEnumeration: false,
      },
    );
  }
  const missing = await service.recordDeliveryAttempt({
    notificationId: 'missing-1',
    channel: 'SMTP',
    status: 'FAILED',
  });
  assert.deepEqual(
    { ...missing },
    {
      ok: false,
      reason: 'NOTIFICATION_NOT_FOUND',
      preventEnumeration: false,
    },
  );
});

test('an injected policy verdict is actually used (non-tautological injection)', async () => {
  const flipped = Object.freeze({
    ok: false,
    reason: 'UNKNOWN_KIND',
    preventEnumeration: false,
  });
  const stubPolicy = { authorizeCreate: () => flipped };
  const service = new NotificationRegistryService(fakeRepository(), stubPolicy);
  const denied = await service.createNotification({ event: event({}) });
  assert.deepEqual({ ...denied }, { ...flipped });
});

test('list result columns are whitelisted to exactly the 8 ERD line 104 columns', async () => {
  const richRepo = {
    async listForRecipient() {
      return {
        items: [row({ id: 'rich', extraAdapterColumn: 'select-*-leak' })],
        nextCursor: null,
      };
    },
  };
  const service = new NotificationRegistryService(richRepo);
  const page = await service.listForRecipient({ viewerUserId: 'user-7' });
  assert.equal(page.ok, true);
  assert.equal(Object.keys(page.notifications[0]).length, 8);
  assert.equal('extraAdapterColumn' in page.notifications[0], false);
  assert.deepEqual(Object.keys(page.notifications[0]).sort(), [
    'bodySafe',
    'createdAt',
    'id',
    'kind',
    'recipientUserId',
    'resourceId',
    'seenAt',
    'state',
  ]);
  assert.ok(Object.isFrozen(page.notifications));
  assert.ok(Object.isFrozen(page.notifications[0]));
});
