'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  AnalysisRunService: UnboundAnalysisRunService,
} = require('../../src/application/analysis-run.service.ts');

class AnalysisRunService extends UnboundAnalysisRunService {
  claimRun(q) {
    return super.claimRun(workerQuery(q));
  }
  recordRepair(q) {
    return super.recordRepair(workerQuery(q));
  }
  settleRun(q) {
    return super.settleRun(workerQuery(q));
  }
}
function workerQuery(q) {
  return q &&
    typeof q === 'object' &&
    !Array.isArray(q) &&
    typeof q.runId === 'string' &&
    q.runId.trim()
    ? { attemptId: 'synthetic-worker-a', ...q }
    : q;
}

function inMemoryRepository(overrides) {
  const runs = new Map();
  const sourceRecords = new Map();
  const audit = [],
    outbox = [],
    failureReasons = new Map();
  const calls = [];
  let idCounter = 0;
  let revisionCounter = 0;

  const SOURCE_FIELDS = [
    'transcriptRevision',
    'templateVersion',
    'promptVersion',
    'analysisLanguage',
    'schemaVersion',
  ];

  function approveStatus(status) {
    if (
      status !== 'QUEUED' &&
      status !== 'RUNNING' &&
      status !== 'VALIDATED' &&
      status !== 'NEEDS_REVIEW' &&
      status !== 'FAILED'
    ) {
      throw new Error(`analysis-run-row-mapping-corrupt (status ${status})`);
    }
    return status;
  }

  function approveOutcome(outcome) {
    if (
      outcome !== 'VALIDATED' &&
      outcome !== 'NEEDS_REVIEW' &&
      outcome !== 'FAILED'
    ) {
      throw new Error(`analysis-run-row-mapping-corrupt (outcome ${outcome})`);
    }
    return outcome;
  }

  function rowView(row) {
    approveStatus(row.status);
    if (
      typeof row.repairCount !== 'number' ||
      !Number.isInteger(row.repairCount) ||
      row.repairCount < 0
    ) {
      throw new Error(
        `analysis-run-row-mapping-corrupt (repairCount ${String(row.repairCount)})`,
      );
    }
    return Object.freeze({
      id: row.id,
      status: row.status,
      repairCount: row.repairCount,
    });
  }

  function settled(status) {
    return (
      status === 'VALIDATED' || status === 'NEEDS_REVIEW' || status === 'FAILED'
    );
  }

  function snapshotReadable(runId) {
    const rec = sourceRecords.get(runId);
    if (
      rec === undefined ||
      rec === null ||
      typeof rec !== 'object' ||
      Array.isArray(rec)
    ) {
      return false;
    }
    return SOURCE_FIELDS.every(
      (field) => typeof rec[field] === 'string' && rec[field].trim() !== '',
    );
  }

  const repo = {
    calls,
    runs,
    audit,
    outbox,
    failureReasons,
    countCalls(op) {
      return calls.filter((call) => call.op === op).length;
    },

    seedRun(runId, status, repairCount, opts = {}) {
      runs.set(runId, {
        id: runId,
        status,
        repairCount,
        version: 0,
        attemptId:
          status === 'RUNNING'
            ? (opts.attemptId ?? 'synthetic-worker-a')
            : null,
        leaseValid: true,
      });
      sourceRecords.set(
        runId,
        opts.sourceRecord ?? {
          transcriptRevision: 'rev-seed-1',
          templateVersion: 'tpl-1',
          promptVersion: 'p-1',
          analysisLanguage: 'en-US',
          schemaVersion: 's-1',
        },
      );
      return runId;
    },

    dropSourceRecord(runId) {
      sourceRecords.delete(runId);
    },

    bumpSourceRevision() {
      for (const rec of sourceRecords.values()) {
        rec.transcriptRevision = `rev-${++revisionCounter}`;
      }
    },

    currentSourceRecord(runId) {
      const rec = sourceRecords.get(runId);
      return rec === undefined ? null : Object.freeze({ ...rec });
    },
    dropRun(runId) {
      runs.delete(runId);
    },
    corruptRun(runId, patch) {
      Object.assign(runs.get(runId), patch);
    },

    getRunStateFacts(context) {
      calls.push({ op: 'getRunStateFacts' });
      const row = runs.get(context.runId);
      if (row === undefined) {
        return { runExists: false, status: null, repairCount: null };
      }
      const status = approveStatus(row.status);
      return {
        runExists: true,
        status,
        version: row.version,
        claimEligible:
          status === 'QUEUED' &&
          row.claimAllowed !== false &&
          row.inputCurrent !== false &&
          row.budgetAvailable !== false,
        leaseCurrent:
          status === 'RUNNING' &&
          row.attemptId === context.attemptId &&
          row.leaseValid === true &&
          row.inputCurrent !== false,
        repairCount: row.repairCount === null ? null : row.repairCount,
      };
    },

    claimQueuedRun(context) {
      calls.push({ op: 'claimQueuedRun' });
      if (typeof context.attemptId !== 'string' || !context.attemptId.trim())
        throw new Error('analysis-run-row-mapping-corrupt');
      const row = runs.get(context.runId);
      if (
        row === undefined ||
        approveStatus(row.status) !== 'QUEUED' ||
        row.version !== context.expectedVersion ||
        row.claimAllowed === false ||
        row.inputCurrent === false ||
        row.budgetAvailable === false
      ) {
        return { claimed: false, refusal: 'CLAIM_RACE_LOST', run: null };
      }

      const postImage = rowView({
        id: row.id,
        status: 'RUNNING',
        repairCount: row.repairCount,
      });
      row.status = 'RUNNING';
      row.version++;
      row.attemptId = context.attemptId;
      row.leaseValid = true;
      return {
        claimed: true,
        refusal: null,
        run: postImage,
        leaseAcquired: true,
      };
    },

    persistRepairCall(req) {
      calls.push({ op: 'persistRepairCall' });
      const row = runs.get(req.runId);
      if (
        row === undefined ||
        approveStatus(row.status) !== 'RUNNING' ||
        row.repairCount !== req.expectedRepairCount ||
        row.version !== req.expectedVersion ||
        row.attemptId !== req.attemptId ||
        row.leaseValid !== true ||
        row.inputCurrent === false ||
        row.budgetAvailable === false
      ) {
        return { persisted: false, refusal: 'REPAIR_RACE_LOST', run: null };
      }

      const postImage = rowView({
        id: row.id,
        status: row.status,
        repairCount: req.repairCountAfter,
      });
      row.repairCount = req.repairCountAfter;
      row.version++;
      return { persisted: true, refusal: null, run: postImage };
    },

    settleRun(req) {
      calls.push({ op: 'settleRun' });
      approveOutcome(req.outcome);
      const row = runs.get(req.runId);
      if (
        row === undefined ||
        approveStatus(row.status) !== 'RUNNING' ||
        row.version !== req.expectedVersion ||
        row.attemptId !== req.attemptId ||
        row.leaseValid !== true ||
        row.inputCurrent === false ||
        row.validationCurrent === false
      ) {
        return { settled: false, refusal: 'SETTLE_RACE_LOST', run: null };
      }

      const postImage = rowView({
        id: row.id,
        status: req.outcome,
        repairCount: row.repairCount,
      });
      if (req.outcome === 'FAILED') {
        if (typeof req.failureReason !== 'string' || !req.failureReason.trim())
          throw new Error('analysis-run-row-mapping-corrupt');
        failureReasons.set(req.runId, req.failureReason);
      }
      row.status = req.outcome;
      row.version++;
      return { settled: true, refusal: null, run: postImage };
    },

    getReanalysisSourceFacts(context) {
      calls.push({ op: 'getReanalysisSourceFacts' });
      const row = runs.get(context.runId);
      const sourceRunExists = row !== undefined;
      const status = sourceRunExists ? approveStatus(row.status) : null;
      return {
        sourceRunExists,
        status,
        version: row?.version ?? null,
        freshInputSnapshotReady: snapshotReadable(context.runId),
      };
    },

    createReanalysisRun(req) {
      calls.push({ op: 'createReanalysisRun' });
      const row = runs.get(req.sourceRunId);
      const currentStatus =
        row === undefined ? null : approveStatus(row.status);
      if (
        row === undefined ||
        !settled(currentStatus) ||
        currentStatus !== req.expectedStatus ||
        row.version !== req.expectedVersion
      ) {
        return {
          created: false,
          refusal: 'SOURCE_STATE_DIVERGED',
          run: null,
        };
      }
      if (!snapshotReadable(req.sourceRunId)) {
        return {
          created: false,
          refusal: 'INPUT_SNAPSHOT_UNAVAILABLE',
          run: null,
        };
      }
      const captured = { ...sourceRecords.get(req.sourceRunId) };
      const newId = `run_re_${++idCounter}`;

      const candidate = {
        id: newId,
        status: 'QUEUED',
        repairCount: 0,
        version: 0,
        snapshot: captured,
      };
      const view = rowView(candidate),
        beforeAudit = audit.length,
        beforeOutbox = outbox.length;
      try {
        runs.set(newId, candidate);
        if (repo.failAudit) throw new Error('synthetic-audit-failure');
        audit.push({
          action: 'analysis.requested.v1',
          runId: newId,
          sourceRunId: req.sourceRunId,
        });
        if (repo.failOutbox) throw new Error('synthetic-outbox-failure');
        outbox.push({
          type: 'analysis.requested.v1',
          payload: { runId: newId },
        });
      } catch (error) {
        runs.delete(newId);
        audit.length = beforeAudit;
        outbox.length = beforeOutbox;
        throw error;
      }
      return {
        created: true,
        refusal: null,
        run: view,
        capturedSnapshot: captured,
        outboxRecorded: true,
        auditRecorded: true,
      };
    },
  };
  return Object.assign(repo, overrides ?? {});
}

