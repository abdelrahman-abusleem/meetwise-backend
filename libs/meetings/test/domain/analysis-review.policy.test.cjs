'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  AnalysisReviewPolicy,
} = require('../../src/domain/analysis-review.policy.ts');

const policy = new AnalysisReviewPolicy();

function request(overrides) {
  return {
    command: 'REVIEW_EDIT',
    itemStatus: 'PENDING',
    ...overrides,
  };
}

const editFacts = {
  reviewerAuthorized: true,
  accessVerified: true,
  reviewRevisionRecorded: true,
  currentItemVersion: 3,
  expectedItemVersion: 3,
};

const approveFacts = {
  approverAuthorizedAtWriteTime: true,
  currentItemVersion: 4,
  expectedItemVersion: 4,
  duplicateDecision: 'COMPLETED',
  schemaFieldsValidated: true,
  evidenceValid: true,
};

test('a present but non-canonical meetingKind fails closed on every command', () => {
  const kinds = [
    'HR',
    ' sales',
    '  ',
    'TECH ',
    'general',
    'generals',
    "GENERAL's",
    'GENERAL;',
  ];
  for (const kind of kinds) {
    assert.equal(
      policy.evaluate(
        request({
          command: 'APPROVE_ITEM',
          ...approveFacts,
          meetingKind: kind,
        }),
      ).reason,
      'DECISION_FACTS_REQUIRED',
      `non-canonical kind "${kind}" must fail before the GENERAL gate`,
    );
    assert.equal(
      policy.evaluate(request({ ...editFacts, meetingKind: kind })).reason,
      'DECISION_FACTS_REQUIRED',
    );
  }

  for (const kind of ['GENERALS', 'general']) {
    const denied = policy.evaluate(
      request({
        command: 'APPROVE_ITEM',
        ...approveFacts,
        meetingKind: kind,
        generateExecution: true,
      }),
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'DECISION_FACTS_REQUIRED');
  }
});

test('execution intent without any kind is an unadjudicable fact gap', () => {
  assert.equal(
    policy.evaluate(
      request({
        command: 'APPROVE_ITEM',
        ...approveFacts,
        generateExecution: true,
      }),
    ).reason,
    'DECISION_FACTS_REQUIRED',
  );
});

test('canonical kinds still gate correctly: GENERAL hard-rejects, TECH/SALES approve', () => {
  const general = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      ...approveFacts,
      meetingKind: 'GENERAL',
      generateExecution: true,
    }),
  );
  assert.equal(general.ok, false);
  assert.equal(general.reason, 'GENERAL_EXTERNAL_EXECUTION_REJECTED');
  for (const kind of ['TECH', 'SALES']) {
    const ok = policy.evaluate(
      request({
        command: 'APPROVE_ITEM',
        ...approveFacts,
        meetingKind: kind,
        generateExecution: true,
      }),
    );
    assert.equal(
      ok.ok,
      true,
      `canonical ${kind} with execution intent approves`,
    );
  }

  const plain = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      ...approveFacts,
      meetingKind: 'GENERAL',
    }),
  );
  assert.equal(plain.ok, true);
});

