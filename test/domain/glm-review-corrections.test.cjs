const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  AnalysisReviewPolicy,
} = require('../../libs/meetings/src/domain/analysis-review.policy.ts');
const {
  ApproveRemainingPolicy,
} = require('../../libs/meetings/src/domain/approve-remaining.policy.ts');
const {
  ManagementTransferPolicy,
} = require('../../libs/meetings/src/domain/management-transfer.policy.ts');
const review = new AnalysisReviewPolicy();
const base = {
  command: 'REJECT_ITEM',
  itemStatus: 'PENDING',
  rejectReason: 'Needs correction',
  reviewerAuthorized: true,
  approverAuthorizedAtWriteTime: false,
  accessVerified: true,
  currentItemVersion: 2,
  expectedItemVersion: 2,
};
for (const itemStatus of ['PENDING', 'NEEDS_EDITS']) {
  for (const change of [
    { reviewerAuthorized: false },
    { accessVerified: false },
    { expectedItemVersion: 1 },
    { currentItemVersion: undefined },
    { expectedItemVersion: undefined },
  ])
    test(
      'F1 rejection rejects missing/stale authority ' +
        JSON.stringify({ itemStatus, change }),
      () =>
        assert.equal(
          review.evaluate({ ...base, itemStatus, ...change }).ok,
          false,
        ),
    );
  for (const authority of [
    'reviewerAuthorized',
    'approverAuthorizedAtWriteTime',
  ])
    test(
      'F1 explicitly scoped ' + authority + ' may reject ' + itemStatus,
      () =>
        assert.equal(
          review.evaluate({
            ...base,
            itemStatus,
            reviewerAuthorized: false,
            [authority]: true,
          }).ok,
          true,
        ),
    );
}
for (const change of [
  { reviewerAuthorized: false },
  { accessVerified: false },
  { expectedItemVersion: 1 },
  { currentItemVersion: undefined },
])
  test(
    'F1 approved edit intent rejects unauthorized/stale facts ' +
      JSON.stringify(change),
    () =>
      assert.equal(
        review.evaluate({
          ...base,
          command: 'REVIEW_EDIT',
          itemStatus: 'APPROVED',
          ...change,
        }).ok,
        false,
      ),
  );
test('F1 authorized approved edit preserves old snapshot and requires new approval', () => {
  const result = review.evaluate({
    ...base,
    command: 'REVIEW_EDIT',
    itemStatus: 'APPROVED',
  });
  assert.equal(result.ok, true);
  assert.equal(result.approvedSnapshotImmutable, true);
  assert.equal(result.newApprovalRevisionRequired, true);
  assert.equal(result.itemVersionBumped, false);
});
const bulk = new ApproveRemainingPolicy();
const inventory = [
  { id: 'a', itemVersion: 1, status: 'PENDING' },
  { id: 'b', itemVersion: 2, status: 'NEEDS_EDITS' },
];
function mixed(confirmPartial, overrides = {}) {
  const preview = bulk.preview({
    command: 'PREVIEW_REMAINING',
    meetingKind: 'TECH',
    approverAuthorizedAtWriteTime: true,
    currentMeetingVersion: 3,
    items: inventory,
  });
  assert.equal(preview.ok, true);
  return bulk.confirm({
    command: 'CONFIRM_REMAINING',
    meetingKind: 'TECH',
    approverAuthorizedAtWriteTime: true,
    idempotencyKeyProvided: true,
    currentMeetingVersion: 3,
    expectedMeetingVersion: 3,
    previewMeetingVersion: 3,
    previewReadyItems: [{ id: 'a', itemVersion: 1 }],
    previewItems: inventory,
    items: [inventory[0]],
    acceptedIds: ['a'],
    previewFingerprint: preview.fingerprint,
    confirmFingerprint: preview.fingerprint,
    confirmPartial,
    ...overrides,
  });
}
test('F2 preview exclusions require explicit partial confirmation', () =>
  assert.deepEqual(mixed(undefined), {
    ok: false,
    reason: 'CONFIRM_PARTIAL_REQUIRED',
  }));
