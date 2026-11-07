'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MeetingAssignmentService,
} = require('../../src/application/meeting-assignment.service.ts');
const {
  MeetingAssignmentPolicy,
} = require('../../src/domain/meeting-assignment.policy.ts');
const {
  fingerprint64,
} = require('../../src/domain/approve-remaining.policy.ts');

const policy = new MeetingAssignmentPolicy();

test('malformed policy assignment-id slots deny before repository access', async () => {
  for (const ids of [[undefined, 'synthetic'], new Array(2)]) {
    const repository = fakeRepository();
    const service = new MeetingAssignmentService(repository, {
      decide: () => ({
        ok: true,
        k: 'ASSIGN',
        assignmentIds: ids,
        grantsReviewerOnly: false,
      }),
    });
    const result = await service.assign({
      meetingId: MEETING,
      assignedById: 'da-1',
      facts: facts(),
    });
    assert.equal(result.ok, false);
    assert.equal(repository.calls.length, 0);
  }
});
const MEETING = 'meeting-1';

function assignmentIdFor(userId, role = 'APPROVER', assignerId = 'da-1') {
  return fingerprint64(
    `${MEETING.length}:${MEETING}|` +
      `${userId.length}:${userId}|` +
      `${role.length}:${role}|` +
      `${assignerId.length}:${assignerId}`,
  );
}

function facts(overrides) {
  return {
    meetingId: MEETING,
    meetingKind: 'TECH',
    assignerUserId: 'da-1',
    assignerScope: 'DEPARTMENT',
    userIds: ['user-1', 'user-2'],
    eligibleUserIds: ['user-1', 'user-2', 'user-3'],
    role: 'APPROVER',
    ...overrides,
  };
}

function fakeRepository() {
  const calls = [];
  const activeUserRows = new Map();
  const ids = new Map();
  return {
    calls,
    async createAssignments(role, records) {
      calls.push({
        op: 'createAssignments',
        role,
        records: records.map((r) => ({ ...r })),
      });
      for (const record of records) {
        if (ids.has(`${role}:${record.id}`)) {
          throw new Error(
            ids.get(`${role}:${record.id}`) === 'revoked'
              ? 'id_collision_with_revoked_history_row'
              : 'duplicate_active_assignment',
          );
        }
        const key = `${role}:${record.meetingId}:${record.userId}`;
        if (activeUserRows.has(key)) {
          throw new Error(
            'duplicate_active_assignment (ERD line 153 unique-active duty)',
          );
        }
        ids.set(`${role}:${record.id}`, 'active');
        activeUserRows.set(key, record.id);
      }
      return { created: records.map((r) => ({ ...r })) };
    },
    async revokeMeetingApproverAssignment(assignmentId, meetingId) {
      calls.push({ op: 'revokeApprover', assignmentId, meetingId });
      return doRevoke('APPROVER', 'revokeApprover', assignmentId, meetingId);
    },
    async revokeMeetingReviewerAssignment(assignmentId, meetingId) {
      calls.push({ op: 'revokeReviewer', assignmentId, meetingId });
      return doRevoke('REVIEWER', 'revokeReviewer', assignmentId, meetingId);
    },
  };

  function doRevoke(role, opLabel, assignmentId, meetingId) {
    if (meetingId !== MEETING) {
      throw new Error('wrong meeting binding (contract duty)');
    }
    if (ids.get(`${role}:${assignmentId}`) === 'revoked') {
      throw new Error('already_revoked (no second revocation event)');
    }
    if (ids.get(`${role}:${assignmentId}`) !== 'active') {
      throw new Error(
        'revoke target not found / wrong meeting (contract duty)',
      );
    }
    ids.set(`${role}:${assignmentId}`, 'revoked');
    return {
      record: {
        id: assignmentId,
        meetingId,
        userId: 'user-1',
        assignedById: 'da-1',
      },
    };
  }
}

function svcFor(repo) {
  return { repo, service: new MeetingAssignmentService(repo) };
}

