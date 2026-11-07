'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MeetingLifecyclePolicy,
} = require('../../src/domain/meeting-lifecycle.policy.ts');

const policy = new MeetingLifecyclePolicy();

function request(overrides) {
  return {
    command: 'SCHEDULE',
    currentLifecycle: 'DRAFT',
    currentScheduleVersion: 0,
    authorized: true,
    reason: 'owner request',
    ...overrides,
  };
}

test('DRAFT schedules the meeting and invalidates stale jobs for later dispatches', () => {
  const decision = policy.evaluate(
    request({ command: 'SCHEDULE', reason: undefined }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.from, 'DRAFT');
  assert.equal(decision.to, 'SCHEDULED');
  assert.equal(decision.invalidateStaleJobs, true);
  assert.equal(decision.stopCapture, false);
  assert.ok(Object.isFrozen(decision));
});

test('SCHEDULE is rejected off DRAFT including terminal states', () => {
  const cases = [
    ['SCHEDULED', 'ILLEGAL_TRANSITION'],
    ['IN_PROGRESS', 'ILLEGAL_TRANSITION'],
    ['ENDED', 'ALREADY_ENDED'],
    ['CANCELLED', 'NO_RESURRECTION'],
  ];
  for (const [current, expected] of cases) {
    const decision = policy.evaluate(
      request({ currentLifecycle: current, reason: undefined }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});

test('RESCHEDULE keeps SCHEDULED and only works while scheduled', () => {
  const ok = policy.evaluate(
    request({ command: 'RESCHEDULE', currentLifecycle: 'SCHEDULED' }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.to, 'SCHEDULED');
  assert.equal(ok.invalidateStaleJobs, true);

  const fromDraft = policy.evaluate(request({ command: 'RESCHEDULE' }));
  assert.equal(fromDraft.ok, false);
  assert.equal(fromDraft.reason, 'ILLEGAL_TRANSITION');

  const fromEnded = policy.evaluate(
    request({ command: 'RESCHEDULE', currentLifecycle: 'ENDED' }),
  );
  assert.equal(fromEnded.reason, 'ALREADY_ENDED');
});

test('START_CAPTURE moves SCHEDULED to IN_PROGRESS with matching schedule version', () => {
  const ok = policy.evaluate(
    request({
      command: 'START_CAPTURE',
      currentLifecycle: 'SCHEDULED',
      claimedScheduleVersion: 3,
      currentScheduleVersion: 3,
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.to, 'IN_PROGRESS');
  assert.equal(ok.stopCapture, false);
});

test('START_CAPTURE rejects stale or missing scheduler versions', () => {
  const stale = policy.evaluate(
    request({
      command: 'START_CAPTURE',
      currentLifecycle: 'SCHEDULED',
      claimedScheduleVersion: 2,
      currentScheduleVersion: 3,
    }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'STALE_SCHEDULE');

  const missing = policy.evaluate(
    request({
      command: 'START_CAPTURE',
      currentLifecycle: 'SCHEDULED',
      claimedScheduleVersion: null,
    }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'STALE_SCHEDULE');
});

test('START_CAPTURE is rejected from every non-SCHEDULED lifecycle', () => {
  const base = { command: 'START_CAPTURE', claimedScheduleVersion: 0 };
  const cases = [
    ['DRAFT', 'ILLEGAL_TRANSITION'],
    ['IN_PROGRESS', 'ILLEGAL_TRANSITION'],
    ['ENDED', 'ALREADY_ENDED'],
    ['CANCELLED', 'NO_RESURRECTION'],
  ];
  for (const [current, expected] of cases) {
    const decision = policy.evaluate(
      request({ ...base, currentLifecycle: current }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});

test('verified capture completion ends an in-progress meeting', () => {
  const ok = policy.evaluate(
    request({
      command: 'CAPTURE_ENDED',
      currentLifecycle: 'IN_PROGRESS',
      reason: undefined,
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.to, 'ENDED');
  assert.equal(ok.stopCapture, false);
  assert.equal(ok.preservePartialEvidence, false);
});

test('late capture events never mutate unrelated lifecycle states', () => {
  const cases = ['DRAFT', 'SCHEDULED', 'ENDED', 'CANCELLED'];
  for (const current of cases) {
    const decision = policy.evaluate(
      request({
        command: 'CAPTURE_ENDED',
        currentLifecycle: current,
        reason: undefined,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'LATE_CAPTURE_EVENT');
  }
});

test('authorized stop on IN_PROGRESS follows MW-043 stop semantics', () => {
  const decision = policy.evaluate(
    request({
      command: 'ADMIN_STOP',
      currentLifecycle: 'IN_PROGRESS',
      reason: 'policy stop test',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'ENDED');
  assert.equal(decision.stopCapture, true);
  assert.equal(decision.preservePartialEvidence, true);
  assert.equal(decision.invalidateStaleJobs, true);
});

test('stop requires a reason and is illegal without active capture', () => {
  const missingReason = policy.evaluate(
    request({
      command: 'ADMIN_STOP',
      currentLifecycle: 'IN_PROGRESS',
      reason: '   ',
    }),
  );
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.reason, 'MISSING_TRANSITION_REASON');

  for (const current of ['DRAFT', 'SCHEDULED']) {
    const decision = policy.evaluate(
      request({
        command: 'ADMIN_STOP',
        currentLifecycle: current,
        reason: 'unused',
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'ILLEGAL_TRANSITION');
  }
  const ended = policy.evaluate(
    request({
      command: 'ADMIN_STOP',
      currentLifecycle: 'ENDED',
      reason: 'unused',
    }),
  );
  assert.equal(ended.reason, 'ALREADY_ENDED');
  const cancelled = policy.evaluate(
    request({
      command: 'ADMIN_STOP',
      currentLifecycle: 'CANCELLED',
      reason: 'unused',
    }),
  );
  assert.equal(cancelled.reason, 'NO_RESURRECTION');
});

test('ADMIN_CANCEL cancels drafts and scheduled meetings', () => {
  for (const current of ['DRAFT', 'SCHEDULED']) {
    const decision = policy.evaluate(
      request({
        command: 'ADMIN_CANCEL',
        currentLifecycle: current,
        reason: 'conflict',
      }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, 'CANCELLED');
    assert.equal(decision.stopCapture, false);
    assert.equal(decision.preservePartialEvidence, false);
    assert.equal(decision.invalidateStaleJobs, true);
  }
});

test('approved MW-043 cancellation after start ends the meeting without CANCELLED rewrite', () => {
  const decision = policy.evaluate(
    request({
      command: 'ADMIN_CANCEL',
      currentLifecycle: 'IN_PROGRESS',
      reason: 'late cancellation',
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'ENDED');
  assert.equal(decision.stopCapture, true);
  assert.equal(decision.preservePartialEvidence, true);
  assert.equal(decision.invalidateStaleJobs, true);
});

test('cancel requires a reason and terminal states never accept it', () => {
  const missing = policy.evaluate(
    request({ command: 'ADMIN_CANCEL', reason: undefined }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'MISSING_TRANSITION_REASON');

  const ended = policy.evaluate(
    request({
      command: 'ADMIN_CANCEL',
      currentLifecycle: 'ENDED',
      reason: 'late',
    }),
  );
  assert.equal(ended.ok, false);
  assert.equal(ended.reason, 'ALREADY_ENDED');

  const cancelled = policy.evaluate(
    request({
      command: 'ADMIN_CANCEL',
      currentLifecycle: 'CANCELLED',
      reason: 'again',
    }),
  );
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.reason, 'NO_RESURRECTION');
});

test('authorization is mandatory and boolean', () => {
  const unauthorized = policy.evaluate(request({ authorized: false }));
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, 'UNAUTHORIZED');

  const nonBoolean = policy.evaluate(request({ authorized: 'yes' }));
  assert.equal(nonBoolean.ok, false);
  assert.equal(nonBoolean.reason, 'UNAUTHORIZED');
});

test('malformed requests fail closed', () => {
  const cases = [
    [
      request({ command: 'AUTOMATIC_JOIN', currentLifecycle: 'SCHEDULED' }),
      'INVALID_COMMAND',
    ],
    [request({ currentLifecycle: 'RUNNING' }), 'UNKNOWN_LIFECYCLE'],
    [request({ currentScheduleVersion: -1 }), 'INVALID_SCHEDULE_VERSION'],
    [request({ currentScheduleVersion: 1.5 }), 'INVALID_SCHEDULE_VERSION'],
    [null, 'INVALID_COMMAND'],
  ];
  for (const [input, expected] of cases) {
    const decision = policy.evaluate(input);
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});

test('optional reason stays accepted where not required', () => {
  const completed = policy.evaluate(
    request({
      command: 'CAPTURE_ENDED',
      currentLifecycle: 'IN_PROGRESS',
      reason: 'provider event',
    }),
  );
  assert.equal(completed.ok, true);
});

test('blank optional reasons behave as absent, only non-string garbage rejects', () => {
  for (const reason of ['', '   ']) {
    const blank = policy.evaluate(request({ command: 'SCHEDULE', reason }));
    assert.equal(blank.ok, true);
  }

  const garbage = policy.evaluate(request({ command: 'SCHEDULE', reason: 42 }));
  assert.equal(garbage.ok, false);
  assert.equal(garbage.reason, 'MISSING_TRANSITION_REASON');
});

test('authorized MANUAL_END ends an in-progress meeting without stop semantics', () => {
  const ended = policy.evaluate(
    request({
      command: 'MANUAL_END',
      currentLifecycle: 'IN_PROGRESS',
      reason: undefined,
    }),
  );
  assert.equal(ended.ok, true);
  assert.equal(ended.to, 'ENDED');

  assert.equal(ended.stopCapture, false);
  assert.equal(ended.preservePartialEvidence, false);
  assert.equal(ended.invalidateStaleJobs, true);
  assert.ok(Object.isFrozen(ended));
});

test('MANUAL_END is illegal from every other lifecycle', () => {
  const cases = [
    ['DRAFT', 'ILLEGAL_TRANSITION'],
    ['SCHEDULED', 'ILLEGAL_TRANSITION'],
    ['ENDED', 'ALREADY_ENDED'],
    ['CANCELLED', 'NO_RESURRECTION'],
  ];
  for (const [current, expected] of cases) {
    const decision = policy.evaluate(
      request({ command: 'MANUAL_END', currentLifecycle: current }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});
