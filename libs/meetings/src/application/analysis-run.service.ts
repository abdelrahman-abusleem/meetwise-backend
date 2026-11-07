import {
  AnalysisRunPolicy,
  type AnalysisRunDecision,
} from '../domain/analysis-run.policy';
import type {
  AnalysisRunRepository,
  AnalysisRunContractView,
  RunClaimFacts,
} from './analysis-run.repository';

export type AnalysisRunServiceFailureReason =
  | 'RUN_FACTS_REQUIRED'
  | 'RUN_NOT_FOUND'
  | 'RUN_STATE_CONFLICT'
  | AnalysisRunPolicyFailure;

export type AnalysisRunServiceFailure = Readonly<{
  ok: false;
  reason: AnalysisRunServiceFailureReason;
}>;

export interface RunClaimed {
  readonly ok: true;
  readonly k: 'CLAIMED';
  readonly run: AnalysisRunContractView;
}

export interface RunRepairRecorded {
  readonly ok: true;
  readonly k: 'REPAIR_RECORDED';
  readonly run: AnalysisRunContractView;

  readonly repairCountAfter: number;
}

export interface RunSettled {
  readonly ok: true;
  readonly k: 'VALIDATED' | 'NEEDS_REVIEW' | 'FAILED';
  readonly run: AnalysisRunContractView;

  readonly itemPersistenceIsTransactionDuty: true;

  readonly noAutoApprove: boolean;
  readonly keepsValidItems: boolean;
  readonly allowsControlledRetry: boolean;
}

export interface ReanalysisQueued {
  readonly ok: true;
  readonly k: 'REANALYSIS_QUEUED';

  readonly run: AnalysisRunContractView;
  readonly approvedSnapshotsUntouched: true;
  readonly outboxRecorded: true;
  readonly auditRecorded: true;
}

export type AnalysisRunServiceOutcome =
  RunClaimed | RunRepairRecorded | RunSettled | ReanalysisQueued;

export interface RunQuery {
  readonly runId: string;
}
export interface RunWorkerQuery extends RunQuery {
  readonly attemptId: string;
}

export interface RunSettleQuery extends RunWorkerQuery {
  readonly outcome: 'VALIDATED' | 'NEEDS_REVIEW' | 'FAILED';
  readonly schemaValidated?: unknown;
  readonly allEvidenceValid?: unknown;
  readonly repairPhaseConcluded?: unknown;
  readonly failureReason?: unknown;
}

export type AnalysisRunPolicyFailure =
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

export class AnalysisRunService {
  private readonly policy: AnalysisRunPolicy;
  private readonly repository: AnalysisRunRepository;

  constructor(repository: AnalysisRunRepository, policy?: AnalysisRunPolicy) {
    this.repository = repository;
    this.policy = policy ?? new AnalysisRunPolicy();
  }

  async claimRun(
    query: RunWorkerQuery | null,
  ): Promise<RunClaimed | AnalysisRunServiceFailure> {
    const gate = this.checkShapeStrings(query, ['runId']);
    if (gate !== null) {
      return gate;
    }
    const q = query as RunWorkerQuery;
    if (typeof q.attemptId !== 'string' || !q.attemptId.trim())
      return this.fail('LEASE_REQUIRED');
    const context = { runId: q.runId, attemptId: q.attemptId };
    const facts: RunClaimFacts =
      await this.repository.getRunStateFacts(context);
    if (!facts.runExists) {
      return this.fail('RUN_NOT_FOUND');
    }
    if (!this.validVersion(facts.version))
      return this.fail('RUN_FACTS_REQUIRED');

    const decision: AnalysisRunDecision = this.policy.evaluate({
      command: 'CLAIM_RUN',
      currentState: facts.status as string,
      leaseAcquired: facts.claimEligible === true,
    });
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    const claim = await this.repository.claimQueuedRun({
      ...context,
      expectedVersion: facts.version,
    });
    if (claim.claimed) {
      if (
        claim.leaseAcquired !== true ||
        claim.run.id !== context.runId ||
        claim.run.status !== 'RUNNING'
      )
        throw new Error('analysis-run-row-mapping-corrupt');
      return this.freeze({
        ok: true as const,
        k: 'CLAIMED' as const,
        run: this.runView(claim.run),
      });
    }

    return this.fail('RUN_STATE_CONFLICT');
  }

