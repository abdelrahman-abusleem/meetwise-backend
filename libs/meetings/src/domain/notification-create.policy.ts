import { fingerprint64 } from './approve-remaining.policy';

export const NOTIFICATION_KINDS: Readonly<string[]> = Object.freeze([
  'meeting.created.v1',
  'meeting.cancelled.v1',
  'meeting.manager_transferred.v1',
  'analysis.finished.v1',
  'execution.unknown.v1',
  'execution.succeeded.v1',
]);

export const NOTIFICATION_CHANNELS: Readonly<string[]> = Object.freeze([
  'IN_APP',
  'SMTP',
]);

export type NotificationFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'UNKNOWN_KIND'
  | 'UNKNOWN_CHANNEL'
  | 'ACCESS_NOT_AUTHORIZED'
  | 'NOTIFICATION_NOT_FOUND';

export interface NotificationEvent {
  readonly outboxEventId: string;
  readonly kind: string;

  readonly resourceId: string;
  readonly recipientUserId: string;

  readonly bodySafe: string;

  readonly createdAt: string;
}

export interface NotificationViewRequest {
  readonly viewerUserId: string;
  readonly notificationId?: string;
  readonly unreadOnly?: unknown;
  readonly cursor?: string;
  readonly limit?: unknown;
}

export type NotificationFailureDecision = Readonly<{
  ok: false;
  reason: NotificationFailure;
  preventEnumeration: boolean;
}>;

export type NotificationDecision =
  Readonly<{ ok: true }> | NotificationFailureDecision;

export class NotificationPolicy {
  authorizeCreate(event: unknown): NotificationDecision {
    if (event === null || typeof event !== 'object') {
      return this.reject('INVALID_REQUEST', false);
    }
    const facts = event as Partial<NotificationEvent>;
    for (const field of [
      'outboxEventId',
      'kind',
      'resourceId',
      'recipientUserId',
      'bodySafe',
      'createdAt',
    ] as const) {
      const value = facts[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    if (NOTIFICATION_KINDS.indexOf(facts.kind as string) === -1) {
      return this.reject('UNKNOWN_KIND', false);
    }
    return Object.freeze({ ok: true as const });
  }

  authorizeView(request: unknown): NotificationDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_REQUEST', false);
    }
    const facts = request as Partial<NotificationViewRequest>;
    if (
      typeof facts.viewerUserId !== 'string' ||
      facts.viewerUserId.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (typeof facts.notificationId === 'string') {
      if (facts.notificationId.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
      return Object.freeze({ ok: true as const });
    }
    if (
      facts.unreadOnly !== undefined &&
      facts.unreadOnly !== true &&
      facts.unreadOnly !== false
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (facts.cursor !== undefined && typeof facts.cursor !== 'string') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      facts.limit !== undefined &&
      (!Number.isSafeInteger(facts.limit) || (facts.limit as number) < 0)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return Object.freeze({ ok: true as const });
  }

  authorizeRecipient(
    viewerUserId: string,
    recipientUserId: string,
  ): NotificationDecision {
    if (viewerUserId !== recipientUserId) {
      return this.reject('ACCESS_NOT_AUTHORIZED', true);
    }
    return Object.freeze({ ok: true as const });
  }

  authorizeChannel(channel: string): NotificationDecision {
    if (typeof channel !== 'string' || channel.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (NOTIFICATION_CHANNELS.indexOf(channel) === -1) {
      return this.reject('UNKNOWN_CHANNEL', false);
    }
    return Object.freeze({ ok: true as const });
  }

  validateStoredRow(
    record: unknown,
    viewerUserId: string,
  ): NotificationFailureDecision | null {
    if (record === null || typeof record !== 'object') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    const row = record as Record<string, unknown>;
    for (const field of [
      'id',
      'recipientUserId',
      'kind',
      'resourceId',
      'bodySafe',
      'state',
      'createdAt',
    ] as const) {
      const value = row[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    if (row.seenAt !== null && typeof row.seenAt !== 'string') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (row.recipientUserId !== viewerUserId) {
      return this.reject('ACCESS_NOT_AUTHORIZED', true);
    }
    return null;
  }

  composeNotificationId(
    outboxEventId: string,
    kind: string,
    recipientUserId: string,
  ): string {
    const canonical =
      `${outboxEventId.length}:${outboxEventId}|` +
      `${kind.length}:${kind}|` +
      `${recipientUserId.length}:${recipientUserId}`;
    return fingerprint64(canonical);
  }

  composeDeliveryId(
    notificationId: string,
    channel: string,
    attempt: number,
  ): string {
    const canonical =
      `${notificationId.length}:${notificationId}|` +
      `${channel.length}:${channel}|` +
      `attempt:${attempt}`;
    return fingerprint64(canonical);
  }

  stateFor(seenAt: string | null): 'UNREAD' | 'READ' {
    return seenAt === null ? 'UNREAD' : 'READ';
  }

  private reject(
    reason: NotificationFailure,
    preventEnumeration: boolean,
  ): NotificationFailureDecision {
    return Object.freeze({ ok: false as const, reason, preventEnumeration });
  }
}