function seedRunIn(repo, runId, status, repairCount, opts) {
  return repo.seedRun(runId, status, repairCount, opts);
}

test('claimRun happy path: the QUEUED run is claimed exactly once (row 61 CAS-committed RUNNING truth)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.claimRun({ runId: 'r1' });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'CLAIMED');
  assert.deepEqual(out.run, { id: 'r1', status: 'RUNNING', repairCount: 0 });
  assert.equal(repo.runs.get('r1').status, 'RUNNING');
  assert.equal(repo.countCalls('getRunStateFacts'), 1);
  assert.equal(repo.countCalls('claimQueuedRun'), 1);
});

test('claimRun frozen outcome and frozen persisted view', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.claimRun({ runId: 'r1' });
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.run), true);
});

test('claimRun a planted caller lease/state boolean cannot flip the claim (repository-computed CURRENT state only)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const forged = {
    runId: 'r1',
    leaseAcquired: false,
    currentState: 'FAILED',
    command: 'SETTLE_FAILED',
    failureReason: 'forged',
  };
  const out = await service.claimRun(forged);
  assert.equal(out.ok, true);
  assert.equal(out.k, 'CLAIMED');
});

test('claimRun malformed/null/blank queries fail closed before any storage read', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  assert.deepEqual(await service.claimRun(null), {
    ok: false,
    reason: 'RUN_FACTS_REQUIRED',
  });
  assert.deepEqual(await service.claimRun({}), {
    ok: false,
    reason: 'RUN_FACTS_REQUIRED',
  });
  assert.deepEqual(await service.claimRun({ runId: '   ' }), {
    ok: false,
    reason: 'RUN_FACTS_REQUIRED',
  });
  assert.equal(repo.countCalls('getRunStateFacts'), 0);
  assert.equal(repo.countCalls('claimQueuedRun'), 0);
});

test('claimRun a RUNNING run refuses with the policy own RUN_IN_PROGRESS (zero mutation)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.claimRun({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_IN_PROGRESS');
  assert.equal(repo.runs.get('r1').status, 'RUNNING');
  assert.equal(repo.countCalls('claimQueuedRun'), 0);
});

