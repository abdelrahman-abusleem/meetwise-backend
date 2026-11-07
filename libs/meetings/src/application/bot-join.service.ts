import { BotJoinEligibilityPolicy } from '../domain/bot-join-eligibility.policy';
import type { EligibilityFailure } from '../domain/bot-join-eligibility.policy';
import type {
  BotAdmissionStateVocabulary,
  BotJoinClaimRefusalLabel,
  BotJoinJob,
  BotJoinOccurrenceFacts,
  BotJoinRecord,
  BotSessionRecord,
  BotJoinRequeueRefusalLabel,
  BotJoinRepository,
} from './bot-join.repository';
import type {
  BotJoinDispatchPayload,
  BotJoinPortObservation,
  BotJoinProviderPort,
} from './bot-join-provider.port';

const CAPTURE_STATES: Readonly<string[]> = Object.freeze([
  'NOT_REQUESTED',
  'QUEUED',
  'JOINING',
  'CAPTURING',
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
]);

const PORT_OBSERVATIONS: Readonly<string[]> = Object.freeze([
  'JOINING',
  'WAITING_FOR_HOST',
  'ADMITTED',
  'DENIED',
  'TIMED_OUT',
  'PROVIDER_UNAVAILABLE',
]);

const ADMISSION_STATES: Readonly<string[]> = Object.freeze([
  'WAITING_FOR_HOST',
  'ADMITTED',
  'DENIED',
  'TIMED_OUT',
]);

const FAILED_OBSERVATIONS: Readonly<string[]> = Object.freeze([
  'DENIED',
  'TIMED_OUT',
  'PROVIDER_UNAVAILABLE',
]);

export type BotJoinDispatchOutcome = Readonly<
  | {
      kind: 'DISPATCHED';

      portObservation: BotJoinPortObservation;
      session: {
        readonly id: string;
        readonly state: string;
        readonly admissionState: BotAdmissionStateVocabulary | null;
      };
    }
  | {
      kind: 'REFUSED';

      policyReason: EligibilityFailure;
    }
  | {
      kind: 'REFUSED_DOWNSTREAM';

      label: BotJoinClaimRefusalLabel;
    }
  | {
      kind: 'OUTCOME_RECORD_REFUSED';

      portObservation: BotJoinPortObservation;
      label: 'GONE' | 'NOT_JOINING';
      currentState: string | null;
    }
>;

export type BotJoinRequeueOutcome = Readonly<
  | {
      kind: 'REQUEUED';

      session: {
        readonly id: string;
        readonly state: string;
        readonly attempt: number;
        readonly idempotencyKey: string;
        readonly captureGeneration: number;
      };
    }
  | {
      kind: 'REFUSED';

      policyReason: EligibilityFailure;
    }
  | {
      kind: 'REFUSED_DOWNSTREAM';
      label: BotJoinRequeueRefusalLabel | 'UNAUTHORIZED_TRIGGER';
    }
>;

export type SystemRoleVocabulary = 'OWNER' | 'MANAGER' | 'MEMBER';
export type DepartmentRoleVocabulary = 'ADMIN' | 'MEMBER';
export type MeetingRoleVocabulary =
  'MEETING_ADMIN' | 'REVIEWER' | 'APPROVER' | 'VIEWER';

export interface BotJoinRetriggerActor {
  readonly userId: string;
  readonly systemRole: SystemRoleVocabulary;
  readonly departmentId?: string | null;
  readonly departmentRole?: DepartmentRoleVocabulary | null;
  readonly meetingRole?: MeetingRoleVocabulary | null;
}

export interface BotJoinRetriggerRequest {
  readonly dispatchAt: string;

  readonly actor: BotJoinRetriggerActor;
}

export class BotJoinDispatchService {
  private readonly repository: BotJoinRepository;
  private readonly providerPort: BotJoinProviderPort;
  private readonly policy: BotJoinEligibilityPolicy;

