export interface NotificationRecord {
  readonly id: string;
  readonly recipientUserId: string;
  readonly kind: string;
  readonly resourceId: string;
  readonly bodySafe: string;
  readonly state: string;
  readonly createdAt: string;
  readonly seenAt: string | null;
}

export interface RecipientPage {
  readonly items: readonly NotificationRecord[];
  readonly nextCursor: string | null;
}

export interface DeliveryAttemptRecord {
  readonly id: string;
  readonly notificationId: string;
  readonly channel: string;
  readonly attempt: number;
  readonly status: string;
  readonly externalMessageId: string | null;
}

export interface NotificationRepository {
  insertNotification(record: NotificationRecord): Promise<{
    record: NotificationRecord;
    created: boolean;
  }>;

  findNotification(id: string): Promise<NotificationRecord | null>;

  listForRecipient(
    recipientUserId: string,
    unreadOnly: boolean,
    cursor?: string,
    limit?: number,
  ): Promise<RecipientPage>;

  markSeen(
    id: string,
    seenAt: string,
  ): Promise<{ seenAt: string; updated: boolean }>;

  nextAttemptNumber(notificationId: string, channel: string): Promise<number>;

  recordDeliveryAttempt(
    attempt: DeliveryAttemptRecord,
  ): Promise<DeliveryAttemptRecord>;
}
