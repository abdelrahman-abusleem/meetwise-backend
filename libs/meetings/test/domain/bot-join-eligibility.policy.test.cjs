'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  BotJoinEligibilityPolicy,
} = require('../../src/domain/bot-join-eligibility.policy.ts');

const policy = new BotJoinEligibilityPolicy();

function facts(overrides) {
  return {
    meetingId: 'meeting-1',
    meetingKind: 'TECH',
    meetingLifecycle: 'SCHEDULED',
    occurrenceStartAt: '2026-10-27T10:00:00Z',
    dispatchAt: '2026-10-27T10:01:00Z',
    staleJob: false,
    scheduleVersionExpected: 3,
    scheduleVersionCurrent: 3,
    meetUrl: 'https://meet.google.com/abc-defg-hij',
    departmentActivationState: 'ACTIVE',
    providerConnectionAuthorized: true,
    providerConfigEnabled: true,
    capturePrerequisitesVerified: true,
    ...overrides,
  };
}

function expectPass(request) {
  const decision = policy.evaluate(request);
  assert.equal(decision.ok, true);
  assert.deepEqual({ ...decision }, { ok: true });
  assert.ok(Object.isFrozen(decision));
}

function expectFail(request, reason) {
  const decision = policy.evaluate(request);
  assert.equal(decision.ok, false);
  assert.deepEqual(
    { ...decision },
    { ok: false, reason, preventEnumeration: false },
  );
  assert.ok(Object.isFrozen(decision));
}

test('an eligible TECH occurrence passes with exactly the {ok:true} decision', () => {
  expectPass(facts());
});

test('an eligible SALES occurrence passes', () => {
  expectPass(facts({ meetingKind: 'SALES' }));
});

test('an eligible GENERAL occurrence passes with NO department activation', () => {
  expectPass(
    facts({ meetingKind: 'GENERAL', departmentActivationState: undefined }),
  );
});

test('GENERAL with the canonical null department state is the absent shape', () => {
  expectPass(
    facts({ meetingKind: 'GENERAL', departmentActivationState: null }),
  );
});

test('a non-object request is INVALID_REQUEST (null, string, number)', () => {
  expectFail(null, 'INVALID_REQUEST');
  expectFail('facts', 'INVALID_REQUEST');
  expectFail(7, 'INVALID_REQUEST');
});

test('empty or missing decision facts are DECISION_FACTS_REQUIRED', () => {
  expectFail(facts({ meetingId: '' }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ meetingId: undefined }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ meetingKind: '' }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ meetingLifecycle: '   ' }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ meetUrl: '' }), 'DECISION_FACTS_REQUIRED');
});

test('a non-string meeting kind value cannot be reconciled', () => {
  expectFail(facts({ meetingKind: 3 }), 'DECISION_FACTS_REQUIRED');
});

