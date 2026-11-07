import type {
  DeliveryAttemptRecord,
  NotificationRecord,
} from './notification.repository';
import { NOTIFICATION_DELIVERY_CONSUMER } from '../domain/notification-delivery.policy';

export const DELIVERY_INBOX_CONSUMER = NOTIFICATION_DELIVERY_CONSUMER;

export interface NotificationInboxOutcome {
  readonly id: string;
  readonly consumer: string;
  readonly eventId: string;
  readonly processedAt: string;

  readonly outcome: string;
}

export interface ReservationOutcome {
  readonly reserved: boolean;

  readonly existing: DeliveryAttemptRecord | null;
}

export interface SettlementCommand {
  readonly id: string;
  readonly expectedStatus: string;
  readonly nextStatus: string;
  readonly externalMessageId: string | null;
}

export interface SettlementOutcome {
  readonly settled: boolean;

  readonly record: DeliveryAttemptRecord;
}

export interface InboxWriteOutcome {
  readonly created: boolean;

  readonly outcome: string | null;

  readonly existingId: string | null;
}

export interface NotificationDeliveryRepository {
  findInboxOutcome(
    consumer: string,
    eventId: string,
  ): Promise<NotificationInboxOutcome | null>;

  writeInboxOutcome(
    receipt: NotificationInboxOutcome,
  ): Promise<InboxWriteOutcome>;

  loadNotificationRow(
    notificationId: string,
  ): Promise<NotificationRecord | null>;

  loadRecipientContact(recipientUserId: string): Promise<string | null>;

  readChannelAttempts(
    notificationId: string,
    channel: string,
  ): Promise<readonly DeliveryAttemptRecord[]>;

  reserveAttempt(record: DeliveryAttemptRecord): Promise<ReservationOutcome>;

  settleAttempt(command: SettlementCommand): Promise<SettlementOutcome>;
}
