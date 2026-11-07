'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  CaptureSessionService,
} = require('../../src/application/capture-session.service.ts');
const {
  CaptureSessionPolicy,
} = require('../../src/domain/capture-session.policy.ts');

class InMemoryCaptureSessionRepository {
  constructor(initialSessions = []) {
    this.sessions = new Map();
    this.inbox = new Set();
    for (const s of initialSessions) {
      this.sessions.set(s.id, { ...s });
    }
    this.loadCalls = 0;
    this.applyCalls = 0;
    this.hooks = {};
  }

  async loadSessionRecord(botSessionId) {
    this.loadCalls += 1;
    const s = this.sessions.get(botSessionId);
    if (!s) return null;
    return { ...s };
  }

  async applyCaptureEventTransition(botSessionId, command) {
    this.applyCalls += 1;
    if (this.hooks.onBeforeApply) {
      await this.hooks.onBeforeApply(botSessionId, command, this);
    }
    const current = this.sessions.get(botSessionId);
    if (!current) {
      return { ok: false, label: 'SESSION_NOT_FOUND' };
    }
    if (this.inbox.has(command.incomingEventId)) {
      return { ok: false, label: 'DUPLICATE_EVENT_RECORDED' };
    }
    if (current.state !== command.expectedState) {
      return {
        ok: false,
        label: 'STATE_DIVERGED',
        currentState: current.state,
        currentGeneration: current.captureGeneration,
      };
    }
    if (current.captureGeneration !== command.expectedGeneration) {
      return {
        ok: false,
        label: 'GENERATION_MISMATCH',
        currentState: current.state,
        currentGeneration: current.captureGeneration,
      };
    }

    const next = { ...current };
    next.state = command.targetState;
    next.admissionState = command.newAdmissionState;
    next.lastProcessedEventId = command.incomingEventId;
    if (
      command.eventSequenceNumber !== undefined &&
      command.eventSequenceNumber !== null
    ) {
      next.lastSequenceNumber = command.eventSequenceNumber;
    }
    if (command.failureReason !== undefined) {
      next.failureReason = command.failureReason;
    }
    if (command.targetState === 'CAPTURING' && !next.admittedAtUtc) {
      next.admittedAtUtc = command.eventTimestampUtc;
    }
    if (
      command.targetState === 'COMPLETED' ||
      command.targetState === 'INTERRUPTED' ||
      command.targetState === 'FAILED'
    ) {
      next.endedAtUtc = command.eventTimestampUtc;
    }

    this.inbox.add(command.incomingEventId);
    this.sessions.set(botSessionId, next);
    return { ok: true, session: { ...next } };
  }
}

const VALID_INSTANT = '2026-10-27T12:00:00Z';
const LATER_INSTANT = '2026-10-27T12:05:00Z';

function createJoiningSession(overrides = {}) {
  return {
    id: 's-1',
    meetingId: 'm-1',
    provider: 'vexa',
    state: 'JOINING',
    attempt: 1,
    idempotencyKey: 'idem-s-1',
    captureGeneration: 1,
    scheduleVersionAtActivation: 1,
    admissionState: null,
    externalSessionId: 'ext-s-1',
    correlationKey: 'corr-s-1',
    lastProcessedEventId: null,
    lastSequenceNumber: 1,
    startedAtUtc: VALID_INSTANT,
    admittedAtUtc: null,
    endedAtUtc: null,
    failureReason: null,
    ...overrides,
  };
}

function createCapturingSession(overrides = {}) {
  return createJoiningSession({
    state: 'CAPTURING',
    admissionState: 'ADMITTED',
    admittedAtUtc: VALID_INSTANT,
    lastSequenceNumber: 5,
    ...overrides,
  });
}

function buildService(initialSessions = []) {
  const repo = new InMemoryCaptureSessionRepository(initialSessions);
  const service = new CaptureSessionService(repo, new CaptureSessionPolicy());
  return { repo, service };
}

test('WAITING_FOR_HOST: updates admissionState to WAITING_FOR_HOST, keeps JOINING', async () => {
  const session = createJoiningSession();
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-lobby',
    eventKind: 'WAITING_FOR_HOST',
    eventTimestampUtc: VALID_INSTANT,
    sequenceNumber: 2,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.fromState, 'JOINING');
  assert.equal(outcome.toState, 'JOINING');
  assert.equal(outcome.toAdmissionState, 'WAITING_FOR_HOST');
  assert.equal(outcome.session.admissionState, 'WAITING_FOR_HOST');
  assert.equal(outcome.session.lastProcessedEventId, 'evt-lobby');
  assert.equal(outcome.session.lastSequenceNumber, 2);
});

