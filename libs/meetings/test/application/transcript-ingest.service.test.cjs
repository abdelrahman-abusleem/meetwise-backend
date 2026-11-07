'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TranscriptIngestService,
} = require('../../src/application/transcript-ingest.service.ts');
const { createHash } = require('node:crypto');

const fixtureDigest = (input) =>
  'sha256:' + createHash('sha256').update(input).digest('hex');

function inMemoryRepository() {
  const meetings = new Map();
  const sessions = new Map();
  const heads = new Map();
  const revisions = new Map();
  const revisionKeys = new Set();
  const segmentRows = new Map();
  const byProvider = new Map();
  const byHashOrdinal = new Map();
  const receipts = new Map();
  const outbox = [];
  const audit = [];
  const calls = [];

  function headIdFor(meetingId, botSessionId, revision) {
    return fixtureDigest(
      `${meetingId.length}:${meetingId}|` +
        `${botSessionId.length}:${botSessionId}|` +
        `${revision}`,
    );
  }

  function segmentIdFor(transcriptId, ordinal) {
    return fixtureDigest(JSON.stringify([transcriptId, ordinal]));
  }

  function snapshotHashOf(transcriptId) {
    const rows = [...segmentRows.values()]
      .filter((row) => row.transcriptId === transcriptId)
      .sort((a, b) => a.ordinal - b.ordinal);
    return fixtureDigest(
      JSON.stringify(
        rows.map((row) => [
          row.ordinal,
          row.contentHash,
          row.textEncryptedRef,
          row.startMs,
          row.endMs,
          row.speakerExternalId ?? null,
          row.speakerText ?? null,
        ]),
      ),
    );
  }

  function externalHead(internalHead) {
    return Object.freeze({
      id: internalHead.id,
      meetingId: internalHead.meetingId,
      botSessionId: internalHead.botSessionId,
      revision: internalHead.revision,
      state: internalHead.state,
      isPartial: internalHead.state === 'PARTIAL',
    });
  }

  function emitRevisionReadyIfNeeded(request, head) {
    if (request.announceRevisionReady) {
      outbox.push({
        eventType: 'transcript.revision_ready.v1',
        meetingId: head.meetingId,
        botSessionId: head.botSessionId,
        revision: head.revision,
        transcriptId: head.id,
      });
    }
  }

  function assertPartialIdentity(head) {
    if ((head.state === 'PARTIAL') !== externalHead(head).isPartial) {
      throw new Error('isPartial identity violation (adapter defect)');
    }
  }

  function applyCasAndRecord(req) {
    calls.push({ op: 'applyIngest', req: snapshotRequest(req) });

    if (receipts.has(req.eventId)) {
      throw new Error(
        'transcript-duplicate-event-receipt (unique receipt lost race)',
      );
    }
    let head = heads.get(req.meetingId) ?? null;
    if (req.createHead) {
      if (head !== null) {
        throw new Error(
          'transcript-stale-event-conflict (create race: head appeared)',
        );
      }
      if (revisionKeys.has(`${req.meetingId}:${req.targetRevision}`)) {
        throw new Error(
          'transcript-stale-event-conflict (revision key reused)',
        );
      }
      const internal = {
        id: headIdFor(req.meetingId, req.botSessionId, req.targetRevision),
        meetingId: req.meetingId,
        botSessionId: req.botSessionId,
        revision: req.targetRevision,
        state: req.targetState,
      };
      heads.set(req.meetingId, internal);
      revisions.set(internal.id, internal);
      revisionKeys.add(`${req.meetingId}:${req.targetRevision}`);
    } else {
      if (head === null) {
        throw new Error(
          'transcript-stale-event-conflict (expected head vanished)',
        );
      }
      if (head.revision !== req.expectedRevision) {
        throw new Error(
          `transcript-stale-event-conflict (revision: committed ${head.revision} vs expected ${req.expectedRevision})`,
        );
      }
      if (!req.receiptOnly) {
        if (head.state !== req.expectedState) {
          throw new Error(
            `transcript-stale-event-conflict (state: committed ${head.state} vs expected ${req.expectedState})`,
          );
        }
        if (
          req.targetRevision !== head.revision &&
          req.targetRevision !== head.revision + 1
        ) {
          throw new Error(
            'transcript-stale-event-conflict (incoherent target revision)',
          );
        }
        if (req.targetRevision !== head.revision) {
          const revisionKey = `${req.meetingId}:${req.targetRevision}`;
          if (revisionKeys.has(revisionKey))
            throw new Error(
              'transcript-stale-event-conflict (revision key reused)',
            );
          const oldId = head.id;
          const next = {
            ...head,
            id: headIdFor(req.meetingId, req.botSessionId, req.targetRevision),
            revision: req.targetRevision,
            state: req.targetState,
          };
          for (const row of [...segmentRows.values()].filter(
            (row) => row.transcriptId === oldId,
          )) {
            const copy = {
              ...row,
              id: segmentIdFor(next.id, row.ordinal),
              transcriptId: next.id,
            };
            segmentRows.set(`${next.id}:${row.ordinal}`, copy);
          }
          heads.set(req.meetingId, next);
          revisions.set(next.id, next);
          revisionKeys.add(revisionKey);
        } else head.state = req.targetState;
      }
    }
    head = heads.get(req.meetingId);
    assertPartialIdentity(head);
    let segmentRecordId;
    if (req.segment !== undefined) {
      const ordinalKey = `${head.id}:${req.segment.ordinal}`;
      const providerKey =
        req.segment.providerSegmentId !== undefined
          ? `${req.botSessionId}:${req.segment.providerSegmentId}`
          : null;
      if (
        segmentRows.has(ordinalKey) ||
        (providerKey !== null && byProvider.has(providerKey))
      ) {
        throw new Error(
          'transcript-segment-unique-defect (duplicate insert lost race)',
        );
      }
      segmentRecordId = segmentIdFor(head.id, req.segment.ordinal);
      segmentRows.set(ordinalKey, {
        id: segmentRecordId,
        transcriptId: head.id,
        ordinal: req.segment.ordinal,
        providerSegmentId: req.segment.providerSegmentId,
        startMs: req.segment.startMs,
        endMs: req.segment.endMs,
        speakerExternalId: req.segment.speakerExternalId,
        speakerText: req.segment.speakerText,
        textEncryptedRef: req.segment.textEncryptedRef,
        contentHash: req.segment.contentHash,
      });
      if (req.segment.providerSegmentId !== undefined) {
        byProvider.set(providerKey, segmentRecordId);
      } else {
        byHashOrdinal.set(
          `${req.botSessionId}:${req.segment.contentHash}:${req.segment.ordinal}`,
          segmentRecordId,
        );
      }
    }

    audit.push({
      eventId: req.eventId,
      command: req.command,
      from: req.expectedState,
      to: head.state,
      revision: head.revision,
    });
    emitRevisionReadyIfNeeded(req, head);
    receipts.set(req.eventId, true);
    return {
      head: externalHead(head),
      segmentRecordId: segmentRecordId ?? undefined,
      auditRecorded: true,
      revisionReadyRecorded: req.announceRevisionReady,
    };
  }

  return {
    calls,
    receipts,
    outbox,
    audit,
    segmentRows,
    heads,
    revisions,

    snapshotHashOf,
    setMeeting(meetingId) {
      meetings.set(meetingId, true);
    },
    setSession(meetingId, botSessionId) {
      sessions.set(botSessionId, meetingId);
    },
    async getIngestFacts(context) {
      calls.push({ op: 'getIngestFacts', context: { ...context } });
      const head = heads.get(context.meetingId) ?? null;
      return Object.freeze({
        meetingExists: meetings.has(context.meetingId),
        sessionMeetingId: sessions.get(context.botSessionId) ?? null,
        head: head !== null ? externalHead(head) : null,
        eventAlreadyProcessed: receipts.has(context.eventId),
      });
    },
    async isSegmentDuplicate(key) {
      calls.push({ op: 'isSegmentDuplicate', key: { ...key } });
      if (key.providerSegmentId !== undefined) {
        return byProvider.has(`${key.botSessionId}:${key.providerSegmentId}`);
      }
      return byHashOrdinal.has(
        `${key.botSessionId}:${key.contentHash}:${key.ordinal}`,
      );
    },
    async applyIngest(request) {
      const maps = [
        heads,
        revisions,
        segmentRows,
        byProvider,
        byHashOrdinal,
        receipts,
      ];
      const before = structuredClone({
        maps: maps.map((map) => [...map]),
        revisionKeys: [...revisionKeys],
        outbox,
        audit,
      });
      try {
        return applyCasAndRecord(request);
      } catch (error) {
        for (let index = 0; index < maps.length; index++) {
          maps[index].clear();
          for (const [key, value] of before.maps[index])
            maps[index].set(key, value);
        }
        revisionKeys.clear();
        for (const key of before.revisionKeys) revisionKeys.add(key);
        outbox.splice(0, outbox.length, ...before.outbox);
        audit.splice(0, audit.length, ...before.audit);
        throw error;
      }
    },
  };
}