test('claimRun settled runs are not active for claims (RUN_NOT_ACTIVE)', async () => {
  for (const status of ['VALIDATED', 'NEEDS_REVIEW', 'FAILED']) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', status, 0);
    const out = await new AnalysisRunService(repo).claimRun({ runId: 'r1' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'RUN_NOT_ACTIVE');
    assert.equal(repo.runs.get('r1').status, status);
    assert.equal(repo.countCalls('claimQueuedRun'), 0);
  }
});

test('claimRun a missing row fails closed with RUN_NOT_FOUND (no queue CAS)', async () => {
  const repo = inMemoryRepository();
  const service = new AnalysisRunService(repo);
  const out = await service.claimRun({ runId: 'missing' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_NOT_FOUND');
  assert.equal(repo.countCalls('claimQueuedRun'), 0);
});

test('claimRun parallel claims serialize through ONE CAS (exactly one winner, loser zero-mutation)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const [a, b] = await Promise.all([
    service.claimRun({ runId: 'r1' }),
    service.claimRun({ runId: 'r1' }),
  ]);
  const outcomes = [a, b];
  assert.equal(outcomes.filter((o) => o.ok && o.k === 'CLAIMED').length, 1);
  assert.equal(outcomes.filter((o) => o.ok === false).length, 1);
  const winner = outcomes.find((o) => o.ok);
  const loser = outcomes.find((o) => !o.ok);
  assert.equal(winner.run.status, 'RUNNING');
  assert.equal(loser.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.get('r1').status, 'RUNNING');
  assert.equal(repo.countCalls('claimQueuedRun'), 2);
});

test('claimRun in-tx divergence before the CAS re-read loses zero-mutation (CLAIM_RACE_LOST → RUN_STATE_CONFLICT)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const original = repo.claimQueuedRun.bind(repo);
  Object.assign(repo, {
    claimQueuedRun(context) {
      repo.runs.get(context.runId).status = 'VALIDATED';
      return original(context);
    },
  });
  const out = await service.claimRun({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_STATE_CONFLICT');

  assert.equal(repo.runs.get('r1').status, 'VALIDATED');
  assert.equal(repo.runs.get('r1').repairCount, 0);
});

test('claimRun a run that vanishes inside its own transaction is the zero-mutation data refusal (nothing to dereference)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const original = repo.claimQueuedRun.bind(repo);
  Object.assign(repo, {
    claimQueuedRun(context) {
      repo.dropRun(context.runId);
      return original(context);
    },
  });
  const out = await service.claimRun({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.has('r1'), false);
});

test('recordRepair records the policy-computed after-count as the PERSISTED storage truth (line 67)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.recordRepair({ runId: 'r1' });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'REPAIR_RECORDED');
  assert.equal(out.repairCountAfter, 1);
  assert.deepEqual(out.run, { id: 'r1', status: 'RUNNING', repairCount: 1 });
  assert.equal(repo.runs.get('r1').repairCount, 1);
  assert.equal(repo.countCalls('getRunStateFacts'), 1);
  assert.equal(repo.countCalls('persistRepairCall'), 1);
});

test('recordRepair the agreed budget cap REFUSES the third-and-later attempt (REPAIR_BUDGET_EXHAUSTED, zero mutation)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 3);
  const service = new AnalysisRunService(repo);
  const out = await service.recordRepair({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'REPAIR_BUDGET_EXHAUSTED');
  assert.equal(repo.runs.get('r1').repairCount, 3);
  assert.equal(repo.countCalls('persistRepairCall'), 0);
});

test('recordRepair counts below the cap still climb (0→1, 2→3 boundary)', async () => {
  for (const [before, after] of [
    [0, 1],
    [2, 3],
  ]) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', 'RUNNING', before);
    const out = await new AnalysisRunService(repo).recordRepair({
      runId: 'r1',
    });
    assert.equal(out.ok, true);
    assert.equal(out.repairCountAfter, after);
    assert.equal(repo.runs.get('r1').repairCount, after);
  }
});

test('recordRepair CAS anchor from a stale fresh read loses to a concurrent repair (RUN_STATE_CONFLICT, one mutation)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const [a, b] = await Promise.all([
    service.recordRepair({ runId: 'r1' }),
    service.recordRepair({ runId: 'r1' }),
  ]);
  const outcomes = [a, b];
  assert.equal(
    outcomes.filter((o) => o.ok && o.k === 'REPAIR_RECORDED').length,
    1,
  );
  assert.equal(outcomes.filter((o) => o.ok === false).length, 1);
  const winner = outcomes.find((o) => o.ok);
  const loser = outcomes.find((o) => !o.ok);
  assert.equal(winner.repairCountAfter, 1);
  assert.equal(loser.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.get('r1').repairCount, 1);
  assert.equal(repo.countCalls('persistRepairCall'), 2);
});

test('recordRepair in-tx divergence before the CAS re-read loses zero-mutation', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const original = repo.persistRepairCall.bind(repo);
  Object.assign(repo, {
    persistRepairCall(req) {
      repo.corruptRun(req.runId, { status: 'VALIDATED' });
      return original(req);
    },
  });
  const out = await service.recordRepair({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.get('r1').status, 'VALIDATED');
  assert.equal(repo.runs.get('r1').repairCount, 0);
});

test('recordRepair a null stored repair count fails closed DECISION_FACTS_REQUIRED (no fabricated 0)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', null);
  const service = new AnalysisRunService(repo);
  const out = await service.recordRepair({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repo.runs.get('r1').repairCount, null);
  assert.equal(repo.countCalls('persistRepairCall'), 0);
});

test('recordRepair non-RUNNING states fail closed with the policy own RUN_NOT_ACTIVE', async () => {
  for (const status of ['QUEUED', 'NEEDS_REVIEW']) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', status, 0);
    const out = await new AnalysisRunService(repo).recordRepair({
      runId: 'r1',
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'RUN_NOT_ACTIVE');
    assert.equal(repo.countCalls('persistRepairCall'), 0);
  }
});

