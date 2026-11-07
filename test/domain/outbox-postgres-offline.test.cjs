const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PostgresOutboxDispatchRepository,
} = require('../../libs/meetings/src/infrastructure/outbox/postgres-outbox-dispatch.repository.ts');
const {
  OutboxDispatchService,
} = require('../../libs/meetings/src/application/outbox-dispatch.service.ts');
const ID = '00000000-0000-4000-8000-000000000001';
const AGGREGATE = '00000000-0000-4000-8000-000000000002';
function row(token) {
  return {
    id: ID,
    aggregateId: AGGREGATE,
    aggregateType: 'Meeting',
    eventType: 'meeting.created.v1',
    eventVersion: 1,
    aggregateVersion: 0,
    payloadJsonSafe: JSON.stringify({ meetingId: AGGREGATE }),
    attempts: 1,
    createdAt: new Date('2026-11-03T00:00:00Z'),
    claimToken: token,
    correlationId: null,
    causationId: null,
  };
}
function fixture({
  rows = (token) => [row(token)],
  markCount = 1,
  diagnostic = [{ id: ID }],
  fault = null,
} = {}) {
  const calls = [];
  let commits = 0,
    rollbacks = 0;
  function capture(kind, strings, values) {
    assert.ok(Array.isArray(strings.raw));
    const sql = strings.reduce(
      (text, part, index) => text + (index ? `$${index}` : '') + part,
      '',
    );
    calls.push({ kind, sql, values });
    return sql;
  }
  const runner = {
    async $queryRaw(strings, ...values) {
      const sql = capture('query', strings, values);
      if (sql.includes('WITH due')) {
        if (fault) throw fault;
        return typeof rows === 'function' ? rows(values[1]) : rows;
      }
      return diagnostic;
    },
    async $executeRaw(strings, ...values) {
      capture('execute', strings, values);
      return markCount;
    },
    async $transaction(work) {
      calls.push({ kind: 'begin' });
      try {
        const result = await work(runner);
        commits++;
        return result;
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  };
  return {
    repository: new PostgresOutboxDispatchRepository({ runner }),
    runner,
    calls,
    commits: () => commits,
    rollbacks: () => rollbacks,
  };
}
test('construction performs no persistence IO and refuses missing runner bindings', () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  for (const runner of [null, {}, { $transaction() {} }])
    assert.throws(
      () => new PostgresOutboxDispatchRepository({ runner }),
      /runner-required/,
    );
});
test('claim uses prepared physical fields, bound parameters, DB clock and row locks', async () => {
  const f = fixture(),
    result = await f.repository.claimDueUnpublished(4, 30);
  assert.equal(f.commits(), 1);
  assert.equal(result.claim.claimedCount, 1);
  assert.equal(result.rows[0].aggregateVersion, 0);
  assert.equal(result.rows[0].createdAt, '2026-11-03T00:00:00.000Z');
  assert.equal(result.rows[0].claimToken, result.claim.claimToken);
  const query = f.calls.find((call) => call.kind === 'query');
  assert.match(query.sql, /FROM outbox_events/);
  assert.match(query.sql, /dispatched_at IS NULL/);
  assert.match(query.sql, /next_retry_at <= clock_timestamp\(\)/);
  assert.match(query.sql, /locked_until <= clock_timestamp\(\)/);
  assert.match(query.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(query.sql, /attempts = event.attempts \+ 1/);
  assert.match(query.sql, /payload::text AS "payloadJsonSafe"/);
  assert.match(query.sql, /SELECT \* FROM claimed ORDER BY id/);
  assert.doesNotMatch(
    query.sql,
    /"OutboxEvent"|"status"|NOW\(\)|CURRENT_TIMESTAMP/,
  );
  assert.deepEqual(query.values, [4, result.claim.claimToken, 30]);
  assert.equal(query.sql.includes(result.claim.claimToken), false);
});
test('every claim gets fresh ownership and empty claim returns no invented rows', async () => {
  const f = fixture({ rows: [] });
  const first = await f.repository.claimDueUnpublished(1, 1),
    second = await f.repository.claimDueUnpublished(1, 1);
  assert.notEqual(first.claim.claimToken, second.claim.claimToken);
  assert.deepEqual(first.rows, []);
  assert.equal(first.claim.claimedCount, 0);
});
for (const [limit, lease] of [
  [0, 1],
  [1, 0],
  [-1, 1],
  [1, 1.5],
  [Infinity, 1],
])
  test('invalid operator claim configuration refuses before SQL', async () => {
    const f = fixture();
    await assert.rejects(f.repository.claimDueUnpublished(limit, lease));
    assert.equal(f.calls.length, 0);
  });
for (const [field, value] of [
  ['id', 'foreign'],
  ['claimToken', 'other-owner'],
  ['aggregateVersion', -1],
  ['attempts', 0],
  ['createdAt', new Date(NaN)],
  ['createdAt', '2026-11-31T00:00:00Z'],
  ['correlationId', undefined],
])
  test(`corrupt claimed ${field} aborts the controlled transaction`, async () => {
    const f = fixture({ rows: (token) => [{ ...row(token), [field]: value }] });
    await assert.rejects(
      f.repository.claimDueUnpublished(1, 30),
      /outbox-postgres-row-invalid/,
    );
    assert.equal(f.commits(), 0);
    assert.equal(f.rollbacks(), 1);
  });
for (const rows of [null, [row('unused'), row('unused')]])
  test('nonarray or oversized claim result refuses', async () => {
    const f = fixture({ rows });
    await assert.rejects(f.repository.claimDueUnpublished(1, 30));
    assert.equal(f.rollbacks(), 1);
  });
test('duplicate claimed IDs refuse even within allowed batch size', async () => {
  const f = fixture({ rows: (token) => [row(token), row(token)] });
  await assert.rejects(
    f.repository.claimDueUnpublished(2, 30),
    /outbox-postgres-row-invalid/,
  );
});
test('query fault propagates without fake claim or followup effects', async () => {
  const fault = new Error('synthetic-query-fault'),
    f = fixture({ fault });
  await assert.rejects(
    f.repository.claimDueUnpublished(1, 30),
    (error) => error === fault,
  );
  assert.equal(f.rollbacks(), 1);
  assert.equal(f.calls.filter((call) => call.kind === 'execute').length, 0);
});
test('postpublish mark binds ID/token/time and requires an unexpired current lease', async () => {
  const f = fixture(),
    token = 'synthetic-opaque-lease';
  assert.deepEqual(
    await f.repository.markDispatched({
      id: ID,
      claimToken: token,
      dispatchedAt: '2026-11-03T00:00:00Z',
    }),
    { marked: true, existingId: null },
  );
  const query = f.calls.find((call) => call.kind === 'execute');
  assert.equal(f.commits(), 1);
  assert.deepEqual(query.values, ['2026-11-03T00:00:00Z', ID, token]);
  assert.match(query.sql, /dispatched_at IS NULL/);
  assert.match(
    query.sql,
    /locked_by = \$3 AND locked_until > clock_timestamp\(\)/,
  );
  assert.match(query.sql, /locked_by = NULL, locked_until = NULL/);
  assert.equal(query.sql.includes(token), false);
});
for (const diagnostic of [[], [{ id: ID }]])
  test('lost lease mark is a refusal with diagnostic identity only', async () => {
    const f = fixture({ markCount: 0, diagnostic });
    assert.deepEqual(
      await f.repository.markDispatched({
        id: ID,
        claimToken: 'stale-owner',
        dispatchedAt: '2026-11-03T00:00:00Z',
      }),
      { marked: false, existingId: diagnostic.length ? ID : null },
    );
  });
for (const options of [
  { markCount: 2 },
  { markCount: 0, diagnostic: [{ id: AGGREGATE }] },
])
  test('corrupt mark count/foreign diagnostic cannot claim success', async () => {
    const f = fixture(options);
    await assert.rejects(
      f.repository.markDispatched({
        id: ID,
        claimToken: 'owner',
        dispatchedAt: '2026-11-03T00:00:00Z',
      }),
      /outbox-postgres-row-invalid/,
    );
  });
test('malformed mark time refuses without SQL', async () => {
  const f = fixture();
  await assert.rejects(
    f.repository.markDispatched({
      id: ID,
      claimToken: 'owner',
      dispatchedAt: '2026-11-31T00:00:00Z',
    }),
  );
  assert.equal(f.calls.length, 0);
});

for (const scenario of ['accepted', 'publish-failure', 'lease-lost'])
  test(`actual dispatcher composes with recording SQL adapter: ${scenario}`, async () => {
    const f = fixture({ markCount: scenario === 'lease-lost' ? 0 : 1 });
    let published = 0;
    const service = new OutboxDispatchService(f.repository, {
      async publish(envelope) {
        assert.equal(f.commits(), 1);
        assert.equal(envelope.aggregateVersion, 0);
        assert.equal(envelope.eventId, ID);
        assert.deepEqual(envelope.payload, { meetingId: AGGREGATE });
        assert.equal(Object.hasOwn(envelope, 'claimToken'), false);
        published++;
        if (scenario === 'publish-failure')
          throw new Error('synthetic-transport-fault');
      },
    });
    const result = await service.dispatchDueTurn({
      batchLimit: 1,
      leaseSeconds: 30,
      dispatchedAt: '2026-11-03T00:01:00Z',
    });
    assert.equal(result.kind, 'DISPATCH_TURN');
    assert.equal(published, 1);
    assert.equal(result.dispatched, scenario === 'accepted' ? 1 : 0);
    assert.equal(result.publishFailed, scenario === 'publish-failure' ? 1 : 0);
    assert.equal(result.markRefused, scenario === 'lease-lost' ? 1 : 0);
    assert.equal(
      f.calls.filter((call) => call.kind === 'execute').length,
      scenario === 'publish-failure' ? 0 : 1,
    );
  });
