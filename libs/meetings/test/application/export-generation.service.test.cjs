'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ExportGenerationService,
} = require('../../src/application/export-generation.service.ts');
const {
  ExportGenerationPolicy,
  EXPORT_GENERATION_CONSUMER,
} = require('../../src/domain/export-generation.policy.ts');
const {
  ExportRequestService,
} = require('../../src/application/export-request.service.ts');
const {
  composeExportGenerationCore,
} = require('../../src/infrastructure/export/export-generation-core.ts');

async function withOwnedStore(work) {
  const fs = require('node:fs/promises'),
    path = require('node:path'),
    os = require('node:os');
  const parent = await fs.realpath(os.tmpdir()),
    root = await fs.mkdtemp(path.join(parent, 'meetwise-export-core-'));
  try {
    return await work(root, fs, path);
  } finally {
    const resolved = await fs.realpath(root);
    assert.equal(resolved, root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('meetwise-export-core-'));
    await fs.rm(resolved, { recursive: true });
    await assert.rejects(fs.stat(resolved), { code: 'ENOENT' });
  }
}

test('composed export worker drives real request policy,renderer and local store with controlled durable ports', async () => {
  await withOwnedStore(async (root, fs, path) => {
    const exportRepo = new SparseExportRequestRepository();
    exportRepo.seedRow();
    const generationRepo = new FakeGenerationRepository({
      found: true,
      bundle: { rows: [{ title: 'synthetic source', count: 2 }] },
    });
    const core = composeExportGenerationCore({
      repository: generationRepo,
      exportService: new ExportRequestService(exportRepo),
      storeRoot: root,
    });
    const first = await core.worker.runTurn(baseTurn());
    assert.equal(first.verdict, 'ACK');
    assert.equal(first.outcome.kind, 'COMPLETED');
    assert.equal(exportRepo.rowView('exp-1').status, 'READY');
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, 'exp-1'), 'utf8')),
      [{ title: 'synthetic source', count: 2 }],
    );
    assert.equal((await fs.readdir(root)).length, 2);
    const replay = await core.worker.runTurn(baseTurn());
    assert.equal(replay.outcome.kind, 'REPLAYED');
    assert.equal(exportRepo.calls.claim, 1);
  });
});
test('composed export worker honors claim-time authorization loss before local publication', async () => {
  await withOwnedStore(async (root, fs) => {
    const exportRepo = new SparseExportRequestRepository();
    exportRepo.seedRow();
    exportRepo.hooks.onBeforeClaim = async () => {
      exportRepo.rows.get('exp-1').exporterAuthorized = false;
    };
    const core = composeExportGenerationCore({
      repository: new FakeGenerationRepository(),
      exportService: new ExportRequestService(exportRepo),
      storeRoot: root,
    });
    const result = await core.worker.runTurn(baseTurn());
    assert.equal(result.outcome.kind, 'CLAIM_REFUSED');
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal(exportRepo.rowView('exp-1').status, 'QUEUED');
  });
});
test('composed export worker refuses READY after report-time authority loss', async () => {
  await withOwnedStore(async (root, fs) => {
    const exportRepo = new SparseExportRequestRepository();
    exportRepo.seedRow();
    exportRepo.hooks.onBeforeReport = async () => {
      exportRepo.rows.get('exp-1').exporterAuthorized = false;
    };
    const core = composeExportGenerationCore({
      repository: new FakeGenerationRepository(),
      exportService: new ExportRequestService(exportRepo),
      storeRoot: root,
    });
    const result = await core.worker.runTurn(baseTurn());
    assert.equal(result.outcome.kind, 'REPORT_REFUSED');
    assert.equal(exportRepo.rowView('exp-1').status, 'RUNNING');
    assert.equal((await fs.readdir(root)).length, 2);
  });
});

class SparseExportRequestRepository {
  constructor() {
    this.rows = new Map();
    this.hooks = {};
    this.calls = { workerFacts: 0, claim: 0, report: 0 };
  }

  seedRow(overrides = {}) {
    const row = {
      id: 'exp-1',
      status: 'QUEUED',
      meetingId: 'm-1',
      meetingExists: true,
      meetingKind: 'TECH',
      kind: 'SUMMARY',
      format: 'JSON',
      exporterAuthorized: true,
      idempotencyKey: 'idem-key-1',
      sourceItems: null,
      ...overrides,
    };
    this.rows.set(row.id, row);
    return row;
  }

