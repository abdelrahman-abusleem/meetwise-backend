type RunState = 'QUEUED' | 'RUNNING' | 'VALIDATED' | 'NEEDS_REVIEW' | 'FAILED';

type RunCommand =
  | 'CLAIM_RUN'
  | 'RECORD_REPAIR'
  | 'SETTLE_VALIDATED'
  | 'SETTLE_NEEDS_REVIEW'
  | 'SETTLE_FAILED'
  | 'REANALYZE';

export interface AnalysisRunRequest {
  readonly command: string;
  readonly currentState: string;

  readonly repairCount?: number;

  readonly leaseAcquired?: boolean;
  readonly schemaValidated?: boolean;
  readonly allEvidenceValid?: boolean;

  readonly repairPhaseConcluded?: boolean;
  readonly failureReason?: string;

  readonly newInputSnapshotCaptured?: boolean;
}

export interface AnalysisRunOutcome {
  readonly ok: true;
  readonly command: RunCommand;
  readonly from: RunState;
  readonly to: RunState;

  readonly noAutoApprove: boolean;

  readonly keepsValidItems: boolean;

  readonly allowsControlledRetry: boolean;
  readonly newRun: boolean;

  readonly approvedSnapshotsUntouched: boolean;
  readonly repairCountAfter?: number;
}

export type AnalysisRunDecision =
  AnalysisRunOutcome | Readonly<{ ok: false; reason: RunFailure }>;

type RunFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_RUN_STATE'
  | 'DECISION_FACTS_REQUIRED'
  | 'LEASE_REQUIRED'
  | 'REPAIR_BUDGET_EXHAUSTED'
  | 'REPAIR_PHASE_NOT_CONCLUDED'
  | 'VALIDATION_NOT_COMPLETE'
  | 'FAILURE_REASON_REQUIRED'
  | 'RUN_NOT_ACTIVE'
  | 'RUN_IN_PROGRESS'
  | 'ALREADY_QUEUED';

const RUN_STATES: Readonly<RunState[]> = [
  'QUEUED',
  'RUNNING',
  'VALIDATED',
  'NEEDS_REVIEW',
  'FAILED',
];
const RUN_COMMANDS: Readonly<RunCommand[]> = [
  'CLAIM_RUN',
  'RECORD_REPAIR',
  'SETTLE_VALIDATED',
  'SETTLE_NEEDS_REVIEW',
  'SETTLE_FAILED',
  'REANALYZE',
];
const MAX_REPAIR_CALLS = 3;
const SETTLED_STATES: Readonly<RunState[]> = [
  'VALIDATED',
  'NEEDS_REVIEW',
  'FAILED',
];

export class AnalysisRunPolicy {
  evaluate(request: AnalysisRunRequest): AnalysisRunDecision {
    const shapeFailure = this.requestShapeFailure(request);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }
    const command = request.command as RunCommand;
    const from = request.currentState as RunState;

    if (command === 'CLAIM_RUN') {
      if (from !== 'QUEUED') {
        return this.reject(
          from === 'RUNNING' ? 'RUN_IN_PROGRESS' : 'RUN_NOT_ACTIVE',
        );
      }
      if (request.leaseAcquired !== true) {
        return this.reject('LEASE_REQUIRED');
      }
      return Object.freeze(this.outcome(command, from, 'RUNNING'));
    }

    if (command === 'RECORD_REPAIR') {
      if (from !== 'RUNNING') {
        return this.reject('RUN_NOT_ACTIVE');
      }
      const repairCount = request.repairCount;
      if (
        typeof repairCount !== 'number' ||
        !Number.isInteger(repairCount) ||
        repairCount < 0 ||
        repairCount > MAX_REPAIR_CALLS
      ) {
        return this.reject('DECISION_FACTS_REQUIRED');
      }
      if (repairCount >= MAX_REPAIR_CALLS) {
        return this.reject('REPAIR_BUDGET_EXHAUSTED');
      }
      const outcome = this.outcome(command, from, 'RUNNING');
      return Object.freeze({ ...outcome, repairCountAfter: repairCount + 1 });
    }

    if (command === 'SETTLE_VALIDATED') {
      if (from !== 'RUNNING') {
        return this.reject('RUN_NOT_ACTIVE');
      }
      if (
        request.schemaValidated !== true ||
        request.allEvidenceValid !== true
      ) {
        return this.reject('VALIDATION_NOT_COMPLETE');
      }
      return Object.freeze({
        ...this.outcome(command, from, 'VALIDATED'),
        noAutoApprove: true,
      });
    }

    if (command === 'SETTLE_NEEDS_REVIEW') {
      if (from !== 'RUNNING') {
        return this.reject('RUN_NOT_ACTIVE');
      }
      if (request.repairPhaseConcluded !== true) {
        return this.reject('REPAIR_PHASE_NOT_CONCLUDED');
      }
      return Object.freeze({
        ...this.outcome(command, from, 'NEEDS_REVIEW'),
        keepsValidItems: true,
      });
    }

    if (command === 'SETTLE_FAILED') {
      if (from !== 'RUNNING') {
        return this.reject('RUN_NOT_ACTIVE');
      }
      if (
        typeof request.failureReason !== 'string' ||
        request.failureReason.trim().length === 0
      ) {
        return this.reject('FAILURE_REASON_REQUIRED');
      }
      return Object.freeze({
        ...this.outcome(command, from, 'FAILED'),
        allowsControlledRetry: true,
      });
    }

    if (from === 'QUEUED') {
      return this.reject('ALREADY_QUEUED');
    }
    if (from === 'RUNNING') {
      return this.reject('RUN_IN_PROGRESS');
    }
    if (SETTLED_STATES.indexOf(from) === -1) {
      return this.reject('RUN_NOT_ACTIVE');
    }

    if (request.newInputSnapshotCaptured !== true) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    return Object.freeze(
      this.outcome(command, from, 'QUEUED', {
        newRun: true,
        approvedSnapshotsUntouched: true,
      }),
    );
  }

  private shapeGuardedBoolean(value: unknown): boolean {
    return value === true || value === false;
  }

  private requestShapeFailure(request: AnalysisRunRequest): RunFailure | null {
    if (request === null || typeof request !== 'object') {
      return 'INVALID_COMMAND';
    }
    if (RUN_COMMANDS.indexOf(request.command as RunCommand) === -1) {
      return 'INVALID_COMMAND';
    }
    if (RUN_STATES.indexOf(request.currentState as RunState) === -1) {
      return 'UNKNOWN_RUN_STATE';
    }
    if (
      request.leaseAcquired !== undefined &&
      !this.shapeGuardedBoolean(request.leaseAcquired)
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.repairCount !== undefined &&
      (typeof request.repairCount !== 'number' ||
        !Number.isInteger(request.repairCount))
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      request.newInputSnapshotCaptured !== undefined &&
      !this.shapeGuardedBoolean(request.newInputSnapshotCaptured)
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    return null;
  }

  private outcome(
    command: RunCommand,
    from: RunState,
    to: RunState,
    overrides: Partial<AnalysisRunOutcome> = {},
  ): AnalysisRunOutcome {
    return {
      ok: true,
      command,
      from,
      to,
      noAutoApprove: false,
      keepsValidItems: false,
      allowsControlledRetry: false,
      newRun: false,
      approvedSnapshotsUntouched: false,
      ...overrides,
    };
  }

  private reject(reason: RunFailure): AnalysisRunDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
