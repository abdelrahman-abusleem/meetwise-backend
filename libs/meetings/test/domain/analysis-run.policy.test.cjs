'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  AnalysisRunPolicy,
} = require('../../src/domain/analysis-run.policy.ts');

const policy = new AnalysisRunPolicy();

function request(overrides) {
  return {
    command: 'CLAIM_RUN',
    currentState: 'QUEUED',
    ...overrides,
  };
}

test('queued runs run only after a worker lease fact', () => {
  const claimed = policy.evaluate(
    request({ currentState: 'QUEUED', leaseAcquired: true }),
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.to, 'RUNNING');
  assert.equal(claimed.noAutoApprove, false);
  assert.ok(Object.isFrozen(claimed));

  const noLease = policy.evaluate(
    request({ currentState: 'QUEUED', leaseAcquired: false }),
  );
  assert.equal(noLease.ok, false);
  assert.equal(noLease.reason, 'LEASE_REQUIRED');

  const missingLease = policy.evaluate(request({ currentState: 'QUEUED' }));
  assert.equal(missingLease.ok, false);
  assert.equal(missingLease.reason, 'LEASE_REQUIRED');
});

test('claims are rejected from active and settled runs', () => {
  const running = policy.evaluate(
    request({ currentState: 'RUNNING', leaseAcquired: true }),
  );
  assert.equal(running.ok, false);
  assert.equal(running.reason, 'RUN_IN_PROGRESS');

  for (const settled of ['VALIDATED', 'NEEDS_REVIEW', 'FAILED']) {
    const decision = policy.evaluate(
      request({ currentState: settled, leaseAcquired: true }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'RUN_NOT_ACTIVE');
  }
});

test('validation settles RUNNING to VALIDATED without auto-approving items', () => {
  const settled = policy.evaluate(
    request({
      command: 'SETTLE_VALIDATED',
      currentState: 'RUNNING',
      schemaValidated: true,
      allEvidenceValid: true,
    }),
  );
  assert.equal(settled.ok, true);
  assert.equal(settled.to, 'VALIDATED');
  assert.equal(settled.noAutoApprove, true);
});

test('validation requires the schema AND all evidence to be valid', () => {
  const cases = [
    [{ schemaValidated: false, allEvidenceValid: true }],
    [{ schemaValidated: true, allEvidenceValid: false }],
    [{ schemaValidated: true }],
    [{}],
  ];
  for (const [overrides] of cases) {
    const decision = policy.evaluate({
      command: 'SETTLE_VALIDATED',
      currentState: 'RUNNING',
      ...overrides,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'VALIDATION_NOT_COMPLETE');
  }
});

test('settling is bound to RUNNING for every settle command', () => {
  const froms = ['QUEUED', 'VALIDATED', 'NEEDS_REVIEW', 'FAILED'];
  for (const command of [
    'SETTLE_VALIDATED',
    'SETTLE_NEEDS_REVIEW',
    'SETTLE_FAILED',
    'RECORD_REPAIR',
  ]) {
    for (const currentState of froms) {
      const decision = policy.evaluate(
        request({ command, currentState, failureReason: 'x', repairCount: 0 }),
      );
      if (currentState === 'RUNNING') {
        continue;
      }
      assert.equal(decision.ok, false);
      assert.equal(decision.reason, 'RUN_NOT_ACTIVE');
    }
  }
});

test('repair attempts are bounded by three repair calls', () => {
  for (let repairCount = 0; repairCount < 3; repairCount++) {
    const repair = policy.evaluate(
      request({
        command: 'RECORD_REPAIR',
        currentState: 'RUNNING',
        repairCount,
      }),
    );
    assert.equal(repair.ok, true);
    assert.equal(repair.to, 'RUNNING');
    assert.equal(repair.repairCountAfter, repairCount + 1);
  }

  const exhausted = policy.evaluate(
    request({
      command: 'RECORD_REPAIR',
      currentState: 'RUNNING',
      repairCount: 3,
    }),
  );
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, 'REPAIR_BUDGET_EXHAUSTED');

  const outOfRange = policy.evaluate(
    request({
      command: 'RECORD_REPAIR',
      currentState: 'RUNNING',
      repairCount: 4,
    }),
  );
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.reason, 'DECISION_FACTS_REQUIRED');

  const negative = policy.evaluate(
    request({
      command: 'RECORD_REPAIR',
      currentState: 'RUNNING',
      repairCount: -1,
    }),
  );
  assert.equal(negative.ok, false);
  assert.equal(negative.reason, 'DECISION_FACTS_REQUIRED');
});