  rowView(id) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async getWorkerFacts(context) {
    this.calls.workerFacts += 1;
    const row = this.rows.get(context.exportId);
    if (!row) {
      return {
        exportExists: false,
        kind: null,
        format: null,
        meetingId: null,
        meetingExists: false,
        meetingKind: null,
        exporterAuthorized: false,
        idempotencyKey: null,
        sourceItems: null,
      };
    }
    return {
      exportExists: true,
      kind: row.kind,
      format: row.format,
      meetingId: row.meetingId,
      meetingExists: row.meetingExists,
      meetingKind: row.meetingKind,
      exporterAuthorized: row.exporterAuthorized,
      idempotencyKey: row.idempotencyKey,
      sourceItems: row.sourceItems,
    };
  }

  async claimExportForProcessing(context) {
    this.calls.claim += 1;
    if (this.hooks.onBeforeClaim) {
      await this.hooks.onBeforeClaim(context, this);
    }
    const row = this.rows.get(context.exportId);
    if (row.status !== 'QUEUED') {
      return {
        claimed: false,
        refusal: 'NOT_QUEUED',
        currentStatus: row.status,
      };
    }
    if (row.meetingKind === 'GENERAL') {
      return {
        claimed: false,
        refusal: 'GENERAL_TARGET_REFUSED',
        currentStatus: row.status,
      };
    }
    if (row.kind === 'ANALYSIS') {
      if (row.sourceItems === null) {
        return {
          claimed: false,
          refusal: 'SOURCE_ENUMERATION_UNREADABLE',
          currentStatus: row.status,
        };
      }
      if (row.sourceItems.some((it) => it.status === 'REJECTED')) {
        return {
          claimed: false,
          refusal: 'ITEM_REJECTED',
          currentStatus: row.status,
        };
      }
    }
    if (row.exporterAuthorized !== true) {
      return {
        claimed: false,
        refusal: 'EXPORTER_RACE_LOST',
        currentStatus: row.status,
      };
    }
    row.status = 'RUNNING';
    return { claimed: true, refusal: null, currentStatus: row.status };
  }

  async reportExportCompletion(request) {
    this.calls.report += 1;
    if (this.hooks.onBeforeReport) {
      await this.hooks.onBeforeReport(request, this);
    }
    const row = this.rows.get(request.exportId);
    if (!row || row.status !== 'RUNNING') {
      return null;
    }
    if (row.meetingKind === 'GENERAL') {
      return { reported: false, refusal: 'GENERAL_TARGET_REFUSED' };
    }
    if (request.outcome === 'SUCCEEDED' && row.kind === 'ANALYSIS') {
      if (row.sourceItems === null) {
        return { reported: false, refusal: 'SOURCE_ENUMERATION_UNREADABLE' };
      }
      if (row.sourceItems.some((it) => it.status === 'REJECTED')) {
        return { reported: false, refusal: 'ITEM_REJECTED' };
      }
    }
    if (request.outcome === 'SUCCEEDED' && row.exporterAuthorized !== true) {
      return { reported: false, refusal: 'EXPORTER_RACE_LOST' };
    }
    row.status = request.outcome === 'SUCCEEDED' ? 'READY' : 'FAILED';
    return {
      reported: true,
      job: { id: row.id, status: row.status, expiresAt: null },
    };
  }
}

class FakeGenerationRepository {
  constructor(sourceOutcome) {
    this.sourceOutcome = sourceOutcome;
    this.inbox = new Map();
    this.hooks = {};
    this.calls = { findInbox: 0, writeInbox: 0, loadSource: 0 };
  }

  async findInboxOutcome(consumer, eventId) {
    this.calls.findInbox += 1;
    const found = this.inbox.get(`${consumer}|${eventId}`);
    return found ? { ...found } : null;
  }

  async writeInboxOutcome(receipt) {
    this.calls.writeInbox += 1;
    if (this.hooks.onBeforeWriteInbox) {
      await this.hooks.onBeforeWriteInbox(receipt, this);
    }
    const key = `${receipt.consumer}|${receipt.eventId}`;
    if (this.inbox.has(key)) {
      return { created: false, outcome: this.inbox.get(key).outcome };
    }
    this.inbox.set(key, { ...receipt });
    return { created: true, outcome: null };
  }