test('F2 confirmed partial result retains the excluded preview item', () => {
  const r = mixed(true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.excluded, [{ id: 'b', reason: 'NOT_READY' }]);
});

for (const [name, overrides] of [
  ['missing stored inventory', { previewItems: undefined }],
  [
    'changed excluded item',
    { previewItems: [inventory[0], { ...inventory[1], status: 'APPROVED' }] },
  ],
  ['ready subset inconsistent with inventory', { previewReadyItems: [] }],
])
  test('F2 rejects ' + name, () =>
    assert.equal(mixed(true, overrides).ok, false),
  );
test('F2 checksum distinguishes an exclusion change with identical ready set', () => {
  const facts = {
    command: 'PREVIEW_REMAINING',
    meetingKind: 'TECH',
    approverAuthorizedAtWriteTime: true,
    currentMeetingVersion: 3,
  };
  assert.notEqual(
    bulk.preview({ ...facts, items: inventory }).fingerprint,
    bulk.preview({ ...facts, items: [inventory[0]] }).fingerprint,
  );
});
const transfer = new ManagementTransferPolicy();
const transferFacts = {
  meetingId: 'meeting',
  transfererAuthorized: true,
  transfererDeptMatches: true,
  meetingKind: 'TECH',
  meetingLifecycle: 'DRAFT',
  targetEligible: true,
  reason: 'Rotation',
};
test('F3 A-B-A-B transfer history identities remain distinct across consumed versions', () => {
  const ids = [
    [1, 'a', 'b'],
    [2, 'b', 'a'],
    [3, 'a', 'b'],
  ].map(([version, oldMeetingAdminId, newManagerUserId]) => {
    const r = transfer.initiateTransfer({
      ...transferFacts,
      expectedMeetingVersion: version,
      currentMeetingVersion: version,
      oldMeetingAdminId,
      newManagerUserId,
    });
    assert.equal(r.ok, true);
    return r.transferId;
  });
  assert.equal(new Set(ids).size, 3);
});

test('F3 a prior-version operation cannot be committed as a later occurrence', () => {
  const original = transfer.initiateTransfer({
    ...transferFacts,
    expectedMeetingVersion: 1,
    currentMeetingVersion: 1,
    oldMeetingAdminId: 'a',
    newManagerUserId: 'b',
  });
  assert.equal(original.ok, true);
  const later = transfer.commitTransfer(
    {
      ...transferFacts,
      expectedMeetingVersion: 3,
      currentMeetingVersion: 3,
      oldMeetingAdminId: 'a',
      newManagerUserId: 'b',
      transfererStillAuthorizedAfterRereview: true,
      targetStillEligible: true,
    },
    original.transferId,
  );
  assert.equal(later.ok, false);
  assert.equal(later.reason, 'TRANSFER_TOKEN_MISMATCH');
});
const {
  MeetingAssignmentService,
} = require('../../libs/meetings/src/application/meeting-assignment.service.ts');
for (const role of ['APPROVER', 'REVIEWER'])
  test(
    'F4 ' +
      role +
      ' revocation carries the authorized audit actor into the atomic repository operation',
    async () => {
      let argumentsPassed;
      const commit = async (...args) => {
        argumentsPassed = args;
        return {
          record: {
            id: 'assignment',
            meetingId: 'meeting',
            userId: 'target',
            assignedById: 'original-assigner',
          },
        };
      };
      const service = new MeetingAssignmentService({
        revokeMeetingApproverAssignment: commit,
        revokeMeetingReviewerAssignment: commit,
      });
      const result = await service.revoke({
        meetingId: 'meeting',
        assignmentId: 'assignment',
        facts: {
          meetingId: 'meeting',
          meetingKind: 'TECH',
          role,
          assignerUserId: 'actor',
          assignerScope: 'DEPARTMENT',
        },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(argumentsPassed, ['assignment', 'meeting', 'actor']);
    },
  );
