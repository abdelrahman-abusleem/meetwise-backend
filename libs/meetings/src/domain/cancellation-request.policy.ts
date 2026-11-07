type RequestState = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

type CancellationRequestCommand =
  'SUBMIT_REQUEST' | 'WITHDRAW_REQUEST' | 'APPROVE_REQUEST' | 'REJECT_REQUEST';

type MeetingLifecycle =
  'DRAFT' | 'SCHEDULED' | 'IN_PROGRESS' | 'ENDED' | 'CANCELLED';

export interface CancellationRequestRequest {
  readonly command: string;
  readonly currentState: string;

  readonly meetingLifecycle: string;

  readonly actorAuthorized?: boolean;

  readonly actorIsOriginalRequester?: boolean;

  readonly activeRequestExists?: boolean;
  readonly reason?: string;

  readonly idempotencyKeyProvided?: boolean;

  readonly expectedRequestVersion?: number;
  readonly currentRequestVersion?: number;
}

export interface CancellationRequestOutcome {
  readonly ok: true;
  readonly command: CancellationRequestCommand;
  readonly from: RequestState;
  readonly to: RequestState;

  readonly appliesMw43StopSemantics: boolean;

  readonly cancelsBeforeStart: boolean;

  readonly persistentNotifications: true;
}

export type CancellationRequestFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_REQUEST_STATE'
  | 'UNKNOWN_MEETING_LIFECYCLE'
  | 'DECISION_FACTS_REQUIRED'
  | 'ACTOR_NOT_AUTHORIZED'
  | 'NOT_ORIGINAL_REQUESTER'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'REQUEST_VERSION_MISMATCH'
  | 'MEETING_ALREADY_TERMINAL'
  | 'ACTIVE_REQUEST_EXISTS'
  | 'REJECTION_REASON_REQUIRED'
  | 'REQUEST_NOT_DECIDABLE';

export type CancellationRequestDecision =
  | CancellationRequestOutcome
  | Readonly<{ ok: false; reason: CancellationRequestFailure }>;

const REQUEST_STATES: Readonly<RequestState[]> = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
];

const LIFECYCLES: Readonly<MeetingLifecycle[]> = [
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
];

const COMMANDS: Readonly<CancellationRequestCommand[]> = [
  'SUBMIT_REQUEST',
  'WITHDRAW_REQUEST',
  'APPROVE_REQUEST',
  'REJECT_REQUEST',
];

export class CancellationRequestPolicy {
  evaluate(request: CancellationRequestRequest): CancellationRequestDecision {
    const shapeFailure = this.requestShapeFailure(request);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }
    const command = request.command as CancellationRequestCommand;
    const from = request.currentState as RequestState;
    const lifecycle = request.meetingLifecycle as MeetingLifecycle;

    if (request.actorAuthorized !== true) {
      return this.reject('ACTOR_NOT_AUTHORIZED');
    }

    if (command === 'SUBMIT_REQUEST') {
      if (request.idempotencyKeyProvided !== true) {
        return this.reject('IDEMPOTENCY_KEY_REQUIRED');
      }
      if (lifecycle === 'ENDED' || lifecycle === 'CANCELLED') {
        return this.reject('MEETING_ALREADY_TERMINAL');
      }
      if (request.activeRequestExists === true) {
        return this.reject('ACTIVE_REQUEST_EXISTS');
      }
      return Object.freeze({
        ok: true as const,
        command,
        from: 'REQUESTED' as const,
        to: 'REQUESTED' as const,
        appliesMw43StopSemantics: false,
        cancelsBeforeStart: false,
        persistentNotifications: true,
      });
    }

    if (command === 'WITHDRAW_REQUEST') {
      if (request.actorIsOriginalRequester !== true) {
        return this.reject('NOT_ORIGINAL_REQUESTER');
      }
      if (from !== 'REQUESTED') {
        return this.reject('REQUEST_NOT_DECIDABLE');
      }
      if (lifecycle === 'ENDED' || lifecycle === 'CANCELLED') {
        return this.reject('MEETING_ALREADY_TERMINAL');
      }
      return Object.freeze({
        ok: true as const,
        command,
        from,
        to: 'WITHDRAWN' as const,
        appliesMw43StopSemantics: false,
        cancelsBeforeStart: false,
        persistentNotifications: true,
      });
    }

    if (from !== 'REQUESTED') {
      return this.reject('REQUEST_NOT_DECIDABLE');
    }
    if (lifecycle === 'ENDED' || lifecycle === 'CANCELLED') {
      return this.reject('MEETING_ALREADY_TERMINAL');
    }
    if (
      !this.isSafeVersion(request.expectedRequestVersion) ||
      !this.isSafeVersion(request.currentRequestVersion)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (request.expectedRequestVersion !== request.currentRequestVersion) {
      return this.reject('REQUEST_VERSION_MISMATCH');
    }
    if (
      command === 'REJECT_REQUEST' &&
      !this.hasNonBlankReason(request.reason)
    ) {
      return this.reject('REJECTION_REASON_REQUIRED');
    }
    return Object.freeze({
      ok: true as const,
      command,
      from,
      to: command === 'APPROVE_REQUEST' ? 'APPROVED' : 'REJECTED',
      appliesMw43StopSemantics:
        command === 'APPROVE_REQUEST' && lifecycle === 'IN_PROGRESS',
      cancelsBeforeStart:
        command === 'APPROVE_REQUEST' &&
        (lifecycle === 'DRAFT' || lifecycle === 'SCHEDULED'),
      persistentNotifications: true,
    });
  }

  private isSafeVersion(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
  }

  private hasNonBlankReason(reason: string | undefined): boolean {
    return typeof reason === 'string' && reason.trim() !== '';
  }

  private requestShapeFailure(
    request: CancellationRequestRequest,
  ): CancellationRequestFailure | null {
    if (request === null || typeof request !== 'object') {
      return 'INVALID_COMMAND';
    }
    if (
      COMMANDS.indexOf(request.command as CancellationRequestCommand) === -1
    ) {
      return 'INVALID_COMMAND';
    }
    if (REQUEST_STATES.indexOf(request.currentState as RequestState) === -1) {
      return 'UNKNOWN_REQUEST_STATE';
    }
    if (
      LIFECYCLES.indexOf(request.meetingLifecycle as MeetingLifecycle) === -1
    ) {
      return 'UNKNOWN_MEETING_LIFECYCLE';
    }
    if (
      request.actorAuthorized !== undefined &&
      request.actorAuthorized !== true &&
      request.actorAuthorized !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.actorIsOriginalRequester !== undefined &&
      request.actorIsOriginalRequester !== true &&
      request.actorIsOriginalRequester !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.activeRequestExists !== undefined &&
      request.activeRequestExists !== true &&
      request.activeRequestExists !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.idempotencyKeyProvided !== undefined &&
      request.idempotencyKeyProvided !== true &&
      request.idempotencyKeyProvided !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (request.reason !== undefined && typeof request.reason !== 'string') {
      return 'DECISION_FACTS_REQUIRED';
    }
    return null;
  }

  private reject(
    reason: CancellationRequestFailure,
  ): CancellationRequestDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
