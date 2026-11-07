'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ApproveRemainingPolicy,
  fingerprint64,
} = require('../../src/domain/approve-remaining.policy.ts');

const policy = new ApproveRemainingPolicy();

function item(id, version, status, duplicatePending) {
  const base = { id, itemVersion: version, status };
  return duplicatePending === undefined ? base : { ...base, duplicatePending };
}

const readySet = [
  item('item-1', 7, 'PENDING'),
  item('item-2', 3, 'PENDING'),
  item('item-3', 1, 'PENDING'),
];

function previewRequest(overrides) {
  return {
    command: 'PREVIEW_REMAINING',
    meetingKind: 'TECH',
    approverAuthorizedAtWriteTime: true,
    currentMeetingVersion: 12,
    items: [
      ...readySet,
      item('item-4', 5, 'APPROVED'),
      item('item-5', 2, 'NEEDS_EDITS'),
      item('item-6', 2, 'REJECTED'),
      item('item-7', 4, 'PENDING', true),
    ],
    ...overrides,
  };
}

function expectFail(decision, reason) {
  assert.equal(decision.ok, false);
  assert.deepEqual({ ...decision }, { ok: false, reason });
  assert.ok(Object.isFrozen(decision));
}

test('preview classifies ready/notReady/alreadyApproved/duplicatePending sets', () => {
  const outcome = policy.preview(previewRequest({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.command, 'PREVIEW_REMAINING');
  assert.equal(outcome.meetingKind, 'TECH');
  assert.equal(outcome.meetingVersion, 12);
  assert.deepEqual(outcome.readyItemIds, ['item-1', 'item-2', 'item-3']);
  assert.deepEqual(outcome.notReadyItemIds, ['item-5', 'item-6']);
  assert.deepEqual(outcome.alreadyApprovedItemIds, ['item-4']);
  assert.deepEqual(outcome.duplicatePendingItemIds, ['item-7']);
  assert.match(outcome.fingerprint, /^fnv1a64:[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(outcome));
});

test('preview does not approve', () => {
  const outcome = policy.preview(previewRequest({}));
  assert.equal(outcome.approvedItemIds, undefined);
});

test('preview with an empty item inventory is a valid empty preview', () => {
  const outcome = policy.preview(previewRequest({ items: [] }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.readyItemIds, []);
  assert.deepEqual(outcome.notReadyItemIds, []);
  assert.deepEqual(outcome.alreadyApprovedItemIds, []);
  assert.deepEqual(outcome.duplicatePendingItemIds, []);
  assert.match(outcome.fingerprint, /^fnv1a64:[0-9a-f]{16}$/);
});

test('preview fingerprints are deterministic, version-sensitive and order-insensitive', () => {
  const first = policy.preview(previewRequest({})).fingerprint;
  assert.equal(policy.preview(previewRequest({})).fingerprint, first);

  const drifted = policy.preview(
    previewRequest({
      items: [
        item('item-1', 8, 'PENDING'),
        item('item-2', 3, 'PENDING'),
        item('item-3', 1, 'PENDING'),
      ],
    }),
  ).fingerprint;
  assert.notEqual(first, drifted);

  const reordered = policy.preview(
    previewRequest({
      items: [...previewRequest({}).items].reverse(),
    }),
  ).fingerprint;
  assert.equal(reordered, first);
});

test('length-prefixed canonical encoding prevents crafted id collisions', () => {
  const setA = [item('a', 1, 'PENDING'), item('x:1\nb', 2, 'PENDING')];
  const setB = [item('a:1\nx:1\nb', 2, 'PENDING')];

  const naiveA = 'a:1\nx:1\nb:2';
  assert.equal(
    [...setA].map((i) => `${i.id}:${i.itemVersion}`).join('\n'),
    naiveA,
  );
  assert.equal(
    [...setB].map((i) => `${i.id}:${i.itemVersion}`).join('\n'),
    naiveA,
  );

  const stampA = policy.preview(previewRequest({ items: setA })).fingerprint;
  const stampB = policy.preview(previewRequest({ items: setB })).fingerprint;
  assert.notEqual(stampA, stampB);
});

test('preview requires the write-time approver assignment fact', () => {
  expectFail(
    policy.preview(previewRequest({ approverAuthorizedAtWriteTime: false })),
    'APPROVER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.preview(
      previewRequest({ approverAuthorizedAtWriteTime: undefined }),
    ),
    'APPROVER_NOT_AUTHORIZED',
  );
});

test('preview fails closed on malformed facts and non-canonical meeting kinds', () => {
  const cases = [
    [previewRequest({ items: 42 }), 'DECISION_FACTS_REQUIRED'],
    [
      previewRequest({ items: [item('', 1, 'PENDING')] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [previewRequest({ items: [item('a', 1, 'DRAFT')] }), 'UNKNOWN_ITEM_STATUS'],
    [
      previewRequest({ items: [item('a', 1.5, 'PENDING')] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      previewRequest({ items: [item('a', -1, 'PENDING')] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      previewRequest({ items: [item('a', 1, 'PENDING', 'yes')] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      previewRequest({
        items: [item('a', 1, 'PENDING'), item('a', 2, 'PENDING')],
      }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      previewRequest({ currentMeetingVersion: undefined }),
      'DECISION_FACTS_REQUIRED',
    ],
    [previewRequest({ currentMeetingVersion: 3.5 }), 'DECISION_FACTS_REQUIRED'],
    [previewRequest({ meetingKind: 'GENERALS' }), 'DECISION_FACTS_REQUIRED'],
    [previewRequest({ meetingKind: 'general' }), 'DECISION_FACTS_REQUIRED'],
    [previewRequest({ meetingKind: undefined }), 'DECISION_FACTS_REQUIRED'],
    [previewRequest({ acceptedIds: ['item-1'] }), 'DECISION_FACTS_REQUIRED'],
    [
      previewRequest({ approverAuthorizedAtWriteTime: true, items: null }),
      'DECISION_FACTS_REQUIRED',
    ],
    [null, 'INVALID_COMMAND'],
  ];
  for (const [request, expected] of cases) {
    expectFail(policy.preview(request), expected);
  }
});

const recordedPreview = policy.preview(previewRequest({ items: readySet }));

function confirmRequest(overrides) {
  return {
    command: 'CONFIRM_REMAINING',
    meetingKind: 'TECH',
    idempotencyKeyProvided: true,
    approverAuthorizedAtWriteTime: true,
    previewItems: readySet.map((entry) => ({ ...entry })),
    previewReadyItems: readySet.map((entry) => ({
      id: entry.id,
      itemVersion: entry.itemVersion,
    })),
    previewFingerprint: recordedPreview.fingerprint,
    confirmFingerprint: recordedPreview.fingerprint,
    previewMeetingVersion: recordedPreview.meetingVersion,
    expectedMeetingVersion: recordedPreview.meetingVersion,
    currentMeetingVersion: recordedPreview.meetingVersion,
    acceptedIds: ['item-1', 'item-2', 'item-3'],
    items: readySet.map((entry) => ({ ...entry })),
    ...overrides,
  };
}

test('full confirmation approves every revalidated previewed item', () => {
  const outcome = policy.confirm(confirmRequest({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.command, 'CONFIRM_REMAINING');
  assert.deepEqual(
    [...outcome.approvedItemIds],
    ['item-1', 'item-2', 'item-3'],
  );
  assert.deepEqual([...outcome.alreadyApprovedItemIds], []);
  assert.deepEqual([...outcome.excluded], []);
  assert.equal(outcome.executionRowsNotCreatedHere, true);
  assert.ok(Object.isFrozen(outcome));
});

test('partial confirmation requires explicit confirmPartial when deselecting items', () => {
  expectFail(
    policy.confirm(confirmRequest({ acceptedIds: ['item-1'] })),
    'CONFIRM_PARTIAL_REQUIRED',
  );

  const explicit = policy.confirm(
    confirmRequest({ acceptedIds: ['item-1'], confirmPartial: true }),
  );
  assert.equal(explicit.ok, true);
  assert.deepEqual([...explicit.approvedItemIds], ['item-1']);
});

test('fresh states for unaccepted items are ignored, never implicitly approved', () => {
  const outcome = policy.confirm(
    confirmRequest({
      acceptedIds: ['item-1'],
      confirmPartial: true,

      items: [...readySet, item('item-9', 2, 'PENDING')].map((entry) => ({
        ...entry,
      })),
    }),
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual([...outcome.approvedItemIds], ['item-1']);
  assert.deepEqual([...outcome.alreadyApprovedItemIds], []);
  assert.deepEqual([...outcome.excluded], []);
});

test('confirm requires the fresh revalidated state for every accepted item', () => {
  expectFail(
    policy.confirm(
      confirmRequest({
        items: readySet.slice(0, 2).map((entry) => ({ ...entry })),
        confirmPartial: true,
      }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
});

test('version drift on a revalidated PENDING item aborts the whole confirm', () => {
  expectFail(
    policy.confirm(
      confirmRequest({
        items: [
          item('item-1', 9, 'PENDING'),
          item('item-2', 3, 'PENDING'),
          item('item-3', 1, 'PENDING'),
        ],
      }),
    ),
    'STALE_ITEM_VERSION',
  );
});

test('status moved to APPROVED/REJECTED dominates over version drift', () => {
  const outcome = policy.confirm(
    confirmRequest({
      items: [
        item('item-1', 99, 'APPROVED'),
        item('item-2', 77, 'REJECTED'),
        item('item-3', 1, 'PENDING'),
      ],
      confirmPartial: true,
    }),
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual([...outcome.alreadyApprovedItemIds], ['item-1']);
  assert.deepEqual([...outcome.approvedItemIds], ['item-3']);
  assert.deepEqual(
    [...outcome.excluded],
    [{ id: 'item-2', reason: 'NOT_READY' }],
  );
});

test('items that dropped out of review state exclude with safe reasons', () => {
  const outcome = policy.confirm(
    confirmRequest({
      items: [
        item('item-1', 7, 'NEEDS_EDITS'),
        item('item-2', 3, 'PENDING', true),
        item('item-3', 1, 'REJECTED'),
      ],
      confirmPartial: true,
    }),
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual([...outcome.approvedItemIds], []);
  assert.deepEqual(
    [...outcome.excluded],
    [
      { id: 'item-1', reason: 'NOT_READY' },
      { id: 'item-2', reason: 'DUPLICATE_PENDING' },
      { id: 'item-3', reason: 'NOT_READY' },
    ],
  );
});

test('duplicate flag appearing after preview excludes without approving', () => {
  const outcome = policy.confirm(
    confirmRequest({
      items: [
        item('item-1', 7, 'PENDING', true),
        item('item-2', 3, 'PENDING'),
        item('item-3', 1, 'PENDING'),
      ],
      confirmPartial: true,
    }),
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual([...outcome.approvedItemIds], ['item-2', 'item-3']);
  assert.deepEqual(
    [...outcome.excluded],
    [{ id: 'item-1', reason: 'DUPLICATE_PENDING' }],
  );
});

test('confirm rejects acceptance of items that were not previewed', () => {
  expectFail(
    policy.confirm(
      confirmRequest({
        acceptedIds: ['item-1', 'item-9'],
        confirmPartial: true,
      }),
    ),
    'UNPREVIEWED_ACCEPTANCE',
  );
});

test('confirm rejects stale or mismatched preview fingerprints without writing', () => {
  expectFail(
    policy.confirm(
      confirmRequest({ previewFingerprint: 'fnv1a64:0000000000000000' }),
    ),
    'PREVIEW_STALE',
  );
  expectFail(
    policy.confirm(
      confirmRequest({ confirmFingerprint: 'fnv1a64:0000000000000000' }),
    ),
    'PREVIEW_STALE',
  );
});

test('meeting-version drift aborts the confirm like any other stale snapshot', () => {
  expectFail(
    policy.confirm(
      confirmRequest({
        expectedMeetingVersion: recordedPreview.meetingVersion + 1,
      }),
    ),
    'MEETING_VERSION_MISMATCH',
  );

  expectFail(
    policy.confirm(
      confirmRequest({
        currentMeetingVersion: recordedPreview.meetingVersion + 1,
      }),
    ),
    'MEETING_VERSION_MISMATCH',
  );
});

test('confirm GENERAL executions hard-reject and cannot be reached around the gate', () => {
  expectFail(
    policy.confirm(
      confirmRequest({ meetingKind: 'GENERAL', generateExecution: true }),
    ),
    'GENERAL_EXTERNAL_EXECUTION_REJECTED',
  );
  expectFail(
    policy.confirm(
      confirmRequest({
        meetingKind: 'GENERAL',
        generateExecution: true,
        approverAuthorizedAtWriteTime: false,
        idempotencyKeyProvided: false,
      }),
    ),
    'GENERAL_EXTERNAL_EXECUTION_REJECTED',
  );
});

test('garbage generateExecution and variant meeting kinds fail closed, never bypass GENERAL', () => {
  expectFail(
    policy.confirm(
      confirmRequest({ meetingKind: 'TEAM', generateExecution: 1 }),
    ),
    'DECISION_FACTS_REQUIRED',
  );

  expectFail(
    policy.confirm(
      confirmRequest({ meetingKind: 'GENERALS', generateExecution: true }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.confirm(
      confirmRequest({ meetingKind: 'general', generateExecution: true }),
    ),
    'DECISION_FACTS_REQUIRED',
  );
});

test('confirm enforces the row-98 Idempotency-Key before authorization', () => {
  expectFail(
    policy.confirm(confirmRequest({ idempotencyKeyProvided: false })),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  expectFail(
    policy.confirm(confirmRequest({ idempotencyKeyProvided: undefined })),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  expectFail(
    policy.confirm(
      confirmRequest({
        idempotencyKeyProvided: false,
        approverAuthorizedAtWriteTime: false,
      }),
    ),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
});

test('confirm requires the write-time approver assignment fact', () => {
  expectFail(
    policy.confirm(confirmRequest({ approverAuthorizedAtWriteTime: false })),
    'APPROVER_NOT_AUTHORIZED',
  );
});

test('empty acceptance is an explicit all-excluded confirm and still requires confirmPartial', () => {
  expectFail(
    policy.confirm(confirmRequest({ acceptedIds: [] })),
    'CONFIRM_PARTIAL_REQUIRED',
  );

  const explicit = policy.confirm(
    confirmRequest({ acceptedIds: [], confirmPartial: true }),
  );
  assert.equal(explicit.ok, true);
  assert.deepEqual([...explicit.approvedItemIds], []);
  assert.deepEqual([...explicit.alreadyApprovedItemIds], []);
  assert.deepEqual([...explicit.excluded], []);
});

test('confirm fails closed on malformed request shapes', () => {
  const cases = [
    [confirmRequest({ command: 'CONFIRM_ONLY' }), 'INVALID_COMMAND'],
    [confirmRequest({ previewReadyItems: null }), 'DECISION_FACTS_REQUIRED'],
    [
      confirmRequest({ previewReadyItems: [{ id: 'a', itemVersion: '3' }] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      confirmRequest({
        previewReadyItems: [readySet[0], readySet[0]].map((entry) => ({
          ...entry,
        })),
      }),
      'DECISION_FACTS_REQUIRED',
    ],
    [confirmRequest({ previewFingerprint: '' }), 'DECISION_FACTS_REQUIRED'],
    [
      confirmRequest({ confirmFingerprint: undefined }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      confirmRequest({ previewMeetingVersion: undefined }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      confirmRequest({ expectedMeetingVersion: '4' }),
      'DECISION_FACTS_REQUIRED',
    ],
    [confirmRequest({ acceptedIds: 'item-1' }), 'DECISION_FACTS_REQUIRED'],
    [
      confirmRequest({ acceptedIds: ['item-1', 'item-1'] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [confirmRequest({ acceptedIds: [''] }), 'DECISION_FACTS_REQUIRED'],
    [confirmRequest({ confirmPartial: 'yes' }), 'DECISION_FACTS_REQUIRED'],
    [confirmRequest({ items: null }), 'DECISION_FACTS_REQUIRED'],
    [
      confirmRequest({ items: [item('item-1', 7, 'DRAFT')] }),
      'UNKNOWN_ITEM_STATUS',
    ],
    [confirmRequest({ meetingKind: undefined }), 'DECISION_FACTS_REQUIRED'],
    [null, 'INVALID_COMMAND'],
  ];
  for (const [request, expected] of cases) {
    expectFail(policy.confirm(request), expected);
  }
});

test('entry points reject mismatched commands', () => {
  expectFail(
    policy.preview({ ...confirmRequest({}), command: 'CONFIRM_REMAINING' }),
    'INVALID_COMMAND',
  );
  expectFail(
    policy.confirm({ ...previewRequest({}), command: 'PREVIEW_REMAINING' }),
    'INVALID_COMMAND',
  );
});

test('fingerprint helper follows the published FNV-1a test vectors and is UTF-8 stable', () => {
  assert.equal(fingerprint64(''), 'fnv1a64:cbf29ce484222325');
  assert.equal(fingerprint64('a'), 'fnv1a64:af63dc4c8601ec8c');
  assert.equal(fingerprint64('foobar'), 'fnv1a64:85944171f73967e8');
  assert.equal(fingerprint64('meetingwise'), fingerprint64('meetingwise'));
  assert.notEqual(fingerprint64('meetingwise'), fingerprint64('meetingwisee'));

  assert.equal(fingerprint64('item-é'), fingerprint64('item-é'));
  assert.notEqual(fingerprint64('item-é'), fingerprint64('item-e'));
});
