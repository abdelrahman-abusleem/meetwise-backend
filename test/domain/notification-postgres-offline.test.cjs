const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresNotificationDeliveryRepository,
} = require('../../libs/meetings/src/infrastructure/notification/postgres-notification-delivery.repository.ts');
const {
  composeNotificationDeliveryCore,
} = require('../../libs/meetings/src/infrastructure/notification/notification-delivery-core.ts');
const {
  NotificationDeliveryPolicy,
} = require('../../libs/meetings/src/domain/notification-delivery.policy.ts');
const USER = '00000000-0000-4000-8000-000000000001';
const notification = () => ({
  id: 'synthetic-notification',
  recipientUserId: USER,
  kind: 'meeting.created.v1',
  resourceId: 'synthetic-meeting',
  bodySafe: 'Synthetic safe notification',
  state: 'UNREAD',
  createdAt: new Date('2026-11-03T00:00:00Z'),
  seenAt: null,
});
const attempt = (overrides = {}) => ({
  id: 'synthetic-attempt',
  notificationId: 'synthetic-notification',
  channel: 'SMTP',
  attempt: 1,
  status: 'PENDING',
  externalMessageId: null,
  ...overrides,
});

function fixture({ transform = (_sql, _values, result) => result } = {}) {
  let receipts = new Map(),
    attempts = new Map(),
    txDepth = 0,
    tail = Promise.resolve();
  const calls = [],
    notes = new Map([['synthetic-notification', notification()]]),
    users = new Map([
      [USER, { id: USER, email: 'synthetic@example.invalid', isActive: true }],
    ]);
  async function query(strings, ...values) {
    assert.ok(Array.isArray(strings.raw));
    const sql = strings
      .reduce(
        (text, part, index) => text + (index ? `$${index}` : '') + part,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim();
    calls.push({ sql, values, txDepth });
    let result;
    if (sql.startsWith('INSERT INTO inbox_receipts')) {
      const [id, consumer, eventId, processedAt, outcome] = values,
        key = consumer + '|' + eventId;
      if (receipts.has(key)) result = [];
      else {
        if ([...receipts.values()].some((row) => row.id === id))
          throw new Error('synthetic-receipt-id-collision');
        receipts.set(key, {
          id,
          consumer,
          eventId,
          processedAt: new Date(processedAt),
          outcome,
        });
        result = [{ id }];
      }
    } else if (sql.includes('FROM inbox_receipts'))
      result = receipts.has(values[0] + '|' + values[1])
        ? [{ ...receipts.get(values[0] + '|' + values[1]) }]
        : [];
    else if (
      sql.includes('FROM notifications') &&
      !sql.includes('INSERT INTO notification_deliveries')
    )
      result = notes.has(values[0]) ? [{ ...notes.get(values[0]) }] : [];
    else if (sql.includes('FROM users'))
      result =
        users.has(values[0]) &&
        (!sql.includes('is_active = true') || users.get(values[0]).isActive)
          ? [{ ...users.get(values[0]) }]
          : [];
    else if (sql.includes('INSERT INTO notification_deliveries')) {
      const eligibleQuery = sql.startsWith('WITH eligible');
      const [id, notificationId, channel, ordinal, status] = eligibleQuery
        ? [values[1], values[0], values[2], values[3], values[4]]
        : values;
      const eligible =
        !eligibleQuery ||
        users.get(notes.get(notificationId)?.recipientUserId)?.isActive ===
          true;
      if (
        !eligible ||
        [...attempts.values()].some(
          (row) =>
            row.notificationId === notificationId &&
            row.channel === channel &&
            row.attempt === ordinal,
        )
      )
        result = [];
      else {
        if (attempts.has(id)) throw new Error('synthetic-attempt-id-collision');
        attempts.set(id, {
          id,
          notificationId,
          channel,
          attempt: ordinal,
          status,
          externalMessageId: null,
        });
        result = [{ id }];
      }
    } else if (sql.startsWith('UPDATE notification_deliveries')) {
      const [status, externalMessageId, id, expected] = values,
        row = attempts.get(id);
      if (!row || row.status !== expected) result = [];
      else {
        const next = { ...row, status, externalMessageId };
        attempts.set(id, next);
        result = [{ ...next }];
      }
    } else if (sql.includes('FROM notification_deliveries')) {
      result = [...attempts.values()]
        .filter((row) =>
          sql.includes('WHERE id =')
            ? row.id === values[0]
            : row.notificationId === values[0] &&
              row.channel === values[1] &&
              (values.length < 3 || row.attempt === values[2]),
        )
        .sort((a, b) => a.attempt - b.attempt)
        .map((row) => ({ ...row }));
    } else throw new Error('unrecognized-recording-query');
    return transform(sql, values, result);
  }
  const runner = {
    $queryRaw: query,
    $transaction(work) {
      const pending = tail.then(async () => {
        const beforeReceipts = structuredClone(receipts),
          beforeAttempts = structuredClone(attempts);
        txDepth++;
        try {
          return await work({ $queryRaw: query });
        } catch (error) {
          receipts = beforeReceipts;
          attempts = beforeAttempts;
          throw error;
        } finally {
          txDepth--;
        }
      });
      tail = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
  };
  return {
    repository: new PostgresNotificationDeliveryRepository({ runner }),
    calls,
    notes,
    users,
    attempts: () => attempts,
    receipts: () => receipts,
    txDepth: () => txDepth,
  };
}
test('constructor has no database IO and rejects incomplete runner', () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => new PostgresNotificationDeliveryRepository({ runner: {} }),
    /runner-required/,
  );
});
test('native notification dates and addressed recipient map without exposing diagnostics', async () => {
  const f = fixture(),
    row = await f.repository.loadNotificationRow('synthetic-notification');
  assert.equal(row.createdAt, '2026-11-03T00:00:00.000Z');
  assert.equal(
    await f.repository.loadRecipientContact(USER),
    'synthetic@example.invalid',
  );
  assert.equal(await f.repository.loadNotificationRow('missing'), null);
  assert.match(f.calls[0].sql, /FROM notifications/);
  assert.match(f.calls[1].sql, /FROM users/);
  assert.match(f.calls[1].sql, /is_active = true/);
});
test('opaque retry event IDs remain text and first receipt wins under concurrent controlled writes', async () => {
  const f = fixture(),
    eventId = new NotificationDeliveryPolicy().composeRetryJobEventId(
      'synthetic-event',
      1,
    );
  const receipt = {
    id: 'synthetic-receipt',
    consumer: 'notification-delivery',
    eventId,
    processedAt: '2026-11-03T00:00:00Z',
    outcome: '{"kind":"synthetic"}',
  };
  const results = await Promise.all([
    f.repository.writeInboxOutcome(receipt),
    f.repository.writeInboxOutcome({
      ...receipt,
      outcome: '{"kind":"different"}',
    }),
  ]);
  assert.equal(results.filter((row) => row.created).length, 1);
  assert.equal(results.find((row) => !row.created).outcome, receipt.outcome);
  assert.equal(
    (await f.repository.findInboxOutcome(receipt.consumer, eventId)).id,
    receipt.id,
  );
  const query = f.calls.find((call) =>
    call.sql.startsWith('INSERT INTO inbox_receipts'),
  );
  assert.match(query.sql, /ON CONFLICT \(consumer,event_id\) DO NOTHING/);
  assert.equal(query.sql.includes(eventId), false);
  assert.doesNotMatch(query.sql, /event_id[^,]*::uuid|source_outbox_event_id/);
  assert.equal(query.txDepth, 1);
});
test('reservation is a single controlled winner and loser gets actual same attempt', async () => {
  const f = fixture(),
    row = attempt();
  const results = await Promise.all([
    f.repository.reserveAttempt(row),
    f.repository.reserveAttempt(row),
  ]);
  assert.equal(results.filter((row) => row.reserved).length, 1);
  assert.deepEqual(results.find((row) => !row.reserved).existing, row);
  assert.deepEqual(
    await f.repository.readChannelAttempts(row.notificationId, row.channel),
    [row],
  );
  assert.ok(
    f.calls.some((call) =>
      /ON CONFLICT \(notification_id,channel,attempt\) DO NOTHING/.test(
        call.sql,
      ),
    ),
  );
  const insert = f.calls.find((call) =>
    call.sql.includes('INSERT INTO notification_deliveries'),
  );
  assert.match(insert.sql, /u.is_active = true/);
  assert.match(insert.sql, /FOR SHARE OF n,u/);
});