  async recordRepair(
    query: RunWorkerQuery | null,
  ): Promise<RunRepairRecorded | AnalysisRunServiceFailure> {
    const gate = this.checkShapeStrings(query, ['runId']);
    if (gate !== null) {
      return gate;
    }
    const q = query as RunWorkerQuery;
    if (typeof q.attemptId !== 'string' || !q.attemptId.trim())
      return this.fail('LEASE_REQUIRED');
    const context = { runId: q.runId, attemptId: q.attemptId };
    const facts: RunClaimFacts =
      await this.repository.getRunStateFacts(context);
    if (!facts.runExists) {
      return this.fail('RUN_NOT_FOUND');
    }
    if (!this.validVersion(facts.version))
      return this.fail('RUN_FACTS_REQUIRED');
    if (facts.status === 'RUNNING' && facts.leaseCurrent !== true)
      return this.fail('LEASE_REQUIRED');
    const decision: AnalysisRunDecision = this.policy.evaluate({
      command: 'RECORD_REPAIR',
      currentState: facts.status as string,

      ...(facts.repairCount === null ? {} : { repairCount: facts.repairCount }),
    });
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    const persisted = await this.repository.persistRepairCall({
      runId: context.runId,
      attemptId: context.attemptId,
      expectedVersion: facts.version,

      expectedRepairCount: facts.repairCount as number,
      repairCountAfter: decision.repairCountAfter as number,
    });
    if (persisted.persisted) {
      if (
        persisted.run.id !== context.runId ||
        persisted.run.status !== 'RUNNING' ||
        persisted.run.repairCount !== decision.repairCountAfter
      )
        throw new Error('analysis-run-row-mapping-corrupt');
      return this.freeze({
        ok: true as const,
        k: 'REPAIR_RECORDED' as const,
        run: this.runView(persisted.run),
        repairCountAfter: persisted.run.repairCount,
      });
    }
    return this.fail('RUN_STATE_CONFLICT');
  }

  async settleRun(
    query: RunSettleQuery | null,
  ): Promise<RunSettled | AnalysisRunServiceFailure> {
    const gate = this.checkShapeStrings(query, ['runId', 'outcome']);
    if (gate !== null) {
      return gate;
    }
    const q = query as RunSettleQuery;
    if (typeof q.attemptId !== 'string' || !q.attemptId.trim())
      return this.fail('LEASE_REQUIRED');
    const outcome = q.outcome;
    if (
      outcome !== 'VALIDATED' &&
      outcome !== 'NEEDS_REVIEW' &&
      outcome !== 'FAILED'
    ) {
      return this.fail('RUN_FACTS_REQUIRED');
    }
    const facts: RunClaimFacts = await this.repository.getRunStateFacts({
      runId: q.runId,
      attemptId: q.attemptId,
    });
    if (!facts.runExists) {
      return this.fail('RUN_NOT_FOUND');
    }
    if (!this.validVersion(facts.version))
      return this.fail('RUN_FACTS_REQUIRED');
    if (facts.status === 'RUNNING' && facts.leaseCurrent !== true)
      return this.fail('LEASE_REQUIRED');
    const decision: AnalysisRunDecision = this.policy.evaluate(
      this.settlePacket(outcome, facts.status as string, q),
    );
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    const settled = await this.repository.settleRun({
      runId: q.runId,
      attemptId: q.attemptId,
      expectedVersion: facts.version,
      outcome,
      ...(outcome === 'FAILED'
        ? { failureReason: q.failureReason as string }
        : {}),
    });
    if (settled.settled) {
      if (settled.run.id !== q.runId || settled.run.status !== outcome)
        throw new Error('analysis-run-row-mapping-corrupt');
      return this.freeze({
        ok: true as const,
        k: outcome,
        run: this.runView(settled.run),
        itemPersistenceIsTransactionDuty: true as const,

        noAutoApprove: decision.noAutoApprove,
        keepsValidItems: decision.keepsValidItems,
        allowsControlledRetry: decision.allowsControlledRetry,
      });
    }
    return this.fail('RUN_STATE_CONFLICT');
  }

