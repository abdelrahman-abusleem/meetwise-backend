import type {
  NotificationDeliveryRepository,
  NotificationInboxOutcome,
  SettlementCommand,
} from '../../application/notification-delivery.repository';
import type {
  DeliveryAttemptRecord,
  NotificationRecord,
} from '../../application/notification.repository';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
} from '../../domain/notification-create.policy';
import {
  NOTIFICATION_DELIVERY_STATUSES,
  PENDING_STATUS,
} from '../../domain/notification-delivery.policy';

export interface NotificationRawSqlClient {
  $queryRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly unknown[]>;
}
export interface NotificationRawSqlRunner extends NotificationRawSqlClient {
  $transaction<T>(
    work: (client: NotificationRawSqlClient) => Promise<T>,
  ): Promise<T>;
}
const CORRUPT = 'notification-postgres-row-invalid';
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(CORRUPT);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(CORRUPT);
  return value as Record<string, unknown>;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(CORRUPT);
  return value;
}
function one(value: unknown): Record<string, unknown> | null {
  const rows = list(value);
  if (rows.length > 1) throw new Error(CORRUPT);
  return rows.length ? record(rows[0]) : null;
}
function ordinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(CORRUPT);
  return value;
}
function member(value: unknown, values: readonly string[]): string {
  const result = text(value);
  if (!values.includes(result)) throw new Error(CORRUPT);
  return result;
}
function nullable(value: unknown): string | null {
  return value === null ? null : text(value);
}
function instant(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(Date.prototype.getTime.call(value)))
      throw new Error(CORRUPT);
    return Date.prototype.toISOString.call(value);
  }
  const result = text(value);
  const parts =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      result,
    );
  if (!parts || !Number.isFinite(Date.parse(result))) throw new Error(CORRUPT);
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (
    day >
    ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
      0)
  )
    throw new Error(CORRUPT);
  return result;
}
function delivery(value: unknown): DeliveryAttemptRecord {
  const row = record(value);
  return {
    id: text(row.id),
    notificationId: text(row.notificationId),
    channel: member(row.channel, NOTIFICATION_CHANNELS),
    attempt: ordinal(row.attempt),
    status: member(row.status, NOTIFICATION_DELIVERY_STATUSES),
    externalMessageId: nullable(row.externalMessageId),
  };
}
function sameAttempt(
  row: DeliveryAttemptRecord,
  expected: DeliveryAttemptRecord,
): void {
  if (
    row.id !== expected.id ||
    row.notificationId !== expected.notificationId ||
    row.channel !== expected.channel ||
    row.attempt !== expected.attempt
  )
    throw new Error(CORRUPT);
}

export class PostgresNotificationDeliveryRepository implements NotificationDeliveryRepository {
  private readonly runner: NotificationRawSqlRunner;
  constructor(options: { readonly runner: NotificationRawSqlRunner }) {
    if (
      !options?.runner ||
      typeof options.runner.$transaction !== 'function' ||
      typeof options.runner.$queryRaw !== 'function'
    )
      throw new Error('notification-postgres-runner-required');
    this.runner = options.runner;
  }

  async findInboxOutcome(
    consumer: string,
    eventId: string,
  ): Promise<NotificationInboxOutcome | null> {
    text(consumer);
    text(eventId);
    const row = one(
      await this.runner
        .$queryRaw`SELECT id, consumer, event_id AS "eventId", processed_at AS "processedAt", outcome FROM inbox_receipts WHERE consumer = ${consumer} AND event_id = ${eventId}`,
    );
    if (!row) return null;
    if (row.consumer !== consumer || row.eventId !== eventId)
      throw new Error(CORRUPT);
    return {
      id: text(row.id),
      consumer,
      eventId,
      processedAt: instant(row.processedAt),
      outcome: text(row.outcome),
    };
  }

  async writeInboxOutcome(receipt: NotificationInboxOutcome) {
    const id = text(receipt.id),
      consumer = text(receipt.consumer),
      eventId = text(receipt.eventId),
      processedAt = instant(receipt.processedAt),
      outcome = text(receipt.outcome);
    return this.runner.$transaction(async (client) => {
      const inserted = one(
        await client.$queryRaw`INSERT INTO inbox_receipts (id,consumer,event_id,processed_at,outcome) VALUES (${id},${consumer},${eventId},${processedAt}::timestamptz,${outcome}) ON CONFLICT (consumer,event_id) DO NOTHING RETURNING id`,
      );

      if (inserted) {
        if (inserted.id !== id) throw new Error(CORRUPT);
        return { created: true, outcome: null, existingId: null };
      }
      const existing = one(
        await client.$queryRaw`SELECT id,outcome FROM inbox_receipts WHERE consumer = ${consumer} AND event_id = ${eventId}`,
      );
      if (!existing) throw new Error(CORRUPT);
      return {
        created: false,
        outcome: text(existing.outcome),
        existingId: text(existing.id),
      };
    });
  }