test('ADMITTED: transitions JOINING to CAPTURING, sets admittedAtUtc', async () => {
  const session = createJoiningSession({ admissionState: 'WAITING_FOR_HOST' });
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-admit',
    eventKind: 'ADMITTED',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 3,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.fromState, 'JOINING');
  assert.equal(outcome.toState, 'CAPTURING');
  assert.equal(outcome.toAdmissionState, 'ADMITTED');
  assert.equal(outcome.session.state, 'CAPTURING');
  assert.equal(outcome.session.admittedAtUtc, LATER_INSTANT);
});

test('DENIED: transitions JOINING to FAILED with HOST_DENIED and sets endedAtUtc', async () => {
  const session = createJoiningSession();
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-deny',
    eventKind: 'DENIED',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 2,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.fromState, 'JOINING');
  assert.equal(outcome.toState, 'FAILED');
  assert.equal(outcome.toAdmissionState, 'DENIED');
  assert.equal(outcome.session.state, 'FAILED');
  assert.equal(outcome.session.failureReason, 'HOST_DENIED');
  assert.equal(outcome.session.endedAtUtc, LATER_INSTANT);
});

test('TIMED_OUT: transitions JOINING to FAILED with LOBBY_TIMEOUT and sets endedAtUtc', async () => {
  const session = createJoiningSession();
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-timeout',
    eventKind: 'TIMED_OUT',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 2,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.fromState, 'JOINING');
  assert.equal(outcome.toState, 'FAILED');
  assert.equal(outcome.toAdmissionState, 'TIMED_OUT');
  assert.equal(outcome.session.failureReason, 'LOBBY_TIMEOUT');
});

test('COMPLETED: transitions CAPTURING to COMPLETED, requires reconciliation, sets endedAtUtc', async () => {
  const session = createCapturingSession();
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-complete',
    eventKind: 'COMPLETED',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 10,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.fromState, 'CAPTURING');
  assert.equal(outcome.toState, 'COMPLETED');
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(outcome.partialFlagRequired, false);
  assert.equal(outcome.session.state, 'COMPLETED');
  assert.equal(outcome.session.endedAtUtc, LATER_INSTANT);
});

test('INTERRUPTED: transitions CAPTURING to INTERRUPTED, requires partial flag', async () => {
  const session = createCapturingSession();
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-crash',
    eventKind: 'INTERRUPTED',
    eventReason: 'Provider node disconnected',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 10,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.fromState, 'CAPTURING');
  assert.equal(outcome.toState, 'INTERRUPTED');
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(outcome.partialFlagRequired, true);
  assert.equal(outcome.session.state, 'INTERRUPTED');
  assert.equal(outcome.session.failureReason, 'Provider node disconnected');
});

test('idempotency: replaying event with same eventId returns IDEMPOTENT_REPLAY with zero storage mutation', async () => {
  const session = createCapturingSession({ lastProcessedEventId: 'evt-prev' });
  const { repo, service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-prev',
    eventKind: 'ADMITTED',
    eventTimestampUtc: LATER_INSTANT,
  });

  assert.equal(outcome.kind, 'IDEMPOTENT_REPLAY');
  assert.equal(outcome.toState, 'CAPTURING');
  assert.equal(repo.applyCalls, 0);
});

test('security: providerSignatureVerified=false fails closed without calling store', async () => {
  const session = createJoiningSession();
  const { repo, service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    botSessionId: 's-1',
    eventId: 'evt-untrusted',
    eventKind: 'ADMITTED',
    eventTimestampUtc: VALID_INSTANT,
    providerSignatureVerified: false,
  });

  assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(outcome.label, 'UNAUTHENTICATED');
  assert.equal(repo.loadCalls, 0);
});

