import type { OutboxDispatchRow } from '../domain/outbox-dispatch.policy';

export interface OutboxClaim {
  readonly claimToken: string;

  readonly claimedCount: number;
}

export type ClaimedDispatchRow = OutboxDispatchRow;

export interface DispatchMarkCommand {
  readonly id: string;

  readonly claimToken: string;

  readonly dispatchedAt: string;
}

export interface DispatchMarkOutcome {
  readonly marked: boolean;

  readonly existingId: string | null;
}

export interface OutboxDispatchRepository {
  claimDueUnpublished(
    batchLimit: number,
    leaseSeconds: number,
  ): Promise<{
    claim: OutboxClaim;
    rows: readonly ClaimedDispatchRow[];
  }>;

  markDispatched(command: DispatchMarkCommand): Promise<DispatchMarkOutcome>;
}