function snapshotRequest(req) {
  return {
    ...req,
    segment: req.segment !== undefined ? { ...req.segment } : undefined,
  };
}

const MEETING = 'meeting-1';
const SESSION = 'bot-1';

function baseService() {
  const repo = inMemoryRepository();
  repo.setMeeting(MEETING);
  repo.setSession(MEETING, SESSION);
  return { repo, service: new TranscriptIngestService(repo) };
}

function segment(overrides) {
  return {
    ordinal: 1,
    providerSegmentId: 'prov-seg-1',
    startMs: 0,
    endMs: 1000,
    speakerExternalId: undefined,
    speakerText: 'نص عربي / english clip',
    textEncryptedRef: 'enc-ref-1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

function query(overrides) {
  return {
    meetingId: MEETING,
    botSessionId: SESSION,
    eventId: 'evt-1',
    expectedRevision: 0,
    event: { kind: 'SEGMENT', segment: segment() },
    ...overrides,
  };
}

function stateOf(repo) {
  return {
    segmentCount: repo.segmentRows.size,
    receiptCount: repo.receipts.size,
    outboxCount: repo.outbox.length,
  };
}

test('first verified segment creates the RECEIVING head at revision 1 and records the event receipt', async () => {
  const { repo, service } = baseService();
  const out = await service.ingest(query());
  assert.equal(out.ok, true);
  assert.equal(out.k, 'APPLIED');
  assert.equal(out.command, 'INGEST_SEGMENT');
  assert.equal(out.from, 'NONE');
  assert.equal(out.to, 'RECEIVING');
  assert.equal(out.revisionBefore, 0);
  assert.equal(out.revisionAfter, 1);
  assert.equal(out.revisionBumped, false);
  assert.equal(out.invalidateUnpublishedAnalysis, false);
  assert.equal(out.receiptRecorded, true);
  assert.equal(typeof out.transcriptId, 'string');
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(out.segmentRecordId));
  assert.equal(repo.segmentRows.size, 1);
  assert.ok(repo.receipts.has('evt-1'));
  assert.deepEqual(repo.outbox, []);
  assert.equal(repo.audit.length, 1);
});

test('continuing segments keep RECEIVING; ordering derives from the oracle ordinals and out-of-order arrival is allowed', async () => {
  const { repo, service } = baseService();
  const first = await service.ingest(query());
  assert.equal(first.ok, true);
  const second = await service.ingest(
    query({
      eventId: 'evt-2',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-seg-2',
          contentHash: 'hash-2',
        }),
      },
    }),
  );
  assert.equal(second.ok, true);
  assert.equal(second.to, 'RECEIVING');
  assert.equal(second.revisionAfter, 1);
  assert.equal(second.revisionBumped, false);
  assert.equal(repo.segmentRows.size, 2);
  assert.equal(repo.outbox.length, 0);
});

