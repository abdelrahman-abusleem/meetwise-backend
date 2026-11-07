export type CaptureStateVocabulary =
  | 'NOT_REQUESTED'
  | 'QUEUED'
  | 'JOINING'
  | 'CAPTURING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED';

export type BotAdmissionStateVocabulary =
  'WAITING_FOR_HOST' | 'ADMITTED' | 'DENIED' | 'TIMED_OUT';

export interface BotJoinJob {
  readonly meetingId: string;

  readonly botSessionId: string;

  readonly idempotencyKey: string;
}

export interface BotSessionRecord {
  readonly id: string;
  readonly meetingId: string;

  readonly provider: string;

  readonly state: string;
  readonly attempt: number;

  readonly idempotencyKey: string;

  readonly captureGeneration: number;

  readonly scheduleVersionAtActivation: number;

  readonly admissionState: BotAdmissionStateVocabulary | null;
  readonly externalSessionId: string | null;

  readonly correlationKey: string | null;
  readonly providerMetadataSafe: string | null;
}

export interface BotJoinOccurrenceFacts {
  readonly meetingId: string;

  readonly meetingKind: string;
  readonly meetingLifecycle: string;

  readonly meetUrl: string | null;

  readonly scheduledAtUtc: string | null;

  readonly captureStatus: string;

  readonly scheduleVersion: number;
  readonly departmentId: string | null;

  readonly departmentActivationState: string | null;

  readonly providerConnectionAuthorized: boolean;
  readonly providerConfigEnabled: boolean;

  readonly capturePrerequisitesVerified: boolean;
}

export interface BotJoinRecord extends BotJoinOccurrenceFacts {
  readonly sessionForJob: BotSessionRecord | null;
}

export interface BotJoinRequeueRecord {
  readonly occurrence: BotJoinOccurrenceFacts;
}

export type BotJoinClaimRefusalLabel =
  'GONE' | 'NOT_QUEUED' | 'KEY_MISMATCH' | 'STALE_VERSION';

export type BotJoinClaimOutcome =
  | Readonly<{ ok: true; session: BotSessionRecord }>
  | Readonly<{ ok: false; label: BotJoinClaimRefusalLabel }>;

export type BotJoinOutcomeRefusalLabel = 'GONE' | 'NOT_JOINING';

export type BotJoinOutcomeRecord =
  | Readonly<{ ok: true; session: BotSessionRecord }>
  | Readonly<{
      ok: false;
      label: BotJoinOutcomeRefusalLabel;

      currentState: string | null;
    }>;

export type BotJoinRequeueRefusalLabel =
  'GONE' | 'NO_TERMINAL_CAPTURE' | 'ACTIVE_ATTEMPT_EXISTS';

export type BotJoinRequeueResult =
  | Readonly<{ ok: true; session: BotSessionRecord }>
  | Readonly<{ ok: false; label: BotJoinRequeueRefusalLabel }>;

export interface CreateRetriggerAttemptCommand {
  readonly triggeredByUserId: string;
}

export interface BotJoinRepository {
  loadJoinRecord(job: BotJoinJob): Promise<BotJoinRecord | null>;

  claimJoining(job: BotJoinJob): Promise<BotJoinClaimOutcome>;

  recordJoinAttemptOutcome(
    job: BotJoinJob,
    command: Readonly<{
      makeFailed: boolean;
      admissionState: BotAdmissionStateVocabulary | null;
    }>,
  ): Promise<BotJoinOutcomeRecord>;

  loadRequeueRecord(meetingId: string): Promise<BotJoinRequeueRecord | null>;

  createRetriggerAttempt(
    meetingId: string,
    command: CreateRetriggerAttemptCommand,
  ): Promise<BotJoinRequeueResult>;
}