test('recordRepair missing rows fail closed RUN_NOT_FOUND', async () => {
  const repo = inMemoryRepository();
  const service = new AnalysisRunService(repo);
  const out = await service.recordRepair({ runId: 'missing' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_NOT_FOUND');
  assert.equal(repo.countCalls('persistRepairCall'), 0);
});

test('recordRepair malformed/null/blank queries fail closed before any storage read', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  assert.deepEqual(await service.recordRepair(null), {
    ok: false,
    reason: 'RUN_FACTS_REQUIRED',
  });
  assert.deepEqual(await service.recordRepair({ runId: '' }), {
    ok: false,
    reason: 'RUN_FACTS_REQUIRED',
  });
  assert.equal(repo.countCalls('getRunStateFacts'), 0);
});

test('settleRun VALIDATED settles only on literally-true validation facts (row 62)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.settleRun({
    runId: 'r1',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'VALIDATED');
  assert.deepEqual(out.run, { id: 'r1', status: 'VALIDATED', repairCount: 0 });
  assert.equal(out.noAutoApprove, true);
  assert.equal(out.keepsValidItems, false);
  assert.equal(out.allowsControlledRetry, false);
  assert.equal(out.itemPersistenceIsTransactionDuty, true);
  assert.equal(repo.runs.get('r1').status, 'VALIDATED');
});

test('settleRun VALIDATED coercive/shallow shapes fail closed (VALIDATION_NOT_COMPLETE, zero mutation)', async () => {
  for (const packet of [
    { schemaValidated: 'true', allEvidenceValid: true },
    { schemaValidated: 1, allEvidenceValid: true },
    { schemaValidated: true, allEvidenceValid: false },
    { schemaValidated: true },
  ]) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', 'RUNNING', 0);
    const out = await new AnalysisRunService(repo).settleRun({
      runId: 'r1',
      outcome: 'VALIDATED',
      ...packet,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'VALIDATION_NOT_COMPLETE');
    assert.equal(repo.runs.get('r1').status, 'RUNNING');
    assert.equal(repo.countCalls('settleRun'), 0);
  }
});

test('settleRun NEEDS_REVIEW keeps valid items after the repair phase is declared concluded (row 63, R06 allows fewer or zero repairs)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.settleRun({
    runId: 'r1',
    outcome: 'NEEDS_REVIEW',
    repairPhaseConcluded: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'NEEDS_REVIEW');
  assert.deepEqual(out.run, {
    id: 'r1',
    status: 'NEEDS_REVIEW',
    repairCount: 0,
  });
  assert.equal(out.keepsValidItems, true);
  assert.equal(out.noAutoApprove, false);
  assert.equal(out.itemPersistenceIsTransactionDuty, true);
  assert.equal(repo.runs.get('r1').status, 'NEEDS_REVIEW');
  assert.equal(repo.runs.get('r1').repairCount, 0);
});

test('settleRun NEEDS_REVIEW refuses while the repair phase is not concluded (REPAIR_PHASE_NOT_CONCLUDED)', async () => {
  for (const q of [{ repairPhaseConcluded: false }, {}]) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', 'RUNNING', 0);
    const out = await new AnalysisRunService(repo).settleRun({
      runId: 'r1',
      outcome: 'NEEDS_REVIEW',
      ...q,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'REPAIR_PHASE_NOT_CONCLUDED');
    assert.equal(repo.runs.get('r1').status, 'RUNNING');
    assert.equal(repo.countCalls('settleRun'), 0);
  }
});

test('settleRun FAILED carries the distinct non-blank reason and keeps controlled retry (row 64)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 1);
  const service = new AnalysisRunService(repo);
  const out = await service.settleRun({
    runId: 'r1',
    outcome: 'FAILED',

    failureReason: 'PROVIDER_TIMEOUT',
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'FAILED');
  assert.deepEqual(out.run, { id: 'r1', status: 'FAILED', repairCount: 1 });
  assert.equal(out.allowsControlledRetry, true);
  assert.equal(out.itemPersistenceIsTransactionDuty, true);
  assert.equal(repo.runs.get('r1').status, 'FAILED');
});

test('settleRun FAILED refuses blank or missing reasons (FAILURE_REASON_REQUIRED)', async () => {
  for (const q of [{ failureReason: '' }, { failureReason: '   ' }, {}]) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', 'RUNNING', 0);
    const out = await new AnalysisRunService(repo).settleRun({
      runId: 'r1',
      outcome: 'FAILED',
      ...q,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'FAILURE_REASON_REQUIRED');
    assert.equal(repo.runs.get('r1').status, 'RUNNING');
    assert.equal(repo.countCalls('settleRun'), 0);
  }
});

test('settleRun non-RUNNING states fail closed RUN_NOT_ACTIVE (the settle boundary does not invent settled-state labels)', async () => {
  for (const status of ['QUEUED', 'VALIDATED']) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', status, 0);
    const out = await new AnalysisRunService(repo).settleRun({
      runId: 'r1',
      outcome: 'VALIDATED',
      schemaValidated: true,
      allEvidenceValid: true,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'RUN_NOT_ACTIVE');
    assert.equal(repo.runs.get('r1').status, status);
    assert.equal(repo.countCalls('settleRun'), 0);
  }
});

test('settleRun unknown/denormalized outcomes fail before any storage read', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  for (const outcome of ['PAUSED', 'validated', 42, undefined]) {
    const out = await service.settleRun({ runId: 'r1', outcome });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'RUN_FACTS_REQUIRED');
  }
  assert.equal(repo.countCalls('getRunStateFacts'), 0);
  assert.equal(repo.countCalls('settleRun'), 0);
});

