export type AnalysisRunStatus =
  'QUEUED' | 'RUNNING' | 'VALIDATED' | 'NEEDS_REVIEW' | 'FAILED';
export type AnalysisRunSettleOutcome = 'VALIDATED' | 'NEEDS_REVIEW' | 'FAILED';
export interface AnalysisRunInputSnapshot {
  readonly transcriptRevision: string;
  readonly templateVersion: string;
  readonly promptVersion: string;
  readonly analysisLanguage: string;
  readonly schemaVersion: string;
}
export interface AnalysisRunContractView {
  readonly id: string;
  readonly status: AnalysisRunStatus;
  readonly repairCount: number;
}
export interface AnalysisRunQueryContext {
  readonly runId: string;
}
export interface RunExecutionContext extends AnalysisRunQueryContext {
  readonly attemptId: string;
}
export interface RunClaimRequest extends RunExecutionContext {
  readonly expectedVersion: number;
}

export interface RunClaimFacts {
  readonly runExists: boolean;
  readonly status: AnalysisRunStatus | null;
  readonly repairCount: number | null;
  readonly version: number | null;

  readonly claimEligible: boolean;

  readonly leaseCurrent: boolean;
}
export type RunClaimRefusal = 'CLAIM_RACE_LOST';
export type RunClaimResult =
  | {
      readonly claimed: true;
      readonly refusal: null;
      readonly run: AnalysisRunContractView;
      readonly leaseAcquired: true;
    }
  | {
      readonly claimed: false;
      readonly refusal: RunClaimRefusal;
      readonly run: null;
    };
export interface RunRepairPersistRequest extends RunClaimRequest {
  readonly expectedRepairCount: number;
  readonly repairCountAfter: number;
}
export type RunRepairRefusal = 'REPAIR_RACE_LOST';
export type RunRepairResult =
  | {
      readonly persisted: true;
      readonly refusal: null;
      readonly run: AnalysisRunContractView;
    }
  | {
      readonly persisted: false;
      readonly refusal: RunRepairRefusal;
      readonly run: null;
    };
export interface RunSettleRequest extends RunClaimRequest {
  readonly outcome: AnalysisRunSettleOutcome;

  readonly failureReason?: string;
}
export type RunSettleRefusal = 'SETTLE_RACE_LOST';
export type RunSettleResult =
  | {
      readonly settled: true;
      readonly refusal: null;
      readonly run: AnalysisRunContractView;
    }
  | {
      readonly settled: false;
      readonly refusal: RunSettleRefusal;
      readonly run: null;
    };
export interface ReanalysisSourceFacts {
  readonly sourceRunExists: boolean;
  readonly status: AnalysisRunStatus | null;
  readonly version: number | null;
  readonly freshInputSnapshotReady: boolean;
}
export interface ReanalysisCreateRequest {
  readonly sourceRunId: string;
  readonly expectedStatus: AnalysisRunStatus;
  readonly expectedVersion: number;
}
export type ReanalysisCreateRefusal =
  'SOURCE_STATE_DIVERGED' | 'INPUT_SNAPSHOT_UNAVAILABLE';
export type ReanalysisCreateResult =
  | {
      readonly created: true;
      readonly refusal: null;
      readonly run: AnalysisRunContractView;
      readonly outboxRecorded: true;
      readonly auditRecorded: true;
    }
  | {
      readonly created: false;
      readonly refusal: ReanalysisCreateRefusal;
      readonly run: null;
    };
export interface AnalysisRunRepository {
  getRunStateFacts(context: RunExecutionContext): Promise<RunClaimFacts>;

  claimQueuedRun(context: RunClaimRequest): Promise<RunClaimResult>;

  persistRepairCall(req: RunRepairPersistRequest): Promise<RunRepairResult>;

  settleRun(req: RunSettleRequest): Promise<RunSettleResult>;
  getReanalysisSourceFacts(
    context: AnalysisRunQueryContext,
  ): Promise<ReanalysisSourceFacts>;

  createReanalysisRun(
    req: ReanalysisCreateRequest,
  ): Promise<ReanalysisCreateResult>;
}
export const ANALYSIS_RUN_ROW_MAPPING_CORRUPT =
  'analysis-run-row-mapping-corrupt' as const;