test('out-of-order provider delivery is legitimate: ordinals define ordering, never receivedAt', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const third = await service.ingest(
    query({
      eventId: 'evt-o3',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 3,
          providerSegmentId: 'prov-o3',
          contentHash: 'hash-o3',
        }),
      },
    }),
  );
  assert.equal(third.ok, true);
  const exporter = await service.ingest(
    query({
      eventId: 'evt-o2',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-o2',
          contentHash: 'hash-o2',
        }),
      },
    }),
  );
  assert.equal(exporter.ok, true);
  const ordinals = [...repo.segmentRows.values()]
    .filter((row) => row.transcriptId === repo.heads.get(MEETING).id)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => row.ordinal);
  assert.deepEqual(ordinals, [1, 2, 3]);

  await assert.rejects(
    () =>
      service.ingest(
        query({
          eventId: 'evt-ordinal-claim',
          expectedRevision: 1,
          event: {
            kind: 'SEGMENT',
            segment: segment({
              ordinal: 1,
              providerSegmentId: 'prov-claim',
              contentHash: 'hash-claim',
            }),
          },
        }),
      ),
    /transcript-segment-unique-defect/,
  );
});

test('duplicate segment (same providerSegmentId) is receipt-only: zero state/revision/segment effects and no emission', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const before = stateOf(repo);
  const dup = await service.ingest(
    query({ eventId: 'evt-dup', expectedRevision: 1 }),
  );
  assert.equal(dup.ok, true);
  assert.equal(dup.k, 'RECORDED_ONLY');
  assert.equal(dup.ignoredDuplicate, true);
  assert.equal(dup.to, 'RECEIVING');
  assert.equal(dup.revisionAfter, 1);
  assert.equal(dup.revisionBumped, false);
  assert.equal(dup.invalidateUnpublishedAnalysis, false);
  assert.ok(dup.segmentRecordId === undefined);
  assert.ok(repo.receipts.has('evt-dup'));
  assert.equal(stateOf(repo).segmentCount, before.segmentCount);
  assert.equal(stateOf(repo).outboxCount, before.outboxCount);
});

test('event replay resolves ALREADY_PROCESSED even when the worker snapshot went stale', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  await service.ingest(
    query({
      eventId: 'evt-2',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  const before = stateOf(repo);
  const replay = await service.ingest(
    query({ eventId: 'evt-1', expectedRevision: 0 }),
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.k, 'ALREADY_PROCESSED');
  assert.equal(replay.command, 'INGEST_SEGMENT');
  assert.equal(replay.to, 'COMPLETE');
  assert.equal(replay.receiptRecorded, false);
  assert.equal(stateOf(repo).receiptCount, before.receiptCount + 0);
});

test('stale worker snapshot fails closed with zero mutation; CAS dimensions cover unexpected-up and invented-down revisions', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  for (const badExpected of [0, 5, 2]) {
    const before = stateOf(repo);
    const stale = await service.ingest(
      query({
        eventId: `evt-stale-${badExpected}`,
        expectedRevision: badExpected,
      }),
    );
    assert.deepEqual(stale, { ok: false, reason: 'STALE_EVENT' });
    assert.deepEqual(stateOf(repo), before);
  }
});

test('(concurrency) parallel same-event workers: single winner; the loser retry resolves ALREADY_PROCESSED', async () => {
  const { repo, service } = baseService();
  const pA = service.ingest(query());
  const pB = service.ingest(query());
  const winner = await pA;
  assert.equal(winner.ok, true);
  await assert.rejects(() => pB, /transcript-duplicate-event-receipt/);
  assert.equal(repo.segmentRows.size, 1);
  assert.ok(repo.receipts.has('evt-1'));
  const retry = await service.ingest(query());
  assert.equal(retry.ok, true);
  assert.equal(retry.k, 'ALREADY_PROCESSED');
  assert.equal(repo.segmentRows.size, 1);
});

test('(concurrency) two different segments racing the same head: one wins; the CAS loser never records a receipt, a payload-faithful retry lands as the same-ordinal integrity defect, and corrected content applies', async () => {
  const { repo, service } = baseService();
  const pA = service.ingest(query({ eventId: 'evt-a' }));
  const pB = service.ingest(
    query({
      eventId: 'evt-b',
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 1,
          providerSegmentId: 'prov-seg-b',
          contentHash: 'hash-b',
        }),
      },
    }),
  );
  const winner = await pA;
  assert.equal(winner.ok, true);
  await assert.rejects(() => pB, /transcript-stale-event-conflict/);
  assert.equal(repo.receipts.size, 1);

  await assert.rejects(
    () =>
      service.ingest(
        query({
          eventId: 'evt-b',
          expectedRevision: 1,
          event: {
            kind: 'SEGMENT',
            segment: segment({
              ordinal: 1,
              providerSegmentId: 'prov-seg-b',
              contentHash: 'hash-b',
            }),
          },
        }),
      ),
    /transcript-segment-unique-defect/,
  );
  assert.equal(repo.segmentRows.size, 1);
  assert.equal(repo.receipts.size, 1);

  const corrected = await service.ingest(
    query({
      eventId: 'evt-b2',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-seg-b2',
          contentHash: 'hash-b2',
        }),
      },
    }),
  );
  assert.equal(corrected.ok, true);
  assert.equal(corrected.to, 'RECEIVING');
  assert.equal(repo.segmentRows.size, 2);
});

