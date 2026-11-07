'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ExternalExecutionPolicy,
} = require('../../src/domain/external-execution.policy.ts');

const policy = new ExternalExecutionPolicy();

function request(overrides) {
  return {
    command: 'CLAIM_DISPATCH',
    currentState: 'PENDING',
    authorized: true,
    ...overrides,
  };
}

test('PENDING and RETRYABLE_FAILED claims move to DISPATCHING', () => {
  const fromPending = policy.evaluate(request({}));
  assert.equal(fromPending.ok, true);
  assert.equal(fromPending.to, 'DISPATCHING');
  assert.ok(Object.isFrozen(fromPending));

  const fromRetriable = policy.evaluate(
    request({ currentState: 'RETRYABLE_FAILED' }),
  );
  assert.equal(fromRetriable.ok, true);
  assert.equal(fromRetriable.to, 'DISPATCHING');
});

test('claims are illegal from DISPATCHING, UNKNOWN and terminal rows', () => {
  const cases = [
    'DISPATCHING',
    'UNKNOWN',
    'SUCCEEDED',
    'PERMANENT_FAILED',
    'CANCELLED',
  ];
  for (const state of cases) {
    const decision = policy.evaluate(request({ currentState: state }));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'INVALID_TRANSITION');
  }
});

test('confirmed success stores the provider reference', () => {
  const decision = policy.evaluate(
    request({
      command: 'CONFIRM_SUCCESS',
      currentState: 'DISPATCHING',
      externalRef: 'ISSUE-42',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'SUCCEEDED');
  assert.equal(decision.idempotentDuplicate, false);
});

test('missing external reference rejects confirmation', () => {
  for (const externalRef of [undefined, '', '   ']) {
    const decision = policy.evaluate(
      request({
        command: 'CONFIRM_SUCCESS',
        currentState: 'DISPATCHING',
        externalRef,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'MISSING_EXTERNAL_REFERENCE');
  }
});

test('duplicate success confirmation with the same reference is an idempotent re-ack', () => {
  const decision = policy.evaluate(
    request({
      command: 'CONFIRM_SUCCESS',
      currentState: 'SUCCEEDED',
      externalRef: 'ISSUE-42',
      expectedExternalRef: 'ISSUE-42',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'SUCCEEDED');
  assert.equal(decision.idempotentDuplicate, true);
});

test('a different external reference on a succeeded row is a conflict', () => {
  const missing = policy.evaluate(
    request({
      command: 'CONFIRM_SUCCESS',
      currentState: 'SUCCEEDED',
      externalRef: 'ISSUE-42',
    }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'MISSING_EXTERNAL_REFERENCE');

  const mismatch = policy.evaluate(
    request({
      command: 'CONFIRM_SUCCESS',
      currentState: 'SUCCEEDED',
      externalRef: 'ISSUE-99',
      expectedExternalRef: 'ISSUE-42',
    }),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'MISMATCHED_EXTERNAL_REFERENCE');
});

test('retryable failures require a reason and only come from DISPATCHING', () => {
  const fromDispatching = policy.evaluate(
    request({
      command: 'RECORD_RETRYABLE_FAILURE',
      currentState: 'DISPATCHING',
      reason: 'upstream 503',
    }),
  );
  assert.equal(fromDispatching.ok, true);
  assert.equal(fromDispatching.to, 'RETRYABLE_FAILED');

  const missing = policy.evaluate(
    request({
      command: 'RECORD_RETRYABLE_FAILURE',
      currentState: 'DISPATCHING',
      reason: '',
    }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'MISSING_FAILURE_REASON');

  const notAllowed = policy.evaluate(
    request({
      command: 'RECORD_RETRYABLE_FAILURE',
      currentState: 'PENDING',
      reason: 'x',
    }),
  );
  assert.equal(notAllowed.ok, false);
  assert.equal(notAllowed.reason, 'INVALID_TRANSITION');
});

test('UNKNOWN never exits through the generic failure recorder (MW-034)', () => {
  const decision = policy.evaluate(
    request({
      command: 'RECORD_RETRYABLE_FAILURE',
      currentState: 'UNKNOWN',
      reason: 'provider confirmed not executed',
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'INVALID_TRANSITION');
});

test('permanent failures require a reason and reject repeating dispatch', () => {
  const decision = policy.evaluate(
    request({
      command: 'RECORD_PERMANENT_FAILURE',
      currentState: 'DISPATCHING',
      reason: 'credential revoked',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'PERMANENT_FAILED');

  const missingReason = policy.evaluate(
    request({
      command: 'RECORD_PERMANENT_FAILURE',
      currentState: 'DISPATCHING',
      reason: null,
    }),
  );
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.reason, 'MISSING_FAILURE_REASON');

  const secondChance = policy.evaluate(
    request({
      command: 'CLAIM_DISPATCH',
      currentState: 'PERMANENT_FAILED',
    }),
  );
  assert.equal(secondChance.ok, false);
  assert.equal(secondChance.reason, 'INVALID_TRANSITION');
});

test('response loss is recorded as UNKNOWN pending reconciliation', () => {
  const decision = policy.evaluate(
    request({
      command: 'MARK_UNKNOWN',
      currentState: 'DISPATCHING',
      reason: undefined,
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'UNKNOWN');
  assert.equal(decision.requiresManualResolution, false);
});

test('unknown rows are reconciled, never blindly retried', () => {
  const blindRetry = policy.evaluate(request({ currentState: 'UNKNOWN' }));
  assert.equal(blindRetry.ok, false);
  assert.equal(blindRetry.reason, 'INVALID_TRANSITION');
});

test('resolved-found links the existing external item', () => {
  const decision = policy.evaluate(
    request({
      command: 'RESOLVE_UNKNOWN_FOUND',
      currentState: 'UNKNOWN',
      externalRef: 'ISSUE-42',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'SUCCEEDED');

  const missing = policy.evaluate(
    request({
      command: 'RESOLVE_UNKNOWN_FOUND',
      currentState: 'UNKNOWN',
      externalRef: '',
    }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'MISSING_EXTERNAL_REFERENCE');
});

test('guaranteed-not-executed unknown resolves to a bounded retry', () => {
  const decision = policy.evaluate(
    request({
      command: 'RESOLVE_UNKNOWN_NOT_EXECUTED',
      currentState: 'UNKNOWN',
      reason: 'provider log says no execution',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'RETRYABLE_FAILED');
});

test('unresolved unknown stays unknown only with audited operator resolution', () => {
  const decision = policy.evaluate(
    request({
      command: 'KEEP_UNKNOWN_MANUAL',
      currentState: 'UNKNOWN',
      reason: 'operator review required per MW-034',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'UNKNOWN');
  assert.equal(decision.requiresManualResolution, true);

  const missingNote = policy.evaluate(
    request({
      command: 'KEEP_UNKNOWN_MANUAL',
      currentState: 'UNKNOWN',
      reason: undefined,
    }),
  );
  assert.equal(missingNote.ok, false);
  assert.equal(missingNote.reason, 'MISSING_FAILURE_REASON');
});

test('route withdrawal before dispatch cancels without external calls', () => {
  for (const state of ['PENDING', 'RETRYABLE_FAILED']) {
    const decision = policy.evaluate(
      request({
        command: 'WITHDRAW_ROUTE',
        currentState: state,
        reason: 'route removed',
      }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, 'CANCELLED');
  }

  const afterDispatch = policy.evaluate(
    request({
      command: 'WITHDRAW_ROUTE',
      currentState: 'DISPATCHING',
      reason: 'late',
    }),
  );
  assert.equal(afterDispatch.ok, false);
  assert.equal(afterDispatch.reason, 'INVALID_TRANSITION');

  const missingReason = policy.evaluate(
    request({
      command: 'WITHDRAW_ROUTE',
      currentState: 'PENDING',
      reason: undefined,
    }),
  );
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.reason, 'MISSING_FAILURE_REASON');
});

test('authorization is mandatory and boolean', () => {
  const unauthorized = policy.evaluate(request({ authorized: false }));
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, 'UNAUTHORIZED');

  const nonBoolean = policy.evaluate(request({ authorized: 1 }));
  assert.equal(nonBoolean.ok, false);
  assert.equal(nonBoolean.reason, 'UNAUTHORIZED');
});

test('malformed requests fail closed', () => {
  const cases = [
    [request({ command: 'RETRY' }), 'INVALID_COMMAND'],
    [request({ currentState: 'RUNNING' }), 'UNKNOWN_STATE'],
    [null, 'INVALID_COMMAND'],
  ];
  for (const [input, expected] of cases) {
    const decision = policy.evaluate(input);
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});

test('confirmation corners reject every non-dispatching and non-succeeded state', () => {
  for (const state of [
    'PENDING',
    'RETRYABLE_FAILED',
    'PERMANENT_FAILED',
    'CANCELLED',
  ]) {
    const decision = policy.evaluate(
      request({
        command: 'CONFIRM_SUCCESS',
        currentState: state,
        externalRef: 'ISSUE-42',
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'INVALID_TRANSITION');
  }
});

test('non-string expectedExternalRef fails closed instead of crashing', () => {
  const decision = policy.evaluate(
    request({
      command: 'CONFIRM_SUCCESS',
      currentState: 'SUCCEEDED',
      externalRef: 'ISSUE-42',
      expectedExternalRef: 42,
    }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'MISSING_EXTERNAL_REFERENCE');
});

test('remaining forbidden-state corners for the execution commands', () => {
  for (const state of [
    'PENDING',
    'RETRYABLE_FAILED',
    'SUCCEEDED',
    'PERMANENT_FAILED',
    'CANCELLED',
  ]) {
    const marked = policy.evaluate(
      request({ command: 'MARK_UNKNOWN', currentState: state }),
    );
    assert.equal(marked.ok, false);
    assert.equal(marked.reason, 'INVALID_TRANSITION');
  }

  for (const state of [
    'PENDING',
    'DISPATCHING',
    'SUCCEEDED',
    'PERMANENT_FAILED',
    'CANCELLED',
  ]) {
    const found = policy.evaluate(
      request({
        command: 'RESOLVE_UNKNOWN_FOUND',
        currentState: state,
        externalRef: 'ISSUE-42',
      }),
    );
    assert.equal(found.ok, false);
    assert.equal(found.reason, 'INVALID_TRANSITION');

    const notExecuted = policy.evaluate(
      request({
        command: 'RESOLVE_UNKNOWN_NOT_EXECUTED',
        currentState: state,
        reason: 'x',
      }),
    );
    assert.equal(notExecuted.ok, false);
    assert.equal(notExecuted.reason, 'INVALID_TRANSITION');

    const keptUnknown = policy.evaluate(
      request({
        command: 'KEEP_UNKNOWN_MANUAL',
        currentState: state,
        reason: 'x',
      }),
    );
    assert.equal(keptUnknown.ok, false);
    assert.equal(keptUnknown.reason, 'INVALID_TRANSITION');
  }

  for (const state of [
    'DISPATCHING',
    'SUCCEEDED',
    'PERMANENT_FAILED',
    'CANCELLED',
  ]) {
    const withdrawn = policy.evaluate(
      request({
        command: 'WITHDRAW_ROUTE',
        currentState: state,
        reason: 'late',
      }),
    );
    assert.equal(withdrawn.ok, false);
    assert.equal(withdrawn.reason, 'INVALID_TRANSITION');
  }

  const missingReason = policy.evaluate(
    request({
      command: 'RESOLVE_UNKNOWN_NOT_EXECUTED',
      currentState: 'UNKNOWN',
      reason: '   ',
    }),
  );
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.reason, 'MISSING_FAILURE_REASON');
});
