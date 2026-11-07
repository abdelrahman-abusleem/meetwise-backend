'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ExportRequestPolicy,
} = require('../../src/domain/export-request.policy.ts');

const policy = new ExportRequestPolicy();

function requestExport(overrides) {
  return {
    command: 'REQUEST_EXPORT',
    kind: 'SUMMARY',
    meetingKind: 'TECH',
    exporterAuthorized: true,
    idempotencyKeyProvided: true,
    ...overrides,
  };
}

function workerGate(overrides) {
  return {
    command: 'WORKER_EXPORT_GATE',
    kind: 'ANALYSIS',
    meetingKind: 'SALES',
    exporterAuthorized: true,
    idempotencyKeyProvided: true,
    sourceItems: [
      { id: 'item-1', status: 'APPROVED' },
      { id: 'item-2', status: 'PENDING' },
    ],
    ...overrides,
  };
}

function download(overrides) {
  return {
    command: 'DOWNLOAD_EXPORT',
    kind: 'TRANSCRIPT',
    meetingKind: 'TECH',
    exporterAuthorized: true,
    ...overrides,
  };
}

function expectFail(decision, reason) {
  assert.equal(decision.ok, false);
  assert.deepEqual({ ...decision }, { ok: false, reason });
  assert.ok(Object.isFrozen(decision));
}

