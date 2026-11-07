'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DuplicateReviewService,
} = require('../../src/application/duplicate-review.service.ts');

function candidate(overrides) {
  return {
    id: 'candidate-1',
    itemId: 'item-1',
    itemVersion: 2,
    source: 'normalized-chunk-merge',
    candidateRef: 'candidate-ref-1',
    score: 0.75,
    computedAt: '2026-10-25T10:00:00Z',
    safePreview: 'partial summary preview …',
    ...overrides,
  };
}

function fakeRepository(pages) {
  const calls = [];
  return {
    calls,
    async findCandidatesByItem(itemId, cursor, limit) {
      calls.push({ itemId, cursor, limit });
      const key = cursor ?? '__first__';
      const page = pages[key];
      if (page === undefined) {
        return { items: [], nextCursor: null };
      }
      return page;
    },
  };
}

function service(pages, overrides) {
  const repository = fakeRepository(pages);
  const svc = new DuplicateReviewService(repository, overrides?.policy);
  return { repository, svc };
}

const authorizedQuery = {
  accessibleItem: true,
  itemId: 'item-1',
  currentItemVersion: 4,
};

test('authorized listing returns the scoped, validated candidate page and the occupancy flag', async () => {
  const { repository, svc } = service({
    __first__: {
      items: [
        candidate({}),
        candidate({ id: 'candidate-2', candidateRef: 'ref-2' }),
      ],
      nextCursor: 'page-2',
    },
  });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.equal(decision.ok, true);
  assert.equal(decision.itemId, 'item-1');
  assert.equal(decision.candidateCount, 2);
  assert.equal(decision.candidates.length, 2);
  assert.equal(decision.nextCursor, 'page-2');
  assert.equal(decision.pageHasCandidates, true);
  assert.ok(Object.isFrozen(decision));
  for (const record of decision.candidates) {
    assert.ok(Object.isFrozen(record));
  }
  assert.deepEqual(repository.calls, [
    { itemId: 'item-1', cursor: undefined, limit: undefined },
  ]);
});

test('empty result exposes pageHasCandidates=false (never an authorization signal)', async () => {
  const { svc } = service({ __first__: { items: [], nextCursor: null } });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.equal(decision.ok, true);
  assert.equal(decision.candidateCount, 0);
  assert.equal(decision.pageHasCandidates, false);
  assert.equal(decision.nextCursor, null);
});

test('access fact is enforced BEFORE any repository access — no enumeration', async () => {
  for (const accessibleItem of [false, undefined]) {
    const { repository, svc } = service({});
    const decision = await svc.listCandidates({
      ...authorizedQuery,
      accessibleItem,
    });
    assert.deepEqual(
      { ...decision },
      { ok: false, reason: 'ACCESS_NOT_AUTHORIZED' },
    );
    assert.equal(repository.calls.length, 0);
  }
});

test('garbage query shape never reaches the repository', async () => {
  for (const mutation of [
    { accessibleItem: 'yes' },
    { itemId: '' },
    { currentItemVersion: 1.5 },
    { cursor: 42 },
    { limit: -1 },
    { limit: 1.5 },
  ]) {
    const { repository, svc } = service({});
    const decision = await svc.listCandidates({
      ...authorizedQuery,
      ...mutation,
    });
    assert.deepEqual(
      { ...decision },
      { ok: false, reason: 'DECISION_FACTS_REQUIRED' },
    );
    assert.equal(repository.calls.length, 0);
  }
  const { repository, svc } = service({});
  assert.deepEqual(
    { ...(await svc.listCandidates(null)) },
    { ok: false, reason: 'DECISION_FACTS_REQUIRED' },
  );
  assert.equal(repository.calls.length, 0);
});

test('cursor and limit are forwarded unchanged to the repository', async () => {
  const { repository, svc } = service({
    __first__: { items: [], nextCursor: null },
  });
  await svc.listCandidates({ ...authorizedQuery, cursor: 'abc', limit: 25 });
  assert.deepEqual(repository.calls, [
    { itemId: 'item-1', cursor: 'abc', limit: 25 },
  ]);
});

test('a wrong-scope candidate fails the WHOLE listing loudly (storage leak surfaces)', async () => {
  const { svc } = service({
    __first__: {
      items: [candidate({}), candidate({ id: 'c-2', itemId: 'item-9' })],
      nextCursor: null,
    },
  });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.deepEqual(
    { ...decision },
    { ok: false, reason: 'CANDIDATE_OUT_OF_SCOPE' },
  );
});

test('a future-versioned candidate fails the whole listing', async () => {
  const { svc } = service({
    __first__: { items: [candidate({ itemVersion: 5 })], nextCursor: null },
  });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.deepEqual(
    { ...decision },
    { ok: false, reason: 'CANDIDATE_VERSION_EXCEEDS_ITEM' },
  );
});

test('malformed repository records fail closed, not silently filtered', async () => {
  for (const record of [
    candidate({ score: Number.NaN }),
    candidate({ source: 7 }),
    null,
    'candidate-1',
  ]) {
    const { svc } = service({
      __first__: { items: [record], nextCursor: null },
    });
    const decision = await svc.listCandidates({ ...authorizedQuery });
    assert.deepEqual(
      { ...decision },
      { ok: false, reason: 'DECISION_FACTS_REQUIRED' },
    );
  }
});

