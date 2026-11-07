const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const {
  PostgresTranscriptConsumer,
} = require('../../libs/meetings/src/infrastructure/transcript-ingest.postgres.ts');
const {
  TranscriptEnvelope,
} = require('../../libs/meetings/src/infrastructure/transcript-envelope.ts');
const eventId = '11111111-1111-4111-8111-111111111111';
const meetingId = '22222222-2222-4222-8222-222222222222';
const botSessionId = '33333333-3333-4333-8333-333333333333';
function model(failAt, options = {}) {
  const key = randomBytes(32);
  const encryption = new TranscriptEnvelope({
    activeVersion: () => 'test-only',
    keyFor: () => key,
  });
  const event = options.event ?? {
    kind: 'SEGMENT',
    segment: {
      ordinal: 0,
      startMs: 0,
      endMs: 50,
      contentHash: 'a'.repeat(64),
      textEncryptedRef: eventId,
      text: 'synthetic private marker',
    },
  };
  const encryptedEvent = encryption.seal(JSON.stringify(event), {
    recordId: eventId,
    purpose: 'transcript-inbox',
    meetingId,
    botSessionId,
  });
  const inbox = { id: eventId, meetingId, botSessionId, encryptedEvent };
  let durable = [],
    committed = 0,
    rolledBack = 0;
  const queries = [];
  const database = {
    $transaction: async (work) => {
      const pending = [];
      const tx = {
        $queryRaw: async (strings, ...values) => {
          const sql = strings.join('?');
          queries.push({ sql, values });
          if (/FROM transcript_inbox WHERE/.test(sql)) return [inbox];
          if (/FROM meetings WHERE/.test(sql))
            return [{ lifecycle: 'IN_PROGRESS', scheduleVersion: 2 }];
          if (/FROM bot_sessions WHERE/.test(sql))
            return [{ scheduleVersion: 2 }];
          if (/FROM transcripts WHERE/.test(sql))
            return options.head ? [options.head] : [];
          if (/FROM transcript_inbox_receipts/.test(sql))
            return durable.some((x) =>
              /INSERT INTO transcript_inbox_receipts/.test(x.sql),
            )
              ? [{ eventId }]
              : [];
          if (/FROM transcript_segments WHERE/.test(sql)) return [];
          if (/FROM transcript_revision_segments m/.test(sql))
            return options.members ?? [];
          throw new Error('unexpected-query');
        },
        $executeRaw: async (strings, ...values) => {
          const sql = strings.join('?');
          if (failAt && sql.includes(failAt))
            throw new Error('synthetic-storage-failure');
          if (
            options.conflict &&
            sql.startsWith('UPDATE transcripts SET state=')
          )
            return 0;
          pending.push({ sql, values });
          return 1;
        },
      };
      try {
        const result = await work(tx);
        durable.push(...pending);
        committed++;
        return result;
      } catch (error) {
        rolledBack++;
        throw error;
      }
    },
  };
  return {
    consumer: new PostgresTranscriptConsumer(database, encryption),
    queries,
    state: () => ({ durable, committed, rolledBack }),
  };
}
test('actual consumer and envelope compose offline; encrypted segment, audit and receipt commit together', async () => {
  const h = model();
  const result = await h.consumer.consume(eventId);
  assert.equal(result.ok, true);
  assert.equal(result.k, 'APPLIED');
  const state = h.state();
  assert.equal(state.committed, 1);
  for (const table of [
    'transcripts',
    'transcript_segments',
    'transcript_revision_segments',
    'transcript_processing_audit',
    'transcript_inbox_receipts',
  ])
    assert.ok(
      state.durable.some((x) => x.sql.includes(`INSERT INTO ${table}(`)),
      table,
    );
  assert.ok(
    !JSON.stringify(state.durable).includes('synthetic private marker'),
  );
  assert.ok(
    !JSON.stringify(state.durable).includes('a'.repeat(64)),
    'provider content identity is not the stored encrypted content hash',
  );
  const writes = state.durable.length;
  assert.equal((await h.consumer.consume(eventId)).k, 'ALREADY_PROCESSED');
  assert.equal(h.state().durable.length, writes);
});
for (const table of [
  'transcript_segments',
  'transcript_revision_segments',
  'transcript_processing_audit',
  'transcript_inbox_receipts',
])
  test(`recording transaction rolls back when ${table} write fails (not DB evidence)`, async () => {
    const h = model(`INSERT INTO ${table}(`);
    await assert.rejects(
      h.consumer.consume(eventId),
      /synthetic-storage-failure/,
    );
    assert.deepEqual(h.state(), { durable: [], committed: 0, rolledBack: 1 });
  });
const receivingHead = {
  id: '44444444-4444-4444-8444-444444444444',
  meetingId,
  botSessionId,
  revision: 1,
  state: 'RECEIVING',
  isPartial: false,
};
test('completion seals current revision with CAS and records ID-only readiness outbox', async () => {
  const h = model(undefined, {
    head: receivingHead,
    event: { kind: 'PROVIDER_COMPLETION' },
  });
  const result = await h.consumer.consume(eventId);
  assert.equal(result.ok, true);
  const writes = h.state().durable;
  assert.ok(
    writes.some(
      (x) =>
        /UPDATE transcripts SET state=.*AND revision=.*AND state=/.test(
          x.sql,
        ) && x.values.includes(receivingHead.id),
    ),
  );
  const outbox = writes.find((x) => /INSERT INTO outbox_events/.test(x.sql));
  assert.ok(outbox);
  assert.deepEqual(JSON.parse(outbox.values.at(-1)), {
    meetingId,
    transcriptId: result.transcriptId,
    revision: result.revisionAfter,
  });
  assert.equal(
    writes.at(-1).sql.startsWith('INSERT INTO transcript_inbox_receipts'),
    true,
  );
});
test('late evidence copies a sealed revision without updating old approved membership', async () => {
  const head = { ...receivingHead, state: 'COMPLETE' };
  const h = model(undefined, { head });
  const result = await h.consumer.consume(eventId);
  assert.equal(result.ok, true);
  assert.equal(result.revisionAfter, 2);
  assert.notEqual(result.transcriptId, head.id);
  assert.ok(
    h
      .state()
      .durable.some(
        (x) =>
          /INSERT INTO transcript_revision_segments.*SELECT/.test(x.sql) &&
          x.values.includes(head.id),
      ),
  );
  assert.ok(
    !h
      .state()
      .durable.some((x) =>
        /DELETE|UPDATE transcript_revision_segments/.test(x.sql),
      ),
  );
});
test('failed state CAS prevents audit, receipt and any durable model write', async () => {
  const h = model(undefined, { head: receivingHead, conflict: true });
  await assert.rejects(
    h.consumer.consume(eventId),
    /transcript-stale-event-conflict/,
  );
  assert.deepEqual(h.state(), { durable: [], committed: 0, rolledBack: 1 });
});
test('outbox failure rolls back sealing with its receipt and audit in recording model', async () => {
  const h = model('INSERT INTO outbox_events(', {
    head: receivingHead,
    event: { kind: 'PROVIDER_COMPLETION' },
  });
  await assert.rejects(
    h.consumer.consume(eventId),
    /synthetic-storage-failure/,
  );
  assert.deepEqual(h.state(), { durable: [], committed: 0, rolledBack: 1 });
});
