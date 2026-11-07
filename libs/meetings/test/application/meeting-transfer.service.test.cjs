'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ManagementTransferService,
} = require('../../src/application/meeting-transfer.service.ts');
const {
  ManagementTransferPolicy,
} = require('../../src/domain/management-transfer.policy.ts');

const policy = new ManagementTransferPolicy();
const MEETING = 'meeting-1';
const REASON = 'Rotation per section lead request';

function initiateFacts(overrides) {
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

function factsForCommit(overrides) {
  return {
    meetingId: MEETING,
    expectedMeetingVersion: 7,
    currentMeetingVersion: 7,
    meetingKind: 'TECH',
    meetingLifecycle: 'SCHEDULED',
    oldMeetingAdminId: 'mgr-1',
    newManagerUserId: 'mgr-2',
    reason: REASON,
    transfererAuthorized: true,
    transfererDeptMatches: true,
    transfererStillAuthorizedAfterRereview: true,
    targetStillEligible: true,
    ...overrides,
  };
}

function fakeRepository() {
  const calls = [];
  let meetingVersion = 7;
  return {
    calls,
    bumpTo(version) {
      meetingVersion = version;
    },
    async commitManagerTransfer(record, expectedMeetingVersion) {
      calls.push({
        op: 'commitManagerTransfer',
        record: { ...record },
        expectedMeetingVersion,
      });
      if (expectedMeetingVersion !== meetingVersion) {
        throw new Error(
          'conflict: meeting version moved (02 line 89: only one winner)',
        );
      }
      meetingVersion += 1;
      return { record: { ...record }, meetingVersion };
    },
  };
}

function svc(meetingVersion = 7) {
  const repo = fakeRepository();
  repo.bumpTo(meetingVersion);
  return { repo, service: new ManagementTransferService(repo) };
}

function commitQuery(facts, overrides) {
  return {
    meetingId: MEETING,
    transferId: policy.composeTransferId(
      MEETING,
      'mgr-1',
      'mgr-2',
      REASON,
      facts.expectedMeetingVersion,
    ),
    changedById: 'da-1',
    createdAt: '2026-10-25T10:00:00Z',
    facts,
    ...overrides,
  };
}

test('initiate returns the deterministic fingerprint and records the integration duties', async () => {
  const { repo, service } = svc();
  const result = await service.initiateTransfer(initiateFacts({}));
  assert.equal(result.ok, true);
  assert.equal(result.state, 'INITIATED');
  assert.match(result.transferId, /^fnv1a64:[0-9a-f]{16}$/);

  assert.equal(
    result.transferId,
    policy.composeTransferId(MEETING, 'mgr-1', 'mgr-2', REASON, 7),
  );
  assert.equal(result.revokeOldPermissionsAtomically, true);
  assert.equal(result.notifyOldAndNew, true);
  assert.equal(repo.calls.length, 0, 'initiation must never touch storage');
});

test('initiate passes policy failures through unchanged (no storage access)', async () => {
  const { repo, service } = svc();
  const failure = await service.initiateTransfer(
    initiateFacts({ transfererAuthorized: false }),
  );
  assert.deepEqual(
    { ...failure },
    {
      ok: false,
      reason: 'TRANSFER_NOT_AUTHORIZED',
      preventEnumeration: false,
    },
  );
  assert.ok(Object.isFrozen(failure));
  assert.equal(repo.calls.length, 0);
  const garbage = await service.initiateTransfer(null);
  assert.deepEqual(
    { ...garbage },
    {
      ok: false,
      reason: 'DECISION_FACTS_REQUIRED',
      preventEnumeration: false,
    },
  );
  assert.ok(Object.isFrozen(garbage));
});

test('commit persists the full ERD line 77 record under the version guard', async () => {
  const { repo, service } = svc();
  const initiated = await service.initiateTransfer(initiateFacts({}));
  const committed = await service.commitTransfer(
    commitQuery(factsForCommit({}), { transferId: initiated.transferId }),
  );
  assert.equal(committed.ok, true);
  assert.equal(committed.state, 'COMMITTED');
  assert.deepEqual(
    { ...committed.transfer },
    {
      id: initiated.transferId,
      meetingId: MEETING,
      oldMeetingAdminId: 'mgr-1',
      newMeetingAdminId: 'mgr-2',
      changedById: 'da-1',
      reason: REASON,
      createdAt: '2026-10-25T10:00:00Z',
    },
  );
  assert.equal(
    committed.meetingVersion,
    8,
    'post-commit version for the next If-Match',
  );
  assert.deepEqual(repo.calls, [
    {
      op: 'commitManagerTransfer',
      record: { ...committed.transfer },
      expectedMeetingVersion: 7,
    },
  ]);
});

test('a tampered target between initiate and commit fails on the token before any storage access', async () => {
  const { repo, service } = svc();
  const initiated = await service.initiateTransfer(initiateFacts({}));
  const tampered = await service.commitTransfer(
    commitQuery(factsForCommit({ newManagerUserId: 'mgr-9' }), {
      transferId: initiated.transferId,
    }),
  );
  assert.deepEqual(
    { ...tampered },
    {
      ok: false,
      reason: 'TRANSFER_TOKEN_MISMATCH',
      preventEnumeration: false,
    },
  );
  assert.equal(repo.calls.length, 0);
});

test('a lost version race propagates as the repository defect it is (never a silent swap)', async () => {
  const { repo, service } = svc(8);
  const initiated = await service.initiateTransfer(
    initiateFacts({ currentMeetingVersion: 7 }),
  );
  await assert.rejects(
    () =>
      service.commitTransfer(
        commitQuery(factsForCommit({}), { transferId: initiated.transferId }),
      ),
    (error) => error instanceof Error && /version moved/.test(error.message),
  );
  assert.equal(repo.calls.length, 1);
});

test('mixed-state meeting coordinates fail DECISION_FACTS_REQUIRED before storage', async () => {
  const { repo, service } = svc();

  const mixed = await service.commitTransfer(
    commitQuery(factsForCommit({ meetingId: 'meeting-2' }), {
      meetingId: 'meeting-1',
      transferId: policy.composeTransferId(
        'meeting-2',
        'mgr-1',
        'mgr-2',
        REASON,
        7,
      ),
    }),
  );
  assert.deepEqual(
    { ...mixed },
    {
      ok: false,
      reason: 'DECISION_FACTS_REQUIRED',
      preventEnumeration: false,
    },
  );
  assert.equal(repo.calls.length, 0);
});

test('createdAt must be an ISO-8601 instant (format discipline on the durable fact)', async () => {
  const { repo, service } = svc();
  for (const createdAt of ['z', 'now', '2026-10-25 10:00:00', 42, '']) {
    const denied = await service.commitTransfer(
      commitQuery(factsForCommit({}), { createdAt }),
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'DECISION_FACTS_REQUIRED');
  }

  const shapeOnly = await service.commitTransfer(
    commitQuery(factsForCommit({}), {
      createdAt: '2026-99-99T99:99:99Z',
    }),
  );
  assert.equal(shapeOnly.ok, true);
  const fresh = svc();
  const fractional = await fresh.service.commitTransfer(
    commitQuery(factsForCommit({}), {
      createdAt: '2026-10-25T10:00:00.123Z',
    }),
  );
  assert.equal(fractional.ok, true);
  assert.equal(fresh.repo.calls.length, 1);
  const offsetOnly = svc();
  const offset = await offsetOnly.service.commitTransfer(
    commitQuery(factsForCommit({}), {
      createdAt: '2026-10-25T10:00:00+02:00',
    }),
  );
  assert.equal(offset.ok, true);
  assert.equal(offsetOnly.repo.calls.length, 1);
});

test('commit failures fail closed before storage: garbage query and policy rejections', async () => {
  const { repo, service } = svc();
  const validCommitFacts = factsForCommit({});
  for (const query of [
    null,
    {
      meetingId: '',
      transferId: 'x',
      changedById: 'y',
      createdAt: '2026-10-25T10:00:00Z',
      facts: validCommitFacts,
    },
    {
      meetingId: 'm',
      transferId: '   ',
      changedById: 'y',
      createdAt: '2026-10-25T10:00:00Z',
      facts: validCommitFacts,
    },
    {
      meetingId: 'm',
      transferId: 'x',
      changedById: null,
      createdAt: '2026-10-25T10:00:00Z',
      facts: validCommitFacts,
    },
    {
      meetingId: 'm',
      transferId: 'x',
      changedById: 'y',
      createdAt: 5,
      facts: validCommitFacts,
    },
    {
      meetingId: 'm',
      transferId: 'x',
      changedById: 'y',
      createdAt: '2026-10-25T10:00:00Z',
      facts: null,
    },
  ]) {
    const denied = await service.commitTransfer(query);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'DECISION_FACTS_REQUIRED');
  }
  const validToken = policy.composeTransferId(
    MEETING,
    'mgr-1',
    'mgr-2',
    REASON,
    validCommitFacts.expectedMeetingVersion,
  );
  const rejections = [
    {
      facts: factsForCommit({ currentMeetingVersion: 9 }),
      reason: 'MEETING_VERSION_MISMATCH',
    },
    {
      facts: factsForCommit({ targetStillEligible: false }),
      reason: 'TARGET_NOT_ELIGIBLE',
    },
    {
      facts: factsForCommit({ transfererStillAuthorizedAfterRereview: false }),
      reason: 'TRANSFER_NOT_AUTHORIZED',
    },
  ];
  for (const { facts, reason } of rejections) {
    const denied = await service.commitTransfer(
      commitQuery(facts, { transferId: validToken }),
    );
    assert.equal(denied.reason, reason);
  }
  assert.equal(
    repo.calls.length,
    0,
    'all rejections must precede any storage access',
  );
});

test('an injected policy verdict is actually used (non-tautological injection)', async () => {
  const flipped = Object.freeze({
    ok: false,
    reason: 'TRANSFER_NOT_AUTHORIZED',
    preventEnumeration: false,
  });
  const stubPolicy = {
    initiateTransfer: () => flipped,
    checkTargetManagerInput: () => flipped,
    commitTransfer: () => flipped,
  };
  const service = new ManagementTransferService(fakeRepository(), stubPolicy);
  const denied = await service.initiateTransfer(initiateFacts({}));
  assert.deepEqual({ ...denied }, { ...flipped });
  const deniedCommit = await service.commitTransfer(
    commitQuery(factsForCommit({})),
  );
  assert.deepEqual({ ...deniedCommit }, { ...flipped });
});