test('inactive row returned despite the SQL predicate is rejected as corrupt', async () => {
  const f = fixture({
    transform: (sql, _values, result) =>
      sql.includes('FROM users')
        ? [{ id: USER, email: 'synthetic@example.invalid', isActive: false }]
        : result,
  });
  await assert.rejects(
    f.repository.loadRecipientContact(USER),
    /notification-postgres-row-invalid/,
  );
});
test('settlement CAS wins once and preserves terminal result on subsequent attempt', async () => {
  const f = fixture();
  await f.repository.reserveAttempt(attempt());
  const command = {
    id: 'synthetic-attempt',
    expectedStatus: 'PENDING',
    nextStatus: 'SENT',
    externalMessageId: null,
  };
  const first = await f.repository.settleAttempt(command),
    second = await f.repository.settleAttempt({
      ...command,
      nextStatus: 'UNKNOWN_EFFECT',
    });
  assert.equal(first.settled, true);
  assert.equal(second.settled, false);
  assert.equal(second.record.status, 'SENT');
  const query = f.calls.find((call) =>
    call.sql.startsWith('UPDATE notification_deliveries'),
  );
  assert.match(query.sql, /WHERE id = \$3 AND status = \$4/);
  assert.equal(query.txDepth, 1);
});
test('missing addressed settlement throws rather than fabricating a record', async () => {
  const f = fixture();
  await assert.rejects(
    f.repository.settleAttempt({
      id: 'missing',
      expectedStatus: 'PENDING',
      nextStatus: 'SENT',
      externalMessageId: null,
    }),
    /notification-postgres-row-invalid/,
  );
});
for (const overrides of [
  { status: 'SENT' },
  { channel: 'OTHER' },
  { attempt: 0 },
  { externalMessageId: 'unexpected' },
])
  test('malformed reservation refuses before SQL', async () => {
    const f = fixture();
    await assert.rejects(f.repository.reserveAttempt(attempt(overrides)));
    assert.equal(f.calls.length, 0);
  });