test('API request for a non-GENERAL meeting is approved as a server-side job', () => {
  const outcome = policy.evaluate(requestExport({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.command, 'REQUEST_EXPORT');
  assert.equal(outcome.kind, 'SUMMARY');
  assert.equal(outcome.meetingKind, 'TECH');
  assert.equal(outcome.surface, 'API');
  assert.equal(outcome.jobCreationIsServerDuty, true);
  assert.equal(outcome.auditExportDecision, true);
  assert.ok(Object.isFrozen(outcome));
});

test('worker gate re-checks authorization against freshly re-read facts', () => {
  const outcome = policy.evaluate(workerGate({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.surface, 'WORKER');
  assert.equal(outcome.auditExportDecision, true);
});

test('GENERAL meetings are hard-rejected on both API and worker side', () => {
  expectFail(
    policy.evaluate(requestExport({ meetingKind: 'GENERAL' })),
    'GENERAL_EXPORT_REJECTED',
  );
  expectFail(
    policy.evaluate(workerGate({ meetingKind: 'GENERAL' })),
    'GENERAL_EXPORT_REJECTED',
  );
});

test('GENERAL hard-reject precedes authorization and idempotency', () => {
  expectFail(
    policy.evaluate(
      requestExport({
        meetingKind: 'GENERAL',
        exporterAuthorized: false,
        idempotencyKeyProvided: false,
      }),
    ),
    'GENERAL_EXPORT_REJECTED',
  );
});

test('all three export kinds are accepted for non-GENERAL meetings', () => {
  for (const kind of ['SUMMARY', 'TRANSCRIPT', 'ANALYSIS']) {
    const outcome = policy.evaluate(requestExport({ kind }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.kind, kind);
  }
});

test('request requires the approved export kind enum', () => {
  expectFail(
    policy.evaluate(requestExport({ kind: 'PDF' })),
    'INVALID_EXPORT_KIND',
  );
  expectFail(
    policy.evaluate(requestExport({ kind: undefined })),
    'INVALID_EXPORT_KIND',
  );
});

test('meeting kinds outside TECH/SALES/GENERAL fail closed', () => {
  expectFail(
    policy.evaluate(requestExport({ meetingKind: 'WEIRD' })),
    'DECISION_FACTS_REQUIRED',
  );
  expectFail(
    policy.evaluate(workerGate({ meetingKind: 'GENERALISH' })),
    'DECISION_FACTS_REQUIRED',
  );
});

test('request and worker gate require the mandatory Idempotency-Key fact', () => {
  expectFail(
    policy.evaluate(requestExport({ idempotencyKeyProvided: false })),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  expectFail(
    policy.evaluate(workerGate({ idempotencyKeyProvided: undefined })),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
});

test('export right is required and status alone never grants it', () => {
  expectFail(
    policy.evaluate(requestExport({ exporterAuthorized: false })),
    'EXPORTER_NOT_AUTHORIZED',
  );
  expectFail(
    policy.evaluate(workerGate({ exporterAuthorized: undefined })),
    'EXPORTER_NOT_AUTHORIZED',
  );
});

test('worker ANALYSIS gate refuses to run without enumerated source items', () => {
  expectFail(
    policy.evaluate(workerGate({ sourceItems: undefined })),
    'SOURCE_ITEMS_REQUIRED',
  );
  expectFail(
    policy.evaluate(workerGate({ sourceItems: [] })),
    'SOURCE_ITEMS_REQUIRED',
  );
});

test('REJECTED analysis items can never be exported, per the state matrix', () => {
  expectFail(
    policy.evaluate(
      workerGate({
        sourceItems: [
          { id: 'item-1', status: 'APPROVED' },
          { id: 'item-2', status: 'REJECTED' },
        ],
      }),
    ),
    'REJECTED_ITEM_NOT_EXPORTABLE',
  );
});

test('worker gate fails closed on malformed source item inventories', () => {
  const cases = [
    [workerGate({ sourceItems: [null] }), 'DECISION_FACTS_REQUIRED'],
    [
      workerGate({ sourceItems: [{ id: '', status: 'PENDING' }] }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      workerGate({
        sourceItems: [
          { id: 'a', status: 'PENDING' },
          { id: 'a', status: 'PENDING' },
        ],
      }),
      'DECISION_FACTS_REQUIRED',
    ],
    [
      workerGate({ sourceItems: [{ id: 'a', status: 'DRAFT' }] }),
      'UNKNOWN_ITEM_STATUS',
    ],
    [workerGate({ sourceItems: 'item-1' }), 'DECISION_FACTS_REQUIRED'],
  ];
  for (const [request, expected] of cases) {
    expectFail(policy.evaluate(request), expected);
  }
});

test('API-side ANALYSIS export must omit enumerated items; the worker owns the filter', () => {
  const outcome = policy.evaluate(
    requestExport({ kind: 'ANALYSIS', sourceItems: undefined }),
  );
  assert.equal(outcome.ok, true);

  expectFail(
    policy.evaluate(
      requestExport({
        kind: 'ANALYSIS',
        sourceItems: [{ id: 'item-1', status: 'APPROVED' }],
      }),
    ),
    'SOURCE_ITEMS_NOT_ACCEPTED_ON_REQUEST',
  );
  expectFail(
    policy.evaluate(
      download({ sourceItems: [{ id: 'item-1', status: 'APPROVED' }] }),
    ),
    'SOURCE_ITEMS_NOT_ACCEPTED_ON_REQUEST',
  );
});

test('download requires the creator plus live-source permission fact', () => {
  const outcome = policy.evaluate(download({}));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.surface, 'DOWNLOAD');

  expectFail(
    policy.evaluate(download({ exporterAuthorized: false })),
    'DOWNLOAD_NOT_AUTHORIZED',
  );
  expectFail(
    policy.evaluate(download({ exporterAuthorized: undefined })),
    'DOWNLOAD_NOT_AUTHORIZED',
  );
});

test('download rejects GENERAL meetings like every other surface', () => {
  expectFail(
    policy.evaluate(
      download({ meetingKind: 'GENERAL', exporterAuthorized: false }),
    ),
    'GENERAL_EXPORT_REJECTED',
  );
});

test('worker gate with SUMMARY/TRANSCRIPT needs no enumerated items', () => {
  const outcome = policy.evaluate(
    workerGate({ kind: 'SUMMARY', sourceItems: undefined }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.surface, 'WORKER');
});

test('outcome surface is derived from the command, not trusted caller input', () => {
  const api = policy.evaluate(requestExport({ surface: 'WORKER' }));
  assert.equal(api.ok, true);
  assert.equal(api.surface, 'API');

  const worker = policy.evaluate(workerGate({ surface: 'API' }));
  assert.equal(worker.surface, 'WORKER');

  const stream = policy.evaluate(download({ surface: 'WORKER' }));
  assert.equal(stream.surface, 'DOWNLOAD');
});

test('unknown commands and malformed flags fail closed', () => {
  const cases = [
    [null, 'INVALID_COMMAND'],
    [requestExport({ command: 'EXPORT_NOW' }), 'INVALID_COMMAND'],
    [requestExport({ exporterAuthorized: 'yes' }), 'DECISION_FACTS_REQUIRED'],
    [
      requestExport({ idempotencyKeyProvided: 'yes' }),
      'DECISION_FACTS_REQUIRED',
    ],
  ];
  for (const [request, expected] of cases) {
    expectFail(policy.evaluate(request), expected);
  }
});