test('(concurrency) completion racing a late segment: the state-CAS blocks the regression; the loser retry lands as an approved late segment of COMPLETE', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const pCompletion = service.ingest(
    query({
      eventId: 'evt-comp',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  const pLate = service.ingest(
    query({
      eventId: 'evt-late-2',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-l2',
          contentHash: 'hash-l2',
        }),
      },
    }),
  );
  const completed = await pCompletion;
  assert.equal(completed.to, 'COMPLETE');
  await assert.rejects(() => pLate, /transcript-stale-event-conflict/);
  assert.equal(repo.heads.get(MEETING).state, 'COMPLETE');
  const retry = await service.ingest(
    query({
      eventId: 'evt-late-2',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-l2',
          contentHash: 'hash-l2',
        }),
      },
    }),
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.to, 'COMPLETE');
  assert.equal(retry.revisionAfter, 2);
  assert.equal(retry.revisionBumped, true);
  assert.equal(retry.invalidateUnpublishedAnalysis, true);
});

test('meeting/session trust gates: unknown meeting, unbound session and head/session mismatch fail closed before any effect', async () => {
  const { repo, service } = baseService();
  const ghost = await service.ingest(query({ meetingId: 'meeting-ghost' }));
  assert.equal(ghost.reason, 'MEETING_NOT_FOUND');
  const unbound = await service.ingest(query({ botSessionId: 'bot-unknown' }));
  assert.equal(unbound.reason, 'SESSION_NOT_BOUND');
  await service.ingest(query());
  repo.setSession(MEETING, 'bot-2');
  const mismatch = await service.ingest(
    query({
      eventId: 'evt-mismatch',
      expectedRevision: 1,
      botSessionId: 'bot-2',
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 3,
          providerSegmentId: 'prov-seg-3',
          contentHash: 'hash-3',
        }),
      },
    }),
  );
  assert.deepEqual(mismatch, { ok: false, reason: 'SESSION_MISMATCH' });
  assert.equal(stateOf(repo).segmentCount, 1);
  assert.equal(stateOf(repo).receiptCount, 1);
});

test('interrupted capture closes RECEIVING → PARTIAL with the banner; the NONE-state interrupt is rejected and replay-visible', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const interrupted = await service.ingest(
    query({
      eventId: 'evt-i',
      expectedRevision: 1,
      event: { kind: 'CAPTURE_INTERRUPTED' },
    }),
  );
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.command, 'MARK_PARTIAL');
  assert.equal(interrupted.from, 'RECEIVING');
  assert.equal(interrupted.to, 'PARTIAL');
  assert.equal(interrupted.revisionAfter, 1);
  assert.equal(repo.heads.get(MEETING).state, 'PARTIAL');
  assert.equal(
    typeof repo.snapshotHashOf(repo.heads.get(MEETING).id),
    'string',
  );
  const freshRepo = baseService();
  const noHead = await freshRepo.service.ingest(
    query({ eventId: 'evt-i-none', event: { kind: 'CAPTURE_INTERRUPTED' } }),
  );
  assert.deepEqual(noHead, { ok: false, reason: 'MARK_PARTIAL_NOT_ALLOWED' });
  assert.deepEqual(stateOf(freshRepo.repo), {
    segmentCount: 0,
    receiptCount: 0,
    outboxCount: 0,
  });
});

