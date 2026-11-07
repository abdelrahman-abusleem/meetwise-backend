import {
  ExternalExecutionPolicy,
  type ExternalExecutionDecision,
} from '../domain/external-execution.policy';
import { PROVIDER_PORT_VIOLATION } from './external-execution-provider.port';
import type {
  DispatchAttemptOutcome,
  UnknownLookupOutcome,
} from './external-execution-provider.port';
import type {
  DispatchInstruction,
  ExternalExecutionProviderPort,
  LookupInstruction,
} from './external-execution-provider.port';
import type {
  ExecutionRequestRepository,
  ExecutionContractView,
  ExecutionClaimResult,
  ExecutionCreateRefusal,
  ExecutionClaimRefusal,
  DispatchSettleCommand,
  DispatchSettleRefusal,
  UnknownResolutionRequest,
  UnknownResolutionRefusal,
  ExecutionSettleRequest,
  ExecutionDispatchFence,
  ExecutionWithdrawRefusal,
} from './execution-request.repository';

export type ExecutionServiceFailureReason =
  | 'EXECUTION_FACTS_REQUIRED'
  | 'EXECUTION_NOT_FOUND'
  | 'EXECUTION_STATE_CONFLICT'
  | 'PROVIDER_PORT_REQUIRED'
  | ExecutionPolicyFailure
  | ExecutionCreateRefusal
  | ExecutionClaimRefusal
  | DispatchSettleRefusal
  | UnknownResolutionRefusal
  | ExecutionWithdrawRefusal;

export type ExecutionServiceFailure = Readonly<{
  ok: false;
  reason: ExecutionServiceFailureReason;
}>;

export type ExecutionPolicyFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_STATE'
  | 'UNAUTHORIZED'
  | 'INVALID_TRANSITION'
  | 'MISSING_EXTERNAL_REFERENCE'
  | 'MISMATCHED_EXTERNAL_REFERENCE'
  | 'MISSING_FAILURE_REASON';

export interface ExecutionRouteRequested {
  readonly ok: true;
  readonly k: 'ROUTE_REQUESTED';
  readonly run: ExecutionContractView;

  readonly requestedEventIsApproveTxDuty: true;
}

export interface ExecutionDispatchOutcome {
  readonly ok: true;
  readonly k: 'SUCCEEDED' | 'RETRYABLE_FAILED' | 'PERMANENT_FAILED' | 'UNKNOWN';
  readonly run: ExecutionContractView;

  readonly providerCallMade: true;

  readonly unknownEventIsReconcilerDuty?: true;
}

export interface UnknownReconciledOutcome {
  readonly ok: true;
  readonly k: 'SUCCEEDED' | 'RETRYABLE_FAILED' | 'AWAITING_OPERATOR';

  readonly run: ExecutionContractView | null;

  readonly providerLookupMade: true;

  readonly requiresManualResolution?: true;
}

export interface SuccessReAcknowledgeOutcome {
  readonly ok: true;
  readonly k: 'REACKNOWLEDGED_SUCCESS';

  readonly externalRef: string;

  readonly idempotentDuplicate: true;
  readonly newWrite: false;
}

export interface ExecutionWithdrawnOutcome {
  readonly ok: true;
  readonly k: 'ROUTE_WITHDRAWN';
  readonly run: ExecutionContractView;

  readonly noExternalCall: true;
}

export type ExecutionServiceOutcome =
  | ExecutionRouteRequested
  | ExecutionDispatchOutcome
  | UnknownReconciledOutcome
  | SuccessReAcknowledgeOutcome
  | ExecutionWithdrawnOutcome;

export interface ExecutionRouteQuery {
  readonly analysisItemId: string;
  readonly connectionId: string;
  readonly destination: string;
  readonly operation: string;
  readonly targetKey: string;
}

export interface ExecutionDispatchQuery {
  readonly executionId: string;
  readonly provider: ExternalExecutionProviderPort;
}

export interface ExecutionReconcileQuery {
  readonly executionId: string;
  readonly provider: ExternalExecutionProviderPort;
}