test('settleRun missing rows fail closed RUN_NOT_FOUND', async () => {
  const repo = inMemoryRepository();
  const service = new AnalysisRunService(repo);
  const out = await service.settleRun({
    runId: 'missing',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_NOT_FOUND');
  assert.equal(repo.countCalls('settleRun'), 0);
});

test('settleRun in-tx divergence before the CAS re-read loses zero-mutation (SETTLE_RACE_LOST → RUN_STATE_CONFLICT)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const original = repo.settleRun.bind(repo);
  Object.assign(repo, {
    settleRun(req) {
      repo.corruptRun(req.runId, { status: 'QUEUED' });
      return original(req);
    },
  });
  const out = await service.settleRun({
    runId: 'r1',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.get('r1').status, 'QUEUED');
});

test('settleRun parallel settles from the same RUNNING run serialize through the CAS (one settled truth)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const [a, b] = await Promise.all([
    service.settleRun({
      runId: 'r1',
      outcome: 'VALIDATED',
      schemaValidated: true,
      allEvidenceValid: true,
    }),
    service.settleRun({
      runId: 'r1',
      outcome: 'FAILED',
      failureReason: 'LATER_LOSER',
    }),
  ]);
  const outcomes = [a, b];
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  assert.equal(outcomes.filter((o) => o.ok === false).length, 1);
  const winner = outcomes.find((o) => o.ok);
  const loser = outcomes.find((o) => !o.ok);
  assert.equal(winner.k, 'VALIDATED');
  assert.equal(loser.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.get('r1').status, 'VALIDATED');
  assert.equal(repo.countCalls('settleRun'), 2);
});

test('settleRun the settled outcome flags surface the policy verdict verbatim (never re-derived)', async () => {
  const expected = {
    VALIDATED: {
      noAutoApprove: true,
      keepsValidItems: false,
      allowsControlledRetry: false,
    },
    NEEDS_REVIEW: {
      noAutoApprove: false,
      keepsValidItems: true,
      allowsControlledRetry: false,
    },
    FAILED: {
      noAutoApprove: false,
      keepsValidItems: false,
      allowsControlledRetry: true,
    },
  };
  for (const outcome of ['VALIDATED', 'NEEDS_REVIEW', 'FAILED']) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', 'RUNNING', 0);
    const packet =
      outcome === 'VALIDATED'
        ? { schemaValidated: true, allEvidenceValid: true }
        : outcome === 'NEEDS_REVIEW'
          ? { repairPhaseConcluded: true }
          : { failureReason: 'ANY_NON_BLANK_REASON' };
    const out = await new AnalysisRunService(repo).settleRun({
      runId: 'r1',
      outcome,
      ...packet,
    });
    assert.equal(out.ok, true);
    assert.equal(out.noAutoApprove, expected[outcome].noAutoApprove);
    assert.equal(out.keepsValidItems, expected[outcome].keepsValidItems);
    assert.equal(
      out.allowsControlledRetry,
      expected[outcome].allowsControlledRetry,
    );
  }
});

test('requestReanalysis from a VALIDATED run queues a NEW QUEUED run with a new ID (row 65)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0);
  const service = new AnalysisRunService(repo);
  repo.bumpSourceRevision();
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'REANALYSIS_QUEUED');
  assert.notEqual(out.run.id, 'r1');
  assert.equal(out.run.status, 'QUEUED');
  assert.equal(out.run.repairCount, 0);
  assert.equal(repo.runs.get(out.run.id).status, 'QUEUED');
  assert.equal(repo.runs.get('r1').status, 'VALIDATED');
  assert.equal(repo.countCalls('createReanalysisRun'), 1);
});

test('requestReanalysis the captured fingerprint equals the CURRENT source record (fresh, fail-closed capture)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'NEEDS_REVIEW', 2);
  const service = new AnalysisRunService(repo);
  const before = repo.currentSourceRecord('r1');
  repo.bumpSourceRevision();
  const fresh = repo.currentSourceRecord('r1');
  assert.notEqual(before.transcriptRevision, fresh.transcriptRevision);
  const original = repo.createReanalysisRun.bind(repo);
  let captured = null;
  Object.assign(repo, {
    createReanalysisRun(req) {
      const result = original(req);
      captured = result.created ? result.capturedSnapshot : null;
      return result;
    },
  });
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, true);
  assert.deepEqual(captured, fresh);

  assert.deepEqual(repo.runs.get(out.run.id).snapshot, fresh);
});

test('requestReanalysis from NEEDS_REVIEW and FAILED settled runs queue new runs just the same', async () => {
  for (const status of ['NEEDS_REVIEW', 'FAILED']) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', status, 0);
    const out = await new AnalysisRunService(repo).requestReanalysis({
      runId: 'r1',
    });
    assert.equal(out.ok, true);
    assert.equal(out.k, 'REANALYSIS_QUEUED');
    assert.equal(out.run.id !== 'r1', true);
    assert.equal(repo.runs.size, 2);
    assert.equal(repo.runs.get('r1').status, status);
  }
});

test('requestReanalysis a QUEUED source refuses ALREADY_QUEUED (no second run row)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'QUEUED', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'ALREADY_QUEUED');
  assert.equal(repo.runs.size, 1);
  assert.equal(repo.countCalls('createReanalysisRun'), 0);
});

test('requestReanalysis a RUNNING source refuses RUN_IN_PROGRESS', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_IN_PROGRESS');
  assert.equal(repo.runs.size, 1);
});

test('requestReanalysis a missing fresh snapshot fails closed DECISION_FACTS_REQUIRED (no half-captured fingerprint can enqueue)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0);
  const service = new AnalysisRunService(repo);
  repo.dropSourceRecord('r1');
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repo.runs.has('run_re_1'), false);
  assert.equal(repo.countCalls('createReanalysisRun'), 0);
});

test('requestReanalysis a partial snapshot (any blank component) fails closed the same way', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0, {
    sourceRecord: {
      transcriptRevision: 'rev-1',
      templateVersion: 'tpl-1',
      promptVersion: 'p-1',
      analysisLanguage: '   ',
      schemaVersion: 's-1',
    },
  });
  const out = await new AnalysisRunService(repo).requestReanalysis({
    runId: 'r1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repo.runs.size, 1);
  assert.equal(repo.countCalls('createReanalysisRun'), 0);
});