test('provider completion closes RECEIVING/PARTIAL → COMPLETE; replayed completion is an audit-only receipt', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const completed = await service.ingest(
    query({
      eventId: 'evt-c',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.command, 'COMPLETE_TRANSACTION');
  assert.equal(completed.to, 'COMPLETE');
  assert.equal(completed.revisionAfter, 1);
  const replay = await service.ingest(
    query({
      eventId: 'evt-c2',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.k, 'RECORDED_ONLY');
  assert.equal(replay.appendedAuditEventOnly, true);
  assert.equal(replay.revisionAfter, 1);
  assert.equal(repo.heads.get(MEETING).state, 'COMPLETE');

  const partial = baseService();
  await partial.service.ingest(
    query({ event: { kind: 'SEGMENT', segment: segment() } }),
  );
  await partial.service.ingest(
    query({
      eventId: 'evt-i2',
      expectedRevision: 1,
      event: { kind: 'CAPTURE_INTERRUPTED' },
    }),
  );
  const completePartial = await partial.service.ingest(
    query({
      eventId: 'evt-c3',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  assert.equal(completePartial.to, 'COMPLETE');
});

test('late segment after COMPLETE/Newly-bumped revision keeps the status and invalidates unpublished AI runs; the late duplicate does not bump again', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  await service.ingest(
    query({
      eventId: 'evt-c',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  const late = await service.ingest(
    query({
      eventId: 'evt-late',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-late',
          contentHash: 'hash-late',
        }),
      },
    }),
  );
  assert.equal(late.ok, true);
  assert.equal(late.k, 'APPLIED');
  assert.equal(late.to, 'COMPLETE');
  assert.equal(late.revisionBefore, 1);
  assert.equal(late.revisionAfter, 2);
  assert.equal(late.revisionBumped, true);
  assert.equal(late.invalidateUnpublishedAnalysis, true);
  assert.equal(repo.outbox.length, 2);
  const lateDup = await service.ingest(
    query({ eventId: 'evt-late-dup', expectedRevision: 2 }),
  );
  assert.equal(lateDup.k, 'RECORDED_ONLY');
  assert.equal(repo.heads.get(MEETING).revision, 2);

  const p = baseService();
  await p.service.ingest(query());
  await p.service.ingest(
    query({
      eventId: 'evt-i',
      expectedRevision: 1,
      event: { kind: 'CAPTURE_INTERRUPTED' },
    }),
  );
  const latePartial = await p.service.ingest(
    query({
      eventId: 'evt-late-p',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-lp',
          contentHash: 'hash-lp',
        }),
      },
    }),
  );
  assert.equal(latePartial.to, 'PARTIAL');
  assert.equal(latePartial.revisionAfter, 2);
  assert.equal(latePartial.revisionBumped, true);
});

test('explicit MALFORMED_SEGMENT quarantines RECEIVING/PARTIAL → INVALID, is inapplicable at NONE and blocked at FAILED', async () => {
  const { repo, service } = baseService();
  const fresh = await service.ingest(
    query({ eventId: 'evt-fresh-q', event: { kind: 'MALFORMED_SEGMENT' } }),
  );
  assert.deepEqual(fresh, { ok: false, reason: 'QUARANTINE_NOT_APPLICABLE' });
  await service.ingest(query());
  const quarantined = await service.ingest(
    query({
      eventId: 'evt-q',
      expectedRevision: 1,
      event: { kind: 'MALFORMED_SEGMENT' },
    }),
  );
  assert.equal(quarantined.ok, true);
  assert.equal(quarantined.to, 'INVALID');
  assert.equal(quarantined.metadataQuarantined, undefined);
  assert.ok(repo.receipts.has('evt-q'));
  assert.equal(repo.heads.get(MEETING).state, 'INVALID');

  const hardened = baseService();
  await hardened.service.ingest(query());
  await hardened.service.ingest(
    query({
      eventId: 'evt-hf',
      expectedRevision: 1,
      event: { kind: 'INGEST_HARD_FAILURE' },
    }),
  );
  assert.equal(hardened.repo.heads.get(MEETING).state, 'FAILED');
  const blocked = await hardened.service.ingest(
    query({
      eventId: 'evt-q2',
      expectedRevision: 1,
      event: { kind: 'MALFORMED_SEGMENT' },
    }),
  );
  assert.deepEqual(blocked, { ok: false, reason: 'INGEST_BLOCKED' });
});

test('malformed SEGMENT metadata is DETERMINISTICALLY reclassified as the quarantine trigger (metadataQuarantined=true) and NEVER re-quarantined', async () => {
  const malformedShapes = [
    ['negative-ordinal', segment({ ordinal: -1 })],
    ['inverted-window', segment({ startMs: 500, endMs: 100 })],
    ['non-integer-ordinal', segment({ ordinal: 1.5 })],
    ['empty-content-hash', segment({ contentHash: '' })],
    ['blank-encrypted-ref', segment({ textEncryptedRef: '  ' })],
    ['non-string-speaker-text', segment({ speakerText: 42 })],
    ['blank-provider-id', segment({ providerSegmentId: '' })],
    ['blank-speaker-external-id', segment({ speakerExternalId: '' })],
  ];
  for (const [label, badSegment] of malformedShapes) {
    const { repo, service } = baseService();
    await service.ingest(query());
    const quarantined = await service.ingest(
      query({
        eventId: `evt-${label}`,
        expectedRevision: 1,
        event: { kind: 'SEGMENT', segment: badSegment },
      }),
    );
    assert.equal(quarantined.ok, true, `case ${label}`);
    assert.equal(quarantined.command, 'QUARANTINE_MALFORMED', `case ${label}`);
    assert.equal(quarantined.metadataQuarantined, true, `case ${label}`);
    assert.equal(quarantined.to, 'INVALID', `case ${label}`);
    assert.equal(repo.segmentRows.size, 1, `case ${label}`);

    const blocked = await service.ingest(
      query({
        eventId: `evt-again-${label}`,
        expectedRevision: repo.heads.get(MEETING).revision,
        event: { kind: 'SEGMENT', segment: badSegment },
      }),
    );
    assert.deepEqual(
      blocked,
      { ok: false, reason: 'INGEST_BLOCKED' },
      `case ${label} second`,
    );
  }

  const { repo: noneRepo, service: noneService } = baseService();
  const notApplicable = await noneService.ingest(
    query({
      eventId: 'evt-none-bad',
      event: { kind: 'SEGMENT', segment: segment({ ordinal: -1 }) },
    }),
  );
  assert.deepEqual(notApplicable, {
    ok: false,
    reason: 'QUARANTINE_NOT_APPLICABLE',
  });
  assert.equal(noneRepo.heads.size, 0);
});

test('hard ingest failure marks FAILED for NONE (document creation) and RECEIVING; FAILED blocks all ingest', async () => {
  const fresh = baseService();
  const failedNone = await fresh.service.ingest(
    query({ eventId: 'evt-f1', event: { kind: 'INGEST_HARD_FAILURE' } }),
  );
  assert.equal(failedNone.ok, true);
  assert.equal(failedNone.to, 'FAILED');
  assert.equal(failedNone.revisionAfter, 1);
  assert.equal(fresh.repo.heads.get(MEETING).state, 'FAILED');
  const blocked = await fresh.service.ingest(
    query({ eventId: 'evt-f2', expectedRevision: 1 }),
  );
  assert.deepEqual(blocked, { ok: false, reason: 'INGEST_BLOCKED' });

  const running = baseService();
  await running.service.ingest(query());
  const failedReceiving = await running.service.ingest(
    query({
      eventId: 'evt-f3',
      expectedRevision: 1,
      event: { kind: 'INGEST_HARD_FAILURE' },
    }),
  );
  assert.equal(failedReceiving.to, 'FAILED');
  assert.equal(failedReceiving.revisionAfter, 1);
  assert.equal(failedReceiving.invalidateUnpublishedAnalysis, false);

  const partial = baseService();
  await partial.service.ingest(query());
  await partial.service.ingest(
    query({
      eventId: 'evt-i3',
      expectedRevision: 1,
      event: { kind: 'CAPTURE_INTERRUPTED' },
    }),
  );
  const hardOnPartial = await partial.service.ingest(
    query({
      eventId: 'evt-f4',
      expectedRevision: 1,
      event: { kind: 'INGEST_HARD_FAILURE' },
    }),
  );
  assert.deepEqual(hardOnPartial, { ok: false, reason: 'INGEST_BLOCKED' });
});

test('contradictory provider FAILED over COMPLETE never regresses: audit-only receipt; on every other state it is inapplicable', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const onReceiving = await service.ingest(
    query({
      eventId: 'evt-cd',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_CONTRADICTORY_FAILURE' },
    }),
  );
  assert.deepEqual(onReceiving, {
    ok: false,
    reason: 'CONTRADICTION_NOT_APPLICABLE',
  });
  await service.ingest(
    query({
      eventId: 'evt-c',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  const contradiction = await service.ingest(
    query({
      eventId: 'evt-cd2',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_CONTRADICTORY_FAILURE' },
    }),
  );
  assert.equal(contradiction.ok, true);
  assert.equal(contradiction.k, 'RECORDED_ONLY');
  assert.equal(contradiction.command, 'OBSERVE_CONTRADICTORY_FAILURE');
  assert.equal(contradiction.appendedAuditEventOnly, true);
  assert.equal(contradiction.to, 'COMPLETE');
  assert.equal(repo.heads.get(MEETING).state, 'COMPLETE');
});

test('a SEGMENT envelope without a segment observation is a shape defect, NOT the quarantine trigger', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const before = stateOf(repo);

  for (const absentEvent of [
    { kind: 'SEGMENT' },
    { kind: 'SEGMENT', segment: null },
    { kind: 'SEGMENT', segment: 'not-an-object' },
  ]) {
    const gate = await service.ingest(
      query({
        eventId: `evt-envelope-defect-${JSON.stringify(absentEvent)}`,
        expectedRevision: 1,
        event: absentEvent,
      }),
    );
    assert.deepEqual(gate, { ok: false, reason: 'TRANSCRIPT_FACTS_REQUIRED' });
  }
  assert.deepEqual(stateOf(repo), before);
  assert.equal(repo.heads.get(MEETING).state, 'RECEIVING');
});

test('malformed/untrusted query shapes fail closed with TRANSCRIPT_FACTS_REQUIRED before ANY repository call', async () => {
  const { repo, service } = baseService();
  const badQueries = [
    null,
    undefined,
    42,
    '',
    {},
    { meetingId: MEETING },
    {
      meetingId: MEETING,
      botSessionId: SESSION,
      eventId: 'evt-x',
      expectedRevision: 0,
      event: { kind: 'TELEPORT', segment: segment() },
    },
    {
      meetingId: MEETING,
      botSessionId: SESSION,
      eventId: '   ',
      expectedRevision: 0,
      event: { kind: 'SEGMENT', segment: segment() },
    },
    {
      meetingId: MEETING,
      botSessionId: SESSION,
      eventId: 'evt-x',
      expectedRevision: -1,
      event: { kind: 'SEGMENT', segment: segment() },
    },
    {
      meetingId: MEETING,
      botSessionId: SESSION,
      eventId: 'evt-x',
      expectedRevision: 1.5,
      event: { kind: 'SEGMENT', segment: segment() },
    },
    {
      meetingId: MEETING,
      botSessionId: SESSION,
      eventId: 'evt-x',
      expectedRevision: 2 ** 53,
      event: { kind: 'SECURE', segment: segment() },
    },
  ];
  for (const bad of badQueries) {
    const gate = await service.ingest(bad);
    assert.deepEqual(gate, { ok: false, reason: 'TRANSCRIPT_FACTS_REQUIRED' });
  }
  assert.equal(repo.calls.length, 0);
});

test('first-segment path and defensive contract-violation guards', async () => {
  const { repo, service } = baseService();
  const first = await service.ingest(query());
  assert.equal(first.ok, true);
  assert.equal(repo.heads.get(MEETING).botSessionId, SESSION);

  const adversarial = {
    async getIngestFacts() {
      return {
        meetingExists: true,
        sessionMeetingId: MEETING,
        head: null,
        eventAlreadyProcessed: false,
      };
    },
    async isSegmentDuplicate() {
      return true;
    },
    async applyIngest() {
      throw new Error('must never be reached');
    },
  };
  const guard = await new TranscriptIngestService(adversarial).ingest(
    query({ eventId: 'evt-adv' }),
  );
  assert.deepEqual(guard, { ok: false, reason: 'SEGMENT_TARGET_UNAVAILABLE' });

  const noneRowAdapter = {
    async getIngestFacts() {
      return {
        meetingExists: true,
        sessionMeetingId: MEETING,
        head: {
          id: 't-none',
          meetingId: MEETING,
          botSessionId: SESSION,
          revision: 7,
          state: 'NONE',
          isPartial: false,
        },
        eventAlreadyProcessed: false,
      };
    },
    async isSegmentDuplicate() {
      return false;
    },
    async applyIngest() {
      throw new Error('must never be reached');
    },
  };
  await assert.rejects(
    () =>
      new TranscriptIngestService(noneRowAdapter).ingest(
        query({ eventId: 'evt-adv2' }),
      ),
    /non-compliant NONE head row/,
  );
});

test('untrusted-content shape-only typing: only metadata determines quarantine; larger text is validated by type (no threshold)', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  const longButStringy = await service.ingest(
    query({
      eventId: 'evt-long',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-long',
          contentHash: 'hash-long',
          speakerText: 'x'.repeat(5000),
        }),
      },
    }),
  );
  assert.equal(longButStringy.ok, true);
  assert.equal(longButStringy.metadataQuarantined, undefined);
  assert.equal(repo.segmentRows.size, 2);
});

