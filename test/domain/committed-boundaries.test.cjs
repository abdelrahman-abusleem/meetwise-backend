const test = require('node:test'),
  assert = require('node:assert/strict'),
  p = require('node:path');
const root = p.resolve(__dirname, '../..');
const { MeetingLifecycleService } = require(
  p.join(root, 'libs/meetings/src/application/meeting-lifecycle.service.ts'),
);
const { CaptureSessionService } = require(
  p.join(root, 'libs/meetings/src/application/capture-session.service.ts'),
);
const { ExternalExecutionService } = require(
  p.join(
    root,
    'libs/external-actions/src/application/external-execution.service.ts',
  ),
);
const { TranscriptIngestService } = require(
  p.join(root, 'libs/meetings/src/application/transcript-ingest.service.ts'),
);
test('lifecycle must not report a foreign unchanged row as committed schedule', async () => {
  const draft = {
    meetingId: 'synthetic-meeting',
    meetingKind: 'TECH',
    departmentId: 'synthetic-dept',
    lifecycleStatus: 'DRAFT',
    scheduleVersion: 0,
    meetUrl: null,
    scheduledAtUtc: null,
    captureStatus: 'NOT_REQUESTED',
    createdById: 'synthetic-owner',
    meetingAdminId: null,
  };
  const service = new MeetingLifecycleService({
    async loadMeetingRecord() {
      return { ...draft };
    },
    async applyTransition() {
      return {
        ok: true,
        meeting: { ...draft, meetingId: 'synthetic-other-meeting' },
      };
    },
  });
  await assert.rejects(
    service.schedule(draft.meetingId, {
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      scheduledAtUtc: '2026-11-03T10:00:00Z',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }),
    /mapping-corrupt/,
  );
});
test('capture must not report a foreign unchanged session as committed admission', async () => {
  const session = {
    id: 'synthetic-session',
    meetingId: 'synthetic-meeting',
    provider: 'vexa',
    state: 'JOINING',
    attempt: 1,
    idempotencyKey: 'synthetic-idem',
    captureGeneration: 1,
    scheduleVersionAtActivation: 1,
    admissionState: null,
    externalSessionId: 'synthetic-external',
    correlationKey: 'synthetic-correlation',
    lastProcessedEventId: null,
    lastSequenceNumber: 1,
    startedAtUtc: '2026-11-03T10:00:00Z',
    admittedAtUtc: null,
    endedAtUtc: null,
    failureReason: null,
  };
  const service = new CaptureSessionService({
    async loadSessionRecord() {
      return { ...session };
    },
    async applyCaptureEventTransition() {
      return {
        ok: true,
        session: { ...session, id: 'synthetic-other-session' },
      };
    },
  });
  await assert.rejects(
    service.processCaptureEvent({
      botSessionId: session.id,
      eventId: 'synthetic-event',
      eventKind: 'ADMITTED',
      eventTimestampUtc: '2026-11-03T10:01:00Z',
      sequenceNumber: 2,
      providerSignatureVerified: true,
    }),
    /mapping-corrupt/,
  );
});
test('external dispatch must reject a foreign claim before a provider call', async () => {
  let calls = 0;
  const run = {
    id: 'synthetic-other-execution',
    status: 'DISPATCHING',
    attemptCount: 1,
    operation: 'CREATE',
    destination: 'GITHUB',
    targetKey: 'synthetic-target',
    storedExternalId: null,
    storedExternalUrl: null,
  };
  const repo = {
    async getExecutionFacts() {
      return {
        executionExists: true,
        status: 'PENDING',
        attemptCount: 0,
        operation: 'CREATE',
        destination: 'GITHUB',
        targetKey: 'synthetic-target',
        storedExternalId: null,
        storedExternalUrl: null,
      };
    },
    async claimExecution() {
      return {
        claimed: true,
        refusal: null,
        run,
        dispatchPayload: {
          approvedSnapshotId: 'synthetic-approved',
          payload: { title: 'Synthetic approved fact' },
        },
      };
    },
    async settleDispatchOutcome() {
      return {
        settled: true,
        refusal: null,
        run: { ...run, status: 'UNKNOWN' },
      };
    },
  };
  const service = new ExternalExecutionService(repo);
  await assert.rejects(
    service.dispatchExecution({
      executionId: 'synthetic-execution',
      provider: {
        async executeDispatch() {
          calls++;
          return { k: 'UNKNOWN_EFFECT' };
        },
        async lookupExternalByCorrelation() {
          return { k: 'UNCERTAIN' };
        },
      },
    }),
    /mapping-corrupt/,
  );
  assert.equal(calls, 0);
});
test('transcript must not report a foreign committed head as applied', async () => {
  const service = new TranscriptIngestService({
    async getIngestFacts() {
      return {
        meetingExists: true,
        sessionMeetingId: 'synthetic-meeting',
        head: null,
        eventAlreadyProcessed: false,
      };
    },
    async isSegmentDuplicate() {
      return false;
    },
    async applyIngest() {
      return {
        auditRecorded: true,
        revisionReadyRecorded: false,
        head: {
          id: 'synthetic-transcript',
          meetingId: 'synthetic-other-meeting',
          botSessionId: 'synthetic-session',
          revision: 1,
          state: 'RECEIVING',
          isPartial: false,
        },
        segmentRecordId: 'synthetic-segment',
      };
    },
  });
  await assert.rejects(
    service.ingest({
      meetingId: 'synthetic-meeting',
      botSessionId: 'synthetic-session',
      eventId: 'synthetic-event',
      expectedRevision: 0,
      event: {
        kind: 'SEGMENT',
        segment: {
          ordinal: 0,
          providerSegmentId: 'synthetic-provider-segment',
          startMs: 0,
          endMs: 10,
          speakerExternalId: undefined,
          speakerText: undefined,
          textEncryptedRef: 'synthetic-encrypted-ref',
          contentHash: 'synthetic-content-hash',
        },
      },
    }),
    /mapping-corrupt|persisted.*mismatch/,
  );
});
for (const method of ['startCapture', 'endCapture']) {
  test(`${method} requires a complete identified actor when actor authorization is used`, async () => {
    let writes = 0;
    const meeting = {
      meetingId: 'synthetic-meeting',
      meetingKind: 'TECH',
      departmentId: 'synthetic-dept',
      lifecycleStatus: method === 'startCapture' ? 'SCHEDULED' : 'IN_PROGRESS',
      scheduleVersion: 1,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      scheduledAtUtc: '2026-11-03T10:00:00Z',
      captureStatus: 'JOINING',
      createdById: 'synthetic-owner',
      meetingAdminId: null,
    };
    const service = new MeetingLifecycleService({
      async loadMeetingRecord() {
        return { ...meeting };
      },
      async applyTransition(id, command) {
        writes++;
        return {
          ok: true,
          meeting: { ...meeting, lifecycleStatus: command.targetLifecycle },
        };
      },
    });
    await assert.rejects(
      service[method](meeting.meetingId, {
        actor: { systemRole: 'OWNER' },
        claimedScheduleVersion: 1,
        systemAuthorized: false,
      }),
      /invalid-request/,
    );
    assert.equal(writes, 0);
  });
}