test('requestReanalysis an unreadable snapshot appearing INSIDE the creation transaction refuses INPUT_SNAPSHOT_UNAVAILABLE (→ DECISION_FACTS_REQUIRED, zero-creation)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0);
  const service = new AnalysisRunService(repo);
  const original = repo.createReanalysisRun.bind(repo);
  Object.assign(repo, {
    createReanalysisRun(req) {
      repo.dropSourceRecord(req.sourceRunId);
      return original(req);
    },
  });
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(repo.runs.size, 1);
});

test('requestReanalysis a source state that diverged inside the transaction refuses SOURCE_STATE_DIVERGED (→ RUN_STATE_CONFLICT, zero-creation)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0);
  const service = new AnalysisRunService(repo);
  const original = repo.createReanalysisRun.bind(repo);
  Object.assign(repo, {
    createReanalysisRun(req) {
      repo.corruptRun(req.sourceRunId, { status: 'QUEUED' });
      return original(req);
    },
  });
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.size, 1);
});

test('requestReanalysis missing source rows fail closed RUN_NOT_FOUND', async () => {
  const repo = inMemoryRepository();
  const service = new AnalysisRunService(repo);
  const out = await service.requestReanalysis({ runId: 'missing' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_NOT_FOUND');
  assert.equal(repo.countCalls('createReanalysisRun'), 0);
});

test('requestReanalysis carries NO requester in this slice (no requester field reaches the repository)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0);
  const original = repo.getReanalysisSourceFacts.bind(repo);
  let seenContext = null;
  Object.assign(repo, {
    getReanalysisSourceFacts(context) {
      seenContext = context;
      return original(context);
    },
  });
  const out = await new AnalysisRunService(repo).requestReanalysis({
    runId: 'r1',
    requesterId: 'u1',
    requestedBy: 'ADMIN',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seenContext, { runId: 'r1' });
});

test('requestReanalysis approved snapshots and the source row are never mutated by a successful creation', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'VALIDATED', 0);
  const service = new AnalysisRunService(repo);
  const beforeRow = { ...repo.runs.get('r1') };
  const beforeRecord = { ...repo.currentSourceRecord('r1') };
  const out = await service.requestReanalysis({ runId: 'r1' });
  assert.equal(out.ok, true);
  assert.equal(out.approvedSnapshotsUntouched, true);
  assert.equal(out.outboxRecorded, true);
  assert.equal(out.auditRecorded, true);
  assert.deepEqual(
    repo.currentSourceRecord('r1'),
    beforeRecord,
    'source record untouched',
  );
  assert.equal(repo.runs.get('r1').status, beforeRow.status);
  assert.equal(repo.runs.get('r1').repairCount, beforeRow.repairCount);
});

test('enum-corrupt stored run status is a thrown adapter defect that propagates from every read surface', async () => {
  const service = new AnalysisRunService(inMemoryRepository());
  const targets = [
    () => {
      const repo = inMemoryRepository();
      seedRunIn(repo, 'c1', 'RUNNING', 0);
      repo.corruptRun('c1', { status: 'PAUSED' });
      return repo;
    },
    () => {
      const repo = inMemoryRepository();
      seedRunIn(repo, 'c1', 'QUEUED', 0);
      repo.corruptRun('c1', { status: 'HIBERNATING' });
      return repo;
    },
    () => {
      const repo = inMemoryRepository();
      seedRunIn(repo, 'c1', 'VALIDATED', 0);
      repo.corruptRun('c1', { status: null });
      return repo;
    },
  ];
  for (const corrupt of targets) {
    const repo = corrupt();
    const service = new AnalysisRunService(repo);
    await assert.rejects(
      () => service.claimRun({ runId: 'c1' }),
      /analysis-run-row-mapping-corrupt/,
    );
    await assert.rejects(
      () => service.recordRepair({ runId: 'c1' }),
      /analysis-run-row-mapping-corrupt/,
    );
    await assert.rejects(
      () => service.settleRun({ runId: 'c1', outcome: 'VALIDATED' }),
      /analysis-run-row-mapping-corrupt/,
    );
    await assert.rejects(
      () => service.requestReanalysis({ runId: 'c1' }),
      /analysis-run-row-mapping-corrupt/,
    );
  }
});

test('an adapter that returns a refusal payload instead of the CAS truth maps mechanically to RUN_STATE_CONFLICT', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const poisoned = Object.assign(repo, {
    settleRun(req) {
      return {
        settled: false,
        refusal: 'SETTLE_RACE_LOST',
        run: null,
      };
    },
  });
  const out = await new AnalysisRunService(poisoned).settleRun({
    runId: 'r1',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_STATE_CONFLICT');
  assert.equal(repo.runs.get('r1').status, 'RUNNING');
});

test('frozen failure shapes across every service surface', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  const failedClaim = await service.claimRun({ runId: 'r1' });
  const failedRepair = await service.recordRepair({ runId: 'missing' });
  const failedSettle = await service.settleRun({
    runId: 'r1',
    outcome: 'NOPE',
  });
  const failedReanalysis = await service.requestReanalysis({ runId: 'r1' });
  for (const failure of [
    failedClaim,
    failedRepair,
    failedSettle,
    failedReanalysis,
  ]) {
    assert.equal(failure.ok, false);
    assert.equal(Object.isFrozen(failure), true);
  }
  seedRunIn(repo, 'r2', 'RUNNING', 0);
  const okSettle = await service.settleRun({
    runId: 'r2',
    outcome: 'FAILED',
    failureReason: 'TIMEOUT',
  });
  assert.equal(Object.isFrozen(okSettle), true);
  assert.equal(Object.isFrozen(okSettle.run), true);
});

test('settle runId shape defects fail closed before any storage read (leftover shapes)', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);
  for (const q of [
    { outcome: 'VALIDATED' },
    { runId: '   ', outcome: 'VALIDATED' },
    { runId: 42, outcome: 'VALIDATED' },
  ]) {
    const out = await service.settleRun(q);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'RUN_FACTS_REQUIRED');
  }
  assert.equal(repo.countCalls('getRunStateFacts'), 0);
  assert.equal(repo.countCalls('settleRun'), 0);
});