test('outbox discipline: sealed snapshot availability and IDs-only payloads; rejected paths emit nothing', async () => {
  const { repo, service } = baseService();
  const rejected = await service.ingest(
    query({ event: { kind: 'CAPTURE_INTERRUPTED' } }),
  );
  assert.equal(rejected.ok, false);
  assert.equal(repo.outbox.length, 0);
  await service.ingest(query());
  await service.ingest(
    query({
      eventId: 'evt-c',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  const late = await service.ingest(
    query({
      eventId: 'evt-late',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-xl',
          contentHash: 'hash-xl',
        }),
      },
    }),
  );
  assert.equal(late.revisionAfter, 2);
  assert.equal(repo.outbox.length, 2);
  for (const event of repo.outbox) {
    assert.deepEqual(Object.keys(event).sort(), [
      'botSessionId',
      'eventType',
      'meetingId',
      'revision',
      'transcriptId',
    ]);
  }
});

test('outcomes and failures are frozen; the persisted reality comes from the APPLY result', async () => {
  const { repo, service } = baseService();
  const applied = await service.ingest(query());
  assert.ok(Object.isFrozen(applied));
  const failed = await service.ingest(query({ meetingId: 'nope' }));
  assert.ok(Object.isFrozen(failed));
  assert.equal(applied.revisionAfter, repo.heads.get(MEETING).revision);
  assert.equal(applied.transcriptId, repo.heads.get(MEETING).id);
});