test('reviewer edit keeps PENDING and bumps the item version once', () => {
  const decision = policy.evaluate(
    request({ itemStatus: 'PENDING', ...editFacts }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'PENDING');
  assert.equal(decision.itemVersionBumped, true);
  assert.equal(decision.approvedSnapshotImmutable, false);
  assert.ok(Object.isFrozen(decision));
});

test('reviewer edit keeps NEEDS_EDITS with the same guard set', () => {
  const decision = policy.evaluate(
    request({ itemStatus: 'NEEDS_EDITS', ...editFacts }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'NEEDS_EDITS');
  assert.equal(decision.itemVersionBumped, true);
});

test('edits fail closed on missing access, authorization or stored ReviewRevision', () => {
  const cases = [
    [{ ...editFacts, reviewerAuthorized: false }, 'REVIEWER_NOT_AUTHORIZED'],
    [{ ...editFacts, accessVerified: false }, 'DECISION_FACTS_REQUIRED'],
    [
      { ...editFacts, reviewRevisionRecorded: false },
      'REVIEW_REVISION_REQUIRED',
    ],
    [{ ...editFacts, accessVerified: undefined }, 'DECISION_FACTS_REQUIRED'],
  ];
  for (const [input, expected] of cases) {
    const decision = policy.evaluate(request(input));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});

test('stale or malformed item versions reject with 412-style facts', () => {
  const stale = policy.evaluate(
    request({ itemStatus: 'PENDING', ...editFacts, expectedItemVersion: 2 }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'VERSION_MISMATCH');

  const missingCurrent = policy.evaluate(
    request({
      itemStatus: 'PENDING',
      reviewerAuthorized: true,
      accessVerified: true,
      reviewRevisionRecorded: true,
      expectedItemVersion: 3,
      currentItemVersion: undefined,
    }),
  );
  assert.equal(missingCurrent.ok, false);
  assert.equal(missingCurrent.reason, 'DECISION_FACTS_REQUIRED');

  const nonInteger = policy.evaluate(
    request({ itemStatus: 'PENDING', ...editFacts, currentItemVersion: 3.5 }),
  );
  assert.equal(nonInteger.ok, false);
  assert.equal(nonInteger.reason, 'DECISION_FACTS_REQUIRED');
});

test('edit request on APPROVED requires a new approval round and never rewrites the snapshot', () => {
  const decision = policy.evaluate(
    request({ itemStatus: 'APPROVED', ...editFacts }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'APPROVED');
  assert.equal(decision.itemVersionBumped, false);
  assert.equal(decision.newApprovalRevisionRequired, true);
  assert.equal(decision.approvedSnapshotImmutable, true);
});

test('rejected items cannot be edited until an agreed reopen flow exists', () => {
  const decision = policy.evaluate(
    request({ itemStatus: 'REJECTED', ...editFacts }),
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'EDIT_NOT_ALLOWED');
});

test('rejections from review states record a mandatory audit reason', () => {
  for (const itemStatus of ['PENDING', 'NEEDS_EDITS']) {
    const decision = policy.evaluate(
      request({
        command: 'REJECT_ITEM',
        itemStatus,
        ...editFacts,
        rejectReason: 'fabricated evidence quote',
      }),
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.to, 'REJECTED');
    assert.equal(decision.auditReasonRecorded, true);
  }
});

test('rejections require a non-blank reason', () => {
  for (const rejectReason of [undefined, '', '   ']) {
    const decision = policy.evaluate(
      request({
        command: 'REJECT_ITEM',
        itemStatus: 'PENDING',
        ...editFacts,
        rejectReason,
      }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'REJECT_REASON_REQUIRED');
  }
});

test('approved items cannot be rejected and rejected items are not re-rejectable', () => {
  const approved = policy.evaluate(
    request({
      command: 'REJECT_ITEM',
      itemStatus: 'APPROVED',
      rejectReason: 'x',
    }),
  );
  assert.equal(approved.ok, false);
  assert.equal(approved.reason, 'REJECT_NOT_ALLOWED');

  const alreadyRejected = policy.evaluate(
    request({
      command: 'REJECT_ITEM',
      itemStatus: 'REJECTED',
      rejectReason: 'x',
    }),
  );
  assert.equal(alreadyRejected.ok, false);
  assert.equal(alreadyRejected.reason, 'ALREADY_REJECTED');
});

test('approval requires the full write-time decision set', () => {
  const decision = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      ...approveFacts,
    }),
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.to, 'APPROVED');
  assert.equal(decision.approvedSnapshotImmutable, true);
  assert.equal(decision.itemVersionBumped, false);
  assert.ok(Object.isFrozen(decision));
});

test('approval is gated on the GENERAL hard-reject first, then write-time authorization', () => {
  const unauthorized = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      ...approveFacts,
      approverAuthorizedAtWriteTime: false,
    }),
  );
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, 'APPROVER_NOT_AUTHORIZED');

  const missingFlag = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      ...approveFacts,
      approverAuthorizedAtWriteTime: undefined,
    }),
  );
  assert.equal(missingFlag.ok, false);
  assert.equal(missingFlag.reason, 'APPROVER_NOT_AUTHORIZED');
});