test('assign persists one record per user in a SINGLE all-or-nothing repo call', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const result = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({}),
  });
  assert.equal(result.ok, true);
  assert.equal(result.k, 'ASSIGN');
  assert.equal(result.role, 'APPROVER');
  assert.equal(result.grantsReviewerOnly, false);
  assert.deepEqual(
    [...result.assignments].map((a) => ({ ...a })),
    [
      {
        id: assignmentIdFor('user-1'),
        meetingId: MEETING,
        userId: 'user-1',
        assignedById: 'da-1',
      },
      {
        id: assignmentIdFor('user-2'),
        meetingId: MEETING,
        userId: 'user-2',
        assignedById: 'da-1',
      },
    ],
  );
  assert.equal(
    repo.calls.length,
    1,
    'one transaction call for the whole batch',
  );
  assert.equal(repo.calls[0].op, 'createAssignments');
  assert.equal(repo.calls[0].role, 'APPROVER');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.assignments));
  assert.ok(Object.isFrozen(result.assignments[0]));
});

test('assign passes policy failures through with ZERO storage access', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const unauthorized = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({
      assignerScope: 'MEETING_DELEGATED',
      meetingScopeDelegationVerified: true,
    }),
  });
  assert.deepEqual(
    { ...unauthorized },
    {
      ok: false,
      reason: 'ASSIGNER_NOT_AUTHORIZED',
      preventEnumeration: false,
    },
  );
  assert.ok(Object.isFrozen(unauthorized));
  assert.equal(repo.calls.length, 0);
  const ineligible = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ userIds: ['user-1', 'user-9'] }),
  });
  assert.equal(ineligible.ok, false);
  assert.equal(ineligible.reason, 'TARGET_NOT_ELIGIBLE');
  assert.deepEqual([...ineligible.offendingUserIds], ['user-9']);
  assert.ok(Object.isFrozen(ineligible.offendingUserIds));
  assert.equal(repo.calls.length, 0);
});

test('mixed-state guards close the transfer-pattern gap (M3): meeting AND actor binding', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const mixedMeeting = await service.assign({
    meetingId: 'meeting-OTHER',
    assignedById: 'da-1',
    facts: facts({}),
  });
  assert.deepEqual(
    { ...mixedMeeting },
    {
      ok: false,
      reason: 'DECISION_FACTS_REQUIRED',
      preventEnumeration: false,
    },
  );
  assert.ok(Object.isFrozen(mixedMeeting));

  const mixedActor = await service.assign({
    meetingId: MEETING,
    assignedById: 'other-actor',
    facts: facts({}),
  });
  assert.equal(mixedActor.ok, false);
  assert.equal(mixedActor.reason, 'DECISION_FACTS_REQUIRED');
  const mixedRevoke = await service.revoke({
    meetingId: 'meeting-OTHER',
    assignmentId: 'x',
    facts: facts({
      command: 'REVOKE',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  });
  assert.equal(mixedRevoke.ok, false);
  assert.equal(mixedRevoke.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repo.calls.length, 0);
});

test('reviewer assignments grant reviewer-only and never approver authority', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const result = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ role: 'REVIEWER' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'REVIEWER');
  assert.equal(result.grantsReviewerOnly, true);

  const withPrivileges = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ privileges: 'can-review-kyc' }),
  });
  assert.equal(withPrivileges.ok, true);
  for (const record of withPrivileges.assignments) {
    assert.deepEqual(
      Object.keys(record).sort(),
      ['assignedById', 'id', 'meetingId', 'userId'],
      'exact 4-field ERD whitelist; no storage internals can leak through',
    );
  }

  const recordCall = repo.calls
    .filter((c) => c.op === 'createAssignments' && c.role === 'APPROVER')
    .pop();
  for (const r of recordCall.records) {
    assert.equal(r.privileges, undefined);
  }
});

test('GENERAL meetings deny department-scope assignment before any storage (MW-044)', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const denied = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ meetingKind: 'GENERAL' }),
  });
  assert.deepEqual(
    { ...denied },
    {
      ok: false,
      reason: 'GENERAL_ASSIGNER_NOT_AUTHORIZED',
      preventEnumeration: false,
    },
  );
  assert.equal(repo.calls.length, 0);
});

