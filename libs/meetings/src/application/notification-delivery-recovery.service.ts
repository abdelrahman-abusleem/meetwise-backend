import {
  DELIVERED_STATUS,
  NotificationDeliveryPolicy,
  PENDING_STATUS,
} from '../domain/notification-delivery.policy';
import {
  NotificationRecoveryPolicy,
  type NotificationRecoveryTurnFact,
} from '../domain/notification-delivery-recovery.policy';
import type { DeliveryAttemptRecord } from './notification.repository';
import type { NotificationDeliveryRepository } from './notification-delivery.repository';

export interface RecoveryAttemptFact {
  readonly id: string;
  readonly notificationId: string;
  readonly channel: string;
  readonly attempt: number;
  readonly status: string;
  readonly externalMessageId: string | null;
}

export type NotificationRecoveryOutcome = Readonly<
  | {
      kind: 'REFUSED';
      reason: string;
      preventEnumeration: boolean;
    }
  | {
      kind: 'NOT_PRESENT';
      notificationId: string;
      channel: string;
      attempt: number;

      durableSeriesEnd: number;
    }
  | {
      kind: 'UNRESOLVABLE';
      attemptId: string;
      channel: string;
      attempt: number;

      cause: 'SMTP_EFFECT_UNPROVEN';
    }
  | {
      kind: 'NOT_PENDING';
      attemptId: string;
      channel: string;
      attempt: number;

      durableStatus: string;
      resolution: null;
    }
  | {
      kind: 'CAS_REFUSED';
      attemptId: string;
      channel: string;
      attempt: number;
      resolution: string;

      durable: RecoveryAttemptFact;
    }
  | {
      kind: 'RESOLVED';
      attemptId: string;
      channel: string;
      attempt: number;

      nextStatus: string;

      externalMessageId: string | null;
      resolution: string;
    }
>;

export class NotificationDeliveryRecoveryService {
  private readonly repository: NotificationDeliveryRepository;
  private readonly recoveryPolicy: NotificationRecoveryPolicy;
  private readonly deliveryPolicy: NotificationDeliveryPolicy;

  constructor(
    repository: NotificationDeliveryRepository,
    recoveryPolicy?: NotificationRecoveryPolicy,
    deliveryPolicy?: NotificationDeliveryPolicy,
  ) {
    this.repository = repository;
    this.recoveryPolicy = recoveryPolicy ?? new NotificationRecoveryPolicy();
    this.deliveryPolicy = deliveryPolicy ?? new NotificationDeliveryPolicy();
  }

  async processRecoveryTurn(
    turn: unknown,
  ): Promise<NotificationRecoveryOutcome> {
    const gate = this.recoveryPolicy.authorizeTurn(turn);
    if (gate.ok !== true) {
      return Object.freeze({
        kind: 'REFUSED' as const,
        reason: gate.reason,
        preventEnumeration: gate.preventEnumeration,
      });
    }
    const fact = turn as NotificationRecoveryTurnFact;

    const attempts = await this.repository.readChannelAttempts(
      fact.notificationId,
      fact.channel,
    );
    if (!Array.isArray(attempts)) {
      throw new Error('notification-delivery-repository-port-violation');
    }
    const rows = attempts as readonly DeliveryAttemptRecord[];
    for (const row of rows) {
      if (
        this.deliveryPolicy.validateStoredAttemptRow(
          row,
          fact.notificationId,
          fact.channel,
        ) !== null
      ) {
        throw new Error('notification-delivery-row-mapping-corrupt');
      }
    }
    const ordinals = rows.map((attemptRow) => attemptRow.attempt);
    if (this.deliveryPolicy.validateAttemptsContiguity(ordinals) !== null) {
      throw new Error('notification-delivery-row-mapping-corrupt');
    }

    const targetRow = rows.find((row) => row.attempt === fact.attempt);
    if (targetRow === undefined) {
      return Object.freeze({
        kind: 'NOT_PRESENT' as const,
        notificationId: fact.notificationId,
        channel: fact.channel,
        attempt: fact.attempt,
        durableSeriesEnd: rows.length,
      });
    }

    if (targetRow.status !== PENDING_STATUS) {
      return Object.freeze({
        kind: 'NOT_PENDING' as const,
        attemptId: targetRow.id,
        channel: fact.channel,
        attempt: fact.attempt,
        durableStatus: targetRow.status,
        resolution: null,
      });
    }

    if (fact.channel === 'SMTP') {
      return Object.freeze({
        kind: 'UNRESOLVABLE' as const,
        attemptId: targetRow.id,
        channel: fact.channel,
        attempt: fact.attempt,
        cause: 'SMTP_EFFECT_UNPROVEN' as const,
      });
    }

    const target = this.recoveryPolicy.resolveTarget(fact.channel);
    if (target.nextStatus === DELIVERED_STATUS) {
      const notificationRow = await this.repository.loadNotificationRow(
        fact.notificationId,
      );
      if (
        notificationRow === null ||
        this.deliveryPolicy.validateStoredNotificationRow(
          notificationRow,
          fact.notificationId,
        ) !== null
      ) {
        throw new Error('notification-delivery-row-mapping-corrupt');
      }
    }

    const settled = await this.repository.settleAttempt({
      id: targetRow.id,
      expectedStatus: PENDING_STATUS,
      nextStatus: target.nextStatus,
      externalMessageId: null,
    });
    if (!settled.settled) {
      return Object.freeze({
        kind: 'CAS_REFUSED' as const,
        attemptId: settled.record.id,
        channel: fact.channel,
        attempt: fact.attempt,
        resolution: target.resolution,
        durable: this.toAttemptFact(settled.record),
      });
    }
    return Object.freeze({
      kind: 'RESOLVED' as const,
      attemptId: settled.record.id,
      channel: fact.channel,
      attempt: fact.attempt,
      nextStatus: settled.record.status,
      externalMessageId: settled.record.externalMessageId,
      resolution: target.resolution,
    });
  }

  private toAttemptFact(record: DeliveryAttemptRecord): RecoveryAttemptFact {
    return Object.freeze({
      id: record.id,
      notificationId: record.notificationId,
      channel: record.channel,
      attempt: record.attempt,
      status: record.status,
      externalMessageId: record.externalMessageId,
    });
  }
}