  async loadSourceFacts(command) {
    this.calls.loadSource += 1;
    if (this.sourceOutcome instanceof Error) {
      throw this.sourceOutcome;
    }
    if (this.sourceOutcome !== null && this.sourceOutcome !== undefined) {
      return this.sourceOutcome;
    }
    return {
      found: true,
      bundle: {
        rows: [
          { segment: 1, speaker: 'a', durationSec: 42 },
          { segment: 2, speaker: 'b', durationSec: 17 },
        ],
      },
    };
  }

  inboxReceipt(eventId) {
    return this.inbox.get(`${EXPORT_GENERATION_CONSUMER}|${eventId}`);
  }
}

class FakeGeneratorPort {
  constructor(result) {
    this.result = result;
    this.commands = [];
  }

  async renderArtifact(command) {
    this.commands.push({ ...command, sourceRows: command.sourceRows });
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}

class FakeObjectStorePort {
  constructor(result) {
    this.result = result;
    this.commands = [];
  }

  async storeArtifact(command) {
    this.commands.push({ ...command, content: command.content });
    return this.result;
  }
}

const VALID_INSTANT = '2026-10-27T09:00:00Z';

function buildHarness({
  rowOverrides = {},
  sourceOutcome = undefined,
  generatorResult = undefined,
  storeResult = undefined,
  generationHooks = {},
} = {}) {
  const exportRepo = new SparseExportRequestRepository();
  exportRepo.seedRow(rowOverrides);
  const exportService = new ExportRequestService(exportRepo);
  const generationRepo = new FakeGenerationRepository(
    sourceOutcome === undefined
      ? {
          found: true,
          bundle: { rows: [{ segment: 1, speaker: 'a', durationSec: 42 }] },
        }
      : sourceOutcome,
  );
  for (const [k, v] of Object.entries(generationHooks)) {
    generationRepo.hooks[k] = v;
  }
  const generator =
    generatorResult === undefined
      ? new FakeGeneratorPort({
          bytes: new Uint8Array([1, 2, 3, 4, 5]),
        })
      : new FakeGeneratorPort(generatorResult);
  const objectStore =
    storeResult === undefined
      ? new FakeObjectStorePort({
          outcome: 'STORED',
          storageRef: 'store://exp-1',
          byteLength: 5,
        })
      : new FakeObjectStorePort(storeResult);
  const service = new ExportGenerationService(
    generationRepo,
    exportService,
    generator,
    objectStore,
    new ExportGenerationPolicy(),
  );
  return { exportRepo, generationRepo, generator, objectStore, service };
}

function baseTurn(overrides = {}) {
  return {
    eventId: 'evt-1',
    exportId: 'exp-1',
    processedAt: VALID_INSTANT,
    ...overrides,
  };
}

for (const [name, options] of [
  ['render', { generatorResult: new Error('synthetic-private-diagnostic') }],
  [
    'storage',
    {
      storeResult: {
        outcome: 'DECLINED',
        declineReason: 'synthetic-private-diagnostic',
      },
    },
  ],
]) {
  test(`${name} diagnostics never enter returned labels or durable outcome`, async () => {
    const h = buildHarness(options);
    const result = await h.service.processGenerationTurn(baseTurn());
    assert.equal(result.kind, 'FAILED');
    assert.equal(
      JSON.stringify(result).includes('synthetic-private-diagnostic'),
      false,
    );
    assert.equal(
      h.generationRepo
        .inboxReceipt('evt-1')
        .outcome.includes('synthetic-private-diagnostic'),
      false,
    );
  });
}
function storedReceipt(outcome, overrides = {}) {
  return {
    id: new ExportGenerationPolicy().composeInboxReceiptId(
      EXPORT_GENERATION_CONSUMER,
      'evt-1',
    ),
    consumer: EXPORT_GENERATION_CONSUMER,
    eventId: 'evt-1',
    processedAt: VALID_INSTANT,
    outcome: JSON.stringify(outcome),
    ...overrides,
  };
}
test('receipt replay rejects an outcome bound to another export before any claim', async () => {
  const h = buildHarness();
  h.generationRepo.inbox.set(
    `${EXPORT_GENERATION_CONSUMER}|evt-1`,
    storedReceipt({ stage: 'READY', exportId: 'synthetic-other-export' }),
  );
  await assert.rejects(
    h.service.processGenerationTurn(baseTurn()),
    /receipt-identity-mismatch/,
  );
  assert.equal(h.exportRepo.calls.claim, 0);
});
for (const binding of [
  { id: 'synthetic-other-receipt' },
  { consumer: 'synthetic-other-consumer' },
  { eventId: 'synthetic-other-event' },
]) {
  test(`receipt replay rejects foreign receipt binding ${Object.keys(binding)[0]}`, async () => {
    const h = buildHarness();
    h.generationRepo.inbox.set(
      `${EXPORT_GENERATION_CONSUMER}|evt-1`,
      storedReceipt({ stage: 'READY', exportId: 'exp-1' }, binding),
    );
    await assert.rejects(
      h.service.processGenerationTurn(baseTurn()),
      /receipt-identity-mismatch/,
    );
    assert.equal(h.exportRepo.calls.claim, 0);
  });
}
test('lost receipt write rejects a foreign export outcome', async () => {
  const h = buildHarness();
  h.generationRepo.hooks.onBeforeWriteInbox = async (receipt, repo) => {
    repo.inbox.set(`${receipt.consumer}|${receipt.eventId}`, {
      ...receipt,
      outcome: JSON.stringify({
        stage: 'READY',
        exportId: 'synthetic-other-export',
      }),
    });
  };
  await assert.rejects(
    h.service.processGenerationTurn(baseTurn()),
    /receipt-identity-mismatch/,
  );
});
for (const stored of [
  { outcome: 'NOT_STORED', storageRef: 'synthetic-ref', byteLength: 5 },
  { outcome: 'STORED', storageRef: 'synthetic-ref', byteLength: 6 },
]) {
  test(`invalid store verdict or length cannot report READY: ${stored.outcome}/${stored.byteLength}`, async () => {
    const h = buildHarness({ storeResult: stored });
    await assert.rejects(
      h.service.processGenerationTurn(baseTurn()),
      /object-store-contract-violation/,
    );
    assert.equal(h.exportRepo.calls.report, 0);
    assert.equal(h.generationRepo.inboxReceipt('evt-1'), undefined);
  });
}
for (const sourceOutcome of [
  { found: false, reason: 'synthetic-private-diagnostic' },
  { found: 'yes', bundle: { rows: [] } },
]) {
  test(`malformed source discriminant/reason fails as a fixed mapping defect: ${sourceOutcome.found}`, async () => {
    const h = buildHarness({ sourceOutcome });
    await assert.rejects(
      h.service.processGenerationTurn(baseTurn()),
      /row-mapping-corrupt/,
    );
    assert.equal(h.exportRepo.calls.report, 0);
    assert.equal(h.generationRepo.inboxReceipt('evt-1'), undefined);
  });
}

test('shape gate: non-object turn is refused before any surface or store call', async () => {
  const h = buildHarness();
  const outcome = await h.service.processGenerationTurn(null);
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.reason, 'INVALID_REQUEST');
  assert.equal(h.generationRepo.calls.findInbox, 0);
  assert.equal(h.exportRepo.calls.claim, 0);
  assert.equal(h.generator.commands.length, 0);
});

