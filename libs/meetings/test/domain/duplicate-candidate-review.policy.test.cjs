'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DuplicateCandidateReviewPolicy,
} = require('../../src/domain/duplicate-candidate-review.policy.ts');

const policy = new DuplicateCandidateReviewPolicy();

function expectFail(decision, reason) {
  assert.equal(decision.ok, false);
  assert.deepEqual({ ...decision }, { ok: false, reason });
  assert.ok(Object.isFrozen(decision));
}

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

test('listing gate admits an authorized item-scoped request', () => {
  const decision = policy.authorizeCandidateListing({
    accessibleItem: true,
    itemId: 'item-1',
    currentItemVersion: 4,
  });
  assert.deepEqual({ ...decision }, { ok: true, itemId: 'item-1' });
  assert.ok(Object.isFrozen(decision));
});

test('listing gate fails closed without the access fact, before any storage access', () => {
  expectFail(
    policy.authorizeCandidateListing({
      accessibleItem: false,
      itemId: 'item-1',
      currentItemVersion: 4,
    }),
    'ACCESS_NOT_AUTHORIZED',
  );
  expectFail(
    policy.authorizeCandidateListing({
      itemId: 'item-1',
      currentItemVersion: 4,
    }),
    'ACCESS_NOT_AUTHORIZED',
  );
  expectFail(
    policy.authorizeCandidateListing({
      accessibleItem: 'yes',
      itemId: 'item-1',
      currentItemVersion: 4,
    }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('listing gate fails closed on malformed facts', () => {
  for (const request of [
    null,
    undefined,
    'item-1',
    { accessibleItem: true, itemId: '', currentItemVersion: 4 },
    { accessibleItem: true, itemId: undefined, currentItemVersion: 4 },
    { accessibleItem: true, itemId: 'item-1', currentItemVersion: 4.5 },
    { accessibleItem: true, itemId: 'item-1', currentItemVersion: -1 },
    { accessibleItem: true, itemId: 'item-1', currentItemVersion: '4' },
  ]) {
    expectFail(
      policy.authorizeCandidateListing(request),
      typeof request === 'object' && request !== null
        ? 'DECISION_FACTS_REQUIRED'
        : 'INVALID_REQUEST',
    );
  }
});

test('candidate record matching the ERD view shape is valid for its own item and revision', () => {
  assert.equal(
    policy.validateCandidateRecord(candidate({}), {
      itemId: 'item-1',
      currentItemVersion: 2,
    }),
    null,
  );
});

test('candidate fields are validated against the ERD shape', () => {
  const contexts = { itemId: 'item-1', currentItemVersion: 2 };
  const cases = [
    [candidate({ id: '' }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ itemId: undefined }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ source: 7 }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ candidateRef: '   ' }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ computedAt: null }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ safePreview: '' }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ score: Number.NaN }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ score: Number.POSITIVE_INFINITY }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ score: 'high' }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ score: undefined }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ itemVersion: 2.5 }), 'DECISION_FACTS_REQUIRED'],
    [candidate({ itemVersion: -3 }), 'DECISION_FACTS_REQUIRED'],
    [null, 'DECISION_FACTS_REQUIRED'],
    ['candidate-1', 'DECISION_FACTS_REQUIRED'],
  ];
  for (const [record, expected] of cases) {
    expectFail(policy.validateCandidateRecord(record, contexts), expected);
  }
});

test('no numeric threshold is implied: finite scores pass, threshold OPEN per MW-021', () => {
  assert.equal(
    policy.validateCandidateRecord(candidate({ score: -1.25 }), {
      itemId: 'item-1',
      currentItemVersion: 2,
    }),
    null,
  );
});

test('candidates from another item are a scope violation, never silently filtered', () => {
  expectFail(
    policy.validateCandidateRecord(candidate({ itemId: 'item-9' }), {
      itemId: 'item-1',
      currentItemVersion: 2,
    }),
    'CANDIDATE_OUT_OF_SCOPE',
  );
});

test('candidates cannot be dated in the future of the item revision', () => {
  expectFail(
    policy.validateCandidateRecord(candidate({ itemVersion: 3 }), {
      itemId: 'item-1',
      currentItemVersion: 2,
    }),
    'CANDIDATE_VERSION_EXCEEDS_ITEM',
  );
});

test('validation context itself is shape-checked', () => {
  const record = candidate({});
  expectFail(policy.validateCandidateRecord(record, null), 'INVALID_REQUEST');
  expectFail(
    policy.validateCandidateRecord(record, 'item-1'),
    'INVALID_REQUEST',
  );
  expectFail(
    policy.validateCandidateRecord(record, {
      itemId: '',
      currentItemVersion: 2,
    }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.validateCandidateRecord(record, {
      itemId: 'item-1',
      currentItemVersion: 'x',
    }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('failure decisions are frozen and carry the exact reason only', () => {
  const decision = policy.authorizeCandidateListing({
    itemId: 'item-1',
    currentItemVersion: 4,
  });
  expectFail(decision, 'ACCESS_NOT_AUTHORIZED');
});
