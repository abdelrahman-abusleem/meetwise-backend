const test = require('node:test');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const {
  PostgresTranscriptConsumer,
} = require('../../libs/meetings/src/infrastructure/transcript-ingest.postgres.ts');
const {
  TranscriptIngestModule,
} = require('../../libs/meetings/src/infrastructure/transcript-ingest.module.ts');
const eventId = '11111111-1111-4111-8111-111111111111';
const meetingId = '22222222-2222-4222-8222-222222222222';
const botSessionId = '33333333-3333-4333-8333-333333333333';
const inbox = {
  id: eventId,
  meetingId,
  botSessionId,
  encryptedEvent: { synthetic: true },
};
function harness(overrides = {}) {
  const calls = [];
  let opened = 0;
  let commits = 0;
  let rollbacks = 0;
  const rows = [
    inbox,
    { lifecycle: 'IN_PROGRESS', scheduleVersion: 1 },
    { scheduleVersion: 1 },
    inbox,
    null,
    { eventId },
  ];
  for (const [index, value] of Object.entries(overrides))
    rows[Number(index)] = value;
  const tx = {
    $queryRaw: async (strings, ...values) => {
      calls.push({ sql: strings.join('?'), values });
      const row = rows[calls.length - 1];
      return row == null ? [] : [row];
    },
    $executeRaw: async () => {
      throw new Error('unexpected-write');
    },
  };
  const database = {
    $transaction: async (work, options) => {
      assert.deepEqual(options, { timeout: 10000, maxWait: 5000 });
      try {
        const result = await work(tx);
        commits++;
        return result;
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  };
  const encryption = {
    open: (_cipher, context) => {
      opened++;
      assert.deepEqual(context, {
        recordId: eventId,
        purpose: 'transcript-inbox',
        meetingId,
        botSessionId,
      });
      return JSON.stringify({ kind: 'PROVIDER_COMPLETION' });
    },
  };
  return {
    consumer: new PostgresTranscriptConsumer(database, encryption),
    database,
    encryption,
    calls,
    stats: () => ({ opened, commits, rollbacks }),
  };
}
for (const [name, overrides] of [
  ['foreign pointer', { 0: { ...inbox, id: meetingId } }],
  ['malformed meeting identity', { 0: { ...inbox, meetingId: 'invalid' } }],
  ['foreign locked inbox', { 3: { ...inbox, botSessionId: meetingId } }],
  ['undefined schedule versions', { 1: { lifecycle: 'IN_PROGRESS' }, 2: {} }],
  [
    'negative schedule versions',
    {
      1: { lifecycle: 'IN_PROGRESS', scheduleVersion: -1 },
      2: { scheduleVersion: -1 },
    },
  ],
  ['stale capture generation', { 2: { scheduleVersion: 0 } }],
  ['cancelled meeting', { 1: { lifecycle: 'CANCELLED', scheduleVersion: 1 } }],
  ['missing locked inbox', { 3: null }],
])
  test(`denies ${name} before decrypt/write`, async () => {
    const h = harness(overrides);
    await assert.rejects(h.consumer.consume(eventId));
    assert.equal(h.stats().opened, 0);
    assert.equal(h.stats().commits, 0);
    assert.equal(h.stats().rollbacks, 1);
  });
test('rejects malformed event ID without transaction or decryption', async () => {
  const h = harness();
  await assert.rejects(h.consumer.consume('invalid'));
  assert.equal(h.calls.length, 0);
  assert.equal(h.stats().opened, 0);
});
test('replay returns existing receipt without SQL writes, in one scoped transaction', async () => {
  const h = harness();
  const result = await h.consumer.consume(eventId);
  assert.equal(result.ok, true);
  assert.equal(result.k, 'ALREADY_PROCESSED');
  assert.deepEqual(h.stats(), { opened: 1, commits: 1, rollbacks: 0 });
  assert.match(h.calls[1].sql, /FOR UPDATE/);
  assert.match(h.calls[2].sql, /FOR SHARE/);
  assert.match(h.calls[3].sql, /FOR UPDATE/);
});
test('opt-in module composes explicitly supplied ports without calling them', async () => {
  let calls = 0;
  const database = {
    $transaction: async () => {
      calls++;
      throw new Error('unexpected-io');
    },
  };
  const encryption = {
    open: () => {
      calls++;
      throw new Error('unexpected-io');
    },
  };
  const module = await Test.createTestingModule({
    imports: [
      TranscriptIngestModule.registerAsync({
        useFactory: async () => ({ database, encryption }),
      }),
    ],
  }).compile();
  try {
    await module.init();
    assert.ok(module.get(PostgresTranscriptConsumer));
    assert.equal(calls, 0);
  } finally {
    await module.close();
  }
});
for (const config of [
  undefined,
  {},
  { database: {}, encryption: { open() {} } },
  { database: { $transaction() {} }, encryption: {} },
])
  test('missing transcript bindings fail closed', async () => {
    await assert.rejects(
      Test.createTestingModule({
        imports: [
          TranscriptIngestModule.registerAsync({ useFactory: () => config }),
        ],
      }).compile(),
      /transcript-composition-binding-required/,
    );
  });