test('shape gate: malformed ids / processedAt fail closed without any store touch', async () => {
  for (const fact of [
    { exportId: 'exp-1', processedAt: VALID_INSTANT, kind: 'x' },
    { eventId: 'evt-1', processedAt: VALID_INSTANT, exportId: '' },
    { eventId: 'evt-1', exportId: 'exp-1', processedAt: '1719400000000' },
    { eventId: 'evt-1', exportId: 'exp-1', processedAt: '2026/10/27' },
  ]) {
    const h = buildHarness();
    const outcome = await h.service.processGenerationTurn(fact);
    assert.equal(outcome.kind, 'REFUSED');
    assert.equal(outcome.reason, 'DECISION_FACTS_REQUIRED');
    assert.equal(h.generationRepo.calls.findInbox, 0);
    assert.equal(h.exportRepo.calls.claim, 0);
  }
});

test('same eventId turn replays the durable outcome with zero claim/generation effects', async () => {
  const h = buildHarness();
  await h.service.processGenerationTurn(baseTurn());
  assert.equal(h.exportRepo.calls.claim, 1);
  assert.equal(h.generator.commands.length, 1);
  const baseline = {
    claim: h.exportRepo.calls.claim,
    render: h.generator.commands.length,
  };
  const receipt = h.generationRepo.inboxReceipt('evt-1');
  const replay = await h.service.processGenerationTurn(baseTurn());
  assert.equal(replay.kind, 'REPLAYED');
  assert.equal(replay.outcome, receipt.outcome);
  assert.equal(replay.processedAt, VALID_INSTANT);
  assert.equal(h.exportRepo.calls.claim, baseline.claim);
  assert.equal(h.generator.commands.length, baseline.render);
});

