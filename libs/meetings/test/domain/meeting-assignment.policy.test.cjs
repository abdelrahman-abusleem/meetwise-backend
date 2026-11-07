'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MeetingAssignmentPolicy,
} = require('../../src/domain/meeting-assignment.policy.ts');

const policy = new MeetingAssignmentPolicy();

function facts(overrides) {
  return {
    command: 'ASSIGN',
    role: 'APPROVER',
    meetingId: 'meeting-1',
    meetingKind: 'TECH',
    assignerUserId: 'da-1',
    assignerScope: 'DEPARTMENT',
    userIds: ['user-1', 'user-2'],
    eligibleUserIds: ['user-1', 'user-2', 'user-3'],
    ...overrides,
  };
}

function expectFail(decision, reason, extra) {
  assert.equal(decision.ok, false);
  if (extra === undefined) {
    assert.deepEqual(
      { ...decision },
      { ok: false, reason, preventEnumeration: false },
    );
  } else {
    assert.deepEqual(
      { ...decision },
      {
        ok: false,
        reason,
        preventEnumeration: false,
        ...extra,
      },
    );
  }
  assert.ok(Object.isFrozen(decision));
}

test('shape: malformed commands, roles, kinds, scopes and batches fail closed', () => {
  expectFail(policy.decide(null), 'INVALID_REQUEST');
  expectFail(
    policy.decide(facts({ command: 'PROMOTE' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(facts({ role: 'MANAGER' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(facts({ meetingId: '' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(facts({ meetingKind: 'HR' })),
    'UNKNOWN_MEETING_KIND',
  );
  expectFail(
    policy.decide(facts({ assignerScope: 'TEAM' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(policy.decide(facts({ userIds: [] })), 'DECISION_FACTS_REQUIRED');
  expectFail(
    policy.decide(facts({ userIds: ['user-1', '  '] })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(facts({ userIds: ['user-1', 'user-1'] })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(facts({ eligibleUserIds: 'user-1' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(facts({ privileges: 42 })),
    'DECISION_FACTS_REQUIRED',
  );
});

test('approver assignment: department and global scopes assign; membership sweep enforced', () => {
  const decision = policy.decide(facts({}));
  assert.deepEqual(
    { ...decision, assignmentIds: [...decision.assignmentIds] },
    {
      ok: true,
      k: 'ASSIGN',
      assignmentIds: [...decision.assignmentIds],
      grantsReviewerOnly: false,
    },
  );
  assert.equal(decision.assignmentIds.length, 2);
  assert.match(decision.assignmentIds[0], /^fnv1a64:[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.assignmentIds));

  const global = policy.decide(
    facts({ assignerUserId: 'owner-1', assignerScope: 'GLOBAL' }),
  );
  assert.equal(global.ok, true);
  assert.equal(global.k, 'ASSIGN');
});

test('approver assignment: a delegated meeting ADMIN can never assign approvers (02 line 15)', () => {
  expectFail(
    policy.decide(
      facts({
        assignerScope: 'MEETING_DELEGATED',
        meetingScopeDelegationVerified: true,
      }),
    ),
    'ASSIGNER_NOT_AUTHORIZED',
  );
});

test('reviewer assignment (MW-044): department scope assigns and grants reviewer-only', () => {
  const decision = policy.decide(facts({ role: 'REVIEWER' }));
  assert.deepEqual(
    { ...decision, assignmentIds: [...decision.assignmentIds] },
    {
      ok: true,
      k: 'ASSIGN',
      assignmentIds: [...decision.assignmentIds],
      grantsReviewerOnly: true,
    },
  );
});

test('reviewer assignment (MW-044): delegated MEETING_ADMIN requires the verified fact', () => {
  expectFail(
    policy.decide(
      facts({ role: 'REVIEWER', assignerScope: 'MEETING_DELEGATED' }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
  const verified = policy.decide(
    facts({
      role: 'REVIEWER',
      assignerScope: 'MEETING_DELEGATED',
      meetingScopeDelegationVerified: true,
    }),
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.k, 'ASSIGN');
  assert.equal(verified.grantsReviewerOnly, true);
});

test('GENERAL meetings: only GLOBAL scope may assign either role (MW-044 sentence + row 100)', () => {
  const ok = policy.decide(
    facts({
      meetingKind: 'GENERAL',
      assignerScope: 'GLOBAL',
      assignerUserId: 'owner-9',
      role: 'REVIEWER',
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.k, 'ASSIGN');
  assert.equal(ok.grantsReviewerOnly, true);

  expectFail(
    policy.decide(facts({ meetingKind: 'GENERAL' })),
    'GENERAL_ASSIGNER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.decide(
      facts({
        meetingKind: 'GENERAL',
        assignerScope: 'MEETING_DELEGATED',
        meetingScopeDelegationVerified: true,
      }),
    ),
    'GENERAL_ASSIGNER_NOT_AUTHORIZED',
  );
});

test('eligibility: an unlisted requested user fails the WHOLE assignment with the offending ids', () => {
  const decision = policy.decide(
    facts({ userIds: ['user-1', 'user-9', 'user-7'] }),
  );
  assert.equal(decision.ok, false);
  assert.deepEqual([...decision.offendingUserIds], ['user-9', 'user-7']);
  assert.ok(Object.isFrozen(decision.offendingUserIds));
});

test('assignment ids are deterministic and distinct across identity dimensions', () => {
  const d1 = policy.decide(facts({}));
  const d2 = policy.decide(facts({}));
  assert.deepEqual([...d1.assignmentIds], [...d2.assignmentIds]);
  const dOtherUser = policy.decide(facts({ assignerUserId: 'da-2' }));
  assert.notEqual(d1.assignmentIds[0], dOtherUser.assignmentIds[0]);
  const dOtherRole = policy.decide(facts({ role: 'REVIEWER' }));
  assert.notEqual(d1.assignmentIds[0], dOtherRole.assignmentIds[0]);
});

test('revoke: mirrors the assignment authorization and never requires a batch', () => {
  const decision = policy.decide(
    facts({
      command: 'REVOKE',
      assignmentId: 'fnv1a64:5003b19a80c47dc2',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  );
  assert.deepEqual(
    { ...decision },
    {
      ok: true,
      k: 'REVOKE',
      revokedAssignmentId: 'fnv1a64:5003b19a80c47dc2',
    },
  );
  expectFail(
    policy.decide(
      facts({
        command: 'REVOKE',
        assignmentId: '   ',
        userIds: undefined,
        eligibleUserIds: undefined,
      }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.decide(
      facts({
        command: 'REVOKE',
        meetingKind: 'GENERAL',
        assignmentId: 'logo-1',
        userIds: undefined,
        eligibleUserIds: undefined,
      }),
    ),
    'GENERAL_ASSIGNER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.decide(
      facts({
        command: 'REVOKE',
        role: 'REVIEWER',
        assignerScope: 'MEETING_DELEGATED',
        assignmentId: 'logo-1',
        userIds: undefined,
        eligibleUserIds: undefined,
      }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
});