test('approval checks stale versions after authorization', () => {
  const stale = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      ...approveFacts,
      expectedItemVersion: 5,
    }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'VERSION_MISMATCH');
});

test('approval blocks on pending duplicate decisions and unvalidated payloads', () => {
  const duplicates = [
    [
      { ...approveFacts, duplicateDecision: 'PENDING' },
      'DUPLICATE_DECISION_PENDING',
    ],
    [
      { ...approveFacts, duplicateDecision: undefined },
      'DUPLICATE_DECISION_PENDING',
    ],
    [{ ...approveFacts, schemaFieldsValidated: false }, 'FIELDS_NOT_VALIDATED'],
    [{ ...approveFacts, evidenceValid: false }, 'EVIDENCE_NOT_VALID'],
  ];
  for (const [overrides, expected] of duplicates) {
    const decision = policy.evaluate(
      request({ command: 'APPROVE_ITEM', itemStatus: 'PENDING', ...overrides }),
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});

test('approval only starts from PENDING; approved snapshots cannot be double-approved', () => {
  const partial = { ...approveFacts, approverAuthorizedAtWriteTime: undefined };
  const needsEdits = policy.evaluate(
    request({ command: 'APPROVE_ITEM', itemStatus: 'NEEDS_EDITS', ...partial }),
  );
  assert.equal(needsEdits.ok, false);
  assert.equal(needsEdits.reason, 'APPROVE_NOT_ALLOWED');

  const rejectedItem = policy.evaluate(
    request({ command: 'APPROVE_ITEM', itemStatus: 'REJECTED', ...partial }),
  );
  assert.equal(rejectedItem.ok, false);
  assert.equal(rejectedItem.reason, 'APPROVE_NOT_ALLOWED');

  const alreadyApproved = policy.evaluate(
    request({ command: 'APPROVE_ITEM', itemStatus: 'APPROVED', ...partial }),
  );
  assert.equal(alreadyApproved.ok, false);
  assert.equal(alreadyApproved.reason, 'ALREADY_APPROVED');
});

test('GENERAL items never generate external executions, regardless of roles', () => {
  const external = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      meetingKind: 'GENERAL',
      generateExecution: true,
      ...approveFacts,
    }),
  );
  assert.equal(external.ok, false);
  assert.equal(external.reason, 'GENERAL_EXTERNAL_EXECUTION_REJECTED');

  const internal = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      meetingKind: 'GENERAL',
      generateExecution: false,
      ...approveFacts,
    }),
  );
  assert.equal(internal.ok, true);
  assert.equal(internal.to, 'APPROVED');

  const garbageFlag = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      meetingKind: 'GENERAL',
      generateExecution: 'yes',
      ...approveFacts,
    }),
  );
  assert.equal(garbageFlag.ok, false);
  assert.equal(garbageFlag.reason, 'DECISION_FACTS_REQUIRED');

  const garbageFlagForDepartment = policy.evaluate(
    request({
      command: 'APPROVE_ITEM',
      itemStatus: 'PENDING',
      meetingKind: 'TEAM',
      generateExecution: 1,
      ...approveFacts,
    }),
  );
  assert.equal(garbageFlagForDepartment.ok, false);
  assert.equal(garbageFlagForDepartment.reason, 'DECISION_FACTS_REQUIRED');
});

test('malformed review requests fail closed', () => {
  const cases = [
    [request({ command: 'APPROVE' }), 'INVALID_COMMAND'],
    [request({ itemStatus: 'DRAFT' }), 'UNKNOWN_ITEM_STATUS'],
    [
      request({ ...editFacts, duplicateDecision: 'SKIPPED' }),
      'DECISION_FACTS_REQUIRED',
    ],
    [null, 'INVALID_COMMAND'],
    [42, 'INVALID_COMMAND'],
  ];
  for (const [input, expected] of cases) {
    const decision = policy.evaluate(input);
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, expected);
  }
});