test('planted caller facts cannot smuggle into the recordRepair/settleRun decisions', async () => {
  const repo = inMemoryRepository();
  seedRunIn(repo, 'r1', 'RUNNING', 0);
  const service = new AnalysisRunService(repo);

  const repair = await service.recordRepair({
    runId: 'r1',
    repairCount: 999,
  });
  assert.equal(repair.ok, true);
  assert.equal(repair.repairCountAfter, 1);

  seedRunIn(repo, 'r2', 'RUNNING', 0);
  const smuggled = await service.settleRun({
    runId: 'r2',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
    repairPhaseConcluded: true,
    failureReason: 'PLANTED',
    leaseAcquired: true,
  });
  assert.equal(smuggled.ok, true);
  assert.equal(smuggled.k, 'VALIDATED');
  assert.equal(smuggled.noAutoApprove, true);

  seedRunIn(repo, 'r3', 'RUNNING', 0);
  const refused = await service.settleRun({
    runId: 'r3',
    outcome: 'VALIDATED',
    repairPhaseConcluded: true,
    failureReason: 'PLANTED',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'VALIDATION_NOT_COMPLETE');
  assert.equal(repo.runs.get('r3').status, 'RUNNING');

  assert.equal(repo.countCalls('settleRun'), 1);
});

test('stored repair counts outside the approved integer window fail closed (policy RN5 tails)', async () => {
  for (const stored of [-1, 4]) {
    const repo = inMemoryRepository();
    seedRunIn(repo, 'r1', 'RUNNING', stored);
    const out = await new AnalysisRunService(repo).recordRepair({
      runId: 'r1',
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'DECISION_FACTS_REQUIRED');
    assert.equal(repo.runs.get('r1').repairCount, stored);
    assert.equal(repo.countCalls('persistRepairCall'), 0);
  }
});

test('enum corruption at the CAS re-read itself is thrown and propagates (service zero-write)', async () => {
  const claimRepo = inMemoryRepository();
  seedRunIn(claimRepo, 'r1', 'QUEUED', 0);
  const claimService = new AnalysisRunService(claimRepo);
  const claimOriginal = claimRepo.claimQueuedRun.bind(claimRepo);
  Object.assign(claimRepo, {
    claimQueuedRun(context) {
      claimRepo.corruptRun(context.runId, { status: 'PAUSED' });
      return claimOriginal(context);
    },
  });
  await assert.rejects(
    () => claimService.claimRun({ runId: 'r1' }),
    /analysis-run-row-mapping-corrupt \(status PAUSED\)/,
  );
  assert.equal(claimRepo.runs.get('r1').repairCount, 0);

  const settleRepo = inMemoryRepository();
  seedRunIn(settleRepo, 'r1', 'RUNNING', 0);
  const settleService = new AnalysisRunService(settleRepo);
  const settleOriginal = settleRepo.settleRun.bind(settleRepo);
  Object.assign(settleRepo, {
    settleRun(req) {
      settleRepo.corruptRun(req.runId, { status: 'PAUSED' });
      return settleOriginal(req);
    },
  });
  await assert.rejects(
    () =>
      settleService.settleRun({
        runId: 'r1',
        outcome: 'VALIDATED',
        schemaValidated: true,
        allEvidenceValid: true,
      }),
    /analysis-run-row-mapping-corrupt \(status PAUSED\)/,
  );
  assert.equal(settleRepo.runs.get('r1').repairCount, 0);
});

test('a stored null repair count on a winning CAS corrupts the post-image BEFORE any mutation (all-or-nothing held)', async () => {
  const claimRepo = inMemoryRepository();
  seedRunIn(claimRepo, 'r1', 'QUEUED', null);
  await assert.rejects(
    () => new AnalysisRunService(claimRepo).claimRun({ runId: 'r1' }),
    /analysis-run-row-mapping-corrupt \(repairCount/,
  );
  assert.equal(claimRepo.runs.get('r1').status, 'QUEUED');

  const settleRepo = inMemoryRepository();
  seedRunIn(settleRepo, 'r1', 'RUNNING', null);
  await assert.rejects(
    () =>
      new AnalysisRunService(settleRepo).settleRun({
        runId: 'r1',
        outcome: 'NEEDS_REVIEW',
        repairPhaseConcluded: true,
      }),
    /analysis-run-row-mapping-corrupt \(repairCount/,
  );
  assert.equal(settleRepo.runs.get('r1').status, 'RUNNING');
});

test('AR-1 foreign worker attempt cannot repair a RUNNING run', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const before = { ...repo.runs.get('r1') };
  const out = await new AnalysisRunService(repo).recordRepair({
    runId: 'r1',
    attemptId: 'different-worker',
  });
  assert.equal(out.ok, false);
  assert.deepEqual(repo.runs.get('r1'), before);
});
test('AR-1 unavailable claim eligibility cannot be fabricated from QUEUED status', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'QUEUED', 0);
  const original = repo.getRunStateFacts.bind(repo);
  repo.getRunStateFacts = (context) => ({
    ...original(context),
    claimEligible: false,
  });
  const out = await new AnalysisRunService(repo).claimRun({
    runId: 'r1',
    attemptId: 'synthetic-worker-a',
  });
  assert.equal(out.ok, false);
  assert.equal(repo.runs.get('r1').status, 'QUEUED');
});
test('AR-1 replaced attempt between facts and repair CAS refuses without a write', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const original = repo.persistRepairCall.bind(repo);
  repo.persistRepairCall = (request) => {
    repo.corruptRun('r1', { attemptId: 'new-worker' });
    return original(request);
  };
  const out = await new AnalysisRunService(repo).recordRepair({
    runId: 'r1',
    attemptId: 'synthetic-worker-a',
  });
  assert.equal(out.ok, false);
  assert.equal(repo.runs.get('r1').repairCount, 0);
});
test('AR-2 new reanalysis persists its own audit and ID-only outbox intent', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'VALIDATED', 0);
  const out = await new AnalysisRunService(repo).requestReanalysis({
    runId: 'r1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.outboxRecorded, true);
  assert.equal(out.auditRecorded, true);
  assert.deepEqual(repo.outbox, [
    { type: 'analysis.requested.v1', payload: { runId: out.run.id } },
  ]);
});
test('AR-2 failed outbox persistence rolls back the new run and audit', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'VALIDATED', 0);
  repo.failOutbox = true;
  const before = [...repo.runs.entries()];
  await assert.rejects(
    () => new AnalysisRunService(repo).requestReanalysis({ runId: 'r1' }),
    /synthetic-outbox-failure/,
  );
  assert.deepEqual([...repo.runs.entries()], before);
  assert.deepEqual(repo.audit, []);
  assert.deepEqual(repo.outbox, []);
});
test('AR-3 FAILED reason reaches the transactional persistence request', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const original = repo.settleRun.bind(repo);
  let seen;
  repo.settleRun = (request) => {
    seen = request;
    return original(request);
  };
  await new AnalysisRunService(repo).settleRun({
    runId: 'r1',
    attemptId: 'synthetic-worker-a',
    outcome: 'FAILED',
    failureReason: 'SYNTHETIC_PROVIDER_TIMEOUT',
  });
  assert.equal(seen.failureReason, 'SYNTHETIC_PROVIDER_TIMEOUT');
  assert.equal(repo.failureReasons.get('r1'), 'SYNTHETIC_PROVIDER_TIMEOUT');
});
test('AR-4 VALIDATED to FAILED drift inside reanalysis CAS does not create another run', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'VALIDATED', 0);
  const original = repo.createReanalysisRun.bind(repo);
  repo.createReanalysisRun = (request) => {
    repo.corruptRun('r1', { status: 'FAILED' });
    return original(request);
  };
  const out = await new AnalysisRunService(repo).requestReanalysis({
    runId: 'r1',
  });
  assert.equal(out.ok, false);
  assert.equal(repo.runs.size, 1);
});

