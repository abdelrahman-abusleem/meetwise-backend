export type DispatchAttemptOutcome =
  | {
      readonly k: 'CONFIRMED';
      readonly externalId: string;
      readonly externalUrl?: string;
    }
  | {
      readonly k: 'RETRYABLE_NO_EFFECT';
      readonly reason: string;
    }
  | {
      readonly k: 'PERMANENT_DENIED';
      readonly reason: string;
    }
  | {
      readonly k: 'UNKNOWN_EFFECT';
    };

export type UnknownLookupOutcome =
  | {
      readonly k: 'FOUND';
      readonly externalId: string;
      readonly externalUrl?: string;
    }
  | {
      readonly k: 'NOT_FOUND_PROVEN';
      readonly reason: string;
    }
  | {
      readonly k: 'UNCERTAIN';
    };

export interface DispatchInstruction {
  readonly executionId: string;
  readonly operation: string;
  readonly destination: string;
  readonly targetKey: string;
  readonly approvedSnapshotId: string;
  readonly approvedPayload: unknown;
}

export interface LookupInstruction {
  readonly executionId: string;
  readonly operation: string;
  readonly destination: string;
  readonly targetKey: string;
}

export interface ExternalExecutionProviderPort {
  executeDispatch(
    instruction: DispatchInstruction,
  ): Promise<DispatchAttemptOutcome>;

  lookupExternalByCorrelation(
    instruction: LookupInstruction,
  ): Promise<UnknownLookupOutcome>;
}

export const PROVIDER_PORT_VIOLATION = 'provider-port-violation' as const;
