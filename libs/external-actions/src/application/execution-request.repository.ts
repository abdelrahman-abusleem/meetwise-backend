export type ExecutionState =
  | 'PENDING'
  | 'DISPATCHING'
  | 'SUCCEEDED'
  | 'RETRYABLE_FAILED'
  | 'PERMANENT_FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

export interface ExecutionContractView {
  readonly id: string;
  readonly status: ExecutionState;

  readonly attemptCount: number;
  readonly operation: string;
  readonly destination: string;
  readonly targetKey: string;

  readonly storedExternalId: string | null;
  readonly storedExternalUrl: string | null;
}

export interface ExecutionFacts {
  readonly executionExists: boolean;
  readonly status: ExecutionState | null;
  readonly operation: string | null;
  readonly destination: string | null;
  readonly targetKey: string | null;
  readonly storedExternalId: string | null;
  readonly storedExternalUrl: string | null;
  readonly attemptCount: number | null;
}

export interface ExecutionRouteRequest {
  readonly analysisItemId: string;
  readonly connectionId: string;
  readonly destination: string;
  readonly operation: string;
  readonly targetKey: string;
}

export type ExecutionCreateRefusal =
  | 'APPROVAL_STATE_DIVERGED'
  | 'APPROVED_SNAPSHOT_UNAVAILABLE'
  | 'GENERAL_EXECUTION_FORBIDDEN'
  | 'CANONICAL_CREATE_EXISTS'
  | 'NON_OUTBOUND_ROUTE_NOT_IN_SLICE'
  | 'CREATE_ANOTHER_NOT_IN_V1';

export type ExecutionCreateResult =
  | {
      readonly created: true;
      readonly refusal: null;
      readonly run: ExecutionContractView;
    }
  | {
      readonly created: false;
      readonly refusal: ExecutionCreateRefusal;
      readonly run: null;
    };

export type ExecutionClaimRefusal =
  | 'CLAIM_RACE_LOST'
  | 'CONNECTION_UNAVAILABLE'
  | 'SNAPSHOT_DIVERGED'
  | 'GENERAL_EXECUTION_FORBIDDEN';

export interface ApprovedDispatchPayload {
  readonly approvedSnapshotId: string;
  readonly payload: unknown;
}

export interface ExecutionDispatchFence {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export type ExecutionClaimResult =
  | {
      readonly claimed: true;
      readonly refusal: null;
      readonly run: ExecutionContractView;
      readonly dispatchPayload: ApprovedDispatchPayload;
      readonly fence: ExecutionDispatchFence;
    }
  | {
      readonly claimed: false;
      readonly refusal: ExecutionClaimRefusal;
      readonly run: null;
      readonly dispatchPayload: null;
    };

export type DispatchSettleCommand =
  | 'CONFIRM_SUCCESS'
  | 'RECORD_RETRYABLE_FAILURE'
  | 'RECORD_PERMANENT_FAILURE'
  | 'MARK_UNKNOWN';

export type DispatchSettleRefusal = 'SETTLE_RACE_LOST';

export type DispatchSettleResult =
  | {
      readonly settled: true;
      readonly refusal: null;
      readonly run: ExecutionContractView;
    }
  | {
      readonly settled: false;
      readonly refusal: DispatchSettleRefusal;
      readonly run: null;
    };

export type UnknownResolutionCommand =
  'RESOLVE_UNKNOWN_FOUND' | 'RESOLVE_UNKNOWN_NOT_EXECUTED';

export type UnknownResolutionRefusal = 'RESOLVE_RACE_LOST';

export type UnknownResolutionResult =
  | {
      readonly settled: true;
      readonly refusal: null;
      readonly run: ExecutionContractView;
    }
  | {
      readonly settled: false;
      readonly refusal: UnknownResolutionRefusal;
      readonly run: null;
    };

export type ExecutionWithdrawRefusal = 'WITHDRAW_RACE_LOST';

export type ExecutionWithdrawResult =
  | {
      readonly settled: true;
      readonly refusal: null;
      readonly run: ExecutionContractView;
    }
  | {
      readonly settled: false;
      readonly refusal: ExecutionWithdrawRefusal;
      readonly run: null;
    };

export interface ExecutionQueryContext {
  readonly executionId: string;
}

export interface ExecutionSettleRequest {
  readonly executionId: string;

  readonly fence: ExecutionDispatchFence;
  readonly command: DispatchSettleCommand;

  readonly externalRef?: string;
  readonly externalUrl?: string;

  readonly reason?: string;
}

export interface UnknownResolutionRequest {
  readonly executionId: string;

  readonly expectedAttemptCount: number;
  readonly command: UnknownResolutionCommand;
  readonly externalRef?: string;
  readonly externalUrl?: string;
  readonly reason?: string;
}

export interface ExecutionWithdrawRequest {
  readonly executionId: string;
  readonly reason: string;
}

export interface ExecutionRequestRepository {
  getExecutionFacts(context: ExecutionQueryContext): Promise<ExecutionFacts>;

  createExecutionRequest(
    req: ExecutionRouteRequest,
  ): Promise<ExecutionCreateResult>;

  claimExecution(context: ExecutionQueryContext): Promise<ExecutionClaimResult>;

  settleDispatchOutcome(
    req: ExecutionSettleRequest,
  ): Promise<DispatchSettleResult>;

  resolveUnknown(
    req: UnknownResolutionRequest,
  ): Promise<UnknownResolutionResult>;

  withdrawExecution(
    req: ExecutionWithdrawRequest,
  ): Promise<ExecutionWithdrawResult>;
}

export const EXECUTION_REQUEST_ROW_MAPPING_CORRUPT =
  'execution-request-row-mapping-corrupt' as const;
