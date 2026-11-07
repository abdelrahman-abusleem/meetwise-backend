'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ManagementTransferPolicy,
  MEETING_LIFECYCLE,
  NONTERMINAL_LIFECYCLE,
} = require('../../src/domain/management-transfer.policy.ts');

const policy = new ManagementTransferPolicy();
const MEETING = 'meeting-1';
const REASON = 'Rotation per section lead request';

function facts(overrides) {
  return {
    meetingId: MEETING,
    transfererAuthorized: true,
    transfererDeptMatches: true,
    meetingKind: 'TECH',
    meetingLifecycle: 'SCHEDULED',
    expectedMeetingVersion: 7,
    currentMeetingVersion: 7,
    oldMeetingAdminId: 'mgr-1',
    newManagerUserId: 'mgr-2',
    targetEligible: true,
    reason: REASON,
    ...overrides,
  };
}

function commitFacts(overrides) {
  return facts({
    expectedMeetingVersion: 8,
    currentMeetingVersion: 8,
    transfererStillAuthorizedAfterRereview: true,
    targetStillEligible: true,
    transfererAuthorized: true,
    transfererDeptMatches: true,
    meetingKind: 'TECH',
    meetingLifecycle: 'SCHEDULED',
    oldMeetingAdminId: 'mgr-1',
    newManagerUserId: 'mgr-2',
    reason: REASON,
    ...overrides,
  });
}

function recomputed(f) {
  return policy.composeTransferId(
    f.meetingId,
    f.oldMeetingAdminId,
    f.newManagerUserId,
    f.reason,
    f.expectedMeetingVersion,
  );
}

function expectFail(decision, reason, preventEnumeration = false) {
  assert.equal(decision.ok, false);
  assert.deepEqual({ ...decision }, { ok: false, reason, preventEnumeration });
  assert.ok(Object.isFrozen(decision));
}