test('garbage query shapes fail DECISION_FACTS_REQUIRED with zero storage', async () => {
  const { repo, service } = svcFor(fakeRepository());
  for (const query of [
    null,
    { meetingId: '', assignedById: 'da-1', facts: facts({}) },
    { meetingId: '   ', assignedById: 'da-1', facts: facts({}) },
    { meetingId: MEETING, assignedById: null, facts: facts({}) },
    { meetingId: MEETING, assignedById: 'da-1', facts: null },
    { meetingId: MEETING, facts: facts({}) },
  ]) {
    const denied = await service.assign(query);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'DECISION_FACTS_REQUIRED');
    assert.ok(Object.isFrozen(denied));
  }
  for (const query of [
    null,
    { meetingId: '', assignmentId: 'x', facts: facts({}) },
    { meetingId: MEETING, assignmentId: '  ', facts: facts({}) },
    { meetingId: MEETING, facts: facts({}) },
  ]) {
    const denied = await service.revoke(query);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'DECISION_FACTS_REQUIRED');
    assert.ok(Object.isFrozen(denied));
  }
  assert.equal(repo.calls.length, 0);
});

test('a repository lost-race defect propagates (never a silent partial batch)', async () => {
  const exploding = {
    async createAssignments() {
      throw new Error('duplicate_active_assignment');
    },
    async revokeMeetingApproverAssignment() {
      throw new Error('unexpected revoke');
    },
    async revokeMeetingReviewerAssignment() {
      throw new Error('unexpected revoke');
    },
  };
  const racing = new MeetingAssignmentService(exploding);
  await assert.rejects(
    () =>
      racing.assign({
        meetingId: MEETING,
        assignedById: 'da-1',
        facts: facts({}),
      }),
    (error) =>
      error instanceof Error &&
      /duplicate_active_assignment/.test(error.message),
  );
});

test('contract duties modeled: re-assignment over revoked history and double revoke throw', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const created = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ userIds: ['user-1'], eligibleUserIds: ['user-1'] }),
  });
  assert.equal(created.ok, true);
  const id = created.assignments[0].id;
  const revoked = await service.revoke({
    meetingId: MEETING,
    assignmentId: id,
    facts: facts({
      command: 'REVOKE',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  });
  assert.equal(revoked.ok, true);
  assert.ok(Object.isFrozen(revoked));

  await assert.rejects(
    () =>
      service.revoke({
        meetingId: MEETING,
        assignmentId: id,
        facts: facts({
          command: 'REVOKE',
          userIds: undefined,
          eligibleUserIds: undefined,
        }),
      }),
    (error) => error instanceof Error && /already_revoked/.test(error.message),
  );

  await assert.rejects(
    () =>
      service.assign({
        meetingId: MEETING,
        assignedById: 'da-1',
        facts: facts({ userIds: ['user-1'], eligibleUserIds: ['user-1'] }),
      }),
    (error) =>
      error instanceof Error &&
      /id_collision_with_revoked_history_row/.test(error.message),
  );

  const createdReviewer = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({
      role: 'REVIEWER',
      userIds: ['user-1'],
      eligibleUserIds: ['user-1'],
    }),
  });
  assert.equal(createdReviewer.ok, true);
  const reviewerId = createdReviewer.assignments[0].id;
  await assert.doesNotReject(() =>
    service.revoke({
      meetingId: MEETING,
      assignmentId: reviewerId,
      facts: facts({
        command: 'REVOKE',
        role: 'REVIEWER',
        userIds: undefined,
        eligibleUserIds: undefined,
      }),
    }),
  );
  await assert.rejects(
    () =>
      service.revoke({
        meetingId: MEETING,
        assignmentId: reviewerId,
        facts: facts({
          command: 'REVOKE',
          role: 'REVIEWER',
          userIds: undefined,
          eligibleUserIds: undefined,
        }),
      }),
    (error) => error instanceof Error && /already_revoked/.test(error.message),
  );
});

