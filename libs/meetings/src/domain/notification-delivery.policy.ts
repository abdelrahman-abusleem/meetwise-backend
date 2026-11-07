import { fingerprint64 } from './approve-remaining.policy';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
} from './notification-create.policy';

export const NOTIFICATION_DELIVERY_EVENT_KIND = 'notification.created.v1';

export const NOTIFICATION_DELIVERY_CONSUMER = 'notification-delivery';

export const NOTIFICATION_DELIVERY_STATUSES: Readonly<string[]> = Object.freeze(
  [
    'PENDING',
    'SENT',
    'RETRYABLE_NO_EFFECT',
    'PERMANENTLY_FAILED',
    'UNKNOWN_EFFECT',
  ],
);

export const DELIVERED_STATUS = 'SENT';

export const PENDING_STATUS = 'PENDING';

export const SMTP_OUTCOMES: Readonly<string[]> = Object.freeze([
  'CONFIRMED',
  'RETRYABLE_NO_EFFECT',
  'PERMANENT_DENIED',
  'UNKNOWN_EFFECT',
]);

export const PERMANENT_STATUS = 'PERMANENTLY_FAILED';
export const RETRYABLE_STATUS = 'RETRYABLE_NO_EFFECT';
export const UNKNOWN_STATUS = 'UNKNOWN_EFFECT';

export type NotificationDeliveryFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'UNKNOWN_KIND'
  | 'UNKNOWN_CHANNEL';

export type NotificationDeliveryFailureDecision = Readonly<{
  ok: false;
  reason: NotificationDeliveryFailure;
  preventEnumeration: boolean;
}>;

export type NotificationDeliveryDecision =
  Readonly<{ ok: true }> | NotificationDeliveryFailureDecision;

export interface NotificationDeliveryTurnFact {
  readonly kind: string;
  readonly eventId: string;
  readonly notificationId: string;
  readonly channels: readonly string[];
  readonly processedAt: string;
}

export interface NotificationDeliveryRetryPolicyFact {
  readonly maxAttempts: number;

  readonly backoffMs: number;

  readonly multiplier: number;

