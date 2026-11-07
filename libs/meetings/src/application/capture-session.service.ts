import {
  CaptureSessionPolicy,
  type CaptureEventKind,
  type CaptureStateVocabulary,
  type BotAdmissionStateVocabulary,
} from '../domain/capture-session.policy';
import type {
  CaptureSessionRecord,
  CaptureTransitionRefusalLabel,
  CaptureSessionRepository,
} from './capture-session.repository';

export type {
  CaptureSessionRecord,
  CaptureTransitionRefusalLabel,
  CaptureSessionRepository,
} from './capture-session.repository';

export interface ProcessCaptureEventQuery {
  readonly botSessionId: string;
  readonly eventId: string;
  readonly eventKind: CaptureEventKind;
  readonly eventTimestampUtc: string;
  readonly sequenceNumber?: number | null | undefined;
  readonly eventReason?: string | null | undefined;

  readonly providerSignatureVerified: boolean;
}

export type ProcessCaptureEventOutcome =
  | Readonly<{
      kind: 'TRANSITIONED';
      fromState: CaptureStateVocabulary;
      toState: CaptureStateVocabulary;
      toAdmissionState: BotAdmissionStateVocabulary | null;
      session: CaptureSessionRecord;
      reconciliationRequired: boolean;
      partialFlagRequired: boolean;
    }>
  | Readonly<{
      kind: 'IDEMPOTENT_REPLAY';
      fromState: CaptureStateVocabulary;
      toState: CaptureStateVocabulary;
      session: CaptureSessionRecord;
    }>
  | Readonly<{
      kind: 'REFUSED';
      refusalReason: string;
    }>
  | Readonly<{
      kind: 'REFUSED_DOWNSTREAM';
      label: CaptureTransitionRefusalLabel | 'UNAUTHENTICATED';
    }>;

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class CaptureSessionService {
  private readonly repository: CaptureSessionRepository;
  private readonly policy: CaptureSessionPolicy;

  constructor(
    repository: CaptureSessionRepository,
    policy?: CaptureSessionPolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new CaptureSessionPolicy();
  }

  async processCaptureEvent(
    query: Readonly<ProcessCaptureEventQuery>,
  ): Promise<ProcessCaptureEventOutcome> {
    if (query === null || typeof query !== 'object') {
      throw new Error('capture-session-invalid-request');
    }

    this.assertNonEmptyString(query.botSessionId);
    this.assertNonEmptyString(query.eventId);
    this.assertInstant(query.eventTimestampUtc);

    if (query.providerSignatureVerified !== true) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHENTICATED' };
    }

    if (
      query.sequenceNumber !== undefined &&
      query.sequenceNumber !== null &&
      (!Number.isInteger(query.sequenceNumber) || query.sequenceNumber < 0)
    ) {
      throw new Error('capture-session-invalid-request');
    }

    const session = await this.repository.loadSessionRecord(query.botSessionId);
    if (session === null) {
      throw new Error('capture-session-race-lost');
    }
    this.assertRecordIntegrity(session, query.botSessionId);

    const evaluation = this.policy.evaluate({
      currentCaptureState: session.state,
      currentAdmissionState: session.admissionState,
      lastSequenceNumber: session.lastSequenceNumber,
      eventKind: query.eventKind,
      eventSequenceNumber: query.sequenceNumber,
      eventReason: query.eventReason,
      lastProcessedEventId: session.lastProcessedEventId,
      incomingEventId: query.eventId,
    });

    if (!evaluation.ok) {
      return { kind: 'REFUSED', refusalReason: evaluation.refusalReason };
    }

    if (evaluation.transition === 'NO_OP_IDEMPOTENT_REPLAY') {
      return {
        kind: 'IDEMPOTENT_REPLAY',
        fromState: session.state,
        toState: session.state,
        session,
      };
    }

    const applied = await this.repository.applyCaptureEventTransition(
      query.botSessionId,
      {
        incomingEventId: query.eventId,
        eventKind: query.eventKind,
        expectedState: session.state,
        targetState: evaluation.toCaptureState,
        expectedGeneration: session.captureGeneration,
        newAdmissionState: evaluation.toAdmissionState,
        eventSequenceNumber: query.sequenceNumber,
        failureReason: evaluation.failureReason,
        eventTimestampUtc: query.eventTimestampUtc,
        reconciliationRequired: evaluation.reconciliationRequired,
        partialFlagRequired: evaluation.partialFlagRequired,
      },
    );

    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }
    this.assertRecordIntegrity(applied.session, query.botSessionId);
    if (
      applied.session.meetingId !== session.meetingId ||
      applied.session.captureGeneration !== session.captureGeneration ||
      applied.session.idempotencyKey !== session.idempotencyKey ||
      applied.session.state !== evaluation.toCaptureState ||
      applied.session.admissionState !== evaluation.toAdmissionState
    ) {
      throw new Error('capture-session-row-mapping-corrupt');
    }

    return {
      kind: 'TRANSITIONED',
      fromState: evaluation.fromCaptureState,
      toState: evaluation.toCaptureState,
      toAdmissionState: evaluation.toAdmissionState,
      session: applied.session,
      reconciliationRequired: evaluation.reconciliationRequired,
      partialFlagRequired: evaluation.partialFlagRequired,
    };
  }

  private assertNonEmptyString(value: unknown): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('capture-session-invalid-request');
    }
  }

  private assertInstant(instant: string): void {
    if (
      typeof instant !== 'string' ||
      instant.trim() === '' ||
      !ISO_8601_INSTANT.test(instant) ||
      Number.isNaN(Date.parse(instant))
    ) {
      throw new Error('capture-session-invalid-request');
    }
  }

  private assertRecordIntegrity(
    session: CaptureSessionRecord,
    expectedSessionId: string,
  ): void {
    if (
      session.id !== expectedSessionId ||
      typeof session.meetingId !== 'string' ||
      session.meetingId.trim() === '' ||
      typeof session.idempotencyKey !== 'string' ||
      session.idempotencyKey.trim() === '' ||
      typeof session.captureGeneration !== 'number' ||
      !Number.isInteger(session.captureGeneration) ||
      session.captureGeneration < 0
    ) {
      throw new Error('capture-session-row-mapping-corrupt');
    }
  }
}
