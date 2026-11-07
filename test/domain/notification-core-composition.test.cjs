const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  composeNotificationDeliveryCore,
} = require('../../libs/meetings/src/infrastructure/notification/notification-delivery-core.ts');
const {
  NodemailerSmtpDeliveryProvider,
} = require('../../libs/meetings/src/infrastructure/notification/nodemailer-smtp-delivery-provider.ts');

function fixture({
  send = async () => ({}),
  retryPolicy = null,
  failSettlement = false,
} = {}) {
  const attempts = new Map(),
    receipts = new Map(),
    messages = [],
    jobs = [];
  let pendingFailure = failSettlement;
  const repository = {
    async findInboxOutcome(consumer, eventId) {
      return receipts.get(consumer + '|' + eventId) ?? null;
    },
    async writeInboxOutcome(row) {
      const key = row.consumer + '|' + row.eventId,
        prior = receipts.get(key);
      if (prior)
        return { created: false, outcome: prior.outcome, existingId: prior.id };
      receipts.set(key, { ...row });
      return { created: true, outcome: null, existingId: null };
    },
    async loadNotificationRow(id) {
      return {
        id,
        recipientUserId: 'synthetic-user',
        kind: 'meeting.created.v1',
        resourceId: 'synthetic-meeting',
        bodySafe: 'Synthetic notification',
        state: 'UNREAD',
        createdAt: '2026-11-03T00:00:00Z',
        seenAt: null,
      };
    },
    async loadRecipientContact() {
      return 'synthetic@example.invalid';
    },
    async readChannelAttempts(notificationId, channel) {
      return [...attempts.values()]
        .filter(
          (row) =>
            row.notificationId === notificationId && row.channel === channel,
        )
        .sort((x, y) => x.attempt - y.attempt)
        .map((row) => ({ ...row }));
    },
    async reserveAttempt(row) {
      const prior = attempts.get(row.id);
      if (prior) return { reserved: false, existing: { ...prior } };
      attempts.set(row.id, { ...row });
      return { reserved: true, existing: null };
    },
    async settleAttempt(command) {
      if (pendingFailure) {
        pendingFailure = false;
        throw new Error('synthetic-settlement-fault');
      }
      const row = attempts.get(command.id);
      assert.ok(row);
      if (row.status !== command.expectedStatus)
        return { settled: false, record: { ...row } };
      const next = {
        ...row,
        status: command.nextStatus,
        externalMessageId: command.externalMessageId,
      };
      attempts.set(next.id, next);
      return { settled: true, record: next };
    },
  };
  const core = composeNotificationDeliveryCore({
    repository,
    transporter: {
      async sendMail(envelope) {
        messages.push(envelope);
        return send(envelope);
      },
    },
    fromAddress: 'synthetic-sender@example.invalid',
    queue: {
      async add(name, data, options) {
        jobs.push({ name, data, options });
      },
    },
    retryJobName: 'synthetic-retry',
    retryPolicy,
  });
  return { core, attempts, receipts, messages, jobs };
}
const turn = (overrides = {}) => ({
  kind: 'notification.created.v1',
  eventId: 'synthetic-turn',
  notificationId: 'synthetic-notification',
  channels: ['IN_APP', 'SMTP'],
  processedAt: '2026-11-03T01:00:00Z',
  ...overrides,
});