test('deterministic ids and snapshot hashes across independent in-memory realizations', async () => {
  const a = baseService();
  const b = baseService();
  const script = [
    query(),
    query({
      eventId: 'evt-2',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'prov-seg-2',
          contentHash: 'hash-2',
        }),
      },
    }),
    query({
      eventId: 'evt-3',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
    query({
      eventId: 'evt-4',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 3,
          providerSegmentId: 'prov-seg-3',
          contentHash: 'hash-3',
        }),
      },
    }),
  ];
  for (const q of script) {
    const ra = await a.service.ingest(q);
    const rb = await b.service.ingest(q);
    assert.deepEqual(
      { id: ra.transcriptId, rev: ra.revisionAfter, seg: ra.segmentRecordId },
      { id: rb.transcriptId, rev: rb.revisionAfter, seg: rb.segmentRecordId },
    );
  }
  assert.equal(
    a.repo.snapshotHashOf(a.repo.heads.get(MEETING).id),
    b.repo.snapshotHashOf(b.repo.heads.get(MEETING).id),
  );
});

test('dedupe honors BOTH approved key alternatives: providerSegmentId primary and stable hash+index fallback', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());

  const sameProviderDup = await service.ingest(
    query({
      eventId: 'evt-dup-key',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({ ordinal: 2, contentHash: 'hash-x' }),
      },
    }),
  );
  assert.equal(sameProviderDup.ignoredDuplicate, true);
  assert.equal(repo.segmentRows.size, 1);

  const anonymous = await service.ingest(
    query({
      eventId: 'evt-anon',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: undefined,
          contentHash: 'hash-anon',
        }),
      },
    }),
  );
  assert.equal(anonymous.ok, true);
  assert.equal(anonymous.ignoredDuplicate, false);
  assert.equal(anonymous.k, 'APPLIED');
  assert.equal(repo.segmentRows.size, 2);
  const anonDup = await service.ingest(
    query({
      eventId: 'evt-anon-dup',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: undefined,
          contentHash: 'hash-anon',
        }),
      },
    }),
  );
  assert.equal(anonDup.ignoredDuplicate, true);
  assert.equal(repo.segmentRows.size, 2);
});

