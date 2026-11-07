'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  CaptureSessionPolicy,
} = require('../../src/domain/capture-session.policy.ts');

const policy = new CaptureSessionPolicy();

test('WAITING_FOR_HOST: moves admissionState to WAITING_FOR_HOST while keeping session in JOINING', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    currentAdmissionState: null,
    eventKind: 'WAITING_FOR_HOST',
    incomingEventId: 'evt-1',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.transition, 'STATE_CHANGED');
  assert.equal(outcome.fromCaptureState, 'JOINING');
  assert.equal(outcome.toCaptureState, 'JOINING');
  assert.equal(outcome.toAdmissionState, 'WAITING_FOR_HOST');
  assert.equal(outcome.reconciliationRequired, false);
  assert.equal(outcome.partialFlagRequired, false);
});

test('ADMITTED: transitions JOINING to CAPTURING and sets admissionState to ADMITTED', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    currentAdmissionState: 'WAITING_FOR_HOST',
    eventKind: 'ADMITTED',
    incomingEventId: 'evt-2',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.transition, 'STATE_CHANGED');
  assert.equal(outcome.fromCaptureState, 'JOINING');
  assert.equal(outcome.toCaptureState, 'CAPTURING');
  assert.equal(outcome.toAdmissionState, 'ADMITTED');
  assert.equal(outcome.reconciliationRequired, false);
  assert.equal(outcome.partialFlagRequired, false);
});

test('DENIED: transitions JOINING to FAILED and records HOST_DENIED reason', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    currentAdmissionState: 'WAITING_FOR_HOST',
    eventKind: 'DENIED',
    incomingEventId: 'evt-3',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.transition, 'STATE_CHANGED');
  assert.equal(outcome.fromCaptureState, 'JOINING');
  assert.equal(outcome.toCaptureState, 'FAILED');
  assert.equal(outcome.toAdmissionState, 'DENIED');
  assert.equal(outcome.failureReason, 'HOST_DENIED');
});

test('DENIED: preserves custom refusal reason from provider', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    eventKind: 'DENIED',
    eventReason: 'Host explicitly clicked deny',
    incomingEventId: 'evt-3b',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.failureReason, 'Host explicitly clicked deny');
});

test('TIMED_OUT: transitions JOINING to FAILED and records LOBBY_TIMEOUT', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    eventKind: 'TIMED_OUT',
    incomingEventId: 'evt-4',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.fromCaptureState, 'JOINING');
  assert.equal(outcome.toCaptureState, 'FAILED');
  assert.equal(outcome.toAdmissionState, 'TIMED_OUT');
  assert.equal(outcome.failureReason, 'LOBBY_TIMEOUT');
});

test('COMPLETED: transitions CAPTURING to COMPLETED and sets reconciliationRequired', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'CAPTURING',
    currentAdmissionState: 'ADMITTED',
    eventKind: 'COMPLETED',
    incomingEventId: 'evt-5',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.fromCaptureState, 'CAPTURING');
  assert.equal(outcome.toCaptureState, 'COMPLETED');
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(outcome.partialFlagRequired, false);
});

test('INTERRUPTED from CAPTURING: moves to INTERRUPTED, sets partialFlag and reconciliationRequired', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'CAPTURING',
    currentAdmissionState: 'ADMITTED',
    eventKind: 'INTERRUPTED',
    eventReason: 'WebRTC stream severed unexpectedly',
    incomingEventId: 'evt-6',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.fromCaptureState, 'CAPTURING');
  assert.equal(outcome.toCaptureState, 'INTERRUPTED');
  assert.equal(outcome.failureReason, 'WebRTC stream severed unexpectedly');
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(outcome.partialFlagRequired, true);
});

test('INTERRUPTED from JOINING: moves to INTERRUPTED if provider process crashes in lobby', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    eventKind: 'INTERRUPTED',
    incomingEventId: 'evt-6b',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.fromCaptureState, 'JOINING');
  assert.equal(outcome.toCaptureState, 'INTERRUPTED');
  assert.equal(outcome.failureReason, 'PROVIDER_INTERRUPTED');
});

