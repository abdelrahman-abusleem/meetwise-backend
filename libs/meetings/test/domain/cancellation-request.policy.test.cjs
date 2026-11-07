'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  CancellationRequestPolicy,
} = require('../../src/domain/cancellation-request.policy.ts');

const policy = new CancellationRequestPolicy();

function submit(overrides) {
  return {
    command: 'SUBMIT_REQUEST',
    currentState: 'REQUESTED',
    meetingLifecycle: 'SCHEDULED',
    actorAuthorized: true,
    idempotencyKeyProvided: true,
    ...overrides,
  };
}

function withdraw(overrides) {
  return {
    command: 'WITHDRAW_REQUEST',
    currentState: 'REQUESTED',
    meetingLifecycle: 'SCHEDULED',
    actorAuthorized: true,
    actorIsOriginalRequester: true,
    ...overrides,
  };
}

function decide(command, overrides) {
  return {
    command,
    currentState: 'REQUESTED',
    meetingLifecycle: 'SCHEDULED',
    actorAuthorized: true,
    expectedRequestVersion: 4,
    currentRequestVersion: 4,
    ...overrides,
  };
}

function expectFail(decision, reason) {
  assert.equal(decision.ok, false);
  assert.deepEqual({ ...decision }, { ok: false, reason });
  assert.ok(Object.isFrozen(decision));
}

test('submit creates a REQUESTED request over a live meeting', () => {
  for (const lifecycle of ['DRAFT', 'SCHEDULED', 'IN_PROGRESS']) {
    const decision = policy.evaluate(submit({ meetingLifecycle: lifecycle }));
    assert.equal(decision.ok, true);
    assert.equal(decision.from, 'REQUESTED');
    assert.equal(decision.to, 'REQUESTED');
    assert.equal(decision.command, 'SUBMIT_REQUEST');
    assert.equal(decision.appliesMw43StopSemantics, false);
    assert.equal(decision.cancelsBeforeStart, false);
    assert.equal(decision.persistentNotifications, true);
    assert.ok(Object.isFrozen(decision));
  }
});

test('submit requires write-time member authorization before anything else', () => {
  expectFail(
    policy.evaluate(
      submit({ actorAuthorized: false, idempotencyKeyProvided: false }),
    ),
    'ACTOR_NOT_AUTHORIZED',
  );
  expectFail(
    policy.evaluate(
      submit({ actorAuthorized: undefined, meetingLifecycle: 'ENDED' }),
    ),
    'ACTOR_NOT_AUTHORIZED',
  );
});