test('TI-R2 mutable receiving has no readiness but completion publishes its sealed snapshot', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  assert.equal(repo.outbox.length, 0);
  const receiving = repo.calls.find((call) => call.op === 'applyIngest').req;
  assert.equal(receiving.announceRevisionReady, false);
  await service.ingest(
    query({
      eventId: 'ti-ready-complete',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  assert.equal(repo.outbox.length, 1);
  assert.equal(
    repo.calls.filter((call) => call.op === 'applyIngest').at(-1).req
      .announceRevisionReady,
    true,
  );
  assert.equal(repo.outbox[0].revision, 1);
});
test('TI-R2 partial snapshot and late partial revision each publish availability without authorizing analysis', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  await service.ingest(
    query({
      eventId: 'ti-partial',
      expectedRevision: 1,
      event: { kind: 'CAPTURE_INTERRUPTED' },
    }),
  );
  assert.equal(repo.outbox.length, 1);
  assert.equal(
    repo.calls.filter((call) => call.op === 'applyIngest').at(-1).req
      .announceRevisionReady,
    true,
  );
  await service.ingest(
    query({
      eventId: 'ti-late-partial',
      expectedRevision: 1,
      event: {
        kind: 'SEGMENT',
        segment: segment({
          ordinal: 2,
          providerSegmentId: 'ti-seg-2',
          contentHash: 'ti-hash-2',
        }),
      },
    }),
  );
  assert.deepEqual(
    repo.outbox.map((event) => event.revision),
    [1, 2],
  );
});
test('TI-R3 receipt-only contradiction carries audit intent and confirms durable audit evidence', async () => {
  const { repo, service } = baseService();
  await service.ingest(query());
  await service.ingest(
    query({
      eventId: 'ti-audit-complete',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_COMPLETION' },
    }),
  );
  const result = await service.ingest(
    query({
      eventId: 'ti-contradiction',
      expectedRevision: 1,
      event: { kind: 'PROVIDER_CONTRADICTORY_FAILURE' },
    }),
  );
  const apply = repo.calls
    .filter((call) => call.op === 'applyIngest')
    .at(-1).req;
  assert.equal(apply.command, 'OBSERVE_CONTRADICTORY_FAILURE');
  assert.equal(result.auditRecorded, true);
  assert(repo.audit.some((event) => event.eventId === 'ti-contradiction'));
});
test('TI-R3 a noncompliant adapter cannot claim success without recording audit evidence', async () => {
  const { repo } = baseService(),
    apply = repo.applyIngest.bind(repo);
  repo.applyIngest = async (request) => ({
    ...(await apply(request)),
    auditRecorded: false,
  });
  await assert.rejects(
    new TranscriptIngestService(repo).ingest(query()),
    /audit.*persisted/,
  );
});
for (const eventKind of ['PROVIDER_COMPLETION', 'CAPTURE_INTERRUPTED']) {
  test(
    'TI-R4 late segment preserves the old sealed revision after ' + eventKind,
    async () => {
      const { repo, service } = baseService();
      await service.ingest(query());
      await service.ingest(
        query({
          eventId: 'ti-seal',
          expectedRevision: 1,
          event: { kind: eventKind },
        }),
      );
      const oldId = repo.heads.get(MEETING).id,
        oldHash = repo.snapshotHashOf(oldId);
      const oldRows = structuredClone(
        [...repo.segmentRows.values()].filter(
          (row) => row.transcriptId === oldId,
        ),
      );
      await service.ingest(
        query({
          eventId: 'ti-new-revision',
          expectedRevision: 1,
          event: {
            kind: 'SEGMENT',
            segment: segment({
              ordinal: 2,
              providerSegmentId: 'ti-new',
              contentHash: 'ti-new-hash',
            }),
          },
        }),
      );
      assert.equal(repo.snapshotHashOf(oldId), oldHash);
      assert.deepEqual(
        [...repo.segmentRows.values()].filter(
          (row) => row.transcriptId === oldId,
        ),
        oldRows,
      );
      assert.notEqual(repo.heads.get(MEETING).id, oldId);
    },
  );
  test(
    'TI-R5 late ordinal conflict rolls back every persistent effect after ' +
      eventKind,
    async () => {
      const { repo, service } = baseService();
      await service.ingest(query());
      await service.ingest(
        query({
          eventId: 'ti-seal-rollback',
          expectedRevision: 1,
          event: { kind: eventKind },
        }),
      );
      const snapshot = () =>
        structuredClone({
          heads: [...repo.heads],
          revisions: [...(repo.revisions ?? new Map())],
          segments: [...repo.segmentRows],
          receipts: [...repo.receipts],
          outbox: repo.outbox,
          audit: repo.audit ?? [],
        });
      const before = snapshot();
      await assert.rejects(
        service.ingest(
          query({
            eventId: 'ti-conflict',
            expectedRevision: 1,
            event: {
              kind: 'SEGMENT',
              segment: segment({
                ordinal: 1,
                providerSegmentId: 'ti-different',
                contentHash: 'ti-different-hash',
              }),
            },
          }),
        ),
        /transcript-segment-unique-defect/,
      );
      assert.deepEqual(snapshot(), before);
      const retry = await service.ingest(
        query({
          eventId: 'ti-after-rollback',
          expectedRevision: 1,
          event: {
            kind: 'SEGMENT',
            segment: segment({
              ordinal: 2,
              providerSegmentId: 'ti-valid-retry',
              contentHash: 'ti-valid-retry-hash',
            }),
          },
        }),
      );
      assert.equal(retry.ok, true);
      assert.equal(repo.heads.get(MEETING).revision, 2);
    },
  );
}
