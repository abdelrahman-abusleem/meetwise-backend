import type {
  CaptureStateVocabulary,
  BotAdmissionStateVocabulary,
  CaptureEventKind,
} from '../domain/capture-session.policy';

export interface CaptureSessionRecord {
  readonly id: string;
  readonly meetingId: string;
  readonly provider: string;
  readonly state: CaptureStateVocabulary;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly captureGeneration: number;
  readonly scheduleVersionAtActivation: number;
  readonly admissionState: BotAdmissionStateVocabulary | null;
  readonly externalSessionId: string | null;
  readonly correlationKey: string | null;
  readonly lastProcessedEventId: string | null;
  readonly lastSequenceNumber: number | null;
  readonly startedAtUtc: string | null;
  readonly admittedAtUtc: string | null;
  readonly endedAtUtc: string | null;
  readonly failureReason: string | null;
}

export type CaptureTransitionRefusalLabel =
  | 'SESSION_NOT_FOUND'
  | 'STATE_DIVERGED'
  | 'GENERATION_MISMATCH'
  | 'DUPLICATE_EVENT_RECORDED';

export type ApplyCaptureEventResult =
  | Readonly<{ ok: true; session: CaptureSessionRecord }>
  | Readonly<{
      ok: false;
      label: CaptureTransitionRefusalLabel;
      currentState?: CaptureStateVocabulary;
      currentGeneration?: number;
    }>;

export interface ApplyCaptureEventCommand {
  readonly incomingEventId: string;
  readonly eventKind: CaptureEventKind;
  readonly expectedState: CaptureStateVocabulary;
  readonly targetState: CaptureStateVocabulary;
  readonly expectedGeneration: number;
  readonly newAdmissionState: BotAdmissionStateVocabulary | null;
  readonly eventSequenceNumber?: number | null | undefined;
  readonly failureReason?: string | null | undefined;
  readonly eventTimestampUtc: string;
  readonly reconciliationRequired: boolean;
  readonly partialFlagRequired: boolean;
}

export interface CaptureSessionRepository {
  loadSessionRecord(botSessionId: string): Promise<CaptureSessionRecord | null>;

  applyCaptureEventTransition(
    botSessionId: string,
    command: ApplyCaptureEventCommand,
  ): Promise<ApplyCaptureEventResult>;
}
