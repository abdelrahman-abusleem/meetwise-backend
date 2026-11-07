type ExecutionState =
  | 'PENDING'
  | 'DISPATCHING'
  | 'SUCCEEDED'
  | 'RETRYABLE_FAILED'
  | 'PERMANENT_FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

type ExecutionCommand =
  | 'CLAIM_DISPATCH'
  | 'CONFIRM_SUCCESS'
  | 'RECORD_RETRYABLE_FAILURE'
  | 'RECORD_PERMANENT_FAILURE'
  | 'MARK_UNKNOWN'
  | 'RESOLVE_UNKNOWN_FOUND'
  | 'RESOLVE_UNKNOWN_NOT_EXECUTED'
  | 'KEEP_UNKNOWN_MANUAL'
  | 'WITHDRAW_ROUTE';

export interface ExecutionCommandRequest {
  readonly command: string;
  readonly currentState: string;
  readonly authorized: boolean;

  readonly externalRef?: string | null;

  readonly expectedExternalRef?: string | null;

  readonly reason?: string | null;
}

export interface ExecutionOutcome {
  readonly ok: true;
  readonly command: ExecutionCommand;
  readonly from: ExecutionState;
  readonly to: ExecutionState;

  readonly idempotentDuplicate: boolean;

  readonly requiresManualResolution: boolean;
}

export type ExternalExecutionDecision =
  ExecutionOutcome | Readonly<{ ok: false; reason: ExecutionFailure }>;

type ExecutionFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_STATE'
  | 'UNAUTHORIZED'
  | 'INVALID_TRANSITION'
  | 'MISSING_EXTERNAL_REFERENCE'
  | 'MISMATCHED_EXTERNAL_REFERENCE'
  | 'MISSING_FAILURE_REASON';

const EXECUTION_STATES: Readonly<ExecutionState[]> = [
  'PENDING',
  'DISPATCHING',
  'SUCCEEDED',
  'RETRYABLE_FAILED',
  'PERMANENT_FAILED',
  'UNKNOWN',
  'CANCELLED',
];
const EXECUTION_COMMANDS: Readonly<ExecutionCommand[]> = [
  'CLAIM_DISPATCH',
  'CONFIRM_SUCCESS',
  'RECORD_RETRYABLE_FAILURE',
  'RECORD_PERMANENT_FAILURE',
  'MARK_UNKNOWN',
  'RESOLVE_UNKNOWN_FOUND',
  'RESOLVE_UNKNOWN_NOT_EXECUTED',
  'KEEP_UNKNOWN_MANUAL',
  'WITHDRAW_ROUTE',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export class ExternalExecutionPolicy {
  evaluate(request: ExecutionCommandRequest): ExternalExecutionDecision {
    const shapeFailure = this.requestShapeFailure(request);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }
    const command = request.command as ExecutionCommand;
    const from = request.currentState as ExecutionState;

    if (command === 'CLAIM_DISPATCH') {
      if (from !== 'PENDING' && from !== 'RETRYABLE_FAILED') {
        return this.reject('INVALID_TRANSITION');
      }
      return this.approve(command, from, 'DISPATCHING', false, false);
    }

    if (command === 'CONFIRM_SUCCESS') {
      if (from === 'DISPATCHING') {
        if (!isNonEmptyString(request.externalRef)) {
          return this.reject('MISSING_EXTERNAL_REFERENCE');
        }
        return this.approve(command, from, 'SUCCEEDED', false, false);
      }
      if (from === 'SUCCEEDED') {
        if (!isNonEmptyString(request.externalRef)) {
          return this.reject('MISSING_EXTERNAL_REFERENCE');
        }
        if (!isNonEmptyString(request.expectedExternalRef)) {
          return this.reject('MISSING_EXTERNAL_REFERENCE');
        }
        if (request.expectedExternalRef !== request.externalRef) {
          return this.reject('MISMATCHED_EXTERNAL_REFERENCE');
        }
        return this.approve(command, from, 'SUCCEEDED', true, false);
      }
      return this.reject('INVALID_TRANSITION');
    }

    if (command === 'RECORD_RETRYABLE_FAILURE') {
      if (from !== 'DISPATCHING') {
        return this.reject('INVALID_TRANSITION');
      }
      if (!isNonEmptyString(request.reason)) {
        return this.reject('MISSING_FAILURE_REASON');
      }
      return this.approve(command, from, 'RETRYABLE_FAILED', false, false);
    }

    if (command === 'RECORD_PERMANENT_FAILURE') {
      if (from !== 'DISPATCHING') {
        return this.reject('INVALID_TRANSITION');
      }
      if (!isNonEmptyString(request.reason)) {
        return this.reject('MISSING_FAILURE_REASON');
      }
      return this.approve(command, from, 'PERMANENT_FAILED', false, false);
    }

    if (command === 'MARK_UNKNOWN') {
      if (from !== 'DISPATCHING') {
        return this.reject('INVALID_TRANSITION');
      }
      return this.approve(command, from, 'UNKNOWN', false, false);
    }

    if (command === 'RESOLVE_UNKNOWN_FOUND') {
      if (from !== 'UNKNOWN') {
        return this.reject('INVALID_TRANSITION');
      }
      if (!isNonEmptyString(request.externalRef)) {
        return this.reject('MISSING_EXTERNAL_REFERENCE');
      }
      return this.approve(command, from, 'SUCCEEDED', false, false);
    }

    if (command === 'RESOLVE_UNKNOWN_NOT_EXECUTED') {
      if (from !== 'UNKNOWN') {
        return this.reject('INVALID_TRANSITION');
      }
      if (!isNonEmptyString(request.reason)) {
        return this.reject('MISSING_FAILURE_REASON');
      }
      return this.approve(command, from, 'RETRYABLE_FAILED', false, false);
    }

    if (command === 'KEEP_UNKNOWN_MANUAL') {
      if (from !== 'UNKNOWN') {
        return this.reject('INVALID_TRANSITION');
      }
      if (!isNonEmptyString(request.reason)) {
        return this.reject('MISSING_FAILURE_REASON');
      }
      return this.approve(command, from, 'UNKNOWN', false, true);
    }

    if (from !== 'PENDING' && from !== 'RETRYABLE_FAILED') {
      return this.reject('INVALID_TRANSITION');
    }
    if (!isNonEmptyString(request.reason)) {
      return this.reject('MISSING_FAILURE_REASON');
    }
    return this.approve(command, from, 'CANCELLED', false, false);
  }

  private requestShapeFailure(
    request: ExecutionCommandRequest,
  ): ExecutionFailure | null {
    if (request === null || typeof request !== 'object') {
      return 'INVALID_COMMAND';
    }
    if (
      EXECUTION_COMMANDS.indexOf(request.command as ExecutionCommand) === -1
    ) {
      return 'INVALID_COMMAND';
    }
    if (
      EXECUTION_STATES.indexOf(request.currentState as ExecutionState) === -1
    ) {
      return 'UNKNOWN_STATE';
    }
    if (typeof request.authorized !== 'boolean') {
      return 'UNAUTHORIZED';
    }
    if (!request.authorized) {
      return 'UNAUTHORIZED';
    }
    return null;
  }

  private approve(
    command: ExecutionCommand,
    from: ExecutionState,
    to: ExecutionState,
    idempotentDuplicate: boolean,
    requiresManualResolution: boolean,
  ): ExecutionOutcome {
    return Object.freeze({
      ok: true as const,
      command,
      from,
      to,
      idempotentDuplicate,
      requiresManualResolution,
    });
  }

  private reject(reason: ExecutionFailure): ExternalExecutionDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