  readonly maxDelayMs: number;
}

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class NotificationDeliveryPolicy {
  authorizeTurn(fact: unknown): NotificationDeliveryDecision {
    if (fact === null || typeof fact !== 'object') {
      return this.reject('INVALID_REQUEST', false);
    }
    const turn = fact as Partial<NotificationDeliveryTurnFact>;
    if (typeof turn.kind !== 'string' || turn.kind.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (turn.kind !== NOTIFICATION_DELIVERY_EVENT_KIND) {
      return this.reject('UNKNOWN_KIND', false);
    }
    if (
      typeof turn.eventId !== 'string' ||
      turn.eventId.trim() === '' ||
      typeof turn.notificationId !== 'string' ||
      turn.notificationId.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      typeof turn.processedAt !== 'string' ||
      turn.processedAt.trim() === '' ||
      !ISO_8601_INSTANT.test(turn.processedAt)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (!Array.isArray(turn.channels) || turn.channels.length === 0) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    const seen: string[] = [];
    for (const channel of turn.channels as unknown[]) {
      if (typeof channel !== 'string' || channel.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
      if (NOTIFICATION_CHANNELS.indexOf(channel) === -1) {
        return this.reject('UNKNOWN_CHANNEL', false);
      }
      if (seen.indexOf(channel) !== -1) {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
      seen.push(channel);
    }
    return Object.freeze({ ok: true as const });
  }

  validateStoredNotificationRow(
    record: unknown,
    expectedNotificationId: string,
  ): NotificationDeliveryFailureDecision | null {
    if (record === null || typeof record !== 'object') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    const row = record as Record<string, unknown>;
    if (row.id !== expectedNotificationId) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    for (const field of [
      'id',
      'recipientUserId',
      'kind',
      'resourceId',
      'bodySafe',
      'state',
      'createdAt',
    ] as const) {
      if (typeof row[field] !== 'string' || row[field].trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    if (row.seenAt !== null && typeof row.seenAt !== 'string') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (NOTIFICATION_KINDS.indexOf(row.kind as string) === -1) {
      return this.reject('UNKNOWN_KIND', false);
    }
    const seenAt = row.seenAt === null ? null : row.seenAt;
    const derived = seenAt === null ? 'UNREAD' : 'READ';
    if (row.state !== derived) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return null;
  }

  validateStoredAttemptRow(
    record: unknown,
    notificationId: string,
    channel: string,
  ): NotificationDeliveryFailureDecision | null {
    if (record === null || typeof record !== 'object') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    const row = record as Record<string, unknown>;
    for (const field of [
      'id',
      'notificationId',
      'channel',
      'status',
    ] as const) {
      if (typeof row[field] !== 'string' || row[field].trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    if (
      typeof row.attempt !== 'number' ||
      !Number.isInteger(row.attempt) ||
      row.attempt < 1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      row.externalMessageId !== null &&
      typeof row.externalMessageId !== 'string'
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (row.notificationId !== notificationId || row.channel !== channel) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (NOTIFICATION_DELIVERY_STATUSES.indexOf(row.status as string) === -1) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return null;
  }

  validateAttemptsContiguity(
    ordinals: readonly number[],
  ): NotificationDeliveryFailureDecision | null {
    for (let index = 0; index < ordinals.length; index += 1) {
      if (ordinals[index] !== index + 1) {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    return null;
  }

  validateRetryPolicy(
    policy: NotificationDeliveryRetryPolicyFact | null | undefined,
  ): NotificationDeliveryDecision {
    if (policy === null || policy === undefined) {
      return Object.freeze({ ok: true as const });
    }
    if (typeof policy !== 'object') {
      return this.reject('INVALID_REQUEST', false);
    }
    if (
      typeof policy.maxAttempts !== 'number' ||
      !Number.isSafeInteger(policy.maxAttempts) ||
      policy.maxAttempts < 1 ||
      typeof policy.backoffMs !== 'number' ||
      !Number.isSafeInteger(policy.backoffMs) ||
      policy.backoffMs < 0 ||
      typeof policy.multiplier !== 'number' ||
      !Number.isFinite(policy.multiplier) ||
      policy.multiplier < 1 ||
      typeof policy.maxDelayMs !== 'number' ||
      !Number.isSafeInteger(policy.maxDelayMs) ||
      policy.maxDelayMs < 0
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (policy.maxDelayMs < policy.backoffMs) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return Object.freeze({ ok: true as const });
  }

  composeNextRetryDelay(
    policy: NotificationDeliveryRetryPolicyFact,
    attemptJustExecuted: number,
  ): number | null {
    if (attemptJustExecuted < 1 || attemptJustExecuted >= policy.maxAttempts) {
      return null;
    }

    if (policy.backoffMs === 0) return 0;
    const linear =
      policy.backoffMs * policy.multiplier ** (attemptJustExecuted - 1);
    return Math.floor(Math.min(linear, policy.maxDelayMs));
  }

  composeInboxReceiptId(
    consumer: string,
    eventId: string,
    notificationId: string,
  ): string {
    const canonical = `${consumer.length}:${consumer}|${eventId.length}:${eventId}|${notificationId.length}:${notificationId}`;
    return fingerprint64(canonical);
  }

  composeRetryJobEventId(eventId: string, attemptJustExecuted: number): string {
    const suffix = `retry:${attemptJustExecuted}`;
    const canonical = `${eventId.length}:${eventId}`;
    return fingerprint64(`${canonical}|${suffix}`);
  }

  private reject(
    reason: NotificationDeliveryFailure,
    preventEnumeration: boolean,
  ): NotificationDeliveryFailureDecision {
    return Object.freeze({ ok: false as const, reason, preventEnumeration });
  }
}