test('AR-1 missing worker attempt is denied before every worker facts read', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const service = new UnboundAnalysisRunService(repo);
  for (const result of [
    await service.claimRun({ runId: 'r1' }),
    await service.recordRepair({ runId: 'r1' }),
    await service.settleRun({
      runId: 'r1',
      outcome: 'FAILED',
      failureReason: 'SYNTHETIC',
    }),
  ])
    assert.deepEqual(result, { ok: false, reason: 'LEASE_REQUIRED' });
  assert.equal(repo.calls.length, 0);
});
test('AR-1 expired attempt cannot repair or settle', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  repo.corruptRun('r1', { leaseValid: false });
  const service = new AnalysisRunService(repo);
  assert.equal((await service.recordRepair({ runId: 'r1' })).ok, false);
  assert.equal(
    (
      await service.settleRun({
        runId: 'r1',
        outcome: 'VALIDATED',
        schemaValidated: true,
        allEvidenceValid: true,
      })
    ).ok,
    false,
  );
  assert.equal(repo.runs.get('r1').status, 'RUNNING');
  assert.equal(repo.runs.get('r1').repairCount, 0);
});
test('AR-1 lease expiry during terminal transaction prevents settlement', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const original = repo.settleRun.bind(repo);
  repo.settleRun = (req) => {
    repo.corruptRun('r1', { leaseValid: false });
    return original(req);
  };
  const out = await new AnalysisRunService(repo).settleRun({
    runId: 'r1',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
  });
  assert.equal(out.ok, false);
  assert.equal(repo.runs.get('r1').status, 'RUNNING');
});
test('AR-1 version change during repair cannot reuse the old facts', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const original = repo.persistRepairCall.bind(repo);
  repo.persistRepairCall = (req) => {
    repo.corruptRun('r1', { version: 1 });
    return original(req);
  };
  assert.equal(
    (await new AnalysisRunService(repo).recordRepair({ runId: 'r1' })).ok,
    false,
  );
  assert.equal(repo.runs.get('r1').repairCount, 0);
});
test('AR-1 direct claim bypass with no attempt cannot acquire a lease', () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'QUEUED', 0);
  assert.throws(
    () => repo.claimQueuedRun({ runId: 'r1', expectedVersion: 0 }),
    /analysis-run-row-mapping-corrupt/,
  );
  assert.equal(repo.runs.get('r1').status, 'QUEUED');
});
test('AR-2 audit failure rolls back new run and outbox', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'VALIDATED', 0);
  repo.failAudit = true;
  const before = [...repo.runs.entries()];
  await assert.rejects(
    () => new AnalysisRunService(repo).requestReanalysis({ runId: 'r1' }),
    /synthetic-audit-failure/,
  );
  assert.deepEqual([...repo.runs.entries()], before);
  assert.deepEqual(repo.outbox, []);
  assert.deepEqual(repo.audit, []);
});
test('AR-3 successful validation never persists an unrelated failure reason', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'RUNNING', 0);
  const original = repo.settleRun.bind(repo);
  let seen;
  repo.settleRun = (req) => {
    seen = req;
    return original(req);
  };
  const out = await new AnalysisRunService(repo).settleRun({
    runId: 'r1',
    outcome: 'VALIDATED',
    schemaValidated: true,
    allEvidenceValid: true,
    failureReason: 'UNRELATED_SYNTHETIC',
  });
  assert.equal(out.ok, true);
  assert.equal(seen.failureReason, undefined);
  assert.equal(repo.failureReasons.size, 0);
});
test('AR-4 exact source version is compared inside reanalysis transaction', async () => {
  const repo = inMemoryRepository();
  repo.seedRun('r1', 'VALIDATED', 0);
  const original = repo.createReanalysisRun.bind(repo);
  repo.createReanalysisRun = (req) => {
    repo.corruptRun('r1', { version: 1 });
    return original(req);
  };
  assert.equal(
    (await new AnalysisRunService(repo).requestReanalysis({ runId: 'r1' })).ok,
    false,
  );
  assert.equal(repo.runs.size, 1);
});