  async requestReanalysis(
    query: RunQuery | null,
  ): Promise<ReanalysisQueued | AnalysisRunServiceFailure> {
    const gate = this.checkShapeStrings(query, ['runId']);
    if (gate !== null) {
      return gate;
    }
    const context = { runId: (query as RunWorkerQuery).runId };
    const facts = await this.repository.getReanalysisSourceFacts(context);
    if (!facts.sourceRunExists) {
      return this.fail('RUN_NOT_FOUND');
    }
    if (!this.validVersion(facts.version))
      return this.fail('RUN_FACTS_REQUIRED');
    const decision: AnalysisRunDecision = this.policy.evaluate({
      command: 'REANALYZE',
      currentState: facts.status as string,

      newInputSnapshotCaptured: facts.freshInputSnapshotReady,
    });
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    const created = await this.repository.createReanalysisRun({
      sourceRunId: context.runId,
      expectedStatus: decision.from,
      expectedVersion: facts.version,
    });
    if (created.created) {
      if (
        created.outboxRecorded !== true ||
        created.auditRecorded !== true ||
        created.run.id === context.runId ||
        created.run.status !== 'QUEUED' ||
        created.run.repairCount !== 0
      )
        throw new Error('analysis-run-row-mapping-corrupt');
      return this.freeze({
        ok: true as const,
        k: 'REANALYSIS_QUEUED' as const,
        run: this.runView(created.run),
        approvedSnapshotsUntouched: true as const,
        outboxRecorded: true as const,
        auditRecorded: true as const,
      });
    }

    return created.refusal === 'INPUT_SNAPSHOT_UNAVAILABLE'
      ? this.fail('DECISION_FACTS_REQUIRED')
      : this.fail('RUN_STATE_CONFLICT');
  }

  private settlePacket(
    outcome: 'VALIDATED' | 'NEEDS_REVIEW' | 'FAILED',
    currentState: string,
    q: RunSettleQuery,
  ): Parameters<AnalysisRunPolicy['evaluate']>[0] {
    if (outcome === 'VALIDATED') {
      return {
        command: 'SETTLE_VALIDATED',
        currentState,
        ...(q.schemaValidated === undefined
          ? {}
          : { schemaValidated: q.schemaValidated as boolean }),
        ...(q.allEvidenceValid === undefined
          ? {}
          : { allEvidenceValid: q.allEvidenceValid as boolean }),
      };
    }
    if (outcome === 'NEEDS_REVIEW') {
      return {
        command: 'SETTLE_NEEDS_REVIEW',
        currentState,
        ...(q.repairPhaseConcluded === undefined
          ? {}
          : { repairPhaseConcluded: q.repairPhaseConcluded as boolean }),
      };
    }
    return {
      command: 'SETTLE_FAILED',
      currentState,
      ...(q.failureReason === undefined
        ? {}
        : { failureReason: q.failureReason as string }),
    };
  }

  private validVersion(version: unknown): version is number {
    return (
      typeof version === 'number' &&
      Number.isSafeInteger(version) &&
      version >= 0
    );
  }

  private runView(run: AnalysisRunContractView): AnalysisRunContractView {
    return Object.freeze({
      id: run.id,
      status: run.status,
      repairCount: run.repairCount,
    });
  }

  private checkShapeStrings(
    query: unknown,
    requiredFields: readonly string[],
  ): AnalysisRunServiceFailure | null {
    if (query === null || typeof query !== 'object') {
      return this.fail('RUN_FACTS_REQUIRED');
    }
    const record = query as Record<string, unknown>;
    for (const field of requiredFields) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.fail('RUN_FACTS_REQUIRED');
      }
    }
    return null;
  }

  private fail(
    reason: AnalysisRunServiceFailureReason,
  ): AnalysisRunServiceFailure {
    return Object.freeze({ ok: false as const, reason });
  }

  private freeze<T extends AnalysisRunServiceOutcome>(outcome: T): T {
    return Object.freeze(outcome);
  }
}
