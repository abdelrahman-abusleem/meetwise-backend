export const OUTBOX_DISPATCH_CONSUMER = 'outbox-dispatch';

export const OUTBOX_ROW_STATUS_UNPUBLISHED = 'UNPUBLISHED';
export const OUTBOX_ROW_STATUS_DISPATCHED = 'DISPATCHED';

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type OutboxDispatchFailure =
  'INVALID_REQUEST' | 'DECISION_FACTS_REQUIRED';

export type OutboxDispatchFailureDecision = Readonly<{
  ok: false;
  reason: OutboxDispatchFailure;
  preventEnumeration: boolean;
}>;

export type OutboxDispatchDecision =
  Readonly<{ ok: true }> | OutboxDispatchFailureDecision;

export interface OutboxDispatchTurnFact {
  readonly batchLimit: number;

  readonly leaseSeconds: number;

  readonly dispatchedAt: string;
}

export interface OutboxDispatchRow {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;

  readonly eventVersion: number;

  readonly aggregateVersion: number;

  readonly payloadJsonSafe: string;
  readonly attempts: number;

  readonly createdAt: string;

  readonly claimToken: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
}

export interface OutboxEventEnvelope {
  readonly eventId: string;
  readonly type: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;

  readonly payload: Readonly<Record<string, unknown>>;
}

export class OutboxDispatchPolicy {
  authorizeDispatch(fact: unknown): OutboxDispatchDecision {
    if (fact === null || typeof fact !== 'object') {
      return this.reject('INVALID_REQUEST');
    }
    const turn = fact as Partial<OutboxDispatchTurnFact>;
    if (
      typeof turn.batchLimit !== 'number' ||
      !Number.isSafeInteger(turn.batchLimit) ||
      turn.batchLimit < 1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      typeof turn.leaseSeconds !== 'number' ||
      !Number.isSafeInteger(turn.leaseSeconds) ||
      turn.leaseSeconds < 1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      typeof turn.dispatchedAt !== 'string' ||
      turn.dispatchedAt.trim() === '' ||
      !ISO_8601_INSTANT.test(turn.dispatchedAt)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    return Object.freeze({ ok: true as const });
  }

  validateClaimedRow(record: unknown): OutboxDispatchFailureDecision | null {
    if (record === null || typeof record !== 'object') {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const row = record as Partial<OutboxDispatchRow>;
    for (const field of [
      'id',
      'aggregateType',
      'aggregateId',
      'eventType',
      'payloadJsonSafe',
      'claimToken',
      'createdAt',
    ] as const) {
      const value = row[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED');
      }
    }
    for (const field of ['eventVersion', 'attempts'] as const) {
      const value = row[field];
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1
      ) {
        return this.reject('DECISION_FACTS_REQUIRED');
      }
    }
    if (
      typeof row.aggregateVersion !== 'number' ||
      !Number.isSafeInteger(row.aggregateVersion) ||
      row.aggregateVersion < 0
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      (row.correlationId !== null && typeof row.correlationId !== 'string') ||
      (row.causationId !== null && typeof row.causationId !== 'string')
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (!ISO_8601_INSTANT.test(row.createdAt as string)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    return null;
  }

  parseDurablePayload(
    payloadJsonSafe: string,
  ): { ok: true; payload: Record<string, unknown> } | { ok: false } {
    if (typeof payloadJsonSafe !== 'string' || payloadJsonSafe.trim() === '') {
      return { ok: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadJsonSafe);
    } catch {
      return { ok: false };
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return { ok: false };
    }
    return { ok: true, payload: parsed as Record<string, unknown> };
  }

  composePublishEnvelope(
    row: OutboxDispatchRow,
    payload: Readonly<Record<string, unknown>>,
  ): OutboxEventEnvelope {
    return Object.freeze({
      eventId: row.id,
      type: row.eventType,
      version: row.eventVersion,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      aggregateVersion: row.aggregateVersion,
      occurredAt: row.createdAt,
      correlationId: row.correlationId,
      causationId: row.causationId,
      payload: Object.freeze({ ...payload }),
    });
  }

  private reject(reason: OutboxDispatchFailure): OutboxDispatchFailureDecision {
    return Object.freeze({
      ok: false as const,
      reason,
      preventEnumeration: true,
    });
  }
}