for (const overrides of [
  { id: 'foreign' },
  { state: 'READ' },
  { createdAt: new Date(NaN) },
  { kind: 'unsupported' },
])
  test('corrupt notification row refuses with fixed diagnostic', async () => {
    const f = fixture();
    f.notes.set('synthetic-notification', { ...notification(), ...overrides });
    await assert.rejects(
      f.repository.loadNotificationRow('synthetic-notification'),
      (error) => error.message === 'notification-postgres-row-invalid',
    );
  });
test('corrupt insert reply rolls back the controlled reservation', async () => {
  const f = fixture({
    transform: (sql, _values, result) =>
      sql.includes('INSERT INTO notification_deliveries')
        ? [{ id: 'foreign' }]
        : result,
  });
  await assert.rejects(
    f.repository.reserveAttempt(attempt()),
    /notification-postgres-row-invalid/,
  );
  assert.equal(f.attempts().size, 0);
});

for (const deactivateAt of ['initial', 'after-contact'])
  test(`inactive recipient refuses SMTP and reservation: ${deactivateAt}`, async () => {
    let f,
      sends = 0;
    f = fixture({
      transform: (sql, _values, result) => {
        if (deactivateAt === 'after-contact' && sql.includes('FROM users'))
          f.users.get(USER).isActive = false;
        return result;
      },
    });
    if (deactivateAt === 'initial') f.users.get(USER).isActive = false;
    const core = composeNotificationDeliveryCore({
      repository: f.repository,
      transporter: {
        async sendMail() {
          sends++;
          return {};
        },
      },
      fromAddress: 'synthetic-sender@example.invalid',
      queue: {
        async add() {
          throw new Error('unexpected-retry');
        },
      },
      retryJobName: 'synthetic',
      retryPolicy: null,
    });
    await assert.rejects(
      core.worker.runTurn({
        kind: 'notification.created.v1',
        eventId: 'synthetic-active-check',
        notificationId: 'synthetic-notification',
        channels: ['SMTP'],
        processedAt: '2026-11-04T00:00:00Z',
      }),
      /recipient-(?:unresolvable|unavailable)/,
    );
    assert.equal(sends, 0);
    assert.equal(f.attempts().size, 0);
    assert.equal(f.receipts().size, 0);
  });