test('idempotent replay: identical incomingEventId returns NO_OP_IDEMPOTENT_REPLAY', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'CAPTURING',
    currentAdmissionState: 'ADMITTED',
    lastProcessedEventId: 'evt-dup',
    incomingEventId: 'evt-dup',
    eventKind: 'ADMITTED',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.transition, 'NO_OP_IDEMPOTENT_REPLAY');
  assert.equal(outcome.toCaptureState, 'CAPTURING');
});

test('terminal state protection: COMPLETED never regresses even on contradictory FAILED/INTERRUPTED event', () => {
  const outcomeFailed = policy.evaluate({
    currentCaptureState: 'COMPLETED',
    eventKind: 'DENIED',
    incomingEventId: 'evt-late-fail',
  });
  assert.equal(outcomeFailed.ok, false);
  assert.equal(outcomeFailed.refusalReason, 'ALREADY_COMPLETED');

  const outcomeInterrupt = policy.evaluate({
    currentCaptureState: 'COMPLETED',
    eventKind: 'INTERRUPTED',
    incomingEventId: 'evt-late-interrupt',
  });
  assert.equal(outcomeInterrupt.ok, false);
  assert.equal(outcomeInterrupt.refusalReason, 'ALREADY_COMPLETED');
});

test('terminal state protection: FAILED session rejects further events', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'FAILED',
    eventKind: 'ADMITTED',
    incomingEventId: 'evt-after-failed',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusalReason, 'TERMINAL_STATE');
});

test('terminal state protection: INTERRUPTED session rejects further events', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'INTERRUPTED',
    eventKind: 'COMPLETED',
    incomingEventId: 'evt-after-interrupted',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusalReason, 'TERMINAL_STATE');
});

test('monotonic sequence: out-of-order sequence number is rejected', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    lastSequenceNumber: 5,
    eventSequenceNumber: 4,
    eventKind: 'ADMITTED',
    incomingEventId: 'evt-stale',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusalReason, 'OUT_OF_ORDER_SEQUENCE');
});

test('monotonic sequence: strictly greater sequence number is accepted', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    lastSequenceNumber: 5,
    eventSequenceNumber: 6,
    eventKind: 'ADMITTED',
    incomingEventId: 'evt-fresh',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.toCaptureState, 'CAPTURING');
});

test('illegal transition: COMPLETED directly from JOINING is rejected', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'JOINING',
    eventKind: 'COMPLETED',
    incomingEventId: 'evt-illegal',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusalReason, 'ILLEGAL_TRANSITION');
});

test('illegal transition: WAITING_FOR_HOST from CAPTURING is rejected', () => {
  const outcome = policy.evaluate({
    currentCaptureState: 'CAPTURING',
    eventKind: 'WAITING_FOR_HOST',
    incomingEventId: 'evt-illegal-2',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusalReason, 'ILLEGAL_TRANSITION');
});

test('shape guards: empty incomingEventId or invalid object fails closed', () => {
  assert.deepEqual(policy.evaluate(null), {
    ok: false,
    refusalReason: 'INVALID_EVENT_SHAPE',
  });

  assert.deepEqual(
    policy.evaluate({
      currentCaptureState: 'JOINING',
      eventKind: 'ADMITTED',
      incomingEventId: '   ',
    }),
    { ok: false, refusalReason: 'INVALID_EVENT_SHAPE' },
  );

  assert.deepEqual(
    policy.evaluate({
      currentCaptureState: 'BOGUS_STATE',
      eventKind: 'ADMITTED',
      incomingEventId: 'evt-1',
    }),
    { ok: false, refusalReason: 'UNKNOWN_CURRENT_STATE' },
  );

  assert.deepEqual(
    policy.evaluate({
      currentCaptureState: 'JOINING',
      eventKind: 'BOGUS_EVENT',
      incomingEventId: 'evt-1',
    }),
    { ok: false, refusalReason: 'UNKNOWN_EVENT_KIND' },
  );
});
