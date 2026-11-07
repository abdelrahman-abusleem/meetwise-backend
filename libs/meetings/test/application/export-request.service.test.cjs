'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ExportRequestService,
} = require('../../src/application/export-request.service.ts');

function inMemoryRepository(overrides) {
  const now = Date.parse('2026-10-27T00:00:00.000Z');
  const clock = { now: now };
  const meetings = new Map();
  const exportRights = new Map();
  const readRights = new Map();
  const downloadRights = new Map();
  const jobs = new Map();
  const byKey = new Map();
  const sourceItems = new Map();
  const audits = [];
  const calls = [];
  let idCounter = 0;

  function approveKind(kind) {
    if (kind !== 'SUMMARY' && kind !== 'TRANSCRIPT' && kind !== 'ANALYSIS') {
      throw new Error(`export-row-mapping-corrupt (kind ${kind})`);
    }
    return kind;
  }

  function approveFormat(format) {
    if (format !== 'JSON' && format !== 'CSV' && format !== 'PDF') {
      throw new Error(`export-row-mapping-corrupt (format ${format})`);
    }
    return format;
  }

  function approveStatus(status) {
    if (
      status !== 'QUEUED' &&
      status !== 'RUNNING' &&
      status !== 'READY' &&
      status !== 'FAILED' &&
      status !== 'EXPIRED'
    ) {
      throw new Error(`export-row-mapping-corrupt (status ${status})`);
    }
    return status;
  }

  function approveItemStatus(status) {
    if (
      status !== 'PENDING' &&
      status !== 'NEEDS_EDITS' &&
      status !== 'REJECTED' &&
      status !== 'APPROVED'
    ) {
      throw new Error(`export-row-mapping-corrupt (item ${status})`);
    }
    return status;
  }

  function meetingKindFor(meetingId) {
    const kind = meetings.get(meetingId);
    if (kind === undefined) {
      throw new Error(
        'export-creation-context-corrupt (meeting vanished mid-write)',
      );
    }
    if (kind !== 'TECH' && kind !== 'SALES' && kind !== 'GENERAL') {
      throw new Error(`export-row-mapping-corrupt (meeting kind ${kind})`);
    }
    return kind;
  }

  function meetingKindForRead(meetingId) {
    const kind = meetings.get(meetingId);
    if (kind === undefined) {
      return null;
    }
    if (kind !== 'TECH' && kind !== 'SALES' && kind !== 'GENERAL') {
      throw new Error(`export-row-mapping-corrupt (meeting kind ${kind})`);
    }
    return kind;
  }

  function view(row) {
    return Object.freeze({
      id: row.id,
      status: row.status,
      expiresAt: row.expiresAt,
    });
  }

  function rightFor(meetingId, userId) {
    return (exportRights.get(`${meetingId}|${userId}`) ?? false) === true;
  }

  function inTxEnumerationVerdict(row) {
    if (row.kind !== 'ANALYSIS') {
      return 'CLEAR';
    }
    const items = sourceItems.get(row.id);
    if (items === undefined) {
      return 'UNREADABLE';
    }
    for (const item of items) {
      if (approveItemStatus(item.status) === 'REJECTED') {
        return 'REJECTED';
      }
    }
    return 'CLEAR';
  }

  const repo = {
    clock,
    audits,
    calls,
    jobs,

    seedMeeting(meetingId, kind) {
      meetings.set(meetingId, kind);
    },

    dropMeeting(meetingId) {
      meetings.delete(meetingId);
    },
    grantExportRight(meetingId, userId, value) {
      if (value) {
        exportRights.set(`${meetingId}|${userId}`, true);
      } else {
        exportRights.delete(`${meetingId}|${userId}`);
      }
    },
    grantReadPermission(meetingId, userId, value) {
      if (value) {
        readRights.set(`${meetingId}|${userId}`, true);
      } else {
        readRights.delete(`${meetingId}|${userId}`);
      }
    },
    grantDownloadPermission(meetingId, userId, value) {
      if (value) {
        downloadRights.set(`${meetingId}|${userId}`, true);
      } else {
        downloadRights.delete(`${meetingId}|${userId}`);
      }
    },

    seedCorruptRow(meetingId, requesterId, kind) {
      const id = `exp_corrupt_${++idCounter}`;
      jobs.set(id, {
        id,
        meetingId,
        requesterId,
        kind,
        format: 'PDF',
        status: 'QUEUED',
        expiresAt: null,
        idempotencyKey: `corrupt-${id}`,
      });
      byKey.set(`${meetingId}|${requesterId}|corrupt-${id}`, id);
      return id;
    },

    createExportJob(req) {
      calls.push({ op: 'createExportJob' });
      approveKind(req.kind);
      approveFormat(req.format);
      if (!meetings.has(req.meetingId)) {
        throw new Error('export-creation-context-corrupt');
      }
      const meetingKind = meetingKindFor(req.meetingId);

      if (meetingKind === 'GENERAL') {
        return {
          created: false,
          refusal: 'GENERAL_TARGET_REFUSED',
          job: null,
        };
      }

      if (rightFor(req.meetingId, req.requesterId) !== true) {
        return { created: false, refusal: 'EXPORTER_RACE_LOST', job: null };
      }
      const key = `${req.meetingId}|${req.requesterId}|${req.idempotencyKey}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        const row = jobs.get(existing);

        approveKind(row.kind);
        approveFormat(row.format);
        approveStatus(row.status);
        if (row.kind !== req.kind || row.format !== req.format) {
          return {
            created: false,
            refusal: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            job: null,
          };
        }

        return { created: false, job: view(row) };
      }
      const id = `exp_${++idCounter}`;
      const row = {
        id,
        meetingId: req.meetingId,
        requesterId: req.requesterId,
        kind: req.kind,
        format: req.format,
        status: 'QUEUED',

        expiresAt: null,
        idempotencyKey: req.idempotencyKey,
      };
      jobs.set(id, row);
      byKey.set(key, id);
      return { created: true, job: view(row) };
    },

    getExportRequestFacts(context) {
      calls.push({ op: 'getExportRequestFacts' });
      const exists = meetings.has(context.meetingId);
      return {
        meetingExists: exists,
        meetingKind: exists ? meetings.get(context.meetingId) : '',
        exporterAuthorized: rightFor(context.meetingId, context.requesterId),
      };
    },

    getWorkerFacts(context) {
      calls.push({ op: 'getWorkerFacts' });
      const row = jobs.get(context.exportId);
      if (row === undefined) {
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
      const kind = approveKind(row.kind);
      const format = approveFormat(row.format);
      approveStatus(row.status);
      const meetingKind = meetingKindForRead(row.meetingId);
      const items = sourceItems.get(row.id) ?? null;
      return {
        exportExists: true,
        kind,
        format,
        meetingId: row.meetingId,
        meetingExists: meetingKind !== null,
        meetingKind,
        exporterAuthorized: rightFor(row.meetingId, row.requesterId),
        idempotencyKey:
          (row.idempotencyKey ?? null) === null ? null : row.idempotencyKey,
        sourceItems: items,
      };
    },

    claimExportForProcessing(context) {
      calls.push({ op: 'claimExportForProcessing' });
      const row = jobs.get(context.exportId);
      if (row === undefined) {
        throw new Error('export-row-mapping-corrupt (claim of a missing row)');
      }
      approveKind(row.kind);
      approveStatus(row.status);

      if (meetingKindFor(row.meetingId) === 'GENERAL') {
        return {
          claimed: false,
          refusal: 'GENERAL_TARGET_REFUSED',
          currentStatus: row.status,
        };
      }
      if (row.status !== 'QUEUED') {
        return {
          claimed: false,
          refusal: 'NOT_QUEUED',
          currentStatus: row.status,
        };
      }
      const enumVerdict = inTxEnumerationVerdict(row);
      if (enumVerdict === 'UNREADABLE') {
        return {
          claimed: false,
          refusal: 'SOURCE_ENUMERATION_UNREADABLE',
          currentStatus: row.status,
        };
      }
      if (enumVerdict === 'REJECTED') {
        return {
          claimed: false,
          refusal: 'ITEM_REJECTED',
          currentStatus: row.status,
        };
      }

      if (rightFor(row.meetingId, row.requesterId) !== true) {
        return {
          claimed: false,
          refusal: 'EXPORTER_RACE_LOST',
          currentStatus: row.status,
        };
      }
      row.status = 'RUNNING';
      return {
        claimed: true,
        refusal: null,
        currentStatus: 'RUNNING',
      };
    },

    reportExportCompletion(request) {
      calls.push({ op: 'reportExportCompletion' });
      const row = jobs.get(request.exportId);
      if (row === undefined) {
        return null;
      }
      approveKind(row.kind);
      approveStatus(row.status);
      if (meetingKindFor(row.meetingId) === 'GENERAL') {
        return {
          reported: false,
          refusal: 'GENERAL_TARGET_REFUSED',
        };
      }
      if (row.status !== 'RUNNING') {
        return null;
      }
      if (request.outcome === 'SUCCEEDED') {
        const enumVerdict = inTxEnumerationVerdict(row);
        if (enumVerdict === 'UNREADABLE') {
          return { reported: false, refusal: 'SOURCE_ENUMERATION_UNREADABLE' };
        }
        if (enumVerdict === 'REJECTED') {
          return { reported: false, refusal: 'ITEM_REJECTED' };
        }
        if (rightFor(row.meetingId, row.requesterId) !== true) {
          return { reported: false, refusal: 'EXPORTER_RACE_LOST' };
        }
        row.status = 'READY';

        row.expiresAt = new Date(clock.now + 24 * 3600 * 1000).toISOString();
      } else {
        row.status = 'FAILED';
      }
      return { reported: true, job: view(row) };
    },

    getReadAccessFacts(context) {
      calls.push({ op: 'getReadAccessFacts' });
      const row = jobs.get(context.exportId);
      if (row === undefined) {
        return {
          exportExists: false,
          meetingExists: false,
          requesterIsCreator: false,
          readPermission: false,
          status: null,
          expiresAt: null,
        };
      }
      approveKind(row.kind);
      approveStatus(row.status);
      return {
        exportExists: true,
        meetingExists: meetings.has(row.meetingId),
        requesterIsCreator: row.requesterId === context.requesterId,
        readPermission:
          readRights.get(`${row.meetingId}|${context.requesterId}`) === true,
        status: row.status,
        expiresAt: row.expiresAt,
      };
    },

    getDownloadAccessFacts(context) {
      calls.push({ op: 'getDownloadAccessFacts' });
      const row = jobs.get(context.exportId);
      if (row === undefined) {
        return {
          exportExists: false,
          meetingExists: false,
          requesterIsCreator: false,
          downloadPermission: false,
          kind: null,
          format: null,
          status: null,
          expiresAt: null,
          isExpired: false,
          meetingKind: null,
        };
      }
      const kind = approveKind(row.kind);
      const format = approveFormat(row.format);
      approveStatus(row.status);

      const parsed = row.expiresAt === null ? NaN : Date.parse(row.expiresAt);
      const isExpired = !Number.isFinite(parsed) ? true : clock.now > parsed;
      return {
        exportExists: true,
        meetingExists: meetingKindForRead(row.meetingId) !== null,
        requesterIsCreator: row.requesterId === context.requesterId,
        downloadPermission:
          downloadRights.get(`${row.meetingId}|${context.requesterId}`) ===
          true,
        kind,
        format,
        status: row.status,
        expiresAt: row.expiresAt,
        isExpired,
        meetingKind: meetingKindForRead(row.meetingId),
      };
    },

    recordDownloadAudit(context) {
      calls.push({ op: 'recordDownloadAudit' });
      const row = jobs.get(context.exportId);
      if (row === undefined) {
        throw new Error(
          'export-row-mapping-corrupt (audit of a missing export)',
        );
      }
      approveStatus(row.status);
      if (meetingKindFor(row.meetingId) === 'GENERAL') {
        throw new Error('export-row-mapping-corrupt (GENERAL audit target)');
      }

      audits.push({
        exportId: context.exportId,
        meetingId: row.meetingId,
        requesterId: context.requesterId,
      });
      return undefined;
    },

    seedSourceItems(exportId, items) {
      for (const item of items) {
        approveItemStatus(item.status);
      }
      sourceItems.set(exportId, Object.freeze([...items]));
    },

    seedSourceItemsUnsafe(exportId, items) {
      sourceItems.set(exportId, Object.freeze([...items]));
    },

    dropSourceItems(exportId) {
      sourceItems.delete(exportId);
    },
    countCalls(op) {
      return calls.filter((c) => c.op === op).length;
    },
  };
  return Object.assign(repo, overrides ?? {});
}

function seedTechMeeting(repo, meetingId, requesterId) {
  repo.seedMeeting(meetingId, 'TECH');
  repo.grantExportRight(meetingId, requesterId, true);
}

const baseRequest = (meetingId, requesterId) => ({
  meetingId,
  requesterId,
  kind: 'TRANSCRIPT',
  format: 'JSON',
  idempotencyKey: 'retry-safe-1',
});

test('requestExport queues an authorized TECH meeting export (created job, QUEUED status)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const out = await service.requestExport(baseRequest('m1', 'u1'));
  assert.equal(out.ok, true);
  assert.equal(out.k, 'QUEUED');
  assert.deepEqual(
    { id: out.job.id, status: out.job.status, expiresAt: out.job.expiresAt },
    { id: out.job.id, status: 'QUEUED', expiresAt: null },
  );
  assert.equal(out.kind, 'TRANSCRIPT');
  assert.equal(out.format, 'JSON');
  assert.equal(out.jobCreationIsServerDuty, true);
  assert.equal(out.auditExportDecision, true);

  assert.equal(out.job.expiresAt, null);
  assert.equal(Object.isFrozen(out.job), true);
});

test('requestExport same-key retry returns EXISTING with the CURRENT row status (no fabricated duplicate)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const first = await service.requestExport(baseRequest('m1', 'u1'));
  assert.equal(first.ok, true);
  assert.equal(first.k, 'QUEUED');

  const jobId = first.job.id;
  await service.claimForProcessing({ exportId: jobId });
  const retry = await service.requestExport(baseRequest('m1', 'u1'));
  assert.equal(retry.ok, true);
  assert.equal(retry.k, 'EXISTING');
  assert.equal(retry.job.id, jobId);
  assert.equal(retry.job.status, 'RUNNING');
  assert.equal(repo.countCalls('createExportJob'), 2);
});

test('requestExport different keys on the same meeting create independent jobs (no invented one-per-meeting rule)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const a = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    idempotencyKey: 'key-a',
  });
  const b = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    idempotencyKey: 'key-b',
  });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.job.id, b.job.id);
});

test('requestExport on a GENERAL meeting hard-rejects BEFORE any storage effect', async () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('g1', 'GENERAL');
  repo.grantExportRight('g1', 'u1', true);
  const service = new ExportRequestService(repo);
  const out = await service.requestExport(baseRequest('g1', 'u1'));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'GENERAL_EXPORT_REJECTED');
  assert.equal(repo.countCalls('createExportJob'), 0);
});

test('requestExport object-level authorization is repository-computed; a planted caller boolean cannot flip it', async () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('m1', 'TECH');
  const service = new ExportRequestService(repo);
  const forged = {
    ...baseRequest('m1', 'u1'),
    exporterAuthorized: true,
    command: 'WORKER_EXPORT_GATE',
    surface: 'DOWNLOAD',
    sourceItems: [{ id: 'x', status: 'REJECTED' }],
    meetingKind: 'TECH',
  };
  const out = await service.requestExport(forged);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORTER_NOT_AUTHORIZED');
  assert.equal(repo.countCalls('createExportJob'), 0);
});

test('requestExport unknown meeting kind facts fail closed without a create', async () => {
  const repo = inMemoryRepository();

  repo.seedMeeting('x1', 'TECH');
  repo.grantExportRight('x1', 'u1', true);
  const poisoned = Object.assign(repo, {
    getExportRequestFacts() {
      return {
        meetingExists: true,
        meetingKind: 'HYBRID',
        exporterAuthorized: true,
      };
    },
  });
  const service = new ExportRequestService(poisoned);
  const out = await service.requestExport(baseRequest('x1', 'u1'));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DECISION_FACTS_REQUIRED');
  assert.equal(poisoned.countCalls('createExportJob'), 0);
});

test('requestExport missing meeting rows fail closed (MEETING_NOT_FOUND, zero storage writes)', async () => {
  const service = new ExportRequestService(inMemoryRepository());
  const out = await service.requestExport(baseRequest('missing', 'u1'));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'MEETING_NOT_FOUND');
});

test('requestExport invalid contract kind (not SUMMARY/TRANSCRIPT/ANALYSIS) fails before any facts read', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const out = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'RAW_TRANSCRIPT',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'INVALID_EXPORT_KIND');
  assert.equal(repo.countCalls('getExportRequestFacts'), 0);
  assert.equal(repo.countCalls('createExportJob'), 0);
});

test('requestExport contract format enum enforced: only JSON/CSV/PDF are approved', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const out = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    format: 'XLSX',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'INVALID_EXPORT_FORMAT');
  assert.equal(repo.countCalls('getExportRequestFacts'), 0);
  assert.equal(repo.countCalls('createExportJob'), 0);
});

test('requestExport Idempotency-Key bounds (contract header 1..128) carry their own mechanical reason', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const oversized = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    idempotencyKey: 'x'.repeat(129),
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reason, 'IDEMPOTENCY_KEY_MALFORMED');
  assert.equal(repo.countCalls('getExportRequestFacts'), 0);
  const blank = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    idempotencyKey: '   ',
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.reason, 'EXPORT_FACTS_REQUIRED');
});

test('requestExport same key with a DIFFERENT payload is a frozen data conflict on the original row', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const first = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    format: 'JSON',
    idempotencyKey: 'same-key',
  });
  assert.equal(first.ok, true);
  const second = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    format: 'PDF',
    idempotencyKey: 'same-key',
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'IDEMPOTENCY_KEY_CONFLICT');

  assert.equal(repo.jobs.size, 1);
  assert.equal(repo.jobs.get(first.job.id).format, 'JSON');
});

test('requestExport write-time right loss (mid-race) is a frozen failure, not an exception', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const originalCreate = repo.createExportJob.bind(repo);
  repo.createExportJob = (req) => {
    repo.grantExportRight(req.meetingId, req.requesterId, false);
    return originalCreate(req);
  };
  return service.requestExport(baseRequest('m1', 'u1')).then((out) => {
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'EXPORTER_NOT_AUTHORIZED');
    assert.equal(repo.jobs.size, 0);
  });
});

test('requestExport corrupt create context (meeting vanished mid-write) propagates the contract defect', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);

  const originalCreate = repo.createExportJob.bind(repo);
  repo.createExportJob = (req) => {
    repo.dropMeeting(req.meetingId);
    return originalCreate(req);
  };
  const query = { ...baseRequest('m1', 'u1'), idempotencyKey: 'ghost-tx' };
  await assert.rejects(
    () => service.requestExport(query),
    /export-creation-context-corrupt/,
  );
});

test('requestExport parallel same-key creates serialize through the idempotency boundary (retry safety)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const outcomes = await Promise.all([
    service.requestExport(baseRequest('m1', 'u1')),
    service.requestExport(baseRequest('m1', 'u1')),
  ]);
  const ids = new Set(outcomes.map((o) => (o.ok ? o.job.id : 'rejected')));
  assert.equal(ids.size, 1);
  assert.equal(
    outcomes.some((o) => o.ok && o.k === 'QUEUED'),
    true,
  );
  assert.equal(
    outcomes.some((o) => o.ok && o.k === 'EXISTING'),
    true,
  );
  assert.equal(repo.jobs.size, 1);
});

test('requestExport frozen result shapes on both branches', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const ok = await service.requestExport(baseRequest('m1', 'u1'));
  assert.equal(Object.isFrozen(ok), true);
  assert.equal(Object.isFrozen(ok.job), true);
  repo.grantExportRight('m1', 'u1', false);
  const denied = await service.requestExport(baseRequest('m1', 'u1'));
  assert.equal(denied.ok, false);
  assert.equal(Object.isFrozen(denied), true);
});

test('storage boundary chain: malformed/null/packet-shaped garbage queries fail closed', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  for (const badQuery of [
    null,
    undefined,
    42,
    'request',
    { meetingId: 'm1', requesterId: 'u1', kind: 'TRANSCRIPT' },
    {
      meetingId: '',
      requesterId: 'u1',
      kind: 'TRANSCRIPT',
      format: 'JSON',
      idempotencyKey: 'k',
    },
  ]) {
    const out = await service.requestExport(badQuery);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'EXPORT_FACTS_REQUIRED');
    assert.equal(repo.countCalls('getExportRequestFacts'), 0);
  }
  const worker = new ExportRequestService(inMemoryRepository());
  for (const badWorkerQuery of [null, 7, { exportId: '   ' }]) {
    const out = await worker.workerGate(badWorkerQuery);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'EXPORT_FACTS_REQUIRED');
  }
});

test('workerGate passes a SUMMARY export with fresh facts (worker supplies no authorization)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'SUMMARY',
  });
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'GATE_PASSED');
  assert.equal(out.meetingId, 'm1');
  assert.equal(out.kind, 'SUMMARY');
  assert.equal(out.format, 'JSON');
});

test('workerGate ANALYSIS with an approved enumeration passes', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'ANALYSIS',
  });
  repo.seedSourceItems(created.job.id, [
    { id: 'i1', status: 'APPROVED' },
    { id: 'i2', status: 'NEEDS_EDITS' },
  ]);
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'GATE_PASSED');
  assert.equal(out.kind, 'ANALYSIS');
});

test('workerGate ANALYSIS with a REJECTED source item cannot pass (01 line 72)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'ANALYSIS',
  });
  repo.seedSourceItems(created.job.id, [
    { id: 'i1', status: 'APPROVED' },
    { id: 'i2', status: 'REJECTED' },
  ]);
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'REJECTED_ITEM_NOT_EXPORTABLE');
});

test('workerGate ANALYSIS without the source enumeration fails closed (SOURCE_ITEMS_REQUIRED)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'ANALYSIS',
  });

  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'SOURCE_ITEMS_REQUIRED');
});

test('workerGate ANALYSIS enumeration with unknown item status fails closed', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'ANALYSIS',
  });
  repo.seedSourceItemsUnsafe(created.job.id, [
    { id: 'i1', status: 'ARCHIVED' },
  ]);
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'UNKNOWN_ITEM_STATUS');
});

test('workerGate verifies the PERSISTED key: a corrupt row without one is refused (not inferred)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  repo.jobs.get(created.job.id).idempotencyKey = null;
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('workerGate GENERAL-bound artifact is rejected at the worker decision boundary', async () => {
  const repo = inMemoryRepository();

  repo.seedMeeting('g1', 'GENERAL');
  repo.grantExportRight('g1', 'u1', true);
  const id = repo.seedCorruptRow('g1', 'u1', 'SUMMARY');
  const service = new ExportRequestService(repo);
  const out = await service.workerGate({ exportId: id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'GENERAL_EXPORT_REJECTED');
});

test('workerGate TM-06: a creator whose right was revoked after request time can no longer gate', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  repo.grantExportRight('m1', 'u1', false);
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORTER_NOT_AUTHORIZED');
});

test('workerGate for a missing export row fails closed (EXPORT_NOT_FOUND)', async () => {
  const service = new ExportRequestService(inMemoryRepository());
  const out = await service.workerGate({ exportId: 'nope' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_FOUND');
});

test('workerGate export whose source meeting vanished fails closed (MEETING_NOT_FOUND)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));

  repo.dropMeeting('m1');
  const out = await service.workerGate({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'MEETING_NOT_FOUND');
});

test('claimForProcessing claims a QUEUED export exactly once (running state begins)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  const out = await service.claimForProcessing({ exportId: created.job.id });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'CLAIMED');
  assert.equal(out.meetingId, 'm1');
  assert.equal(out.kind, 'TRANSCRIPT');
  assert.equal(out.format, 'JSON');
  assert.equal(repo.jobs.get(created.job.id).status, 'RUNNING');
});

test('claimForProcessing loses the CAS race without a second mutation (still RUNNING, one claim)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  const first = await service.claimForProcessing({ exportId: created.job.id });
  assert.equal(first.ok, true);
  const second = await service.claimForProcessing({ exportId: created.job.id });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'EXPORT_STATUS_CONFLICT');
  assert.equal(repo.jobs.get(created.job.id).status, 'RUNNING');
  assert.equal(repo.countCalls('claimExportForProcessing'), 2);
});

test('claimForProcessing REVALIDATES the worker gate first: REJECTED analysis content can never be claimed', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'ANALYSIS',
  });
  repo.seedSourceItems(created.job.id, [{ id: 'i1', status: 'REJECTED' }]);
  const out = await service.claimForProcessing({ exportId: created.job.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'REJECTED_ITEM_NOT_EXPORTABLE');
  assert.equal(repo.countCalls('claimExportForProcessing'), 0);
  assert.equal(repo.jobs.get(created.job.id).status, 'QUEUED');
});

test('claimForProcessing in-tx item ban: an item rejected between the fresh read and the CAS blocks the claim', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'ANALYSIS',
    format: 'PDF',
    idempotencyKey: 'claim-ban-race',
  }).job;
  repo.seedSourceItems(created.id, [{ id: 'i1', status: 'APPROVED' }]);
  const originalClaim = repo.claimExportForProcessing.bind(repo);
  repo.claimExportForProcessing = (context) => {
    repo.seedSourceItems(context.exportId, [{ id: 'i1', status: 'REJECTED' }]);
    return originalClaim(context);
  };
  return service.claimForProcessing({ exportId: created.id }).then((out) => {
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'REJECTED_ITEM_NOT_EXPORTABLE');

    assert.equal(repo.jobs.get(created.id).status, 'QUEUED');
  });
});

test('claimForProcessing in-tx enumeration duty: a vanishing ANALYSIS enumeration fails the claim closed', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'ANALYSIS',
    format: 'JSON',
    idempotencyKey: 'enum-duty-claim',
  }).job;
  repo.seedSourceItems(created.id, [{ id: 'i1', status: 'APPROVED' }]);

  const originalClaim = repo.claimExportForProcessing.bind(repo);
  repo.claimExportForProcessing = (context) => {
    repo.dropSourceItems(context.exportId);
    return originalClaim(context);
  };
  const out = await service.claimForProcessing({ exportId: created.id });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_FACTS_REQUIRED');
  assert.equal(repo.jobs.get(created.id).status, 'QUEUED');
});

test('claimForProcessing write-time right loss keeps the row QUEUED with zero mutation (TM-06 mid-race)', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const original = repo.claimExportForProcessing.bind(repo);
  repo.claimExportForProcessing = (context) => {
    repo.grantExportRight('m1', 'u1', false);
    return original(context);
  };
  const created = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'SUMMARY',
    format: 'PDF',
    idempotencyKey: 'claim-race',
  }).job;
  return service.claimForProcessing({ exportId: created.id }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'EXPORTER_NOT_AUTHORIZED');
    assert.equal(repo.jobs.get(created.id).status, 'QUEUED');
    assert.equal(repo.jobs.get(created.id).requesterId, 'u1');
  });
});

test('claimForProcessing parallel race: exactly one claimant proceeds', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  const outcomes = await Promise.all([
    service.claimForProcessing({ exportId: created.job.id }),
    service.claimForProcessing({ exportId: created.job.id }),
  ]);
  const claimants = outcomes.filter((o) => o.ok === true);
  const losers = outcomes.filter((o) => o.ok === false);
  assert.equal(claimants.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, 'EXPORT_STATUS_CONFLICT');
  assert.equal(repo.jobs.get(created.job.id).status, 'RUNNING');
});

test('claimForProcessing of a READY job fails closed (CAS loser, zero mutation)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  const late = await service.claimForProcessing({ exportId: created.job.id });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'EXPORT_STATUS_CONFLICT');
  assert.equal(repo.jobs.get(created.job.id).status, 'READY');
});

test('claimForProcessing of a missing row fails at the fresh-read gate (EXPORT_NOT_FOUND)', async () => {
  const service = new ExportRequestService(inMemoryRepository());
  const out = await service.claimForProcessing({ exportId: 'ghost-claim' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_FOUND');
});

test('reportCompletion RUNNING → READY re-freezes the repository-issued view (ready state becomes the record)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'READY');
  assert.equal(out.job.id, created.job.id);
  assert.equal(out.job.status, 'READY');

  assert.equal(
    out.job.expiresAt,
    new Date(repo.clock.now + 24 * 3600 * 1000).toISOString(),
  );
  assert.equal(Object.isFrozen(out.job), true);
});

test('reportCompletion RUNNING → FAILED preserves the approved FAILED terminal state (plain CAS, no content gate)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });

  repo.grantExportRight('m1', 'u1', false);
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'FAILED',
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'FAILED');
  assert.equal(out.job.status, 'FAILED');
});

test('reportCompletion SUCCEEDED re-runs the worker gate fresh: right revoked after the claim blocks READY', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  repo.grantExportRight('m1', 'u1', false);
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORTER_NOT_AUTHORIZED');

  assert.equal(repo.jobs.get(created.job.id).status, 'RUNNING');
  assert.equal(repo.countCalls('reportExportCompletion'), 0);
});

test('reportCompletion SUCCEEDED re-runs the worker gate fresh: a REJECTED item blocks READY', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    kind: 'ANALYSIS',
  });
  repo.seedSourceItems(created.job.id, [{ id: 'i1', status: 'APPROVED' }]);
  await service.claimForProcessing({ exportId: created.job.id });
  repo.seedSourceItems(created.job.id, [{ id: 'i1', status: 'REJECTED' }]);
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'REJECTED_ITEM_NOT_EXPORTABLE');
  assert.equal(repo.jobs.get(created.job.id).status, 'RUNNING');
  assert.equal(repo.countCalls('reportExportCompletion'), 0);
});

test('reportCompletion in-tx race: an item rejected between the fresh gate and the CAS cannot flip READY', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'ANALYSIS',
    format: 'JSON',
    idempotencyKey: 'report-ban-race',
  }).job;
  repo.seedSourceItems(created.id, [{ id: 'i1', status: 'APPROVED' }]);

  return service
    .claimForProcessing({ exportId: created.id })
    .then((claim) => {
      assert.equal(claim.ok, true);
      const originalReport = repo.reportExportCompletion.bind(repo);
      repo.reportExportCompletion = (req) => {
        repo.seedSourceItems(req.exportId, [{ id: 'i1', status: 'REJECTED' }]);
        return originalReport(req);
      };
      return service
        .reportCompletion({
          exportId: created.id,
          outcome: 'SUCCEEDED',
        })
        .then((out) => {
          assert.equal(out.ok, false);
          assert.equal(out.reason, 'REJECTED_ITEM_NOT_EXPORTABLE');

          assert.equal(repo.jobs.get(created.id).status, 'RUNNING');
          assert.equal(repo.jobs.get(created.id).expiresAt, null);
        });
    })
    .then(() => {
      repo.grantDownloadPermission('m1', 'u1', true);
      return service.authorizeDownload({
        exportId: created.id,
        requesterId: 'u1',
      });
    })
    .then((download) => {
      assert.equal(download.ok, false);
      assert.equal(download.reason, 'EXPORT_NOT_DOWNLOADABLE');
      assert.equal(download.notDownloadable, 'STATUS_NOT_READY');
    });
});

test('reportCompletion in-tx race: right revoked between the fresh gate and the CAS blocks READY', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'SUMMARY',
    format: 'JSON',
    idempotencyKey: 'report-right-race',
  }).job;
  return service.claimForProcessing({ exportId: created.id }).then((claim) => {
    assert.equal(claim.ok, true);
    const originalReport = repo.reportExportCompletion.bind(repo);
    repo.reportExportCompletion = (req) => {
      repo.grantExportRight('m1', 'u1', false);
      return originalReport(req);
    };
    return service
      .reportCompletion({
        exportId: created.id,
        outcome: 'SUCCEEDED',
      })
      .then((out) => {
        assert.equal(out.ok, false);
        assert.equal(out.reason, 'EXPORTER_NOT_AUTHORIZED');
        assert.equal(repo.jobs.get(created.id).status, 'RUNNING');
      });
  });
});

test('reportCompletion double report loses the CAS with zero mutation (row stays READY)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'FAILED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_STATUS_CONFLICT');
  assert.equal(repo.jobs.get(created.job.id).status, 'READY');
});

test('reportCompletion of a never-claimed QUEUED row fails closed (no fabrication)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_STATUS_CONFLICT');
  assert.equal(repo.jobs.get(created.job.id).status, 'QUEUED');
});

test('reportCompletion outcome vocabulary is strictly SUCCEEDED/FAILED (no invented states)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'ABORTED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_FACTS_REQUIRED');
  assert.equal(repo.jobs.get(created.job.id).status, 'RUNNING');
});

test('reportCompletion SUCCEEDED of a vanished export re-gates first and fails closed (EXPORT_NOT_FOUND)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  repo.jobs.delete(created.job.id);

  const out = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_FOUND');

  assert.equal(repo.audits.length, 0);
});

test('reportCompletion SUCCEEDED in-tx enumeration duty: a vanishing enumeration blocks READY (fails closed)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'ANALYSIS',
    format: 'JSON',
    idempotencyKey: 'enum-duty-report',
  }).job;
  repo.seedSourceItems(created.id, [{ id: 'i1', status: 'APPROVED' }]);
  await service.claimForProcessing({ exportId: created.id });
  const originalReport = repo.reportExportCompletion.bind(repo);
  repo.reportExportCompletion = (req) => {
    repo.dropSourceItems(req.exportId);
    return originalReport(req);
  };
  const out = await service.reportCompletion({
    exportId: created.id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_FACTS_REQUIRED');
  assert.equal(repo.jobs.get(created.id).status, 'RUNNING');
  assert.equal(repo.jobs.get(created.id).expiresAt, null);
});

test('readExportMetadata creator with continuing permission sees status + expiry and NO url', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  repo.grantReadPermission('m1', 'u1', true);
  const out = await service.readExportMetadata({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'METADATA');
  assert.equal(out.job.id, created.job.id);
  assert.equal(out.job.status, 'QUEUED');
  assert.equal(out.job.expiresAt, null);
  assert.equal(Object.isFrozen(out.job), true);
  assert.equal('url' in out.job, false);
  assert.equal('downloadUrl' in out, false);
});

test('readExportMetadata non-creator WITH permission is denied (creator AND permission, 04 row 118 literal)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  repo.grantReadPermission('m1', 'u2', true);
  const out = await service.readExportMetadata({
    exportId: created.job.id,
    requesterId: 'u2',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_ACCESSIBLE');
});

test('readExportMetadata creator whose continuing permission was revoked is denied', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  repo.grantReadPermission('m1', 'u1', true);
  repo.grantReadPermission('m1', 'u1', false);
  const out = await service.readExportMetadata({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_ACCESSIBLE');
});

test('readExportMetadata nonexistent export denies with the SAME label (anti-enumeration)', async () => {
  const service = new ExportRequestService(inMemoryRepository());
  const out = await service.readExportMetadata({
    exportId: 'ghost',
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_ACCESSIBLE');
});

test('readExportMetadata with an unrepresentable status defect throws the storage defect (no fabrication)', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  repo.grantReadPermission('m1', 'u1', true);
  const id = repo.seedCorruptRow('m1', 'u1', 'SUMMARY');

  repo.jobs.get(id).status = 'PENDING_INSTANCE';
  const service = new ExportRequestService(repo);
  return service.readExportMetadata({ exportId: id, requesterId: 'u1' }).then(
    () => {
      throw new Error('expected a repository defect');
    },
    (defect) => {
      assert.equal(
        String(defect.message).startsWith('export-row-mapping-corrupt'),
        true,
      );
    },
  );
});

async function readyExportFor(repo) {
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  const reported = await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'SUCCEEDED',
  });
  repo.grantReadPermission('m1', 'u1', true);
  repo.grantDownloadPermission('m1', 'u1', true);
  return { service, created, reported };
}

test('authorizeDownload of a READY export by its authorized creator records the download audit without content', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, true);
  assert.equal(out.k, 'DELIVERY_AUTHORIZED');
  assert.equal(out.job.id, created.job.id);
  assert.equal(out.job.status, 'READY');
  assert.equal(out.kind, 'TRANSCRIPT');
  assert.equal(out.format, 'JSON');
  assert.equal(out.deliveryIsServerDuty, true);
  assert.equal(out.auditRecorded, true);
  assert.equal(Object.isFrozen(out.job), true);
  assert.deepEqual(repo.audits, [
    {
      exportId: created.job.id,
      meetingId: 'm1',
      requesterId: 'u1',
    },
  ]);
});

test('final download-audit authority loss propagates without successful authorization', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  repo.recordDownloadAudit = async () => {
    repo.grantDownloadPermission('m1', 'u1', false);
    throw new Error('synthetic-current-authority-denied');
  };
  await assert.rejects(
    service.authorizeDownload({ exportId: created.job.id, requesterId: 'u1' }),
    /synthetic-current-authority-denied/,
  );
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload QUEUED export is not downloadable (requested state separation)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  repo.grantDownloadPermission('m1', 'u1', true);
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(out.notDownloadable, 'STATUS_NOT_READY');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload RUNNING export is not downloadable (processing state separation)', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  repo.grantDownloadPermission('m1', 'u1', true);
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(out.notDownloadable, 'STATUS_NOT_READY');
});

test('authorizeDownload FAILED export is not downloadable', async () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  const service = new ExportRequestService(repo);
  const created = await service.requestExport(baseRequest('m1', 'u1'));
  await service.claimForProcessing({ exportId: created.job.id });
  await service.reportCompletion({
    exportId: created.job.id,
    outcome: 'FAILED',
  });
  repo.grantDownloadPermission('m1', 'u1', true);
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload EXPIRED-status export reports its own EXPIRED verdict', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);

  repo.jobs.get(created.job.id).status = 'EXPIRED';
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(out.notDownloadable, 'EXPIRED');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload of a READY-but-past-expiry record uses the adapter clock verdict', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  repo.clock.now = repo.clock.now + 48 * 3600 * 1000;
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(out.notDownloadable, 'EXPIRED');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload READY row with a MISSING expiry datum is denied (fail-closed adapter duty)', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);

  repo.jobs.get(created.job.id).expiresAt = null;
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(out.notDownloadable, 'EXPIRED');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload READY row with an UNPARSEABLE expiry datum is denied (fail-closed)', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  repo.jobs.get(created.job.id).expiresAt = 'not-a-timestamp';
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'EXPORT_NOT_DOWNLOADABLE');
  assert.equal(out.notDownloadable, 'EXPIRED');
});

test('authorizeDownload non-creator WITH live permission is denied (creator AND permission)', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  repo.grantDownloadPermission('m1', 'u2', true);
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u2',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DOWNLOAD_NOT_AUTHORIZED');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload creator whose LIVE permission was revoked mid-flight is denied (TM-06 stale download)', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  repo.grantDownloadPermission('m1', 'u1', false);
  const out = await service.authorizeDownload({
    exportId: created.job.id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DOWNLOAD_NOT_AUTHORIZED');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload nonexistent export denies identically (anti-enumeration)', async () => {
  const service = new ExportRequestService(inMemoryRepository());
  const out = await service.authorizeDownload({
    exportId: 'ghost',
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DOWNLOAD_NOT_AUTHORIZED');
});

test('authorizeDownload GENERAL-bound corrupt artifact: creator is still rejected at the download boundary', async () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('g1', 'GENERAL');
  repo.grantExportRight('g1', 'u1', true);
  repo.grantDownloadPermission('g1', 'u1', true);
  repo.grantReadPermission('g1', 'u1', true);
  const id = repo.seedCorruptRow('g1', 'u1', 'SUMMARY');
  const service = new ExportRequestService(repo);
  const out = await service.authorizeDownload({
    exportId: id,
    requesterId: 'u1',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'GENERAL_EXPORT_REJECTED');
  assert.equal(repo.audits.length, 0);
});

test('authorizeDownload of a corrupt status artifact throws the storage defect (never silently allowed)', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  repo.grantDownloadPermission('m1', 'u1', true);
  repo.grantReadPermission('m1', 'u1', true);
  const id = repo.seedCorruptRow('m1', 'u1', 'SUMMARY');
  repo.jobs.get(id).status = 'PENDING_INSTANCE';
  const service = new ExportRequestService(repo);
  return service.authorizeDownload({ exportId: id, requesterId: 'u1' }).then(
    () => {
      throw new Error('expected a repository defect');
    },
    (defect) => {
      assert.equal(
        String(defect.message).startsWith('export-row-mapping-corrupt'),
        true,
      );
    },
  );
});

test('authorizeDownload audit failure propagates and records NO authority result', async () => {
  const repo = inMemoryRepository();
  const { service, created } = await readyExportFor(repo);
  repo.recordDownloadAudit = () => {
    throw new Error('export-audit-channel-failed');
  };
  await assert.rejects(
    () =>
      service.authorizeDownload({
        exportId: created.job.id,
        requesterId: 'u1',
      }),
    /export-audit-channel-failed/,
  );

  assert.equal(repo.audits.length, 0);
});

test('storage boundary: creating an export for a GENERAL meeting is a DATA refusal with zero rows', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('g1', 'GENERAL');
  repo.grantExportRight('g1', 'u1', true);
  const out = repo.createExportJob({
    meetingId: 'g1',
    requesterId: 'u1',
    kind: 'SUMMARY',
    format: 'JSON',
    idempotencyKey: 'k1',
  });
  assert.equal(out.created, false);
  assert.equal(out.refusal, 'GENERAL_TARGET_REFUSED');
  assert.equal(out.job, null);
  assert.equal(repo.jobs.size, 0);
});

test('storage boundary: claiming an export of a GENERAL meeting is a DATA refusal (row untouched)', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('g1', 'GENERAL');
  repo.grantExportRight('g1', 'u1', true);
  const id = repo.seedCorruptRow('g1', 'u1', 'SUMMARY');
  const out = repo.claimExportForProcessing({ exportId: id });
  assert.equal(out.claimed, false);
  assert.equal(out.refusal, 'GENERAL_TARGET_REFUSED');
  assert.equal(repo.jobs.get(id).status, 'QUEUED');
});

test('storage boundary: reporting completion of a GENERAL-bound export is a DATA refusal (row untouched)', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('g1', 'GENERAL');
  repo.grantExportRight('g1', 'u1', true);
  const id = repo.seedCorruptRow('g1', 'u1', 'SUMMARY');

  repo.jobs.get(id).status = 'RUNNING';
  const out = repo.reportExportCompletion({
    exportId: id,
    outcome: 'SUCCEEDED',
  });
  assert.equal(out.reported, false);
  assert.equal(out.refusal, 'GENERAL_TARGET_REFUSED');
  assert.equal(repo.jobs.get(id).status, 'RUNNING');
});

test('storage boundary: the download-audit write rejects GENERAL-bound artifacts as corruption (post-auth integrity)', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('g1', 'GENERAL');
  const id = repo.seedCorruptRow('g1', 'u1', 'SUMMARY');

  assert.throws(
    () => repo.recordDownloadAudit({ exportId: id, requesterId: 'u1' }),
    /export-row-mapping-corrupt/,
  );
});

test('storage boundary: claiming an ANALYSIS row with NO readable enumeration is a fail-closed DATA refusal', () => {
  const repo = inMemoryRepository();
  seedTechMeeting(repo, 'm1', 'u1');
  repo.grantExportRight('m1', 'u1', true);

  const row = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'ANALYSIS',
    format: 'CSV',
    idempotencyKey: 'enum-bypass-direct',
  }).job;
  const out = repo.claimExportForProcessing({ exportId: row.id });
  assert.equal(out.claimed, false);
  assert.equal(out.refusal, 'SOURCE_ENUMERATION_UNREADABLE');
  assert.equal(out.currentStatus, 'QUEUED');
  assert.equal(repo.jobs.get(row.id).status, 'QUEUED');
});

test('storage boundary: same idempotency key with a different payload is a DATA refusal (no silent upsert)', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('m1', 'TECH');
  repo.grantExportRight('m1', 'u1', true);
  const first = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'SUMMARY',
    format: 'JSON',
    idempotencyKey: 'k1',
  });
  assert.equal(first.created, true);
  const second = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'SUMMARY',
    format: 'PDF',
    idempotencyKey: 'k1',
  });
  assert.equal(second.created, false);
  assert.equal(second.refusal, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal(second.job, null);
  assert.equal(repo.jobs.size, 1);
});

test('storage boundary: same-key RETRY over a corrupt-status row throws (enum integrity on every dereference)', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('m1', 'TECH');
  repo.grantExportRight('m1', 'u1', true);
  const first = repo.createExportJob({
    meetingId: 'm1',
    requesterId: 'u1',
    kind: 'SUMMARY',
    format: 'JSON',
    idempotencyKey: 'k2',
  });
  repo.jobs.get(first.job.id).status = 'PENDING_INSTANCE';
  assert.throws(
    () =>
      repo.createExportJob({
        meetingId: 'm1',
        requesterId: 'u1',
        kind: 'SUMMARY',
        format: 'JSON',
        idempotencyKey: 'k2',
      }),
    /export-row-mapping-corrupt/,
  );
});

test('storage boundary: a different requester sharing the same Idempotency-Key gets her OWN job', async () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('m1', 'TECH');
  repo.grantExportRight('m1', 'u1', true);
  repo.grantExportRight('m1', 'u2', true);
  const service = new ExportRequestService(repo);
  const a = await service.requestExport({
    ...baseRequest('m1', 'u1'),
    idempotencyKey: 'shared-key',
  });
  const b = await service.requestExport({
    ...baseRequest('m1', 'u2'),
    idempotencyKey: 'shared-key',
  });
  assert.equal(a.ok === true && b.ok === true, true);
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(b.k, 'QUEUED');
});

test('storage boundary: out-of-enum export kind on a stored row throws (fail-closed mapping)', () => {
  const repo = inMemoryRepository();
  repo.seedMeeting('m1', 'TECH');
  repo.grantExportRight('m1', 'u1', true);
  const id = repo.seedCorruptRow('m1', 'u1', 'DECK');
  assert.throws(
    () => repo.getWorkerFacts({ exportId: id }),
    /export-row-mapping-corrupt/,
  );
});