test('NEEDS_REVIEW only after the repair phase is concluded, keeping valid items', () => {
  const premature = policy.evaluate(
    request({
      command: 'SETTLE_NEEDS_REVIEW',
      currentState: 'RUNNING',
      repairPhaseConcluded: false,
    }),
  );
  assert.equal(premature.ok, false);
  assert.equal(premature.reason, 'REPAIR_PHASE_NOT_CONCLUDED');

  const missingFlag = policy.evaluate(
    request({ command: 'SETTLE_NEEDS_REVIEW', currentState: 'RUNNING' }),
  );
  assert.equal(missingFlag.ok, false);
  assert.equal(missingFlag.reason, 'REPAIR_PHASE_NOT_CONCLUDED');

  const settled = policy.evaluate(
    request({
      command: 'SETTLE_NEEDS_REVIEW',
      currentState: 'RUNNING',
      repairPhaseConcluded: true,
    }),
  );
  assert.equal(settled.ok, true);
  assert.equal(settled.to, 'NEEDS_REVIEW');
  assert.equal(settled.keepsValidItems, true);
  assert.ok(Object.isFrozen(settled));
});

test('failed runs require a distinct non-blank reason and still allow controlled retry', () => {
  for (const failureReason of [undefined, '', '   ']) {
    const decision = policy.evaluate(
      request({
        command: 'SETTLE_FAILED',
        currentState: 'RUNNING',
        failureReason,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'FAILURE_REASON_REQUIRED');
  }

  const failed = policy.evaluate(
    request({
      command: 'SETTLE_FAILED',
      currentState: 'RUNNING',
      failureReason: 'provider timeout after retries',
    }),
  );
  assert.equal(failed.ok, true);
  assert.equal(failed.to, 'FAILED');
  assert.equal(failed.allowsControlledRetry, true);
});

test('reanalysis spawns a NEW queued run only with a fresh input snapshot fact', () => {
  for (const from of ['VALIDATED', 'NEEDS_REVIEW', 'FAILED']) {
    const reanalysis = policy.evaluate(
      request({
        command: 'REANALYZE',
        currentState: from,
        newInputSnapshotCaptured: true,
      }),
    );
    assert.equal(reanalysis.ok, true);
    assert.equal(reanalysis.to, 'QUEUED');
    assert.equal(reanalysis.newRun, true);
    assert.equal(reanalysis.approvedSnapshotsUntouched, true);
  }

  const missingSnapshot = policy.evaluate(
    request({ command: 'REANALYZE', currentState: 'FAILED' }),
  );
  assert.equal(missingSnapshot.ok, false);
  assert.equal(missingSnapshot.reason, 'DECISION_FACTS_REQUIRED');

  const falseSnapshot = policy.evaluate(
    request({
      command: 'REANALYZE',
      currentState: 'NEEDS_REVIEW',
      newInputSnapshotCaptured: false,
    }),
  );
  assert.equal(falseSnapshot.ok, false);
  assert.equal(falseSnapshot.reason, 'DECISION_FACTS_REQUIRED');
});

test('reanalysis is blocked for queued and running runs', () => {
  const queued = policy.evaluate(
    request({ command: 'REANALYZE', currentState: 'QUEUED' }),
  );
  assert.equal(queued.ok, false);
  assert.equal(queued.reason, 'ALREADY_QUEUED');

  const running = policy.evaluate(
    request({ command: 'REANALYZE', currentState: 'RUNNING' }),
  );
  assert.equal(running.ok, false);
  assert.equal(running.reason, 'RUN_IN_PROGRESS');
});

test('malformed run requests fail closed', () => {
  const cases = [
    [request({ command: 'ANALYZE' }), 'INVALID_COMMAND'],
    [request({ currentState: 'DISPATCHED' }), 'UNKNOWN_RUN_STATE'],
    [request({ leaseAcquired: 'yes' }), 'DECISION_FACTS_REQUIRED'],
    [request({ repairCount: 1.5 }), 'DECISION_FACTS_REQUIRED'],
    [request({ newInputSnapshotCaptured: 'yes' }), 'DECISION_FACTS_REQUIRED'],
    [null, 'INVALID_COMMAND'],
  ];
  for (const [input, expected] of cases) {
    const decision = policy.evaluate(input);
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});