  constructor(
    repository: BotJoinRepository,
    providerPort: BotJoinProviderPort,
    policy: BotJoinEligibilityPolicy,
  ) {
    this.repository = repository;
    this.providerPort = providerPort;
    this.policy = policy;
  }

  async dispatchFromDelivery(
    job: BotJoinJob,
    request: Readonly<{ dispatchAt: string }>,
  ): Promise<BotJoinDispatchOutcome> {
    this.assertJobShape(job);
    if (typeof request?.dispatchAt !== 'string') {
      throw new Error('bot-join-invalid-request');
    }
    const facts = await this.repository.loadJoinRecord(job);
    if (facts === null) {
      throw new Error('bot-join-race-lost');
    }
    this.assertRecordIntegrity(facts, job);

    const session = facts.sessionForJob;
    const decision = this.policy.evaluate({
      meetingId: facts.meetingId,
      meetingKind: facts.meetingKind,
      meetingLifecycle: facts.meetingLifecycle,
      occurrenceStartAt:
        facts.scheduledAtUtc === null ? undefined : facts.scheduledAtUtc,
      dispatchAt: request.dispatchAt,

      staleJob:
        session === null || session.idempotencyKey !== job.idempotencyKey,
      scheduleVersionExpected:
        session === null
          ? facts.scheduleVersion
          : session.scheduleVersionAtActivation,
      scheduleVersionCurrent: facts.scheduleVersion,
      meetUrl: facts.meetUrl === null ? undefined : facts.meetUrl,
      departmentActivationState:
        facts.departmentActivationState === null
          ? undefined
          : facts.departmentActivationState,
      providerConnectionAuthorized: facts.providerConnectionAuthorized,
      providerConfigEnabled: facts.providerConfigEnabled,
      capturePrerequisitesVerified: facts.capturePrerequisitesVerified,
    });
    if (decision.ok !== true) {
      return {
        kind: 'REFUSED',
        policyReason: decision.reason as EligibilityFailure,
      };
    }

    const claim = await this.repository.claimJoining(job);
    if (claim.ok !== true) {
      return { kind: 'REFUSED_DOWNSTREAM', label: claim.label };
    }
    this.assertRecordIntegrity({ ...facts, sessionForJob: claim.session }, job);
    if (
      claim.session.state !== 'JOINING' ||
      !session ||
      claim.session.idempotencyKey !== job.idempotencyKey ||
      claim.session.attempt !== session.attempt ||
      claim.session.captureGeneration !== session.captureGeneration ||
      claim.session.scheduleVersionAtActivation !==
        session.scheduleVersionAtActivation ||
      claim.session.provider !== session.provider
    ) {
      throw new Error('bot-join-row-mapping-corrupt');
    }

    const payload: BotJoinDispatchPayload = {
      meetingId: job.meetingId,
      botSessionId: job.botSessionId,
      idempotencyKey: job.idempotencyKey,
      attempt: claim.session.attempt,
      joinUrl: this.assertDispatchableJoinUrl(facts),
    };
    const observation = await this.providerPort.attemptJoin(payload);
    if (PORT_OBSERVATIONS.indexOf(observation) === -1) {
      throw new Error('bot-join-provider-port-violation');
    }
    const recorded = await this.repository.recordJoinAttemptOutcome(job, {
      makeFailed: FAILED_OBSERVATIONS.indexOf(observation) !== -1,
      admissionState:
        ADMISSION_STATES.indexOf(observation) !== -1
          ? (observation as BotAdmissionStateVocabulary)
          : null,
    });
    if (recorded.ok !== true) {
      return {
        kind: 'OUTCOME_RECORD_REFUSED',
        portObservation: observation,
        label: recorded.label,
        currentState: recorded.currentState,
      };
    }
    this.assertRecordIntegrity(
      { ...facts, sessionForJob: recorded.session },
      job,
    );
    this.assertSameAttempt(recorded.session, claim.session);
    const expectedState =
      FAILED_OBSERVATIONS.indexOf(observation) !== -1 ? 'FAILED' : 'JOINING';
    if (recorded.session.state !== expectedState)
      throw new Error('bot-join-row-mapping-corrupt');
    return {
      kind: 'DISPATCHED',
      portObservation: observation,
      session: {
        id: recorded.session.id,
        state: recorded.session.state,
        admissionState: recorded.session.admissionState,
      },
    };
  }