test('lost receipt race mirrors the concurrent durable outcome verbatim', async () => {
  const h = buildHarness();
  h.generationRepo.hooks.onBeforeWriteInbox = async (receipt, repo) => {
    repo.hooks.onBeforeWriteInbox = undefined;
    repo.inbox.set(`${receipt.consumer}|${receipt.eventId}`, {
      ...receipt,
      outcome: '{"stage":"READY","exportId":"exp-1"}',
    });
  };
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'REPLAYED');
  assert.equal(outcome.processedAt, null);
  assert.ok(outcome.outcome.includes('READY'));
});

test('lost race with a null durable outcome is a LOUD corrupt-receipt defect, never an empty replay', async () => {
  const h = buildHarness({ rowOverrides: { status: 'RUNNING' } });
  h.generationRepo.hooks.onBeforeWriteInbox = async (receipt, repo) => {
    repo.hooks.onBeforeWriteInbox = undefined;

    repo.inbox.set(`${receipt.consumer}|${receipt.eventId}`, {
      ...receipt,
      outcome: null,
    });
  };
  await assert.rejects(
    h.service.processGenerationTurn(baseTurn()),
    /export-generation-receipt-outcome-missing/,
  );
  assert.equal(h.exportRepo.calls.report, 0);
});

test('long render diagnostics are replaced by the fixed safe label inside the receipt', async () => {
  const message = `RENDER_BLOWUP_${'x'.repeat(500)}`;
  const h = buildHarness({ generatorResult: new Error(message) });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED');
  assert.equal(outcome.stage, 'RENDER');
  assert.equal(outcome.label, 'EXPORT_RENDER_FAILED');
  const raw = h.generationRepo.inboxReceipt('evt-1').outcome;
  const fact = JSON.parse(raw);
  assert.equal(fact.stage, 'FAILED:RENDER');
  assert.equal(fact.label, 'EXPORT_RENDER_FAILED');
  assert.equal(raw.includes(message), false);
});

test('happy path: claim CAS then SUCCEEDED report leaves the row READY with the artifact facts', async () => {
  const h = buildHarness();
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'COMPLETED');
  assert.equal(outcome.storageRef, 'store://exp-1');
  assert.equal(outcome.byteLength, 5);
  assert.equal(h.exportRepo.rowView('exp-1').status, 'READY');
  assert.equal(h.generator.commands.length, 1);
  assert.deepEqual(h.generator.commands[0].sourceRows, [
    { segment: 1, speaker: 'a', durationSec: 42 },
  ]);
  assert.equal(h.generator.commands[0].kind, 'SUMMARY');
  assert.equal(h.generator.commands[0].format, 'JSON');

  assert.deepEqual([...h.objectStore.commands[0].content], [1, 2, 3, 4, 5]);
  const receipt = h.generationRepo.inboxReceipt('evt-1');
  assert.ok(receipt.outcome.includes('"stage":"READY"'));
  assert.ok(receipt.outcome.includes('"storageRef":"store://exp-1"'));
});

test('claim refusal (row not QUEUED): surfaced verbatim, zero generator effects, receipt recorded', async () => {
  const h = buildHarness({ rowOverrides: { status: 'RUNNING' } });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'CLAIM_REFUSED');
  assert.equal(outcome.label, 'EXPORT_STATUS_CONFLICT');
  assert.equal(h.generator.commands.length, 0);
  assert.equal(h.exportRepo.rowView('exp-1').status, 'RUNNING');
  assert.ok(
    h.generationRepo.inboxReceipt('evt-1').outcome.includes('CLAIM_REFUSED'),
  );
});

test('unknown export id: claim refusal EXPORT_NOT_FOUND with zero mutations', async () => {
  const h = buildHarness();
  const outcome = await h.service.processGenerationTurn(
    baseTurn({ exportId: 'missing-1' }),
  );
  assert.equal(outcome.kind, 'CLAIM_REFUSED');
  assert.equal(outcome.label, 'EXPORT_NOT_FOUND');
  assert.equal(h.generator.commands.length, 0);
});