test('submit enforces the row-88 Idempotency-Key after authorization', () => {
  expectFail(
    policy.evaluate(submit({ idempotencyKeyProvided: false })),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  expectFail(
    policy.evaluate(submit({ idempotencyKeyProvided: undefined })),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
});

test('submit is refused once the meeting is terminal', () => {
  for (const lifecycle of ['ENDED', 'CANCELLED']) {
    expectFail(
      policy.evaluate(submit({ meetingLifecycle: lifecycle })),
      'MEETING_ALREADY_TERMINAL',
    );
  }
});

test('submit fails closed while another active request exists', () => {
  expectFail(
    policy.evaluate(submit({ activeRequestExists: true })),
    'ACTIVE_REQUEST_EXISTS',
  );

  assert.equal(
    policy.evaluate(submit({ activeRequestExists: false })).ok,
    true,
  );
});

test('withdraw by the original requester resolves the open request', () => {
  const decision = policy.evaluate(withdraw({}));
  assert.equal(decision.ok, true);
  assert.equal(decision.from, 'REQUESTED');
  assert.equal(decision.to, 'WITHDRAWN');
  assert.equal(decision.appliesMw43StopSemantics, false);
  assert.equal(decision.cancelsBeforeStart, false);
  assert.equal(decision.persistentNotifications, true);
});

test('withdraw requires authorization and original-requester identity', () => {
  expectFail(
    policy.evaluate(withdraw({ actorAuthorized: false })),
    'ACTOR_NOT_AUTHORIZED',
  );
  expectFail(
    policy.evaluate(withdraw({ actorIsOriginalRequester: false })),
    'NOT_ORIGINAL_REQUESTER',
  );
  expectFail(
    policy.evaluate(withdraw({ actorIsOriginalRequester: undefined })),
    'NOT_ORIGINAL_REQUESTER',
  );
});

test('withdraw only applies to a still-open REQUESTED request', () => {
  for (const from of ['APPROVED', 'REJECTED', 'WITHDRAWN']) {
    expectFail(
      policy.evaluate(withdraw({ currentState: from })),
      'REQUEST_NOT_DECIDABLE',
    );
  }
});

test('withdraw and decisions refuse terminal meetings', () => {
  for (const lifecycle of ['ENDED', 'CANCELLED']) {
    expectFail(
      policy.evaluate(withdraw({ meetingLifecycle: lifecycle })),
      'MEETING_ALREADY_TERMINAL',
    );
    expectFail(
      policy.evaluate(
        decide('APPROVE_REQUEST', { meetingLifecycle: lifecycle }),
      ),
      'MEETING_ALREADY_TERMINAL',
    );
    expectFail(
      policy.evaluate(
        decide('REJECT_REQUEST', {
          meetingLifecycle: lifecycle,
          reason: 'not needed now',
        }),
      ),
      'MEETING_ALREADY_TERMINAL',
    );
  }
});

test('withdraw and decisions work over IN_PROGRESS meetings', () => {
  assert.equal(
    policy.evaluate(withdraw({ meetingLifecycle: 'IN_PROGRESS' })).ok,
    true,
  );
  assert.equal(
    policy.evaluate(
      decide('REJECT_REQUEST', {
        meetingLifecycle: 'IN_PROGRESS',
        reason: 'declined',
      }),
    ).ok,
    true,
  );
});

test('decisions refuse anything but the open REQUESTED state', () => {
  for (const from of ['APPROVED', 'REJECTED', 'WITHDRAWN']) {
    expectFail(
      policy.evaluate(decide('APPROVE_REQUEST', { currentState: from })),
      'REQUEST_NOT_DECIDABLE',
    );
    expectFail(
      policy.evaluate(
        decide('REJECT_REQUEST', { currentState: from, reason: 'x' }),
      ),
      'REQUEST_NOT_DECIDABLE',
    );
  }
});

test('decisions enforce the row-89 If-Match pair after the open-state guard', () => {
  expectFail(
    policy.evaluate(
      decide('APPROVE_REQUEST', {
        expectedRequestVersion: 4,
        currentRequestVersion: 5,
      }),
    ),
    'REQUEST_VERSION_MISMATCH',
  );
  expectFail(
    policy.evaluate(
      decide('REJECT_REQUEST', { reason: 'x', currentRequestVersion: 6 }),
    ),
    'REQUEST_VERSION_MISMATCH',
  );
  expectFail(
    policy.evaluate(
      decide('APPROVE_REQUEST', { expectedRequestVersion: undefined }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.evaluate(decide('APPROVE_REQUEST', { currentRequestVersion: 2.5 })),
    'DECISION_FACTS_REQUIRED',
  );
});

test('approval before start cancels the meeting and never rewrites history', () => {
  const beforeStart = policy.evaluate(
    decide('APPROVE_REQUEST', { meetingLifecycle: 'SCHEDULED' }),
  );
  assert.equal(beforeStart.ok, true);
  assert.equal(beforeStart.to, 'APPROVED');
  assert.equal(beforeStart.cancelsBeforeStart, true);
  assert.equal(beforeStart.appliesMw43StopSemantics, false);

  const draft = policy.evaluate(
    decide('APPROVE_REQUEST', { meetingLifecycle: 'DRAFT' }),
  );
  assert.equal(draft.cancelsBeforeStart, true);
});

test('approval over an IN_PROGRESS meeting resolves through MW-043 stop semantics', () => {
  const inProgress = policy.evaluate(
    decide('APPROVE_REQUEST', { meetingLifecycle: 'IN_PROGRESS' }),
  );
  assert.equal(inProgress.ok, true);
  assert.equal(inProgress.to, 'APPROVED');
  assert.equal(inProgress.appliesMw43StopSemantics, true);
  assert.equal(inProgress.cancelsBeforeStart, false);
  assert.equal(inProgress.persistentNotifications, true);
});

const INVARIANT_LIFECYCLES = ['DRAFT', 'SCHEDULED', 'IN_PROGRESS'];

test('invariant: the MW-043 flags never both fire, across every live lifecycle and decision', () => {
  for (const lifecycle of INVARIANT_LIFECYCLES) {
    for (const command of ['APPROVE_REQUEST', 'REJECT_REQUEST']) {
      const decision = policy.evaluate(
        decide(command, {
          meetingLifecycle: lifecycle,
          ...(command === 'REJECT_REQUEST'
            ? { reason: 'invariant sweep' }
            : {}),
        }),
      );
      assert.equal(decision.ok, true);
      assert.equal(
        decision.appliesMw43StopSemantics && decision.cancelsBeforeStart,
        false,
        `flags combine for ${command} over ${lifecycle}`,
      );
    }
  }
});

test('decisions require decision-level write-time authorization first', () => {
  expectFail(
    policy.evaluate(
      decide('APPROVE_REQUEST', {
        actorAuthorized: false,
        currentState: 'APPROVED',
      }),
    ),
    'ACTOR_NOT_AUTHORIZED',
  );
  expectFail(
    policy.evaluate(
      decide('REJECT_REQUEST', {
        actorAuthorized: undefined,
        currentState: 'REQUESTED',
        meetingLifecycle: 'ENDED',
      }),
    ),
    'ACTOR_NOT_AUTHORIZED',
  );
});

test('rejection demands an explicit non-blank audit reason', () => {
  expectFail(
    policy.evaluate(decide('REJECT_REQUEST', { reason: undefined })),
    'REJECTION_REASON_REQUIRED',
  );
  expectFail(
    policy.evaluate(decide('REJECT_REQUEST', { reason: '   ' })),
    'REJECTION_REASON_REQUIRED',
  );
  const rejected = policy.evaluate(
    decide('REJECT_REQUEST', { reason: 'meeting moved, capture not required' }),
  );
  assert.equal(rejected.ok, true);
  assert.equal(rejected.to, 'REJECTED');
  assert.equal(rejected.appliesMw43StopSemantics, false);
});

test('approval does not require a reason but accepts one', () => {
  const decision = policy.evaluate(
    decide('APPROVE_REQUEST', { reason: 'attendee count dropped to zero' }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'APPROVED');
});

test('workflow fails closed on malformed request shapes', () => {
  const cases = [
    [null, 'INVALID_COMMAND'],
    [submit({ command: 'CANCEL_MEETING' }), 'INVALID_COMMAND'],
    [submit({ currentState: 'NOPE' }), 'UNKNOWN_REQUEST_STATE'],
    [submit({ meetingLifecycle: 'ARCHIVED' }), 'UNKNOWN_MEETING_LIFECYCLE'],
    [submit({ actorAuthorized: 'yes' }), 'DECISION_FACTS_REQUIRED'],
    [withdraw({ actorIsOriginalRequester: 1 }), 'DECISION_FACTS_REQUIRED'],
    [submit({ activeRequestExists: 'no' }), 'DECISION_FACTS_REQUIRED'],
    [submit({ idempotencyKeyProvided: 'yes' }), 'DECISION_FACTS_REQUIRED'],
    [decide('REJECT_REQUEST', { reason: 42 }), 'DECISION_FACTS_REQUIRED'],
  ];
  for (const [request, expected] of cases) {
    expectFail(policy.evaluate(request), expected);
  }
});