export interface ExecutionReAcknowledgeQuery {
  readonly executionId: string;
  readonly externalRef: unknown;
}

export interface ExecutionWithdrawQuery {
  readonly executionId: string;

  readonly reason: unknown;
}

const OUTBOUND_OPERATIONS: ReadonlySet<string> = new Set([
  'CREATE',
  'UPDATE_EXISTING',
]);

const NON_OUTBOUND_OPERATIONS: ReadonlySet<string> = new Set([
  'LINK_EXISTING',
  'KEEP_INTERNAL',
  'CREATE_ANOTHER',
]);

export class ExternalExecutionService {
  private readonly policy: ExternalExecutionPolicy;
  private readonly repository: ExecutionRequestRepository;

  constructor(
    repository: ExecutionRequestRepository,
    policy?: ExternalExecutionPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.policy = policy ?? new ExternalExecutionPolicy();
  }

  async requestExecutionRoute(
    query: ExecutionRouteQuery | null,
  ): Promise<ExecutionRouteRequested | ExecutionServiceFailure> {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    const shapeGate = this.checkShapeStrings(query, [
      'analysisItemId',
      'connectionId',
      'destination',
      'targetKey',
    ]);
    if (shapeGate !== null) {
      return shapeGate;
    }
    const operation = query.operation;
    if (
      operation === undefined ||
      operation === null ||
      typeof operation !== 'string' ||
      operation.trim() === ''
    ) {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    if (!OUTBOUND_OPERATIONS.has(operation)) {
      return this.fail(
        NON_OUTBOUND_OPERATIONS.has(operation)
          ? operation === 'CREATE_ANOTHER'
            ? 'CREATE_ANOTHER_NOT_IN_V1'
            : 'NON_OUTBOUND_ROUTE_NOT_IN_SLICE'
          : 'EXECUTION_FACTS_REQUIRED',
      );
    }
    const created = await this.repository.createExecutionRequest({
      analysisItemId: query.analysisItemId,
      connectionId: query.connectionId,
      destination: query.destination,
      operation: operation,
      targetKey: query.targetKey,
    });
    if (created.created) {
      return this.freeze({
        ok: true as const,
        k: 'ROUTE_REQUESTED' as const,
        run: this.executionView(created.run),
        requestedEventIsApproveTxDuty: true as const,
      });
    }
    return this.fail(created.refusal);
  }

  async dispatchExecution(
    query: ExecutionDispatchQuery | null,
  ): Promise<ExecutionDispatchOutcome | ExecutionServiceFailure> {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    const shapeGate = this.checkShapeStrings(query, ['executionId']);
    if (shapeGate !== null) {
      return shapeGate;
    }
    const providerPort = this.providerPort(query.provider);
    if (providerPort === null) {
      return this.fail('PROVIDER_PORT_REQUIRED');
    }
    const executionId = query.executionId;
    const facts = await this.repository.getExecutionFacts({ executionId });
    if (!facts.executionExists) {
      return this.fail('EXECUTION_NOT_FOUND');
    }
    const claimDecision: ExternalExecutionDecision = this.policy.evaluate({
      command: 'CLAIM_DISPATCH',
      currentState: facts.status as string,

      authorized:
        facts.status === 'PENDING' || facts.status === 'RETRYABLE_FAILED',
    });
    if (claimDecision.ok !== true) {
      return this.fail(claimDecision.reason);
    }
    const claim: ExecutionClaimResult = await this.repository.claimExecution({
      executionId,
    });
    if (!claim.claimed) {
      return claim.refusal === 'CLAIM_RACE_LOST'
        ? this.fail('EXECUTION_STATE_CONFLICT')
        : this.fail(claim.refusal);
    }
    const view = claim.run;
    if (
      !view ||
      view.id !== executionId ||
      view.status !== 'DISPATCHING' ||
      !OUTBOUND_OPERATIONS.has(view.operation) ||
      view.operation !== facts.operation ||
      view.destination !== facts.destination ||
      view.targetKey !== facts.targetKey ||
      typeof view.destination !== 'string' ||
      view.destination.trim() === '' ||
      typeof view.targetKey !== 'string' ||
      view.targetKey.trim() === '' ||
      !claim.dispatchPayload ||
      typeof claim.dispatchPayload.approvedSnapshotId !== 'string' ||
      claim.dispatchPayload.approvedSnapshotId.trim() === '' ||
      !Object.prototype.hasOwnProperty.call(claim.dispatchPayload, 'payload')
    ) {
      throw new Error('execution-row-mapping-corrupt');
    }
    const fence = this.dispatchFence(claim.fence, view.attemptCount);
    const instruction: DispatchInstruction = {
      executionId,
      operation: view.operation,
      destination: view.destination,
      targetKey: view.targetKey,
      approvedSnapshotId: claim.dispatchPayload.approvedSnapshotId,
      approvedPayload: claim.dispatchPayload.payload,
    };
    const outcome = await providerPort.executeDispatch(instruction);
    const settle = this.dispatchOutcomeSettle(outcome);
    if (settle === null) {
      throw new Error(
        `${PROVIDER_PORT_VIOLATION} (unsupported dispatch outcome shape)`,
      );
    }
    const policyDecision: ExternalExecutionDecision = this.policy.evaluate({
      ...settle.packet,
      currentState: claim.run.status,
      authorized: true,
    });
    if (policyDecision.ok !== true) {
      return this.fail(policyDecision.reason);
    }
    const settled = await this.repository.settleDispatchOutcome(
      this.settleRequest(executionId, fence, settle),
    );
    if (!settled.settled) {
      return this.fail('EXECUTION_STATE_CONFLICT');
    }
    return this.freeze({
      ok: true as const,
      k: this.settleState(settle.command),
      run: this.executionView(settled.run),
      providerCallMade: true as const,
      ...(settle.command === 'MARK_UNKNOWN'
        ? { unknownEventIsReconcilerDuty: true as const }
        : {}),
    });
  }

  async reconcileUnknown(
    query: ExecutionReconcileQuery | null,
  ): Promise<UnknownReconciledOutcome | ExecutionServiceFailure> {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    const shapeGate = this.checkShapeStrings(query, ['executionId']);
    if (shapeGate !== null) {
      return shapeGate;
    }
    const providerPort = this.providerLookupPort(query.provider);
    if (providerPort === null) {
      return this.fail('PROVIDER_PORT_REQUIRED');
    }
    const executionId = query.executionId;
    const facts = await this.repository.getExecutionFacts({ executionId });
    if (!facts.executionExists) {
      return this.fail('EXECUTION_NOT_FOUND');
    }
    const observedState = facts.status;
    if (observedState !== 'UNKNOWN') {
      return this.fail('EXECUTION_STATE_CONFLICT');
    }
    if (
      typeof facts.attemptCount !== 'number' ||
      !Number.isSafeInteger(facts.attemptCount) ||
      facts.attemptCount < 0 ||
      typeof facts.operation !== 'string' ||
      !OUTBOUND_OPERATIONS.has(facts.operation) ||
      typeof facts.destination !== 'string' ||
      facts.destination.trim() === '' ||
      typeof facts.targetKey !== 'string' ||
      facts.targetKey.trim() === ''
    ) {
      throw new Error('execution-row-mapping-corrupt');
    }

    const observedAttemptCount = facts.attemptCount;
    const instruction: LookupInstruction = {
      executionId,
      operation: facts.operation,
      destination: facts.destination,
      targetKey: facts.targetKey,
    };
    const lookup = await providerPort.lookupExternalByCorrelation(instruction);

    if (
      lookup === null ||
      typeof lookup !== 'object' ||
      (lookup.k !== 'FOUND' &&
        lookup.k !== 'NOT_FOUND_PROVEN' &&
        lookup.k !== 'UNCERTAIN')
    ) {
      throw new Error(
        `${PROVIDER_PORT_VIOLATION} (unsupported lookup outcome shape)`,
      );
    }
    const evidence = this.reconcileVerdict(lookup);
    if (evidence.command === 'KEEP_UNKNOWN_MANUAL') {
      return this.freeze({
        ok: true as const,
        k: 'AWAITING_OPERATOR' as const,
        run: null,
        providerLookupMade: true as const,
        requiresManualResolution: true as const,
      });
    }
    const policyDecision: ExternalExecutionDecision = this.policy.evaluate({
      command: evidence.command,

      currentState: observedState,
      authorized: true,
      ...(evidence.command === 'RESOLVE_UNKNOWN_FOUND'
        ? { externalRef: evidence.externalRef }
        : { reason: evidence.reason }),
    });
    if (policyDecision.ok !== true) {
      return this.fail(policyDecision.reason);
    }
    const request: UnknownResolutionRequest = {
      executionId,
      expectedAttemptCount: observedAttemptCount,
      command: evidence.command,
      ...(evidence.command === 'RESOLVE_UNKNOWN_FOUND'
        ? {
            externalRef: evidence.externalRef,
            ...(evidence.externalUrl !== undefined
              ? { externalUrl: evidence.externalUrl }
              : {}),
          }
        : { reason: evidence.reason }),
    };
    const settled = await this.repository.resolveUnknown(request);
    if (!settled.settled) {
      return this.fail('EXECUTION_STATE_CONFLICT');
    }
    return this.freeze({
      ok: true as const,
      k:
        evidence.command === 'RESOLVE_UNKNOWN_FOUND'
          ? ('SUCCEEDED' as const)
          : ('RETRYABLE_FAILED' as const),
      run: this.executionView(settled.run),
      providerLookupMade: true as const,
    });
  }

  async reAcknowledgeSuccess(
    query: ExecutionReAcknowledgeQuery | null,
  ): Promise<SuccessReAcknowledgeOutcome | ExecutionServiceFailure> {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    const shapeGate = this.checkShapeStrings(query, ['executionId']);
    if (shapeGate !== null) {
      return shapeGate;
    }
    const executionId = query.executionId;
    const facts = await this.repository.getExecutionFacts({ executionId });
    if (!facts.executionExists) {
      return this.fail('EXECUTION_NOT_FOUND');
    }
    if (facts.status !== 'SUCCEEDED') {
      return this.fail('EXECUTION_STATE_CONFLICT');
    }
    const storedRef = facts.storedExternalId;
    const policyDecision: ExternalExecutionDecision = this.policy.evaluate({
      command: 'CONFIRM_SUCCESS',

      currentState: facts.status,
      authorized: true,
      externalRef: query.externalRef as string,
      ...(storedRef === null ? {} : { expectedExternalRef: storedRef }),
    });
    if (policyDecision.ok !== true) {
      return this.fail(policyDecision.reason);
    }
    return this.freeze({
      ok: true as const,
      k: 'REACKNOWLEDGED_SUCCESS' as const,
      externalRef: query.externalRef as string,
      idempotentDuplicate: true as const,
      newWrite: false as const,
    });
  }

  async withdrawRoute(
    query: ExecutionWithdrawQuery | null,
  ): Promise<ExecutionWithdrawnOutcome | ExecutionServiceFailure> {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    const shapeGate = this.checkShapeStrings(query, ['executionId']);
    if (shapeGate !== null) {
      return shapeGate;
    }
    const executionId = query.executionId;
    const facts = await this.repository.getExecutionFacts({ executionId });
    if (!facts.executionExists) {
      return this.fail('EXECUTION_NOT_FOUND');
    }
    const policyDecision: ExternalExecutionDecision = this.policy.evaluate({
      command: 'WITHDRAW_ROUTE',
      currentState: facts.status as string,

      authorized:
        facts.status === 'PENDING' || facts.status === 'RETRYABLE_FAILED',
      ...(query.reason === undefined ? {} : { reason: query.reason as string }),
    });
    if (policyDecision.ok !== true) {
      return this.fail(policyDecision.reason);
    }
    const withdrawn = await this.repository.withdrawExecution({
      executionId,
      reason: query.reason as string,
    });
    if (!withdrawn.settled) {
      return this.fail('EXECUTION_STATE_CONFLICT');
    }
    return this.freeze({
      ok: true as const,
      k: 'ROUTE_WITHDRAWN' as const,
      run: this.executionView(withdrawn.run),
      noExternalCall: true as const,
    });
  }

  private dispatchOutcomeSettle(outcome: DispatchAttemptOutcome): {
    command: DispatchSettleCommand;
    packet: {
      command: DispatchSettleCommand;
      externalRef?: string;
      externalUrl?: string;
      reason?: string;
    };
  } | null {
    if (outcome === null || typeof outcome !== 'object') {
      return null;
    }
    if (outcome.k === 'CONFIRMED') {
      if (
        typeof outcome.externalId !== 'string' ||
        outcome.externalId.trim() === ''
      ) {
        return { command: 'MARK_UNKNOWN', packet: { command: 'MARK_UNKNOWN' } };
      }
      return {
        command: 'CONFIRM_SUCCESS',
        packet: {
          command: 'CONFIRM_SUCCESS',
          externalRef: outcome.externalId,
          ...(typeof outcome.externalUrl === 'string' &&
          outcome.externalUrl.trim() !== ''
            ? { externalUrl: outcome.externalUrl }
            : {}),
        },
      };
    }
    if (outcome.k === 'RETRYABLE_NO_EFFECT') {
      if (typeof outcome.reason !== 'string' || outcome.reason.trim() === '') {
        return { command: 'MARK_UNKNOWN', packet: { command: 'MARK_UNKNOWN' } };
      }
      return {
        command: 'RECORD_RETRYABLE_FAILURE',
        packet: {
          command: 'RECORD_RETRYABLE_FAILURE',
          reason: outcome.reason,
        },
      };
    }
    if (outcome.k === 'PERMANENT_DENIED') {
      if (typeof outcome.reason !== 'string' || outcome.reason.trim() === '') {
        return { command: 'MARK_UNKNOWN', packet: { command: 'MARK_UNKNOWN' } };
      }
      return {
        command: 'RECORD_PERMANENT_FAILURE',
        packet: {
          command: 'RECORD_PERMANENT_FAILURE',
          reason: outcome.reason,
        },
      };
    }
    if (outcome.k === 'UNKNOWN_EFFECT') {
      return { command: 'MARK_UNKNOWN', packet: { command: 'MARK_UNKNOWN' } };
    }
    return null;
  }

  private reconcileVerdict(lookup: UnknownLookupOutcome):
    | {
        command: 'RESOLVE_UNKNOWN_FOUND';
        externalRef: string;
        externalUrl?: string;
      }
    | { command: 'RESOLVE_UNKNOWN_NOT_EXECUTED'; reason: string }
    | { command: 'KEEP_UNKNOWN_MANUAL' } {
    if (lookup === null || typeof lookup !== 'object') {
      return { command: 'KEEP_UNKNOWN_MANUAL' };
    }
    if (lookup.k === 'FOUND') {
      if (
        typeof lookup.externalId !== 'string' ||
        lookup.externalId.trim() === ''
      ) {
        return { command: 'KEEP_UNKNOWN_MANUAL' };
      }
      return {
        command: 'RESOLVE_UNKNOWN_FOUND',
        externalRef: lookup.externalId,
        ...(typeof lookup.externalUrl === 'string' &&
        lookup.externalUrl.trim() !== ''
          ? { externalUrl: lookup.externalUrl }
          : {}),
      };
    }
    if (lookup.k === 'NOT_FOUND_PROVEN') {
      if (typeof lookup.reason !== 'string' || lookup.reason.trim() === '') {
        return { command: 'KEEP_UNKNOWN_MANUAL' };
      }
      return {
        command: 'RESOLVE_UNKNOWN_NOT_EXECUTED',
        reason: lookup.reason,
      };
    }
    return { command: 'KEEP_UNKNOWN_MANUAL' };
  }

  private settleState(
    command: DispatchSettleCommand,
  ): 'SUCCEEDED' | 'RETRYABLE_FAILED' | 'PERMANENT_FAILED' | 'UNKNOWN' {
    if (command === 'CONFIRM_SUCCESS') {
      return 'SUCCEEDED';
    }
    if (command === 'RECORD_RETRYABLE_FAILURE') {
      return 'RETRYABLE_FAILED';
    }
    if (command === 'RECORD_PERMANENT_FAILURE') {
      return 'PERMANENT_FAILED';
    }
    return 'UNKNOWN';
  }

  private dispatchFence(
    value: ExecutionDispatchFence,
    attemptCount: number,
  ): ExecutionDispatchFence {
    const now = this.now();
    const deadline = this.leaseDeadline(value?.leaseExpiresAt);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.attemptId !== 'string' ||
      value.attemptId.trim() === '' ||
      typeof value.leaseToken !== 'string' ||
      value.leaseToken.trim() === '' ||
      !Number.isSafeInteger(value.attemptNumber) ||
      value.attemptNumber < 1 ||
      value.attemptNumber !== attemptCount ||
      !Number.isFinite(now) ||
      !Number.isFinite(deadline) ||
      deadline <= now
    ) {
      throw new Error('execution-claim-fence-invalid');
    }

    return Object.freeze({
      attemptId: value.attemptId,
      attemptNumber: value.attemptNumber,
      leaseToken: value.leaseToken,
      leaseExpiresAt: value.leaseExpiresAt,
    });
  }