test('concurrency: concurrent conflicting events race - loser receives STATE_DIVERGED', async () => {
  const session = createJoiningSession();
  const { service } = buildService([session]);

  const [res1, res2] = await Promise.all([
    service.processCaptureEvent({
      providerSignatureVerified: true,
      botSessionId: 's-1',
      eventId: 'evt-race-admit',
      eventKind: 'ADMITTED',
      eventTimestampUtc: LATER_INSTANT,
      sequenceNumber: 2,
    }),
    service.processCaptureEvent({
      providerSignatureVerified: true,
      botSessionId: 's-1',
      eventId: 'evt-race-deny',
      eventKind: 'DENIED',
      eventTimestampUtc: LATER_INSTANT,
      sequenceNumber: 3,
    }),
  ]);

  const transitioned = [res1, res2].filter((r) => r.kind === 'TRANSITIONED');
  const refused = [res1, res2].filter((r) => r.kind === 'REFUSED_DOWNSTREAM');

  assert.equal(transitioned.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].label, 'STATE_DIVERGED');
});

test('terminal state: contradictory provider event arriving after COMPLETED is refused', async () => {
  const session = createCapturingSession({
    state: 'COMPLETED',
    endedAtUtc: VALID_INSTANT,
  });
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-late-fail',
    eventKind: 'DENIED',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 20,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.refusalReason, 'ALREADY_COMPLETED');
});

test('ordering: event with stale sequence number is refused', async () => {
  const session = createCapturingSession({ lastSequenceNumber: 15 });
  const { service } = buildService([session]);

  const outcome = await service.processCaptureEvent({
    providerSignatureVerified: true,
    botSessionId: 's-1',
    eventId: 'evt-stale',
    eventKind: 'COMPLETED',
    eventTimestampUtc: LATER_INSTANT,
    sequenceNumber: 14,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.refusalReason, 'OUT_OF_ORDER_SEQUENCE');
});

test('shape guards: empty botSessionId or eventId throws invalid request', async () => {
  const { service } = buildService([]);

  await assert.rejects(
    () =>
      service.processCaptureEvent({
        providerSignatureVerified: true,
        botSessionId: '   ',
        eventId: 'evt-1',
        eventKind: 'ADMITTED',
        eventTimestampUtc: VALID_INSTANT,
      }),
    /^Error: capture-session-invalid-request$/,
  );

  await assert.rejects(
    () =>
      service.processCaptureEvent({
        providerSignatureVerified: true,
        botSessionId: 's-1',
        eventId: '   ',
        eventKind: 'ADMITTED',
        eventTimestampUtc: VALID_INSTANT,
      }),
    /^Error: capture-session-invalid-request$/,
  );
});

test('shape guards: malformed ISO timestamp throws invalid request', async () => {
  const { service } = buildService([]);

  await assert.rejects(
    () =>
      service.processCaptureEvent({
        providerSignatureVerified: true,
        botSessionId: 's-1',
        eventId: 'evt-1',
        eventKind: 'ADMITTED',
        eventTimestampUtc: 'not-a-timestamp',
      }),
    /^Error: capture-session-invalid-request$/,
  );
});

test('shape guards: negative sequence number throws invalid request', async () => {
  const { service } = buildService([]);

  await assert.rejects(
    () =>
      service.processCaptureEvent({
        providerSignatureVerified: true,
        botSessionId: 's-1',
        eventId: 'evt-1',
        eventKind: 'ADMITTED',
        eventTimestampUtc: VALID_INSTANT,
        sequenceNumber: -1,
      }),
    /^Error: capture-session-invalid-request$/,
  );
});

test('missing session throws race-lost', async () => {
  const { service } = buildService([]);

  await assert.rejects(
    () =>
      service.processCaptureEvent({
        providerSignatureVerified: true,
        botSessionId: 's-nonexistent',
        eventId: 'evt-1',
        eventKind: 'ADMITTED',
        eventTimestampUtc: VALID_INSTANT,
      }),
    /^Error: capture-session-race-lost$/,
  );
});

test('row integrity: mismatched ID or negative generation throws corrupt mapping', async () => {
  const corruptSession = createJoiningSession({ captureGeneration: -1 });
  const { service } = buildService([corruptSession]);

  await assert.rejects(
    () =>
      service.processCaptureEvent({
        providerSignatureVerified: true,
        botSessionId: 's-1',
        eventId: 'evt-1',
        eventKind: 'ADMITTED',
        eventTimestampUtc: VALID_INSTANT,
      }),
    /^Error: capture-session-row-mapping-corrupt$/,
  );
});
