export type CaptureStateVocabulary =
  | 'NOT_REQUESTED'
  | 'QUEUED'
  | 'JOINING'
  | 'CAPTURING'
  | 'COMPLETED'
  | 'INTERRUPTED'
  | 'FAILED';

export type BotAdmissionStateVocabulary =
  'WAITING_FOR_HOST' | 'ADMITTED' | 'DENIED' | 'TIMED_OUT';

export type CaptureEventKind =
  | 'WAITING_FOR_HOST'
  | 'ADMITTED'
  | 'DENIED'
  | 'TIMED_OUT'
  | 'COMPLETED'
  | 'INTERRUPTED';

export interface EvaluateCaptureEventInput {
  readonly currentCaptureState: CaptureStateVocabulary;
  readonly currentAdmissionState?:
    BotAdmissionStateVocabulary | null | undefined;
  readonly lastSequenceNumber?: number | null | undefined;
  readonly eventKind: CaptureEventKind;
  readonly eventSequenceNumber?: number | null | undefined;
  readonly eventReason?: string | null | undefined;
  readonly lastProcessedEventId?: string | null | undefined;
  readonly incomingEventId: string;
}

export type CaptureSessionEvaluationOutcome =
  | Readonly<{
      ok: true;
      transition: 'STATE_CHANGED' | 'NO_OP_IDEMPOTENT_REPLAY';
      fromCaptureState: CaptureStateVocabulary;
      toCaptureState: CaptureStateVocabulary;
      toAdmissionState: BotAdmissionStateVocabulary | null;
      failureReason?: string | null | undefined;
      reconciliationRequired: boolean;
      partialFlagRequired: boolean;
    }>
  | Readonly<{
      ok: false;
      refusalReason:
        | 'INVALID_EVENT_SHAPE'
        | 'UNKNOWN_EVENT_KIND'
        | 'UNKNOWN_CURRENT_STATE'
        | 'ILLEGAL_TRANSITION'
        | 'ALREADY_COMPLETED'
        | 'TERMINAL_STATE'
        | 'OUT_OF_ORDER_SEQUENCE';
    }>;

const VALID_CAPTURE_STATES: ReadonlySet<CaptureStateVocabulary> = new Set([
  'NOT_REQUESTED',
  'QUEUED',
  'JOINING',
  'CAPTURING',
  'COMPLETED',
  'INTERRUPTED',
  'FAILED',
]);

const VALID_EVENT_KINDS: ReadonlySet<CaptureEventKind> = new Set([
  'WAITING_FOR_HOST',
  'ADMITTED',
  'DENIED',
  'TIMED_OUT',
  'COMPLETED',
  'INTERRUPTED',
]);

