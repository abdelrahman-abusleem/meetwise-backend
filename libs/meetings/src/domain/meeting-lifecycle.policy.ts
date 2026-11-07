type MeetingLifecycle =
  'DRAFT' | 'SCHEDULED' | 'IN_PROGRESS' | 'ENDED' | 'CANCELLED';

type MeetingTransitionCommand =
  | 'SCHEDULE'
  | 'RESCHEDULE'
  | 'START_CAPTURE'
  | 'CAPTURE_ENDED'
  | 'MANUAL_END'
  | 'ADMIN_STOP'
  | 'ADMIN_CANCEL';

export interface MeetingTransitionRequest {
  readonly command: string;
  readonly currentLifecycle: string;
  readonly currentScheduleVersion: number;
  readonly authorized: boolean;

  readonly claimedScheduleVersion?: number | null;

  readonly reason?: string;
}

type TransitionFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_LIFECYCLE'
  | 'UNAUTHORIZED'
  | 'INVALID_SCHEDULE_VERSION'
  | 'STALE_SCHEDULE'
  | 'MISSING_TRANSITION_REASON'
  | 'LATE_CAPTURE_EVENT'
  | 'ALREADY_ENDED'
  | 'NO_RESURRECTION'
  | 'ILLEGAL_TRANSITION';

export interface MeetingTransitionOutcome {
  readonly ok: true;
  readonly command: MeetingTransitionCommand;
  readonly from: MeetingLifecycle;
  readonly to: MeetingLifecycle;
  readonly stopCapture: boolean;
  readonly preservePartialEvidence: boolean;
  readonly invalidateStaleJobs: boolean;
}

export type MeetingTransitionDecision =
  MeetingTransitionOutcome | Readonly<{ ok: false; reason: TransitionFailure }>;

const LIFECYCLES: Readonly<MeetingLifecycle[]> = [
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
];
const COMMANDS: Readonly<MeetingTransitionCommand[]> = [
  'SCHEDULE',
  'RESCHEDULE',
  'START_CAPTURE',
  'CAPTURE_ENDED',
  'MANUAL_END',
  'ADMIN_STOP',
  'ADMIN_CANCEL',
];
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class MeetingLifecyclePolicy {
  evaluate(request: MeetingTransitionRequest): MeetingTransitionDecision {
    const commandFailure = this.requestShapeFailure(request);
    if (commandFailure !== null) {
      return this.reject(commandFailure);
    }
    const command = request.command as MeetingTransitionCommand;
    const from = request.currentLifecycle as MeetingLifecycle;

    if (command === 'START_CAPTURE') {
      if (request.claimedScheduleVersion !== request.currentScheduleVersion) {
        return this.reject('STALE_SCHEDULE');
      }
    }

    if (command === 'CAPTURE_ENDED') {
      if (from !== 'IN_PROGRESS') {
        return this.reject('LATE_CAPTURE_EVENT');
      }
      return this.approve(command, from, 'ENDED', false, false, false);
    }

    if (command === 'MANUAL_END') {
      if (from !== 'IN_PROGRESS') {
        return this.reject(this.terminalOrIllegal(from));
      }

      return this.approve(command, from, 'ENDED', false, false, true);
    }

    if (command === 'SCHEDULE') {
      if (from !== 'DRAFT') {
        return this.reject(this.terminalOrIllegal(from));
      }
      return this.approve(command, from, 'SCHEDULED', false, false, true);
    }

    if (command === 'RESCHEDULE') {
      if (from !== 'SCHEDULED') {
        return this.reject(this.terminalOrIllegal(from));
      }
      return this.approve(command, from, 'SCHEDULED', false, false, true);
    }

    if (command === 'START_CAPTURE') {
      if (from !== 'SCHEDULED') {
        return this.reject(this.terminalOrIllegal(from));
      }
      return this.approve(command, from, 'IN_PROGRESS', false, false, false);
    }

    if (from === 'ENDED') {
      return this.reject('ALREADY_ENDED');
    }
    if (from === 'CANCELLED') {
      return this.reject('NO_RESURRECTION');
    }

    if (command === 'ADMIN_STOP') {
      if (from !== 'IN_PROGRESS') {
        return this.reject('ILLEGAL_TRANSITION');
      }
      return this.approve(command, from, 'ENDED', true, true, true);
    }

    if (from === 'IN_PROGRESS') {
      return this.approve(command, from, 'ENDED', true, true, true);
    }

    return this.approve(command, from, 'CANCELLED', false, false, true);
  }

  private requestShapeFailure(
    request: MeetingTransitionRequest,
  ): TransitionFailure | null {
    if (request === null || typeof request !== 'object') {
      return 'INVALID_COMMAND';
    }
    if (COMMANDS.indexOf(request.command as MeetingTransitionCommand) === -1) {
      return 'INVALID_COMMAND';
    }
    if (
      LIFECYCLES.indexOf(request.currentLifecycle as MeetingLifecycle) === -1
    ) {
      return 'UNKNOWN_LIFECYCLE';
    }
    if (typeof request.authorized !== 'boolean') {
      return 'UNAUTHORIZED';
    }
    if (!request.authorized) {
      return 'UNAUTHORIZED';
    }
    if (!isSafeNonNegativeInteger(request.currentScheduleVersion)) {
      return 'INVALID_SCHEDULE_VERSION';
    }
    if (
      request.command === 'ADMIN_CANCEL' ||
      request.command === 'ADMIN_STOP'
    ) {
      if (!isNonEmptyString(request.reason)) {
        return 'MISSING_TRANSITION_REASON';
      }
    }
    if (
      request.reason !== undefined &&
      request.reason !== null &&
      typeof request.reason !== 'string'
    ) {
      return 'MISSING_TRANSITION_REASON';
    }
    return null;
  }

  private terminalOrIllegal(from: MeetingLifecycle): TransitionFailure {
    if (from === 'ENDED') {
      return 'ALREADY_ENDED';
    }
    if (from === 'CANCELLED') {
      return 'NO_RESURRECTION';
    }
    return 'ILLEGAL_TRANSITION';
  }

  private approve(
    command: MeetingTransitionCommand,
    from: MeetingLifecycle,
    to: MeetingLifecycle,
    stopCapture: boolean,
    preservePartialEvidence: boolean,
    invalidateStaleJobs: boolean,
  ): MeetingTransitionDecision {
    return Object.freeze({
      ok: true as const,
      command,
      from,
      to,
      stopCapture,
      preservePartialEvidence,
      invalidateStaleJobs,
    });
  }

  private reject(reason: TransitionFailure): MeetingTransitionDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