test('inactive recipient cannot win an IN_APP reservation', async () => {
  const f = fixture();
  f.users.get(USER).isActive = false;
  await assert.rejects(
    f.repository.reserveAttempt(attempt({ channel: 'IN_APP' })),
    /recipient-unavailable/,
  );
  assert.equal(f.attempts().size, 0);
});
for (const mode of ['confirmed', 'unknown'])
  test(`actual core over recording SQL adapter: ${mode}, replay never resends`, async () => {
    const f = fixture(),
      messages = [],
      jobs = [];
    const core = composeNotificationDeliveryCore({
      repository: f.repository,
      transporter: {
        async sendMail(envelope) {
          assert.equal(f.txDepth(), 0);
          messages.push(envelope);
          if (mode === 'unknown')
            throw Object.assign(new Error('synthetic-unavailability'), {
              code: 'ETIMEDOUT',
            });
          return {};
        },
      },
      fromAddress: 'synthetic-sender@example.invalid',
      queue: {
        async add(...args) {
          jobs.push(args);
        },
      },
      retryJobName: 'synthetic-delivery',
      retryPolicy: null,
    });
    const turn = {
      kind: 'notification.created.v1',
      eventId: 'synthetic-turn',
      notificationId: 'synthetic-notification',
      channels: ['IN_APP', 'SMTP'],
      processedAt: '2026-11-03T00:00:00Z',
    };
    const first = await core.worker.runTurn(turn),
      replay = await core.worker.runTurn(turn);
    assert.equal(first.verdict, 'ACK');
    assert.equal(replay.outcome.kind, 'REPLAYED');
    assert.equal(messages.length, 1);
    assert.equal(jobs.length, 0);
    const smtp = [...f.attempts().values()].find(
      (row) => row.channel === 'SMTP',
    );
    assert.equal(smtp.status, mode === 'confirmed' ? 'SENT' : 'UNKNOWN_EFFECT');
    if (mode === 'unknown')
      await core.worker.runTurn({
        ...turn,
        eventId: 'synthetic-redelivery',
        channels: ['SMTP'],
      });
    assert.equal(messages.length, 1);
  });

test('foreign receipt lookup facts refuse without returning another consumer outcome', async () => {
  const f = fixture({
    transform: (sql, _values, result) =>
      sql.includes('SELECT id, consumer')
        ? [
            {
              id: 'receipt',
              consumer: 'foreign',
              eventId: 'event',
              processedAt: new Date(),
              outcome: '{}',
            },
          ]
        : result,
  });
  await assert.rejects(
    f.repository.findInboxOutcome('notification-delivery', 'event'),
    /notification-postgres-row-invalid/,
  );
});
test('existing receipt winner identity is preserved for service ownership validation', async () => {
  const f = fixture(),
    receipt = {
      id: 'first-receipt',
      consumer: 'notification-delivery',
      eventId: 'event',
      processedAt: '2026-11-03T00:00:00Z',
      outcome: '{"first":true}',
    };
  await f.repository.writeInboxOutcome(receipt);
  assert.deepEqual(
    await f.repository.writeInboxOutcome({
      ...receipt,
      id: 'different-receipt',
      outcome: '{}',
    }),
    { created: false, outcome: receipt.outcome, existingId: receipt.id },
  );
});
test('conflicting reservation identity is surfaced and stored winner preserved', async () => {
  const f = fixture(),
    stored = attempt({ id: 'foreign-id' });
  f.attempts().set(stored.id, stored);
  await assert.rejects(
    f.repository.reserveAttempt(attempt()),
    /notification-postgres-row-invalid/,
  );
  assert.equal(f.attempts().size, 1);
  assert.deepEqual(f.attempts().get(stored.id), stored);
});
for (const boundary of ['settlement', 'receipt'])
  test(`delivery failure after fake SMTP acceptance never blindly resends: ${boundary}`, async () => {
    let fault = true,
      sends = 0;
    const f = fixture({
      transform: (sql, _values, result) => {
        const target =
          boundary === 'settlement'
            ? sql.startsWith('UPDATE notification_deliveries')
            : sql.startsWith('INSERT INTO inbox_receipts');
        if (fault && target) {
          fault = false;
          throw new Error('synthetic-storage-fault');
        }
        return result;
      },
    });
    const core = composeNotificationDeliveryCore({
      repository: f.repository,
      transporter: {
        async sendMail() {
          assert.equal(f.txDepth(), 0);
          sends++;
          return {};
        },
      },
      fromAddress: 'synthetic-sender@example.invalid',
      queue: {
        async add() {
          throw new Error('unexpected-retry');
        },
      },
      retryJobName: 'synthetic',
      retryPolicy: null,
    });
    const turn = {
      kind: 'notification.created.v1',
      eventId: 'synthetic-turn',
      notificationId: 'synthetic-notification',
      channels: ['SMTP'],
      processedAt: '2026-11-03T00:00:00Z',
    };
    await assert.rejects(core.worker.runTurn(turn), /synthetic-storage-fault/);
    const result = await core.worker.runTurn(turn);
    assert.equal(sends, 1);
    assert.equal(result.verdict, 'ACK');
    assert.equal(
      JSON.stringify(result).includes('synthetic@example.invalid'),
      false,
    );
    assert.equal(
      JSON.stringify(result).includes('Synthetic safe notification'),
      false,
    );
  });