test('every required boolean fact must be present (missing one fails closed)', () => {
  expectFail(facts({ staleJob: undefined }), 'DECISION_FACTS_REQUIRED');
  expectFail(
    facts({ providerConnectionAuthorized: undefined }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    facts({ providerConfigEnabled: undefined }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    facts({ capturePrerequisitesVerified: undefined }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('the scheduleVersion pair must be present as positive integers', () => {
  expectFail(facts({ scheduleVersionExpected: 0 }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ scheduleVersionCurrent: -1 }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ scheduleVersionCurrent: 1.5 }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ scheduleVersionCurrent: '3' }), 'DECISION_FACTS_REQUIRED');
});

test('an off-catalog meeting kind is unknown', () => {
  expectFail(facts({ meetingKind: 'PRODUCT' }), 'UNKNOWN_MEETING_KIND');
});

test('an off-catalog lifecycle is unknown', () => {
  expectFail(facts({ meetingLifecycle: 'SOMEDAY' }), 'UNKNOWN_LIFECYCLE');
});

test('an off-catalog department activation state is unknown', () => {
  expectFail(
    facts({ departmentActivationState: 'INACTIVE' }),
    'UNKNOWN_DEPARTMENT_STATE',
  );
});

test('non-SCHEDULED lifecycles are not joinable through this gate', () => {
  expectFail(facts({ meetingLifecycle: 'DRAFT' }), 'MEETING_NOT_JOINABLE');
  expectFail(
    facts({ meetingLifecycle: 'IN_PROGRESS' }),
    'MEETING_NOT_JOINABLE',
  );
  expectFail(facts({ meetingLifecycle: 'ENDED' }), 'MEETING_NOT_JOINABLE');
  expectFail(facts({ meetingLifecycle: 'CANCELLED' }), 'MEETING_NOT_JOINABLE');
});

test('a delivered job flagged stale is ignored', () => {
  expectFail(facts({ staleJob: true }), 'STALE_JOB');
});

test('a scheduleVersion pair mismatch marks the delivery stale (FM-13)', () => {
  expectFail(
    facts({ scheduleVersionExpected: 3, scheduleVersionCurrent: 4 }),
    'STALE_JOB',
  );
});

test('the occurrence cannot be due before its scheduled time', () => {
  expectFail(facts({ dispatchAt: '2026-10-27T09:59:00Z' }), 'MEETING_NOT_DUE');

  expectPass(
    facts({
      occurrenceStartAt: '2026-10-27T10:00:00Z',
      dispatchAt: '2026-10-27T10:00:00Z',
    }),
  );
});

test('instants must be present, shaped, and parseable', () => {
  expectFail(
    facts({ occurrenceStartAt: undefined }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    facts({ occurrenceStartAt: '2026-10-27 10:00:00' }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(facts({ dispatchAt: undefined }), 'DECISION_FACTS_REQUIRED');
  expectFail(facts({ dispatchAt: 'nonsense' }), 'DECISION_FACTS_REQUIRED');
  expectFail(
    facts({ occurrenceStartAt: '2026-13-01T00:00:00Z' }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('only the canonical supported Google Meet host is joinable', () => {
  expectFail(
    facts({ meetUrl: 'https://zoom.us/j/123' }),
    'UNSUPPORTED_MEETING_URL',
  );
  expectFail(
    facts({ meetUrl: 'http://meet.google.com/abc' }),
    'UNSUPPORTED_MEETING_URL',
  );
  expectFail(
    facts({ meetUrl: 'https://meet.google.com/' }),
    'UNSUPPORTED_MEETING_URL',
  );
  expectFail(
    facts({ meetUrl: 'https://meet.google.com' }),
    'UNSUPPORTED_MEETING_URL',
  );
});

test('TECH/SALES require DepartmentActivation strictly ACTIVE', () => {
  expectFail(
    facts({ departmentActivationState: 'CONFIGURING' }),
    'DEPARTMENT_NOT_ACTIVE',
  );
  expectFail(
    facts({ meetingKind: 'SALES', departmentActivationState: 'DISABLED' }),
    'DEPARTMENT_NOT_ACTIVE',
  );
  expectFail(
    facts({ departmentActivationState: 'SUSPENDED' }),
    'DEPARTMENT_NOT_ACTIVE',
  );
  expectFail(
    facts({ departmentActivationState: undefined }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('GENERAL with a present department state is an incoherent facts shape', () => {
  expectFail(
    facts({
      meetingKind: 'GENERAL',
      departmentActivationState: 'ACTIVE',
    }),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    facts({
      meetingKind: 'GENERAL',
      departmentActivationState: 'SUSPENDED',
    }),
    'DECISION_FACTS_REQUIRED',
  );
});

test('provider readiness requires BOTH the connection authorization and the enabled configuration', () => {
  expectFail(
    facts({ providerConnectionAuthorized: false }),
    'PROVIDER_NOT_READY',
  );
  expectFail(facts({ providerConfigEnabled: false }), 'PROVIDER_NOT_READY');
});

test('unverified capture-policy prerequisites refuse the dispatch (AJ-10)', () => {
  expectFail(
    facts({ capturePrerequisitesVerified: false }),
    'PROVIDER_NOT_READY',
  );
});

test('staleness precedes every later gate', () => {
  expectFail(
    facts({
      staleJob: true,
      meetingLifecycle: 'IN_PROGRESS',
      dispatchAt: '2026-10-27T09:00:00Z',
    }),
    'STALE_JOB',
  );
  expectFail(
    facts({
      scheduleVersionExpected: 3,
      scheduleVersionCurrent: 9,
      dispatchAt: '2026-10-27T09:00:00Z',
    }),
    'STALE_JOB',
  );
});

test('staleness precedes provider readiness', () => {
  expectFail(
    facts({
      staleJob: true,
      providerConnectionAuthorized: false,
    }),
    'STALE_JOB',
  );
});

test('the Meet-URL gate precedes the department-activation gate', () => {
  expectFail(
    facts({
      meetUrl: 'https://zoom.us/j/123',
      departmentActivationState: 'DISABLED',
    }),
    'UNSUPPORTED_MEETING_URL',
  );
});

test('the department gate precedes provider readiness', () => {
  expectFail(
    facts({
      departmentActivationState: 'DISABLED',
      providerConfigEnabled: false,
    }),
    'DEPARTMENT_NOT_ACTIVE',
  );
});

test('the due-time gate precedes provider readiness', () => {
  expectFail(
    facts({
      occurrenceStartAt: '2026-10-27T10:00:00Z',
      dispatchAt: '2026-10-27T09:00:00Z',
      providerConfigEnabled: false,
    }),
    'MEETING_NOT_DUE',
  );
});

test('shape failures come before any ordered gate', () => {
  expectFail(
    facts({
      meetingKind: 'PRODUCT',
      staleJob: true,
      meetUrl: 'https://zoom.us/x',
    }),
    'UNKNOWN_MEETING_KIND',
  );
  expectFail(
    facts({
      staleJob: undefined,
      meetingLifecycle: 'ENDED',
    }),
    'DECISION_FACTS_REQUIRED',
  );
});