test('lifecycle constants are canonical and terminal ones are excluded from transfer', () => {
  assert.deepEqual(
    [...MEETING_LIFECYCLE],
    ['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'ENDED', 'CANCELLED'],
  );
  assert.deepEqual(
    [...NONTERMINAL_LIFECYCLE],
    ['DRAFT', 'SCHEDULED', 'IN_PROGRESS'],
  );
});

test('initiate: department admin of the meeting department transfers a department meeting', () => {
  const decision = policy.initiateTransfer(facts({}));
  assert.equal(decision.ok, true);
  assert.match(decision.transferId, /^fnv1a64:[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(decision));
});

test('initiate: global roles transfer department meetings and GENERAL meetings', () => {
  assert.equal(
    policy.initiateTransfer(facts({ transfererDeptMatches: false })).ok,
    true,
  );
  const general = policy.initiateTransfer(
    facts({ meetingKind: 'GENERAL', transfererDeptMatches: false }),
  );
  assert.equal(general.ok, true);
});

test('initiate: malformed and non-canonical facts fail closed', () => {
  expectFail(policy.initiateTransfer(null), 'INVALID_REQUEST');
  expectFail(policy.initiateTransfer('facts'), 'INVALID_REQUEST');
  expectFail(
    policy.initiateTransfer(facts({ meetingId: '  ' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.initiateTransfer(facts({ meetingKind: '   ' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.initiateTransfer(facts({ meetingKind: 'HR' })),
    'UNKNOWN_MEETING_KIND',
  );
  expectFail(
    policy.initiateTransfer(facts({ meetingLifecycle: '  ' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.initiateTransfer(facts({ meetingLifecycle: 'ARCHIVED' })),
    'UNKNOWN_LIFECYCLE',
  );
  expectFail(
    policy.initiateTransfer(facts({ meetingLifecycle: 'ENDED' })),
    'TERMINAL_MEETING_NOT_TRANSFERABLE',
  );
  expectFail(
    policy.initiateTransfer(facts({ meetingLifecycle: 'CANCELLED' })),
    'TERMINAL_MEETING_NOT_TRANSFERABLE',
  );
  for (const mutation of [
    { currentMeetingVersion: 0 },
    { expectedMeetingVersion: 1.5 },
    { currentMeetingVersion: Number.NaN },
    { expectedMeetingVersion: Number.POSITIVE_INFINITY },
    { currentMeetingVersion: '7' },
    { oldMeetingAdminId: '' },
    { reason: '   ' },
    { newManagerUserId: undefined },
    { newManagerUserId: '  ' },
  ]) {
    expectFail(
      policy.initiateTransfer(facts(mutation)),
      'DECISION_FACTS_REQUIRED',
    );
  }
});

test('initiate: authorization is checked BEFORE version/eligibility (anti-probing order)', () => {
  expectFail(
    policy.initiateTransfer(
      facts({ transfererAuthorized: false, expectedMeetingVersion: 9 }),
    ),
    'TRANSFER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.initiateTransfer(
      facts({ transfererAuthorized: 'yes', currentMeetingVersion: 9 }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.initiateTransfer(facts({ transfererDeptMatches: null })),
    'DECISION_FACTS_REQUIRED',
  );
});

test('initiate: GENERAL meetings cannot be transferred by a department-matched actor', () => {
  expectFail(
    policy.initiateTransfer(
      facts({ meetingKind: 'GENERAL', transfererDeptMatches: true }),
    ),
    'TRANSFER_NOT_AUTHORIZED',
  );
});

test('initiate: stale If-Match pair, ineligible target, and no-op target are rejected', () => {
  expectFail(
    policy.initiateTransfer(facts({ currentMeetingVersion: 8 })),
    'MEETING_VERSION_MISMATCH',
  );
  expectFail(
    policy.initiateTransfer(facts({ targetEligible: false })),
    'TARGET_NOT_ELIGIBLE',
  );
  expectFail(
    policy.initiateTransfer(facts({ newManagerUserId: 'mgr-1' })),
    'DECISION_FACTS_REQUIRED',
  );
});

test('initiate: the operation fingerprint is stable and binds the versioned content', () => {
  const a = recomputed(facts({}));
  assert.equal(a, recomputed(facts({})));
  assert.match(a, /^fnv1a64:[0-9a-f]{16}$/);
  const variants = [
    recomputed(facts({ meetingId: 'meeting-2' })),
    recomputed(facts({ oldMeetingAdminId: 'mgr-1x' })),
    recomputed(facts({ newManagerUserId: 'mgr-2x' })),
    recomputed(facts({ reason: 'other reason' })),
    recomputed({
      meetingId: 'mgr-1|mgr-2',
      oldMeetingAdminId: 'reason',
      newManagerUserId: '',
      reason: '',
      expectedMeetingVersion: 7,
    }),
  ];
  assert.equal(new Set([a, ...variants]).size, 6);
});

test('commit: happy re-check passes (stated token = recomposition)', () => {
  const cf = commitFacts({});
  const decision = policy.commitTransfer(cf, recomputed(cf));
  assert.deepEqual({ ...decision }, { ok: true });
  assert.ok(Object.isFrozen(decision));
});

test('commit: the stated token must equal the recomputed identity quadruple', () => {
  const cf = commitFacts({});
  expectFail(
    policy.commitTransfer(cf, 'fnv1a64:0000000000000000'),
    'TRANSFER_TOKEN_MISMATCH',
  );

  const tampered = commitFacts({ newManagerUserId: 'mgr-3' });
  expectFail(
    policy.commitTransfer(tampered, recomputed(commitFacts({}))),
    'TRANSFER_TOKEN_MISMATCH',
  );

  expectFail(
    policy.commitTransfer(cf, recomputed(cf), 'fnv1a64:0000000000000000'),
    'TRANSFER_TOKEN_MISMATCH',
  );
  const storedOk = policy.commitTransfer(cf, recomputed(cf), recomputed(cf));
  assert.deepEqual({ ...storedOk }, { ok: true });
});

test('commit: a self-recomputed token is a fresh self-consistent transfer, not a smuggle', () => {
  const fresh = commitFacts({
    newManagerUserId: 'mgr-3',
    transfererAuthorized: false,
  });
  expectFail(
    policy.commitTransfer(fresh, recomputed(fresh)),
    'TRANSFER_NOT_AUTHORIZED',
  );
  const legit = commitFacts({ newManagerUserId: 'mgr-3' });
  assert.deepEqual(
    { ...policy.commitTransfer(legit, recomputed(legit)) },
    { ok: true },
  );
});

test('commit: re-authorization, version race, and target re-eligibility are enforced', () => {
  const cf = commitFacts({});
  const token = recomputed(cf);
  expectFail(
    policy.commitTransfer(
      commitFacts({ transfererStillAuthorizedAfterRereview: false }),
      token,
    ),
    'TRANSFER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.commitTransfer(
      commitFacts({ transfererStillAuthorizedAfterRereview: 'yes' }),
      token,
    ),
    'TRANSFER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.commitTransfer(commitFacts({ currentMeetingVersion: 9 }), token),
    'MEETING_VERSION_MISMATCH',
  );
  expectFail(
    policy.commitTransfer(
      commitFacts({ targetStillEligible: 'yes', currentMeetingVersion: 9 }),
      token,
    ),
    'MEETING_VERSION_MISMATCH',
  );
  expectFail(
    policy.commitTransfer(commitFacts({ targetStillEligible: false }), token),
    'TARGET_NOT_ELIGIBLE',
  );
  expectFail(
    policy.commitTransfer(commitFacts({ targetStillEligible: 'yes' }), token),
    'TARGET_NOT_ELIGIBLE',
  );
  expectFail(
    policy.commitTransfer(commitFacts({ newManagerUserId: 'mgr-1' }), token),
    'DECISION_FACTS_REQUIRED',
  );
});

test('commit: GENERAL and global-anywhere rules mirror initiate exactly', () => {
  const globalTech = commitFacts({ transfererDeptMatches: false });
  assert.deepEqual(
    { ...policy.commitTransfer(globalTech, recomputed(globalTech)) },
    { ok: true },
  );
  const globalGeneral = commitFacts({
    meetingKind: 'GENERAL',
    transfererDeptMatches: false,
  });
  assert.deepEqual(
    { ...policy.commitTransfer(globalGeneral, recomputed(globalGeneral)) },
    { ok: true },
  );
  expectFail(
    policy.commitTransfer(
      commitFacts({ meetingKind: 'GENERAL', transfererDeptMatches: true }),
      recomputed(
        commitFacts({ meetingKind: 'GENERAL', transfererDeptMatches: true }),
      ),
    ),
    'TRANSFER_NOT_AUTHORIZED',
  );
});