test('composed worker sends once and receipt replay has no new effects', async () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.core), true);
  const first = await f.core.worker.runTurn(turn());
  assert.equal(first.verdict, 'ACK');
  assert.equal(f.messages.length, 1);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.attempts.size, 2);
  const second = await f.core.worker.runTurn(turn());
  assert.equal(second.outcome.kind, 'REPLAYED');
  assert.equal(f.messages.length, 1);
});
test('unknown SMTP effects block resend even through a fresh event identity', async () => {
  const f = fixture({
    send: async () => {
      throw { code: 'ETIMEDOUT', command: 'CONN' };
    },
  });
  await f.core.worker.runTurn(turn());
  await f.core.worker.runTurn(turn({ eventId: 'synthetic-fresh-event' }));
  assert.equal(f.messages.length, 1);
  assert.equal(f.jobs.length, 0);
  assert.ok(
    [...f.attempts.values()].some((row) => row.status === 'UNKNOWN_EFFECT'),
  );
});
test('crash after provider acceptance leaves a pending claim that cannot resend', async () => {
  const f = fixture({ failSettlement: true });
  await assert.rejects(
    f.core.worker.runTurn(turn({ channels: ['SMTP'] })),
    /synthetic-settlement-fault/,
  );
  assert.equal(f.messages.length, 1);
  await f.core.worker.runTurn(
    turn({ eventId: 'synthetic-recovery', channels: ['SMTP'] }),
  );
  assert.equal(f.messages.length, 1);
  assert.equal(f.jobs.length, 0);
  assert.ok([...f.attempts.values()].some((row) => row.status === 'PENDING'));
});
test('provably no-effect failure schedules bounded retry with IDs-only payload', async () => {
  const f = fixture({
    send: async () => {
      throw { code: 'EENVELOPE' };
    },
    retryPolicy: {
      maxAttempts: 2,
      backoffMs: 100,
      multiplier: 2,
      maxDelayMs: 100,
    },
  });
  await f.core.worker.runTurn(turn({ channels: ['SMTP'] }));
  assert.equal(f.messages.length, 1);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].options.delay, 100);
  assert.doesNotMatch(f.jobs[0].options.jobId, /:/);
  assert.deepEqual(Object.keys(f.jobs[0].data).sort(), [
    'channels',
    'eventId',
    'kind',
    'notificationId',
    'processedAt',
  ]);
});
test('malformed delivery is dead-lettered without provider or queue effects', async () => {
  const f = fixture();
  assert.equal((await f.core.worker.runTurn(null)).verdict, 'DEAD_LETTER');
  assert.equal(f.messages.length, 0);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.attempts.size, 0);
});
for (const [code, expected] of [
  ['EAUTH', 'PERMANENT_DENIED'],
  ['ENOAUTH', 'PERMANENT_DENIED'],
  ['EENVELOPE', 'RETRYABLE_NO_EFFECT'],
  ['ETIMEDOUT', 'UNKNOWN_EFFECT'],
  ['ECONNECTION', 'UNKNOWN_EFFECT'],
  ['EMESSAGE', 'UNKNOWN_EFFECT'],
]) {
  test(`fake SMTP ${code} is classified as ${expected} after one attempt`, async () => {
    let calls = 0;
    const provider = new NodemailerSmtpDeliveryProvider({
      fromAddress: 'synthetic@example.invalid',
      transporter: {
        async sendMail() {
          calls++;
          throw { code };
        },
      },
    });
    const result = await provider.sendEmail({
      to: 'synthetic-recipient@example.invalid',
      kind: 'meeting.created.v1',
      bodySafe: 'Synthetic notification',
      attempt: 1,
    });
    assert.deepEqual(result, { outcome: expected, externalMessageId: null });
    assert.equal(calls, 1);
  });
}
test('partial SMTP rejection remains uncertain and never invents a provider receipt', async () => {
  const provider = new NodemailerSmtpDeliveryProvider({
    fromAddress: 'synthetic@example.invalid',
    transporter: {
      async sendMail() {
        return {
          rejected: ['synthetic@example.invalid'],
          messageId: 'library-header-only',
        };
      },
    },
  });
  assert.deepEqual(
    await provider.sendEmail({
      to: 'synthetic@example.invalid',
      kind: 'meeting.created.v1',
      bodySafe: 'Synthetic',
      attempt: 1,
    }),
    { outcome: 'UNKNOWN_EFFECT', externalMessageId: null },
  );
});

for (const existingId of [null, undefined]) {
  test(`lost receipt race rejects missing winner identity: ${existingId}`, async () => {
    const f = fixture();
    f.core.repository.writeInboxOutcome = async () => ({
      created: false,
      outcome: 'synthetic-winner',
      existingId,
    });
    await assert.rejects(
      f.core.worker.runTurn(turn({ channels: ['IN_APP'] })),
      /notification-delivery-receipt-identity-mismatch/,
    );
    assert.equal(f.messages.length, 0);
  });
}
test('lost receipt race replays only the exact bound winner identity', async () => {
  const f = fixture();
  f.core.repository.writeInboxOutcome = async (row) => ({
    created: false,
    outcome: 'synthetic-winner',
    existingId: row.id,
  });
  const result = await f.core.worker.runTurn(turn({ channels: ['IN_APP'] }));
  assert.equal(result.outcome.kind, 'REPLAYED');
  assert.equal(result.outcome.outcome, 'synthetic-winner');
});
