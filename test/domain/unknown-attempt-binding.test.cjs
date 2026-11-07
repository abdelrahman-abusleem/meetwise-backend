const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ExternalExecutionService,
} = require('../../libs/external-actions/src/application/external-execution.service.ts');
function fixture({
  overrides = {},
  lookup = { k: 'NOT_FOUND_PROVEN', reason: 'synthetic-proof' },
  beforeLookupReturn = () => {},
} = {}) {
  const row = {
    id: 'synthetic-execution',
    executionExists: true,
    status: 'UNKNOWN',
    operation: 'CREATE',
    destination: 'jira',
    targetKey: 'synthetic-target',
    attemptCount: 1,
    storedExternalId: null,
    storedExternalUrl: null,
    ...overrides,
  };
  const calls = { lookup: 0, resolve: [], writes: 0 };
  const repository = {
    async getExecutionFacts() {
      return row;
    },
    async resolveUnknown(command) {
      calls.resolve.push(command);

      if (
        row.status !== 'UNKNOWN' ||
        row.attemptCount !== command.expectedAttemptCount
      )
        return { settled: false, refusal: 'RESOLVE_RACE_LOST', run: null };
      calls.writes++;
      row.status =
        command.command === 'RESOLVE_UNKNOWN_FOUND'
          ? 'SUCCEEDED'
          : 'RETRYABLE_FAILED';
      return { settled: true, refusal: null, run: { ...row } };
    },
  };
  const provider = {
    async lookupExternalByCorrelation() {
      calls.lookup++;
      await beforeLookupReturn(row);
      return lookup;
    },
  };
  const service = new ExternalExecutionService(repository);
  return {
    run: () => service.reconcileUnknown({ executionId: row.id, provider }),
    row,
    calls,
  };
}
for (const lookup of [
  { k: 'FOUND', externalId: 'synthetic-reference' },
  { k: 'NOT_FOUND_PROVEN', reason: 'synthetic-proof' },
]) {
  test(`${lookup.k}: same-attempt resolution carries observed ordinal`, async () => {
    const f = fixture({ lookup });
    assert.equal((await f.run()).ok, true);
    assert.equal(f.calls.resolve[0].expectedAttemptCount, 1);
    assert.equal(f.calls.writes, 1);
  });
  test(`${lookup.k}: old lookup cannot resolve a newer UNKNOWN attempt`, async () => {
    const f = fixture({
      lookup,
      beforeLookupReturn: (row) => {
        row.attemptCount = 2;
        row.status = 'UNKNOWN';
      },
    });
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
    assert.equal(f.calls.resolve[0].expectedAttemptCount, 1);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.row.status, 'UNKNOWN');
  });
}
for (const overrides of [
  { attemptCount: null },
  { attemptCount: -1 },
  { attemptCount: 1.5 },
  { attemptCount: Number.MAX_SAFE_INTEGER + 1 },
  { operation: 'KEEP_INTERNAL' },
  { destination: '' },
  { targetKey: ' ' },
])
  test(`invalid durable lookup facts refuse before provider: ${JSON.stringify(overrides)}`, async () => {
    const f = fixture({ overrides, lookup: { k: 'UNCERTAIN' } });
    await assert.rejects(f.run(), /execution-row-mapping-corrupt/);
    assert.equal(f.calls.lookup, 0);
    assert.equal(f.calls.resolve.length, 0);
  });
test('UNCERTAIN lookup remains manual and performs no resolve', async () => {
  const f = fixture({ lookup: { k: 'UNCERTAIN' } });
  assert.equal((await f.run()).k, 'AWAITING_OPERATOR');
  assert.equal(f.calls.resolve.length, 0);
});
test('concurrent same-attempt resolvers have one controlled CAS winner', async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    beforeLookupReturn: async () => {
      await wait;
    },
  });
  const first = f.run(),
    second = f.run();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) => result.reason === 'EXECUTION_STATE_CONFLICT')
      .length,
    1,
  );
  assert.equal(f.calls.writes, 1);
});