  private leaseDeadline(value: unknown): number {
    if (typeof value !== 'string') return NaN;
    const parts =
      /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
        value,
      );
    if (!parts) return NaN;
    const year = Number(parts[1]),
      month = Number(parts[2]),
      day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    return day <= (days[month - 1] ?? 0) ? Date.parse(value) : NaN;
  }

  private settleRequest(
    executionId: string,
    fence: ExecutionDispatchFence,
    settle: {
      command: DispatchSettleCommand;
      packet: {
        command: DispatchSettleCommand;
        externalRef?: string;
        externalUrl?: string;
        reason?: string;
      };
    },
  ): ExecutionSettleRequest {
    return {
      executionId,
      fence,
      command: settle.command,
      ...(settle.packet.externalRef !== undefined
        ? { externalRef: settle.packet.externalRef }
        : {}),
      ...(settle.packet.externalUrl !== undefined
        ? { externalUrl: settle.packet.externalUrl }
        : {}),
      ...(settle.packet.reason !== undefined
        ? { reason: settle.packet.reason }
        : {}),
    };
  }

  private providerPort(value: unknown): {
    executeDispatch(
      instruction: DispatchInstruction,
    ): Promise<DispatchAttemptOutcome>;
  } | null {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof (value as { executeDispatch?: unknown }).executeDispatch !==
        'function'
    ) {
      return null;
    }
    return value as ExternalExecutionProviderPort;
  }

  private providerLookupPort(value: unknown): {
    lookupExternalByCorrelation(
      instruction: LookupInstruction,
    ): Promise<UnknownLookupOutcome>;
  } | null {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof (value as { lookupExternalByCorrelation?: unknown })
        .lookupExternalByCorrelation !== 'function'
    ) {
      return null;
    }
    return value as ExternalExecutionProviderPort;
  }

  private executionView(run: ExecutionContractView): ExecutionContractView {
    return Object.freeze({
      id: run.id,
      status: run.status,
      attemptCount: run.attemptCount,
      operation: run.operation,
      destination: run.destination,
      targetKey: run.targetKey,
      storedExternalId: run.storedExternalId,
      storedExternalUrl: run.storedExternalUrl,
    });
  }

  private checkShapeStrings(
    query: unknown,
    requiredFields: readonly string[],
  ): ExecutionServiceFailure | null {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXECUTION_FACTS_REQUIRED');
    }
    const record = query as Record<string, unknown>;
    for (const field of requiredFields) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.fail('EXECUTION_FACTS_REQUIRED');
      }
    }
    return null;
  }

  private fail(reason: ExecutionServiceFailureReason): ExecutionServiceFailure {
    return Object.freeze({ ok: false as const, reason });
  }

  private freeze<T extends ExecutionServiceOutcome>(outcome: T): T {
    return Object.freeze(outcome);
  }
}