test('revoke addresses the role-specific table WITH the meeting binding', async () => {
  const { repo, service } = svcFor(fakeRepository());

  const createdApprover = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ userIds: ['user-1'], eligibleUserIds: ['user-1'] }),
  });
  assert.equal(createdApprover.ok, true);
  const approverId = createdApprover.assignments[0].id;
  const ok = await service.revoke({
    meetingId: MEETING,
    assignmentId: approverId,
    facts: facts({
      command: 'REVOKE',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  });
  assert.deepEqual(
    { ...ok },
    {
      ok: true,
      k: 'REVOKE',
      role: 'APPROVER',
      revokedAssignmentId: approverId,
    },
  );
  assert.deepEqual(repo.calls[repo.calls.length - 1], {
    op: 'revokeApprover',
    assignmentId: approverId,
    meetingId: MEETING,
  });

  const { repo: revRepo, service: revService } = svcFor(fakeRepository());
  const createdReviewer = await revService.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({
      role: 'REVIEWER',
      userIds: ['user-1'],
      eligibleUserIds: ['user-1'],
    }),
  });
  assert.equal(createdReviewer.ok, true);
  const reviewerId = createdReviewer.assignments[0].id;
  const okReviewer = await revService.revoke({
    meetingId: MEETING,
    assignmentId: reviewerId,
    facts: facts({
      command: 'REVOKE',
      role: 'REVIEWER',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  });
  assert.equal(okReviewer.ok, true);
  assert.equal(okReviewer.role, 'REVIEWER');
  assert.equal(okReviewer.revokedAssignmentId, reviewerId);
  assert.deepEqual(revRepo.calls[revRepo.calls.length - 1], {
    op: 'revokeReviewer',
    assignmentId: reviewerId,
    meetingId: MEETING,
  });

  const { repo: bindRepo, service: bindService } = svcFor(fakeRepository());
  const created = await bindService.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({ userIds: ['user-1'], eligibleUserIds: ['user-1'] }),
  });
  assert.equal(created.ok, true);
  await assert.rejects(
    () =>
      bindService.revoke({
        meetingId: 'meeting-OTHER',
        assignmentId: created.assignments[0].id,
        facts: facts({
          command: 'REVOKE',
          meetingId: 'meeting-OTHER',
          userIds: undefined,
          eligibleUserIds: undefined,
        }),
      }),
    (error) =>
      error instanceof Error && /wrong meeting binding/.test(error.message),
  );
  const wrongMeetingCall = bindRepo.calls.find(
    (c) => c.op === 'revokeApprover',
  );
  assert.equal(wrongMeetingCall.meetingId, 'meeting-OTHER');
});

test('revoke passes policy failures through with zero storage access', async () => {
  const { repo, service } = svcFor(fakeRepository());
  const denied = await service.revoke({
    meetingId: MEETING,
    assignmentId: 'x',
    facts: facts({
      command: 'REVOKE',
      meetingKind: 'GENERAL',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  });
  assert.deepEqual(
    { ...denied },
    {
      ok: false,
      reason: 'GENERAL_ASSIGNER_NOT_AUTHORIZED',
      preventEnumeration: false,
    },
  );
  assert.equal(repo.calls.length, 0);
});

test('an injected policy verdict is genuinely used on BOTH commands', async () => {
  const flipped = Object.freeze({
    ok: false,
    reason: 'DECISION_FACTS_REQUIRED',
    preventEnumeration: false,
  });
  const stubPolicy = { decide: () => flipped };
  const service = new MeetingAssignmentService(fakeRepository(), stubPolicy);
  const deniedAssign = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({}),
  });
  assert.deepEqual({ ...deniedAssign }, { ...flipped });
  const deniedRevoke = await service.revoke({
    meetingId: MEETING,
    assignmentId: 'x',
    facts: facts({
      command: 'REVOKE',
      userIds: undefined,
      eligibleUserIds: undefined,
    }),
  });
  assert.deepEqual({ ...deniedRevoke }, { ...flipped });
});

test('a hypothetical short-batch policy defect fails closed before storage (i1 pin)', async () => {
  const shortBatch = Object.freeze({
    ok: true,
    k: 'ASSIGN',
    assignmentIds: Object.freeze([assignmentIdFor('user-1')]),
    grantsReviewerOnly: false,
  });
  const stubPolicy = { decide: () => shortBatch };
  const repo = fakeRepository();
  const service = new MeetingAssignmentService(repo, stubPolicy);
  const denied = await service.assign({
    meetingId: MEETING,
    assignedById: 'da-1',
    facts: facts({}),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repo.calls.length, 0);
});