test('a repository contract violation (non-array page / garbage page) fails closed', async () => {
  for (const page of [
    null,
    'page',
    { items: 'all-candidates', nextCursor: null },
    { items: undefined, nextCursor: null },
  ]) {
    const { svc } = service({ __first__: page });
    const decision = await svc.listCandidates({ ...authorizedQuery });
    assert.deepEqual(
      { ...decision },
      { ok: false, reason: 'DECISION_FACTS_REQUIRED' },
    );
  }
});

test('a non-string nextCursor from the repository fails closed', async () => {
  const { svc } = service({
    __first__: { items: [], nextCursor: 7 },
  });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.deepEqual(
    { ...decision },
    { ok: false, reason: 'DECISION_FACTS_REQUIRED' },
  );
});

test('repository failures propagate without silent suppression', async () => {
  const repository = {
    async findCandidatesByItem() {
      throw new Error('db-connection-lost');
    },
  };
  const svc = new DuplicateReviewService(repository);
  await assert.rejects(
    () => svc.listCandidates({ ...authorizedQuery }),
    (error) => error instanceof Error && error.message === 'db-connection-lost',
  );
});

test('detection-pipeline ingestion guard passes valid candidates and rejects scope violations', () => {
  const { svc } = service({});
  const valid = svc.validateIncomingCandidate(candidate({}), {
    itemId: 'item-1',
    currentItemVersion: 2,
  });
  assert.deepEqual({ ...valid }, { ok: true });
  const leaked = svc.validateIncomingCandidate(
    candidate({ itemId: 'item-2' }),
    {
      itemId: 'item-1',
      currentItemVersion: 2,
    },
  );
  assert.deepEqual(
    { ...leaked },
    { ok: false, reason: 'CANDIDATE_OUT_OF_SCOPE' },
  );
  const future = svc.validateIncomingCandidate(candidate({}), {
    itemId: 'item-1',
    currentItemVersion: 1,
  });
  assert.deepEqual(
    { ...future },
    { ok: false, reason: 'CANDIDATE_VERSION_EXCEEDS_ITEM' },
  );
});

test('the service is read-only and never mutates record data: frozen inputs come out identical', async () => {
  const record = Object.freeze(candidate({ extraInternalField: 'leak-me' }));
  const { repository, svc } = service({
    __first__: { items: [record], nextCursor: null },
  });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.equal(decision.ok, true);
  assert.equal(repository.calls.length, 1);
  assert.equal(typeof record.extraInternalField, 'string');
  assert.deepEqual({ ...record }, candidate({ extraInternalField: 'leak-me' }));
  assert.ok(Object.isFrozen(decision));
  assert.ok(decision.candidates.every((item) => Object.isFrozen(item)));
});

test('ERD whitelist: extra adapter columns never flow to the caller', async () => {
  const { svc } = service({
    __first__: {
      items: [
        candidate({ rowIndex: 42, internalTranscriptHash: 'not-for-review' }),
      ],
      nextCursor: 'next',
    },
  });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.equal(decision.ok, true);
  assert.equal(Object.keys(decision.candidates[0]).length, 8);
  assert.equal('rowIndex' in decision.candidates[0], false);
  assert.equal('internalTranscriptHash' in decision.candidates[0], false);
  const keys = Object.keys(decision.candidates[0]).sort();
  assert.deepEqual(keys, [
    'candidateRef',
    'computedAt',
    'id',
    'itemId',
    'itemVersion',
    'safePreview',
    'score',
    'source',
  ]);
});

test('nextCursor contract is string|null exactly: undefined fails closed', async () => {
  const { svc } = service({ __first__: { items: [], nextCursor: undefined } });
  const decision = await svc.listCandidates({ ...authorizedQuery });
  assert.deepEqual(
    { ...decision },
    { ok: false, reason: 'DECISION_FACTS_REQUIRED' },
  );
});

test('boundary edges are passed through without invented limits', async () => {
  const { repository, svc } = service({
    __first__: { items: [], nextCursor: null },
  });
  await svc.listCandidates({ ...authorizedQuery, cursor: '', limit: 0 });
  assert.deepEqual(repository.calls, [
    { itemId: 'item-1', cursor: '', limit: 0 },
  ]);
  await svc.listCandidates({
    ...authorizedQuery,
    currentItemVersion: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(repository.calls.length, 2);
  const bigVersion = {
    ...candidate({ itemVersion: Number.MAX_SAFE_INTEGER }),
  };
  const accepted = svc.validateIncomingCandidate(bigVersion, {
    itemId: 'item-1',
    currentItemVersion: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual({ ...accepted }, { ok: true });
  const minusZero = svc.validateIncomingCandidate(candidate({ score: -0 }), {
    itemId: 'item-1',
    currentItemVersion: 2,
  });
  assert.deepEqual({ ...minusZero }, { ok: true });
});
