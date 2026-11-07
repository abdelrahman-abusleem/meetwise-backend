import {
  OutboxDispatchPolicy,
  type OutboxDispatchTurnFact,
  type OutboxEventEnvelope,
} from '../domain/outbox-dispatch.policy';
import type { OutboxDispatchRepository } from './outbox-dispatch.repository';
import type { OutboxPublishPort } from './outbox-publish.port';

export type OutboxDispatchRowOutcome = Readonly<
  | { eventId: string; kind: 'DISPATCHED' }
  | { eventId: string; kind: 'MARK_REFUSED' }
  | { eventId: string; kind: 'PUBLISH_FAILED' }
>;

export type OutboxDispatchTurnOutcome = Readonly<
  | {
      kind: 'REFUSED';
      reason: string;
      preventEnumeration: boolean;
    }
  | {
      kind: 'IDLE';
      claimToken: string;
      claimedCount: 0;
    }
  | {
      kind: 'DISPATCH_TURN';
      claimToken: string;
      claimedCount: number;
      dispatched: number;
      markRefused: number;
      publishFailed: number;
      rows: readonly OutboxDispatchRowOutcome[];
    }
>;

export class OutboxDispatchService {
  private readonly repository: OutboxDispatchRepository;
  private readonly publisher: OutboxPublishPort;
  private readonly policy: OutboxDispatchPolicy;

  constructor(
    repository: OutboxDispatchRepository,
    publisher: OutboxPublishPort,
    policy?: OutboxDispatchPolicy,
  ) {
    this.repository = repository;
    this.publisher = publisher;
    this.policy = policy ?? new OutboxDispatchPolicy();
  }

  async dispatchDueTurn(turn: unknown): Promise<OutboxDispatchTurnOutcome> {
    const gate = this.policy.authorizeDispatch(turn);
    if (gate.ok !== true) {
      return Object.freeze({
        kind: 'REFUSED' as const,
        reason: gate.reason,
        preventEnumeration: gate.preventEnumeration,
      });
    }
    const fact = turn as OutboxDispatchTurnFact;

    const claimed = await this.repository.claimDueUnpublished(
      fact.batchLimit,
      fact.leaseSeconds,
    );
    if (
      claimed.rows.length === 0 ||
      claimed.claim.claimedCount !== claimed.rows.length
    ) {
      if (claimed.claim.claimedCount === 0 && claimed.rows.length === 0) {
        return Object.freeze({
          kind: 'IDLE' as const,
          claimToken: claimed.claim.claimToken,
          claimedCount: 0,
        });
      }

      throw new Error('outbox-dispatch-claim-facts-divergent');
    }

    if (
      claimed.rows.length > fact.batchLimit ||
      claimed.rows.some(
        (claimedRow) => claimedRow.claimToken !== claimed.claim.claimToken,
      )
    ) {
      throw new Error('outbox-dispatch-claim-facts-divergent');
    }

    const rows: OutboxDispatchRowOutcome[] = [];
    let dispatched = 0;
    let markRefused = 0;
    let publishFailed = 0;

    for (const row of claimed.rows) {
      if (this.policy.validateClaimedRow(row) !== null) {
        throw new Error('outbox-dispatch-row-contract-violation');
      }
      const parsed = this.policy.parseDurablePayload(row.payloadJsonSafe);
      if (!parsed.ok) {
        throw new Error('outbox-dispatch-payload-corrupt');
      }
      const envelope: OutboxEventEnvelope = this.policy.composePublishEnvelope(
        row,
        parsed.payload,
      );
      try {
        await this.publisher.publish(envelope);
      } catch {
        publishFailed += 1;
        rows.push(Object.freeze({ eventId: row.id, kind: 'PUBLISH_FAILED' }));
        continue;
      }
      const mark = await this.repository.markDispatched({
        id: row.id,
        claimToken: row.claimToken,
        dispatchedAt: fact.dispatchedAt,
      });
      if (mark.marked) {
        dispatched += 1;
        rows.push(Object.freeze({ eventId: row.id, kind: 'DISPATCHED' }));
      } else {
        markRefused += 1;
        rows.push(Object.freeze({ eventId: row.id, kind: 'MARK_REFUSED' }));
      }
    }

    return Object.freeze({
      kind: 'DISPATCH_TURN' as const,
      claimToken: claimed.claim.claimToken,
      claimedCount: claimed.claim.claimedCount,
      dispatched,
      markRefused,
      publishFailed,
      rows: Object.freeze([...rows]),
    });
  }
}