export class CaptureSessionPolicy {
  evaluate(input: EvaluateCaptureEventInput): CaptureSessionEvaluationOutcome {
    if (input === null || typeof input !== 'object') {
      return { ok: false, refusalReason: 'INVALID_EVENT_SHAPE' };
    }

    if (
      typeof input.incomingEventId !== 'string' ||
      input.incomingEventId.trim() === ''
    ) {
      return { ok: false, refusalReason: 'INVALID_EVENT_SHAPE' };
    }

    if (!VALID_CAPTURE_STATES.has(input.currentCaptureState)) {
      return { ok: false, refusalReason: 'UNKNOWN_CURRENT_STATE' };
    }

    if (!VALID_EVENT_KINDS.has(input.eventKind)) {
      return { ok: false, refusalReason: 'UNKNOWN_EVENT_KIND' };
    }

    if (
      typeof input.lastProcessedEventId === 'string' &&
      input.lastProcessedEventId === input.incomingEventId
    ) {
      return {
        ok: true,
        transition: 'NO_OP_IDEMPOTENT_REPLAY',
        fromCaptureState: input.currentCaptureState,
        toCaptureState: input.currentCaptureState,
        toAdmissionState: input.currentAdmissionState ?? null,
        reconciliationRequired: false,
        partialFlagRequired: false,
      };
    }

    if (input.currentCaptureState === 'COMPLETED') {
      return { ok: false, refusalReason: 'ALREADY_COMPLETED' };
    }

    if (
      input.currentCaptureState === 'FAILED' ||
      input.currentCaptureState === 'INTERRUPTED'
    ) {
      return { ok: false, refusalReason: 'TERMINAL_STATE' };
    }

    if (
      typeof input.eventSequenceNumber === 'number' &&
      typeof input.lastSequenceNumber === 'number'
    ) {
      if (input.eventSequenceNumber <= input.lastSequenceNumber) {
        return { ok: false, refusalReason: 'OUT_OF_ORDER_SEQUENCE' };
      }
    }

    switch (input.eventKind) {
      case 'WAITING_FOR_HOST': {
        if (input.currentCaptureState !== 'JOINING') {
          return { ok: false, refusalReason: 'ILLEGAL_TRANSITION' };
        }
        return {
          ok: true,
          transition: 'STATE_CHANGED',
          fromCaptureState: 'JOINING',
          toCaptureState: 'JOINING',
          toAdmissionState: 'WAITING_FOR_HOST',
          reconciliationRequired: false,
          partialFlagRequired: false,
        };
      }

      case 'ADMITTED': {
        if (input.currentCaptureState !== 'JOINING') {
          return { ok: false, refusalReason: 'ILLEGAL_TRANSITION' };
        }
        return {
          ok: true,
          transition: 'STATE_CHANGED',
          fromCaptureState: 'JOINING',
          toCaptureState: 'CAPTURING',
          toAdmissionState: 'ADMITTED',
          reconciliationRequired: false,
          partialFlagRequired: false,
        };
      }

      case 'DENIED': {
        if (input.currentCaptureState !== 'JOINING') {
          return { ok: false, refusalReason: 'ILLEGAL_TRANSITION' };
        }
        return {
          ok: true,
          transition: 'STATE_CHANGED',
          fromCaptureState: 'JOINING',
          toCaptureState: 'FAILED',
          toAdmissionState: 'DENIED',
          failureReason: input.eventReason?.trim() || 'HOST_DENIED',
          reconciliationRequired: false,
          partialFlagRequired: false,
        };
      }

      case 'TIMED_OUT': {
        if (input.currentCaptureState !== 'JOINING') {
          return { ok: false, refusalReason: 'ILLEGAL_TRANSITION' };
        }
        return {
          ok: true,
          transition: 'STATE_CHANGED',
          fromCaptureState: 'JOINING',
          toCaptureState: 'FAILED',
          toAdmissionState: 'TIMED_OUT',
          failureReason: input.eventReason?.trim() || 'LOBBY_TIMEOUT',
          reconciliationRequired: false,
          partialFlagRequired: false,
        };
      }

      case 'COMPLETED': {
        if (input.currentCaptureState !== 'CAPTURING') {
          return { ok: false, refusalReason: 'ILLEGAL_TRANSITION' };
        }
        return {
          ok: true,
          transition: 'STATE_CHANGED',
          fromCaptureState: 'CAPTURING',
          toCaptureState: 'COMPLETED',
          toAdmissionState: input.currentAdmissionState ?? 'ADMITTED',
          reconciliationRequired: true,
          partialFlagRequired: false,
        };
      }

      case 'INTERRUPTED': {
        if (
          input.currentCaptureState !== 'JOINING' &&
          input.currentCaptureState !== 'CAPTURING'
        ) {
          return { ok: false, refusalReason: 'ILLEGAL_TRANSITION' };
        }
        return {
          ok: true,
          transition: 'STATE_CHANGED',
          fromCaptureState: input.currentCaptureState,
          toCaptureState: 'INTERRUPTED',
          toAdmissionState: input.currentAdmissionState ?? null,
          failureReason: input.eventReason?.trim() || 'PROVIDER_INTERRUPTED',
          reconciliationRequired: true,
          partialFlagRequired: true,
        };
      }

      default:
        return { ok: false, refusalReason: 'UNKNOWN_EVENT_KIND' };
    }
  }
}
