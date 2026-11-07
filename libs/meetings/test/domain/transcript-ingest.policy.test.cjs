'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TranscriptIngestPolicy,
} = require('../../src/domain/transcript-ingest.policy.ts');

const policy = new TranscriptIngestPolicy();

function request(overrides) {
  return {
    command: 'INGEST_SEGMENT',
    currentState: 'NONE',
    duplicate: false,
    ...overrides,
  };
}

test('first persisted segment moves NONE to RECEIVING', () => {
  const decision = policy.evaluate(request({}));
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'RECEIVING');
  assert.equal(decision.revisionBumped, false);
  assert.equal(decision.ignoredDuplicate, false);
  assert.ok(Object.isFrozen(decision));
});

test('ongoing RECEIVING ingestion stays RECEIVING without a revision bump', () => {
  const decision = policy.evaluate(request({ currentState: 'RECEIVING' }));
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'RECEIVING');
  assert.equal(decision.revisionBumped, false);
});

test('duplicate segments never mutate state, bump the revision or invalidate AI runs', () => {
  for (const currentState of ['NONE', 'RECEIVING', 'PARTIAL', 'COMPLETE']) {
    const decision = policy.evaluate(
      request({ currentState, duplicate: true }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, currentState);
    assert.equal(decision.revisionBumped, false);
    assert.equal(decision.invalidateUnpublishedAnalysis, false);
    assert.equal(decision.ignoredDuplicate, true);
  }
});

test('late segments after COMPLETE/PARTIAL keep status and bump the transcript revision', () => {
  const afterComplete = policy.evaluate(request({ currentState: 'COMPLETE' }));
  assert.equal(afterComplete.ok, true);
  assert.equal(afterComplete.to, 'COMPLETE');
  assert.equal(afterComplete.revisionBumped, true);
  assert.equal(afterComplete.invalidateUnpublishedAnalysis, true);

  const afterPartial = policy.evaluate(request({ currentState: 'PARTIAL' }));
  assert.equal(afterPartial.ok, true);
  assert.equal(afterPartial.to, 'PARTIAL');
  assert.equal(afterPartial.revisionBumped, true);
  assert.equal(afterPartial.invalidateUnpublishedAnalysis, true);
});

test('ingest is blocked for quarantined and failed documents', () => {
  for (const currentState of ['INVALID', 'FAILED']) {
    const decision = policy.evaluate(request({ currentState }));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'INGEST_BLOCKED');
  }
});

test('interrupted captures close RECEIVING as an explicit PARTIAL banner', () => {
  const decision = policy.evaluate(
    request({
      command: 'MARK_PARTIAL',
      currentState: 'RECEIVING',
      duplicate: false,
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'PARTIAL');
});

test('MARK_PARTIAL is rejected on states that are not active ingest runs', () => {
  const alreadyPartial = policy.evaluate(
    request({
      command: 'MARK_PARTIAL',
      currentState: 'PARTIAL',
      duplicate: false,
    }),
  );
  assert.equal(alreadyPartial.ok, false);
  assert.equal(alreadyPartial.reason, 'INTERRUPT_NOT_ALLOWED');

  for (const currentState of ['NONE', 'COMPLETE', 'INVALID', 'FAILED']) {
    const decision = policy.evaluate(
      request({ command: 'MARK_PARTIAL', currentState, duplicate: false }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'MARK_PARTIAL_NOT_ALLOWED');
  }
});

test('provider completion plus reconciliation closes RECEIVING/PARTIAL as COMPLETE', () => {
  for (const currentState of ['RECEIVING', 'PARTIAL']) {
    const decision = policy.evaluate(
      request({
        command: 'COMPLETE_TRANSACTION',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, 'COMPLETE');
    assert.equal(decision.revisionBumped, false);
  }
});

test('completion is rejected without persisted segments', () => {
  for (const currentState of ['NONE', 'INVALID', 'FAILED']) {
    const decision = policy.evaluate(
      request({
        command: 'COMPLETE_TRANSACTION',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'COMPLETION_NOT_ALLOWED');
  }
});

test('completion replay on COMPLETE is audit-only', () => {
  const replay = policy.evaluate(
    request({
      command: 'COMPLETE_TRANSACTION',
      currentState: 'COMPLETE',
      duplicate: false,
    }),
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.to, 'COMPLETE');
  assert.equal(replay.appendedAuditEventOnly, true);
  assert.equal(replay.revisionBumped, false);
});

test('malformed persisted segments quarantine active ingest runs', () => {
  for (const currentState of ['RECEIVING', 'PARTIAL']) {
    const decision = policy.evaluate(
      request({
        command: 'QUARANTINE_MALFORMED',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, 'INVALID');
  }
  const nothingPersisted = policy.evaluate(
    request({
      command: 'QUARANTINE_MALFORMED',
      currentState: 'NONE',
      duplicate: false,
    }),
  );
  assert.equal(nothingPersisted.ok, false);
  assert.equal(nothingPersisted.reason, 'QUARANTINE_NOT_APPLICABLE');

  for (const currentState of ['COMPLETE', 'INVALID', 'FAILED']) {
    const decision = policy.evaluate(
      request({
        command: 'QUARANTINE_MALFORMED',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'INGEST_BLOCKED');
  }
});

test('hard ingest errors become FAILED only while no document content is complete', () => {
  for (const currentState of ['NONE', 'RECEIVING']) {
    const decision = policy.evaluate(
      request({
        command: 'MARK_INGEST_FAILED',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, 'FAILED');
  }
  for (const currentState of ['PARTIAL', 'COMPLETE', 'INVALID', 'FAILED']) {
    const decision = policy.evaluate(
      request({
        command: 'MARK_INGEST_FAILED',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'INGEST_BLOCKED');
  }
});

test('contradictory provider failure over COMPLETE never regresses status', () => {
  const decision = policy.evaluate(
    request({
      command: 'OBSERVE_CONTRADICTORY_FAILURE',
      currentState: 'COMPLETE',
      duplicate: false,
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'COMPLETE');
  assert.equal(decision.appendedAuditEventOnly, true);
  assert.equal(decision.revisionBumped, false);

  for (const currentState of [
    'NONE',
    'RECEIVING',
    'PARTIAL',
    'INVALID',
    'FAILED',
  ]) {
    const notApplicable = policy.evaluate(
      request({
        command: 'OBSERVE_CONTRADICTORY_FAILURE',
        currentState,
        duplicate: false,
      }),
    );
    assert.equal(notApplicable.ok, false);
    assert.equal(notApplicable.reason, 'CONTRADICTION_NOT_APPLICABLE');
  }
});

test('malformed requests fail closed', () => {
  const cases = [
    [request({ command: 'INGEST' }), 'INVALID_COMMAND'],
    [request({ currentState: 'STREAMING' }), 'UNKNOWN_STATE'],
    [request({ duplicate: 'no' }), 'SEGMENT_FACTS_REQUIRED'],
    [null, 'INVALID_COMMAND'],
  ];
  for (const [input, expected] of cases) {
    const decision = policy.evaluate(input);
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});
