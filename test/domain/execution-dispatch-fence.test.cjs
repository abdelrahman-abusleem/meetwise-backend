const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ExternalExecutionService,
} = require('../../libs/external-actions/src/application/external-execution.service.ts');
const NOW = Date.parse('2026-11-03T00:00:00Z');
const fence = () => ({
  attemptId: 'synthetic-attempt',
  attemptNumber: 1,
  leaseToken: 'synthetic-lease',
  leaseExpiresAt: '2026-11-03T00:01:00Z',
});
function fixture({
  claimFence = fence(),
  providerOutcome = { k: 'CONFIRMED', externalId: 'synthetic-reference' },
  afterProvider = () => {},
} = {}) {
  let now = NOW;
  let sends = 0;
  const settlements = [];
  const row = {
    id: 'synthetic-execution',
    status: 'PENDING',
    attemptCount: 0,
    operation: 'CREATE',
    destination: 'jira',
    targetKey: 'synthetic-target',
    storedExternalId: null,
    storedExternalUrl: null,
  };
  let currentFence = claimFence;
  const repository = {
    async getExecutionFacts() {
      return { ...row, executionExists: true };
    },
    async claimExecution() {
      row.status = 'DISPATCHING';
      row.attemptCount = 1;
      return {
        claimed: true,
        refusal: null,
        run: { ...row },
        dispatchPayload: {
          approvedSnapshotId: 'synthetic-snapshot',
          payload: {},
        },
        fence: claimFence,
      };
    },
    async settleDispatchOutcome(command) {
      settlements.push(command);

      if (
        JSON.stringify(command.fence) !== JSON.stringify(currentFence) ||
        Date.parse(currentFence.leaseExpiresAt) <= now
      )
        return { settled: false, refusal: 'SETTLE_RACE_LOST', run: null };
      row.status =
        command.command === 'CONFIRM_SUCCESS'
          ? 'SUCCEEDED'
          : command.command === 'MARK_UNKNOWN'
            ? 'UNKNOWN'
            : command.command === 'RECORD_RETRYABLE_FAILURE'
              ? 'RETRYABLE_FAILED'
              : 'PERMANENT_FAILED';
      return { settled: true, refusal: null, run: { ...row } };
    },
  };
  const service = new ExternalExecutionService(
    repository,
    undefined,
    () => now,
  );
  const provider = {
    async executeDispatch() {
      sends++;
      afterProvider();
      return providerOutcome;
    },
  };
  return {
    dispatch: () =>
      service.dispatchExecution({ executionId: row.id, provider }),
    sends: () => sends,
    settlements,
    replaceFence: (next) => {
      currentFence = next;
    },
    setNow: (next) => {
      now = next;
    },
    row,
  };
}
for (const [name, value] of [
  ['absent', undefined],
  ['null', null],
  ['blank attempt', { ...fence(), attemptId: ' ' }],
  ['blank lease', { ...fence(), leaseToken: '' }],
  ['foreign ordinal', { ...fence(), attemptNumber: 2 }],
  ['fractional ordinal', { ...fence(), attemptNumber: 1.5 }],
  ['invalid expiry', { ...fence(), leaseExpiresAt: 'invalid' }],
  [
    'overflow calendar day',
    { ...fence(), leaseExpiresAt: '2026-11-31T00:00:00Z' },
  ],
  ['nonleap February', { ...fence(), leaseExpiresAt: '2027-02-29T00:00:00Z' }],
  ['nonleap century', { ...fence(), leaseExpiresAt: '2100-02-29T00:00:00Z' }],
  ['overflow hour', { ...fence(), leaseExpiresAt: '2026-11-04T24:00:00Z' }],
  ['expired', { ...fence(), leaseExpiresAt: '2026-11-02T23:59:59Z' }],
  ['exact expiry', { ...fence(), leaseExpiresAt: '2026-11-03T00:00:00Z' }],
])
  test(`dispatch refuses ${name} claim fence before provider`, async () => {
    const f = fixture({ claimFence: value === undefined ? {} : value });
    await assert.rejects(f.dispatch(), /execution-claim-fence-invalid/);
    assert.equal(f.sends(), 0);
    assert.equal(f.settlements.length, 0);
  });
for (const outcome of [
  { k: 'CONFIRMED', externalId: 'synthetic-reference' },
  { k: 'UNKNOWN_EFFECT', reason: 'synthetic-uncertainty' },
  { k: 'RETRYABLE_NO_EFFECT', reason: 'synthetic-no-effect' },
  { k: 'PERMANENT_DENIED', reason: 'synthetic-denial' },
])
  test(`settlement carries exact original fence for ${outcome.k}`, async () => {
    const source = fence();
    const f = fixture({ claimFence: source, providerOutcome: outcome });
    const result = await f.dispatch();
    assert.equal(result.ok, true);
    assert.deepEqual(f.settlements[0].fence, source);
    assert.notEqual(f.settlements[0].fence, source);
    assert.equal(Object.isFrozen(f.settlements[0].fence), true);
    assert.equal(JSON.stringify(result).includes(source.leaseToken), false);
  });
test('stale worker cannot settle a replaced attempt even while status remains DISPATCHING', async () => {
  const source = fence();
  let f;
  f = fixture({
    claimFence: source,
    afterProvider: () =>
      f.replaceFence({
        ...fence(),
        attemptId: 'new-attempt',
        leaseToken: 'new-lease',
        attemptNumber: 2,
      }),
  });
  const result = await f.dispatch();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(f.row.status, 'DISPATCHING');
  assert.equal(f.sends(), 1);
});
test('provider-time mutation cannot replace captured attempt or lease ownership', async () => {
  const source = fence();
  const original = { ...source };
  const f = fixture({
    claimFence: source,
    afterProvider: () => {
      source.attemptId = 'mutated';
      source.leaseToken = 'mutated';
    },
  });
  await f.dispatch();
  assert.deepEqual(f.settlements[0].fence, original);
});
test('expiry during provider wait is sent to fenced settlement, never reported as success or resent', async () => {
  let f;
  f = fixture({ afterProvider: () => f.setNow(NOW + 60_000) });
  const result = await f.dispatch();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(f.sends(), 1);
  assert.equal(f.settlements.length, 1);
  assert.equal(f.row.status, 'DISPATCHING');
});

for (const leaseExpiresAt of [
  '2096-02-29T00:00:00Z',
  '2026-11-03T00:01:00.123Z',
  '2026-11-03T01:01:00+01:00',
])
  test(`valid calendar expiry is preserved: ${leaseExpiresAt}`, async () => {
    const f = fixture({ claimFence: { ...fence(), leaseExpiresAt } });
    assert.equal((await f.dispatch()).ok, true);
    assert.equal(f.settlements[0].fence.leaseExpiresAt, leaseExpiresAt);
  });
for (const now of [NaN, Infinity])
  test('invalid local clock fails closed before provider', async () => {
    const f = fixture();
    f.setNow(now);
    await assert.rejects(f.dispatch(), /execution-claim-fence-invalid/);
    assert.equal(f.sends(), 0);
  });