  async loadNotificationRow(
    notificationId: string,
  ): Promise<NotificationRecord | null> {
    text(notificationId);
    const row = one(
      await this.runner
        .$queryRaw`SELECT id,recipient_user_id AS "recipientUserId",kind,resource_id AS "resourceId",body_safe AS "bodySafe",state,created_at AS "createdAt",seen_at AS "seenAt" FROM notifications WHERE id = ${notificationId}`,
    );
    if (!row) return null;
    if (row.id !== notificationId) throw new Error(CORRUPT);
    const seenAt = row.seenAt === null ? null : instant(row.seenAt);
    const state = member(row.state, ['UNREAD', 'READ']);
    if ((state === 'READ') !== (seenAt !== null)) throw new Error(CORRUPT);
    return {
      id: notificationId,
      recipientUserId: text(row.recipientUserId),
      kind: member(row.kind, NOTIFICATION_KINDS),
      resourceId: text(row.resourceId),
      bodySafe: text(row.bodySafe),
      state,
      createdAt: instant(row.createdAt),
      seenAt,
    };
  }

  async loadRecipientContact(recipientUserId: string): Promise<string | null> {
    text(recipientUserId);
    const row = one(
      await this.runner
        .$queryRaw`SELECT id,email,is_active AS "isActive" FROM users WHERE id = ${recipientUserId}::uuid AND is_active = true`,
    );
    if (!row) return null;
    if (row.id !== recipientUserId || row.isActive !== true)
      throw new Error(CORRUPT);
    return text(row.email);
  }

  async readChannelAttempts(
    notificationId: string,
    channel: string,
  ): Promise<readonly DeliveryAttemptRecord[]> {
    text(notificationId);
    member(channel, NOTIFICATION_CHANNELS);
    const rows = list(
      await this.runner
        .$queryRaw`SELECT id,notification_id AS "notificationId",channel,attempt,status,external_message_id AS "externalMessageId" FROM notification_deliveries WHERE notification_id = ${notificationId} AND channel = ${channel} ORDER BY attempt`,
    );
    const mapped = rows.map(delivery);
    for (const row of mapped)
      if (row.notificationId !== notificationId || row.channel !== channel)
        throw new Error(CORRUPT);
    return mapped;
  }

  async reserveAttempt(attempt: DeliveryAttemptRecord) {
    const input = delivery(attempt);
    if (input.status !== PENDING_STATUS || input.externalMessageId !== null)
      throw new Error(CORRUPT);
    return this.runner.$transaction(async (client) => {
      const inserted = one(
        await client.$queryRaw`
          WITH eligible AS (
            SELECT n.id FROM notifications n
            JOIN users u ON u.id = n.recipient_user_id
            WHERE n.id = ${input.notificationId} AND u.is_active = true
            FOR SHARE OF n,u
          )
          INSERT INTO notification_deliveries (id,notification_id,channel,attempt,status,external_message_id)
          SELECT ${input.id}, eligible.id, ${input.channel}, ${input.attempt}, ${input.status}, NULL FROM eligible
          ON CONFLICT (notification_id,channel,attempt) DO NOTHING RETURNING id`,
      );
      if (inserted) {
        if (inserted.id !== input.id) throw new Error(CORRUPT);
        return { reserved: true, existing: null };
      }
      const row = one(
        await client.$queryRaw`SELECT id,notification_id AS "notificationId",channel,attempt,status,external_message_id AS "externalMessageId" FROM notification_deliveries WHERE notification_id = ${input.notificationId} AND channel = ${input.channel} AND attempt = ${input.attempt}`,
      );
      if (!row) throw new Error('notification-delivery-recipient-unavailable');
      const existing = delivery(row);
      sameAttempt(existing, input);
      return { reserved: false, existing };
    });
  }

  async settleAttempt(command: SettlementCommand) {
    const id = text(command.id),
      next = member(command.nextStatus, NOTIFICATION_DELIVERY_STATUSES),
      externalId = nullable(command.externalMessageId);
    if (command.expectedStatus !== PENDING_STATUS || next === PENDING_STATUS)
      throw new Error(CORRUPT);
    return this.runner.$transaction(async (client) => {
      const updated = one(
        await client.$queryRaw`UPDATE notification_deliveries SET status = ${next}, external_message_id = ${externalId} WHERE id = ${id} AND status = ${PENDING_STATUS} RETURNING id,notification_id AS "notificationId",channel,attempt,status,external_message_id AS "externalMessageId"`,
      );
      if (updated) {
        const row = delivery(updated);
        if (
          row.id !== id ||
          row.status !== next ||
          row.externalMessageId !== externalId
        )
          throw new Error(CORRUPT);
        return { settled: true, record: row };
      }
      const existing = one(
        await client.$queryRaw`SELECT id,notification_id AS "notificationId",channel,attempt,status,external_message_id AS "externalMessageId" FROM notification_deliveries WHERE id = ${id}`,
      );
      if (!existing) throw new Error(CORRUPT);
      const row = delivery(existing);
      if (row.id !== id) throw new Error(CORRUPT);
      return { settled: false, record: row };
    });
  }
}