  async requeueForRetrigger(
    meetingId: string,
    request: Readonly<BotJoinRetriggerRequest>,
  ): Promise<BotJoinRequeueOutcome> {
    if (typeof meetingId !== 'string' || meetingId.trim() === '') {
      throw new Error('bot-join-invalid-request');
    }
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.dispatchAt !== 'string' ||
      request.dispatchAt.trim() === ''
    ) {
      throw new Error('bot-join-invalid-request');
    }

    this.assertActorShape(request.actor);

    const record = await this.repository.loadRequeueRecord(meetingId);
    if (record === null) {
      throw new Error('bot-join-race-lost');
    }
    const facts = record.occurrence;
    this.assertOccurrenceIntegrity(facts);

    if (!this.isActorAuthorizedForRetrigger(request.actor, facts)) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED_TRIGGER' };
    }

    const decision = this.policy.evaluate({
      meetingId: facts.meetingId,
      meetingKind: facts.meetingKind,
      meetingLifecycle: facts.meetingLifecycle,
      occurrenceStartAt:
        facts.scheduledAtUtc === null ? undefined : facts.scheduledAtUtc,
      dispatchAt: request.dispatchAt,
      staleJob: false,
      scheduleVersionExpected: facts.scheduleVersion,
      scheduleVersionCurrent: facts.scheduleVersion,
      meetUrl: facts.meetUrl === null ? undefined : facts.meetUrl,
      departmentActivationState:
        facts.departmentActivationState === null
          ? undefined
          : facts.departmentActivationState,
      providerConnectionAuthorized: facts.providerConnectionAuthorized,
      providerConfigEnabled: facts.providerConfigEnabled,
      capturePrerequisitesVerified: facts.capturePrerequisitesVerified,
    });
    if (decision.ok !== true) {
      return {
        kind: 'REFUSED',
        policyReason: decision.reason as EligibilityFailure,
      };
    }

    const command = { triggeredByUserId: request.actor.userId };
    const created = await this.repository.createRetriggerAttempt(
      meetingId,
      command,
    );
    if (created.ok !== true) {
      return { kind: 'REFUSED_DOWNSTREAM', label: created.label };
    }
    if (created.session.state !== 'QUEUED') {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    this.assertRecordIntegrity(
      { ...facts, sessionForJob: created.session },
      {
        meetingId,
        botSessionId: created.session.id,
        idempotencyKey: created.session.idempotencyKey,
      },
    );
    if (created.session.scheduleVersionAtActivation !== facts.scheduleVersion) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    return {
      kind: 'REQUEUED',
      session: {
        id: created.session.id,
        state: created.session.state,
        attempt: created.session.attempt,
        idempotencyKey: created.session.idempotencyKey,
        captureGeneration: created.session.captureGeneration,
      },
    };
  }

  private assertJobShape(job: BotJoinJob): void {
    if (
      job === null ||
      typeof job !== 'object' ||
      typeof job.meetingId !== 'string' ||
      typeof job.botSessionId !== 'string' ||
      typeof job.idempotencyKey !== 'string' ||
      job.meetingId.trim() === '' ||
      job.botSessionId.trim() === '' ||
      job.idempotencyKey.trim() === ''
    ) {
      throw new Error('bot-join-invalid-request');
    }
  }

  private assertActorShape(actor: BotJoinRetriggerActor): void {
    if (
      actor === null ||
      typeof actor !== 'object' ||
      typeof actor.userId !== 'string' ||
      actor.userId.trim() === '' ||
      typeof actor.systemRole !== 'string' ||
      (actor.systemRole !== 'OWNER' &&
        actor.systemRole !== 'MANAGER' &&
        actor.systemRole !== 'MEMBER')
    ) {
      throw new Error('bot-join-invalid-request');
    }
    if (
      actor.departmentRole !== undefined &&
      actor.departmentRole !== null &&
      actor.departmentRole !== 'ADMIN' &&
      actor.departmentRole !== 'MEMBER'
    ) {
      throw new Error('bot-join-invalid-request');
    }
    if (
      actor.meetingRole !== undefined &&
      actor.meetingRole !== null &&
      actor.meetingRole !== 'MEETING_ADMIN' &&
      actor.meetingRole !== 'REVIEWER' &&
      actor.meetingRole !== 'APPROVER' &&
      actor.meetingRole !== 'VIEWER'
    ) {
      throw new Error('bot-join-invalid-request');
    }
  }

  private isActorAuthorizedForRetrigger(
    actor: BotJoinRetriggerActor,
    facts: BotJoinOccurrenceFacts,
  ): boolean {
    if (actor.systemRole === 'OWNER' || actor.systemRole === 'MANAGER') {
      return true;
    }
    if (actor.meetingRole === 'MEETING_ADMIN') {
      return true;
    }
    if (
      facts.meetingKind !== 'GENERAL' &&
      facts.departmentId !== null &&
      actor.departmentId === facts.departmentId &&
      actor.departmentRole === 'ADMIN'
    ) {
      return true;
    }
    return false;
  }

  private assertSameAttempt(
    actual: BotSessionRecord,
    expected: BotSessionRecord,
  ): void {
    if (
      actual.id !== expected.id ||
      actual.meetingId !== expected.meetingId ||
      actual.idempotencyKey !== expected.idempotencyKey ||
      actual.attempt !== expected.attempt ||
      actual.captureGeneration !== expected.captureGeneration ||
      actual.scheduleVersionAtActivation !==
        expected.scheduleVersionAtActivation ||
      actual.provider !== expected.provider
    ) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
  }

  private assertRecordIntegrity(facts: BotJoinRecord, job: BotJoinJob): void {
    this.assertOccurrenceIntegrity(facts);
    const session = facts.sessionForJob;
    if (session === null) {
      return;
    }
    if (
      session.meetingId !== facts.meetingId ||
      facts.meetingId !== job.meetingId ||
      session.id !== job.botSessionId
    ) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    if (
      typeof session.idempotencyKey !== 'string' ||
      session.idempotencyKey.trim() === ''
    ) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    if (!this.isKnownCaptureState(session.state)) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    if (
      typeof session.attempt !== 'number' ||
      !Number.isInteger(session.attempt) ||
      session.attempt < 1 ||
      typeof session.captureGeneration !== 'number' ||
      !Number.isInteger(session.captureGeneration) ||
      session.captureGeneration < 1 ||
      typeof session.scheduleVersionAtActivation !== 'number' ||
      !Number.isInteger(session.scheduleVersionAtActivation) ||
      session.scheduleVersionAtActivation < 1 ||
      (session.admissionState !== null &&
        ADMISSION_STATES.indexOf(session.admissionState) === -1)
    ) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
  }

  private assertOccurrenceIntegrity(facts: BotJoinOccurrenceFacts): void {
    if (typeof facts.meetingId !== 'string' || facts.meetingId.trim() === '') {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    if (!this.isKnownCaptureState(facts.captureStatus)) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    if (
      typeof facts.scheduleVersion !== 'number' ||
      !Number.isInteger(facts.scheduleVersion) ||
      facts.scheduleVersion < 1
    ) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
  }

  private isKnownCaptureState(value: string): boolean {
    return CAPTURE_STATES.indexOf(value) !== -1;
  }

  private assertDispatchableJoinUrl(facts: BotJoinRecord): string {
    const url = facts.meetUrl;
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    return url;
  }
}