test('GENERAL meeting export is refused by the REAL claim surface (no content stage)', async () => {
  const h = buildHarness({ rowOverrides: { meetingKind: 'GENERAL' } });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'CLAIM_REFUSED');
  assert.equal(outcome.label, 'GENERAL_EXPORT_REJECTED');
  assert.equal(h.generator.commands.length, 0);
  assert.equal(h.objectStore.commands.length, 0);
});

test('ANALYSIS export with a REJECTED source item never reaches the generator', async () => {
  const h = buildHarness({
    rowOverrides: {
      kind: 'ANALYSIS',
      sourceItems: [
        { id: 'ai-1', status: 'APPROVED' },
        { id: 'ai-2', status: 'REJECTED' },
      ],
    },
  });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'CLAIM_REFUSED');
  assert.equal(outcome.label, 'REJECTED_ITEM_NOT_EXPORTABLE');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'QUEUED');
  assert.equal(h.generationRepo.calls.loadSource, 0);
});

test('creator right revoked before claim: EXPORTER_NOT_AUTHORIZED, row untouched', async () => {
  const h = buildHarness({ rowOverrides: { exporterAuthorized: false } });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'CLAIM_REFUSED');
  assert.equal(outcome.label, 'EXPORTER_NOT_AUTHORIZED');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'QUEUED');
});

test('source content missing: the REAL FAILED report lands and the label surfaces', async () => {
  const h = buildHarness({
    sourceOutcome: { found: false, reason: 'EXPORT_CONTENT_MISSING' },
  });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED');
  assert.equal(outcome.stage, 'SOURCE_FACTS');
  assert.equal(outcome.label, 'EXPORT_CONTENT_MISSING');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'FAILED');
});

test('source kind unmappable: FAILED report; the row is honestly terminal', async () => {
  const h = buildHarness({
    sourceOutcome: { found: false, reason: 'SOURCE_KIND_UNMAPPABLE' },
  });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED');
  assert.equal(outcome.stage, 'SOURCE_FACTS');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'FAILED');
});

test('structurally-invalid source bundle is a THROWN store defect (zero receipt, row stays RUNNING)', async () => {
  const h = buildHarness({
    sourceOutcome: {
      found: true,
      bundle: { rows: [{ nested: { bad: true } }] },
    },
  });
  await assert.rejects(
    () => h.service.processGenerationTurn(baseTurn()),
    /export-generation-row-mapping-corrupt/,
  );
  assert.equal(h.exportRepo.rowView('exp-1').status, 'RUNNING');
  assert.equal(h.generationRepo.calls.writeInbox, 0);
});

test('generator refusal: definite failure reported FAILED with a fixed metadata-only label', async () => {
  const h = buildHarness({
    generatorResult: new Error(
      'kind/format pair unmapped\nand multi-line;oops',
    ),
  });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED');
  assert.equal(outcome.stage, 'RENDER');
  assert.equal(outcome.label, 'EXPORT_RENDER_FAILED');
  assert.ok(!outcome.label.includes('\n'));
  assert.equal(h.exportRepo.rowView('exp-1').status, 'FAILED');
});

test('empty artifact bytes are a definite render failure, never a fake READY', async () => {
  const h = buildHarness({
    generatorResult: { bytes: new Uint8Array(0) },
  });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED');
  assert.equal(outcome.stage, 'RENDER');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'FAILED');
  assert.equal(h.objectStore.commands.length, 0);
});

test('storage DECLINED: definite no-store verdict reports FAILED with the decline fact', async () => {
  const h = buildHarness({
    storeResult: {
      outcome: 'DECLINED',
      declineReason: 'quota-exhausted-for-surface',
    },
  });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED');
  assert.equal(outcome.stage, 'STORAGE_DECLINED');
  assert.equal(outcome.label, 'EXPORT_STORAGE_DECLINED');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'FAILED');
});

test('storage UNKNOWN_EFFECT: no report is fabricated; the row stays RUNNING and the verdict surfaces', async () => {
  const h = buildHarness({ storeResult: { outcome: 'UNKNOWN_EFFECT' } });
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'UNRESOLVED_STORAGE_EFFECT');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'RUNNING');
  const receipt = h.generationRepo.inboxReceipt('evt-1');
  assert.ok(receipt.outcome.includes('UNRESOLVED_STORAGE'));

  assert.ok(!receipt.outcome.includes('storageRef'));
});

