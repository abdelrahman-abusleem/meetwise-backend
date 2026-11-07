import {
  NotificationPolicy,
  type NotificationEvent,
  type NotificationFailureDecision,
} from '../domain/notification-create.policy';
import type {
  DeliveryAttemptRecord,
  NotificationRecord,
  NotificationRepository,
} from './notification.repository';

export type { NotificationRepository } from './notification.repository';
export type { NotificationFailureDecision } from '../domain/notification-create.policy';

export interface CreateNotificationQuery {
  readonly event: NotificationEvent;
}

export interface CreateNotificationResult {
  readonly ok: true;
  readonly notificationId: string;

  readonly created: boolean;
}

export interface ListNotificationsQuery {
  readonly viewerUserId: string;
  readonly unreadOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListNotificationsResult {
  readonly ok: true;
  readonly recipientUserId: string;
  readonly notifications: readonly NotificationRecord[];
  readonly nextCursor: string | null;
}

export interface MarkReadQuery {
  readonly viewerUserId: string;
  readonly notificationId: string;

  readonly seenAt: string;
}

export type MarkReadResult =
  | Readonly<{
      ok: true;
      alreadySeen: boolean;
      seenAt: string;
    }>
  | NotificationFailureDecision;

export interface RecordDeliveryQuery {
  readonly notificationId: string;
  readonly channel: string;

  readonly status: string;
  readonly externalMessageId?: string | null;
}

export type RecordDeliveryResult =
  | Readonly<{ ok: true; attempt: DeliveryAttemptRecord }>
  | NotificationFailureDecision;

export type CreateNotificationDecision =
  CreateNotificationResult | NotificationFailureDecision;

export type ListNotificationsDecision =
  ListNotificationsResult | NotificationFailureDecision;

export class NotificationRegistryService {
  private readonly policy: NotificationPolicy;
  private readonly repository: NotificationRepository;

  constructor(repository: NotificationRepository, policy?: NotificationPolicy) {
    this.repository = repository;
    this.policy = policy ?? new NotificationPolicy();
  }

  async createNotification(
    query: CreateNotificationQuery,
  ): Promise<CreateNotificationDecision> {
    if (query === null || typeof query !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    const gate = this.policy.authorizeCreate(query.event);
    if (gate.ok !== true) {
      return gate;
    }
    const event = query.event;
    const id = this.policy.composeNotificationId(
      event.outboxEventId,
      event.kind,
      event.recipientUserId,
    );
    const record: NotificationRecord = {
      id,
      recipientUserId: event.recipientUserId,
      kind: event.kind,
      resourceId: event.resourceId,
      bodySafe: event.bodySafe,
      state: this.policy.stateFor(null),
      createdAt: event.createdAt,
      seenAt: null,
    };
    const stored = await this.repository.insertNotification(record);
    return Object.freeze({
      ok: true as const,
      notificationId: stored.record.id,
      created: stored.created,
    });
  }

  async listForRecipient(
    query: ListNotificationsQuery,
  ): Promise<ListNotificationsDecision> {
    if (query === null || typeof query !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    const gate = this.policy.authorizeView(query);
    if (gate.ok !== true) {
      return gate;
    }

    const page = await this.repository.listForRecipient(
      query.viewerUserId,
      query.unreadOnly === true,
      query.cursor,
      query.limit,
    );
    if (
      page === null ||
      typeof page !== 'object' ||
      !Array.isArray(page.items)
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }

    const rows: NotificationRecord[] = [];
    const items: readonly unknown[] = page.items;
    for (const item of items) {
      const failure = this.policy.validateStoredRow(item, query.viewerUserId);
      if (failure !== null) {
        return failure;
      }

      const row = item as NotificationRecord;
      rows.push(
        Object.freeze({
          id: row.id,
          recipientUserId: row.recipientUserId,
          kind: row.kind,
          resourceId: row.resourceId,
          bodySafe: row.bodySafe,
          state: row.state,
          createdAt: row.createdAt,
          seenAt: row.seenAt,
        }),
      );
    }
    return Object.freeze({
      ok: true as const,
      recipientUserId: query.viewerUserId,
      notifications: Object.freeze(rows),
      nextCursor: page.nextCursor,
    });
  }

  async markRead(query: MarkReadQuery): Promise<MarkReadResult> {
    if (query === null || typeof query !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    const gate = this.policy.authorizeView(query);
    if (gate.ok !== true) {
      return gate;
    }
    if (typeof query.seenAt !== 'string' || query.seenAt.trim() === '') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    const record = await this.repository.findNotification(query.notificationId);

    if (record === null) {
      return Object.freeze({
        ok: false as const,
        reason: 'ACCESS_NOT_AUTHORIZED',
        preventEnumeration: true,
      });
    }
    const recipientGate = this.policy.authorizeRecipient(
      query.viewerUserId,
      record.recipientUserId,
    );
    if (recipientGate.ok !== true) {
      return recipientGate;
    }
    if (record.seenAt !== null) {
      return Object.freeze({
        ok: true as const,
        alreadySeen: true,
        seenAt: record.seenAt,
      });
    }
    const updated = await this.repository.markSeen(
      query.notificationId,
      query.seenAt,
    );

    return Object.freeze({
      ok: true as const,
      alreadySeen: !updated.updated,
      seenAt: updated.seenAt,
    });
  }

  async recordDeliveryAttempt(
    query: RecordDeliveryQuery,
  ): Promise<RecordDeliveryResult> {
    if (query === null || typeof query !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    if (
      typeof query.status !== 'string' ||
      query.status.trim() === '' ||
      (query.externalMessageId !== undefined &&
        query.externalMessageId !== null &&
        typeof query.externalMessageId !== 'string')
    ) {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    const channelGate = this.policy.authorizeChannel(query.channel);
    if (channelGate.ok !== true) {
      return channelGate;
    }
    const record = await this.repository.findNotification(query.notificationId);
    if (record === null) {
      return Object.freeze({
        ok: false as const,
        reason: 'NOTIFICATION_NOT_FOUND',
        preventEnumeration: false,
      });
    }
    const attemptNumber = await this.repository.nextAttemptNumber(
      query.notificationId,
      query.channel,
    );
    const attempt: DeliveryAttemptRecord = {
      id: this.policy.composeDeliveryId(
        query.notificationId,
        query.channel,
        attemptNumber,
      ),
      notificationId: query.notificationId,
      channel: query.channel,
      attempt: attemptNumber,
      status: query.status,
      externalMessageId: query.externalMessageId ?? null,
    };
    const stored = await this.repository.recordDeliveryAttempt(attempt);

    return Object.freeze({ ok: true as const, attempt: stored });
  }
}
