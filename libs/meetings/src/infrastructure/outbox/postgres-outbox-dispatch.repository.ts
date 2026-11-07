import { randomUUID } from 'node:crypto';
import type {
  ClaimedDispatchRow,
  DispatchMarkCommand,
  DispatchMarkOutcome,
  OutboxDispatchRepository,
} from '../../application/outbox-dispatch.repository';

export interface OutboxRawSqlClient {
  $queryRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly unknown[]>;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<number>;
}
export interface OutboxRawSqlTransactionRunner extends OutboxRawSqlClient {
  $transaction<T>(work: (client: OutboxRawSqlClient) => Promise<T>): Promise<T>;
}

const MAPPING_ERROR = 'outbox-postgres-row-invalid';
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(MAPPING_ERROR);
  return value;
}
function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result))
    throw new Error(MAPPING_ERROR);
  return result;
}
function integer(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error(MAPPING_ERROR);
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function instant(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(Date.prototype.getTime.call(value)))
      throw new Error(MAPPING_ERROR);
    return Date.prototype.toISOString.call(value);
  }
  const result = text(value);
  const parts =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      result,
    );
  if (!parts || !Number.isFinite(Date.parse(result)))
    throw new Error(MAPPING_ERROR);
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (days[month - 1] ?? 0)) throw new Error(MAPPING_ERROR);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(MAPPING_ERROR);
  return value as Record<string, unknown>;
}
function claimedRow(value: unknown, claimToken: string): ClaimedDispatchRow {
  const row = record(value);
  if (row.claimToken !== claimToken) throw new Error(MAPPING_ERROR);
  return Object.freeze({
    id: uuid(row.id),
    aggregateType: text(row.aggregateType),
    aggregateId: uuid(row.aggregateId),
    eventType: text(row.eventType),
    eventVersion: integer(row.eventVersion, 1),
    aggregateVersion: integer(row.aggregateVersion, 0),
    payloadJsonSafe: text(row.payloadJsonSafe),
    attempts: integer(row.attempts, 1),
    createdAt: instant(row.createdAt),
    claimToken,
    correlationId: nullableText(row.correlationId),
    causationId: nullableText(row.causationId),
  });
}

export class PostgresOutboxDispatchRepository implements OutboxDispatchRepository {
  private readonly runner: OutboxRawSqlTransactionRunner;
  constructor(options: { readonly runner: OutboxRawSqlTransactionRunner }) {
    if (
      !options?.runner ||
      typeof options.runner.$transaction !== 'function' ||
      typeof options.runner.$queryRaw !== 'function' ||
      typeof options.runner.$executeRaw !== 'function'
    )
      throw new Error('outbox-postgres-runner-required');
    this.runner = options.runner;
  }

  async claimDueUnpublished(batchLimit: number, leaseSeconds: number) {
    integer(batchLimit, 1);
    integer(leaseSeconds, 1);
    const claimToken = randomUUID();
    return this.runner.$transaction(async (client) => {
      const raw = await client.$queryRaw`
        WITH due AS (
          SELECT id FROM outbox_events
          WHERE dispatched_at IS NULL
            AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp())
            AND (locked_until IS NULL OR locked_until <= clock_timestamp())
          ORDER BY id LIMIT ${batchLimit}::bigint FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE outbox_events AS event
          SET locked_by = ${claimToken},
              locked_until = clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
              attempts = event.attempts + 1
          FROM due WHERE event.id = due.id
          RETURNING event.id, event.aggregate_type AS "aggregateType",
            event.aggregate_id AS "aggregateId", event.type AS "eventType",
            event.event_version AS "eventVersion", event.aggregate_version AS "aggregateVersion",
            event.payload::text AS "payloadJsonSafe", event.attempts,
            event.created_at AS "createdAt", event.locked_by AS "claimToken",
            event.correlation_id AS "correlationId", event.causation_id AS "causationId"
        ) SELECT * FROM claimed ORDER BY id`;
      if (!Array.isArray(raw) || raw.length > batchLimit)
        throw new Error(MAPPING_ERROR);
      const rows = raw.map((value) => claimedRow(value, claimToken));
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error(MAPPING_ERROR);
      return { claim: { claimToken, claimedCount: rows.length }, rows };
    });
  }

  async markDispatched(
    command: DispatchMarkCommand,
  ): Promise<DispatchMarkOutcome> {
    if (!command || typeof command !== 'object')
      throw new Error('outbox-postgres-mark-required');
    const id = uuid(command.id),
      claimToken = text(command.claimToken),
      dispatchedAt = instant(command.dispatchedAt);
    return this.runner.$transaction(async (client) => {
      const count = await client.$executeRaw`
      UPDATE outbox_events
      SET dispatched_at = ${dispatchedAt}::timestamptz, locked_by = NULL, locked_until = NULL
      WHERE id = ${id}::uuid AND dispatched_at IS NULL
        AND locked_by = ${claimToken} AND locked_until > clock_timestamp()`;
      if (count !== 0 && count !== 1) throw new Error(MAPPING_ERROR);
      if (count === 1) return { marked: true, existingId: null };
      const rows =
        await client.$queryRaw`SELECT id FROM outbox_events WHERE id = ${id}::uuid LIMIT 1`;
      if (!Array.isArray(rows) || rows.length > 1)
        throw new Error(MAPPING_ERROR);
      const existingId = rows.length === 0 ? null : uuid(record(rows[0]).id);
      if (existingId !== null && existingId !== id)
        throw new Error(MAPPING_ERROR);
      return { marked: false, existingId };
    });
  }
}