test('store contract violation (blank ref) is loud and leaves the row RUNNING', async () => {
  const h = buildHarness({
    storeResult: { outcome: 'STORED', storageRef: '   ', byteLength: 5 },
  });
  await assert.rejects(
    () => h.service.processGenerationTurn(baseTurn()),
    /export-generation-object-store-contract-violation/,
  );
  assert.equal(h.exportRepo.rowView('exp-1').status, 'RUNNING');
});

test('SUCCEEDED report refused by racing state keeps RUNNING stage parked without silent abandonment', async () => {
  const h = buildHarness();

  h.exportRepo.hooks.onBeforeReport = async (request, repo) => {
    const row = repo.rows.get(request.exportId);
    row.status = 'READY';
    delete h.exportRepo.hooks.onBeforeReport;
  };
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'REPORT_REFUSED');
  assert.equal(outcome.label, 'EXPORT_STATUS_CONFLICT');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'READY');
  const receipt = h.generationRepo.inboxReceipt('evt-1');
  assert.ok(receipt.outcome.includes('REPORT_REFUSED'));
});

test('creator right revoked between claim and SUCCEEDED report: EXPORTER_NOT_AUTHORIZED surfaced', async () => {
  const h = buildHarness();
  h.exportRepo.hooks.onBeforeReport = async (request, repo) => {
    const row = repo.rows.get(request.exportId);
    row.exporterAuthorized = false;
    delete h.exportRepo.hooks.onBeforeReport;
  };
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'REPORT_REFUSED');
  assert.equal(outcome.label, 'EXPORTER_NOT_AUTHORIZED');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'RUNNING');
});

test('FAILED report refused (divergence): FAILED_UNREPORTED keeps the label and the row untouched', async () => {
  const h = buildHarness({
    sourceOutcome: { found: false, reason: 'EXPORT_CONTENT_MISSING' },
  });

  const original = h.exportRepo.reportExportCompletion.bind(h.exportRepo);
  h.exportRepo.reportExportCompletion = async (request) => {
    if (request.outcome === 'FAILED') {
      const row = h.exportRepo.rows.get(request.exportId);
      row.status = 'EXPIRED';
    }
    return original(request);
  };
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(outcome.kind, 'FAILED_UNREPORTED');
  assert.equal(outcome.stage, 'SOURCE_FACTS');
  assert.equal(h.exportRepo.rowView('exp-1').status, 'EXPIRED');
});

test('receipt outcome JSON carries stage facts only (no source rows, no artifact bytes)', async () => {
  const h = buildHarness();
  await h.service.processGenerationTurn(baseTurn());
  const receipt = h.generationRepo.inboxReceipt('evt-1');
  assert.ok(!receipt.outcome.includes('speaker'));
  assert.ok(!receipt.outcome.includes('segment'));
  assert.ok(!receipt.outcome.includes('durationSec'));
});

test('generation port receives ONLY the claimed identity + durable source facts', async () => {
  const h = buildHarness({
    rowOverrides: { kind: 'TRANSCRIPT', format: 'CSV' },
  });
  await h.service.processGenerationTurn(baseTurn());
  assert.equal(h.generator.commands.length, 1);
  const command = h.generator.commands[0];
  const allowed = new Set(['exportId', 'kind', 'format', 'sourceRows']);
  for (const key of Object.keys(command)) {
    assert.equal(allowed.has(key), true);
  }
  assert.equal(command.exportId, 'exp-1');
  assert.equal(command.kind, 'TRANSCRIPT');
  assert.equal(command.format, 'CSV');
});

test('turn outcomes are frozen with whitelisted key sets', async () => {
  const h = buildHarness();
  const outcome = await h.service.processGenerationTurn(baseTurn());
  assert.equal(Object.isFrozen(outcome), true);
  const allowed = new Set([
    'kind',
    'reason',
    'preventEnumeration',
    'outcome',
    'processedAt',
    'label',
    'stage',
    'storageRef',
    'byteLength',
  ]);
  for (const key of Object.keys(outcome)) {
    assert.equal(allowed.has(key), true);
  }
});
