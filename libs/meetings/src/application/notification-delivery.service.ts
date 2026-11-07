import { NotificationPolicy } from '../domain/notification-create.policy';
import {
  DELIVERED_STATUS,
  NOTIFICATION_DELIVERY_CONSUMER,
  NOTIFICATION_DELIVERY_EVENT_KIND,
  NotificationDeliveryPolicy,
  PENDING_STATUS,
  PERMANENT_STATUS,
  RETRYABLE_STATUS,
  SMTP_OUTCOMES,
  UNKNOWN_STATUS,
  type NotificationDeliveryRetryPolicyFact,
  type NotificationDeliveryTurnFact,
} from '../domain/notification-delivery.policy';
import type { DeliveryAttemptRecord } from './notification.repository';
import type { NotificationDeliveryRepository } from './notification-delivery.repository';
import type {
  NotificationSmtpProviderPort,
  SmtpEmailDeliveryCommand,
} from './notification-delivery-provider.port';
import type {
  NotificationDeliveryQueuePort,
  NotificationDeliveryRetrySchedule,
} from './notification-delivery-queue.port';

export type NotificationDeliveryChannelOutcome = Readonly<
  | {
      kind: 'DELIVERED';
      channel: string;

      attempt: number;
      externalMessageId: string | null;
    }
  | {
      kind: 'ALREADY_DELIVERED';
      channel: string;

      settledAttemptId: string;
    }
  | {
      kind: 'SCHEDULED_RETRY';
      channel: string;
      attempt: number;
      delayMs: number;

      retryJobEventId: string;
    }
  | {
      kind: 'NO_RETRY';
      channel: string;
      attempt: number;

      status: string | null;

      cause:
        | 'BOUNDS_EXHAUSTED'
        | 'RETRY_UNCONFIGURED'
        | 'UNSETTLED_CLAIM'
        | 'CLAIM_HELD'
        | 'PERMANENT'
        | 'UNKNOWN'
        | null;
    }
>;

export type NotificationDeliveryTurnOutcome = Readonly<
  | {
      kind: 'REFUSED';
      reason: string;
      preventEnumeration: boolean;
    }
  | {
      kind: 'REPLAYED';

      outcome: string;

      processedAt: string | null;
    }
  | {
      kind: 'COMPLETED';
      results: readonly NotificationDeliveryChannelOutcome[];
    }
>;

interface ProviderStepFact {
  readonly statusFact: string;
  readonly externalMessageId: string | null;
}

type SectionResolution =
  | Readonly<{
      kind: 'DELIVERED';
      settledAttemptId: string;
      nextOrdinal: number;
    }>
  | Readonly<{
      kind: 'OPEN';

      pendingOrdinal: number | null;
      nextOrdinal: number;
    }>
  | Readonly<{
      kind: 'BLOCKED_TERMINAL';

      attempt: number;

      status: string;
      cause: 'UNKNOWN' | 'PERMANENT';
    }>;

export class NotificationDeliveryService {
  private readonly repository: NotificationDeliveryRepository;
  private readonly smtpPort: NotificationSmtpProviderPort;
  private readonly queuePort: NotificationDeliveryQueuePort;
  private readonly retryPolicy: NotificationDeliveryRetryPolicyFact | null;
  private readonly deliveryPolicy: NotificationDeliveryPolicy;
  private readonly notificationPolicy: NotificationPolicy;

  constructor(
    repository: NotificationDeliveryRepository,
    smtpPort: NotificationSmtpProviderPort,
    queuePort: NotificationDeliveryQueuePort,
    retryPolicy: NotificationDeliveryRetryPolicyFact | null = null,
    deliveryPolicy?: NotificationDeliveryPolicy,
    notificationPolicy?: NotificationPolicy,
  ) {
    this.repository = repository;
    this.smtpPort = smtpPort;
    this.queuePort = queuePort;
    this.deliveryPolicy = deliveryPolicy ?? new NotificationDeliveryPolicy();
    this.notificationPolicy = notificationPolicy ?? new NotificationPolicy();
    const retryGate = this.deliveryPolicy.validateRetryPolicy(retryPolicy);
    if (retryGate.ok !== true) {
      throw new Error('notification-delivery-invalid-retry-policy');
    }
    this.retryPolicy = retryPolicy ?? null;
  }

  async processDeliveryTurn(
    turn: unknown,
  ): Promise<NotificationDeliveryTurnOutcome> {
    const gate = this.deliveryPolicy.authorizeTurn(turn);
    if (gate.ok !== true) {
      return Object.freeze({
        kind: 'REFUSED' as const,
        reason: gate.reason,
        preventEnumeration: gate.preventEnumeration,
      });
    }
    const fact = turn as NotificationDeliveryTurnFact;

    const receipt = await this.repository.findInboxOutcome(
      NOTIFICATION_DELIVERY_CONSUMER,
      fact.eventId,
    );
    if (receipt !== null) {
      const expectedReceiptId = this.deliveryPolicy.composeInboxReceiptId(
        NOTIFICATION_DELIVERY_CONSUMER,
        fact.eventId,
        fact.notificationId,
      );
      if (receipt.id !== expectedReceiptId) {
        throw new Error('notification-delivery-receipt-identity-mismatch');
      }
      return Object.freeze({
        kind: 'REPLAYED' as const,
        outcome: receipt.outcome,
        processedAt: receipt.processedAt,
      });
    }

    const row = await this.repository.loadNotificationRow(fact.notificationId);
    if (row === null) {
      throw new Error('notification-delivery-row-mapping-corrupt');
    }
    if (
      this.deliveryPolicy.validateStoredNotificationRow(
        row,
        fact.notificationId,
      ) !== null
    ) {
      throw new Error('notification-delivery-row-mapping-corrupt');
    }

    const results: NotificationDeliveryChannelOutcome[] = [];
    for (const channel of fact.channels) {
      const outcome =
        channel === 'IN_APP'
          ? await this.deliverInApp(fact, channel)
          : await this.deliverSmtp(fact, channel, row);
      results.push(outcome);
    }

    const write = await this.repository.writeInboxOutcome({
      eventId: fact.eventId,
      processedAt: fact.processedAt,
      outcome: JSON.stringify(results),
      id: this.deliveryPolicy.composeInboxReceiptId(
        NOTIFICATION_DELIVERY_CONSUMER,
        fact.eventId,
        fact.notificationId,
      ),
      consumer: NOTIFICATION_DELIVERY_CONSUMER,
    });
    if (write.created === false) {
      if (
        write.existingId !==
        this.deliveryPolicy.composeInboxReceiptId(
          NOTIFICATION_DELIVERY_CONSUMER,
          fact.eventId,
          fact.notificationId,
        )
      ) {
        throw new Error('notification-delivery-receipt-identity-mismatch');
      }
      if (write.outcome === null) {
        throw new Error('notification-delivery-receipt-outcome-missing');
      }
      return Object.freeze({
        kind: 'REPLAYED' as const,
        outcome: write.outcome,
        processedAt: null,
      });
    }
    return Object.freeze({
      kind: 'COMPLETED' as const,
      results: Object.freeze(results),
    });
  }

  private async deliverInApp(
    fact: NotificationDeliveryTurnFact,
    channel: string,
  ): Promise<NotificationDeliveryChannelOutcome> {
    const settled = await this.reserveAndSettle(fact, channel, () =>
      Promise.resolve({
        statusFact: DELIVERED_STATUS,
        externalMessageId: null,
      }),
    );
    if (settled === null) {
      throw new Error('notification-delivery-settlement-conflict');
    }
    return settled;
  }

  private async deliverSmtp(
    fact: NotificationDeliveryTurnFact,
    channel: string,
    row: { recipientUserId: string; kind: string; bodySafe: string },
  ): Promise<NotificationDeliveryChannelOutcome> {
    const contact = await this.repository.loadRecipientContact(
      row.recipientUserId,
    );
    if (typeof contact !== 'string' || contact.trim() === '') {
      throw new Error('notification-delivery-recipient-unresolvable');
    }
    const settled = await this.reserveAndSettle(fact, channel, (ordinal) => {
      const command: SmtpEmailDeliveryCommand = {
        to: contact,
        kind: row.kind,
        bodySafe: row.bodySafe,
        attempt: ordinal,
      };
      return this.invokeSmtpPort(command);
    });
    if (settled === null) {
      throw new Error('notification-delivery-settlement-conflict');
    }
    return settled;
  }

  private async invokeSmtpPort(
    command: SmtpEmailDeliveryCommand,
  ): Promise<ProviderStepFact> {
    const result = await this.smtpPort.sendEmail(command);
    if (
      result === null ||
      typeof result !== 'object' ||
      SMTP_OUTCOMES.indexOf(result.outcome) === -1 ||
      (result.externalMessageId !== null &&
        typeof result.externalMessageId !== 'string')
    ) {
      throw new Error('notification-delivery-provider-port-violation');
    }
    const statusFact =
      result.outcome === 'CONFIRMED'
        ? DELIVERED_STATUS
        : result.outcome === 'RETRYABLE_NO_EFFECT'
          ? RETRYABLE_STATUS
          : result.outcome === 'PERMANENT_DENIED'
            ? PERMANENT_STATUS
            : UNKNOWN_STATUS;
    return { statusFact, externalMessageId: result.externalMessageId };
  }

  private async reserveAndSettle(
    fact: NotificationDeliveryTurnFact,
    channel: string,
    providerStep: (ordinal: number) => Promise<ProviderStepFact>,
  ): Promise<NotificationDeliveryChannelOutcome | null> {
    const notificationId = fact.notificationId;
    const section = await this.resolveSection(notificationId, channel);
    if (section.kind === 'DELIVERED') {
      return Object.freeze({
        kind: 'ALREADY_DELIVERED' as const,
        channel,
        settledAttemptId: section.settledAttemptId,
      });
    }
    if (section.kind === 'OPEN' && section.pendingOrdinal !== null) {
      return Object.freeze({
        kind: 'NO_RETRY' as const,
        channel,
        attempt: section.pendingOrdinal,
        status: PENDING_STATUS,
        cause: 'UNSETTLED_CLAIM',
      });
    }
    if (section.kind === 'BLOCKED_TERMINAL') {
      return Object.freeze({
        kind: 'NO_RETRY' as const,
        channel,
        attempt: section.attempt,
        status: section.status,
        cause: section.cause,
      });
    }
    const ordinal = section.nextOrdinal;
    if (this.retryPolicy !== null && ordinal > this.retryPolicy.maxAttempts) {
      return Object.freeze({
        kind: 'NO_RETRY' as const,
        channel,
        attempt: ordinal,
        status: null,
        cause: 'BOUNDS_EXHAUSTED',
      });
    }
    const reserved = await this.reservePending(
      notificationId,
      channel,
      ordinal,
    );
    if (!reserved.reserved) {
      if (reserved.existing === null) {
        throw new Error('notification-delivery-claim-conflict');
      }
      if (reserved.existing.status === DELIVERED_STATUS) {
        return Object.freeze({
          kind: 'ALREADY_DELIVERED' as const,
          channel,
          settledAttemptId: reserved.existing.id,
        });
      }
      if (reserved.existing.status === PENDING_STATUS) {
        return Object.freeze({
          kind: 'NO_RETRY' as const,
          channel,
          attempt: ordinal,
          status: PENDING_STATUS,
          cause: 'UNSETTLED_CLAIM',
        });
      }

      return Object.freeze({
        kind: 'NO_RETRY' as const,
        channel,
        attempt: ordinal,
        status: reserved.existing.status,
        cause: 'CLAIM_HELD',
      });
    }

    const step = await providerStep(ordinal);
    const attemptId = this.notificationPolicy.composeDeliveryId(
      notificationId,
      channel,
      ordinal,
    );
    const settledAttempt = await this.repository.settleAttempt({
      id: attemptId,
      expectedStatus: PENDING_STATUS,
      nextStatus: step.statusFact,
      externalMessageId: step.externalMessageId,
    });
    if (!settledAttempt.settled) {
      return null;
    }
    if (step.statusFact === DELIVERED_STATUS) {
      return Object.freeze({
        kind: 'DELIVERED' as const,
        channel,
        attempt: ordinal,
        externalMessageId: step.externalMessageId,
      });
    }
    if (step.statusFact === RETRYABLE_STATUS) {
      const delayMs =
        this.retryPolicy === null
          ? null
          : this.deliveryPolicy.composeNextRetryDelay(
              this.retryPolicy,
              ordinal,
            );
      if (delayMs === null) {
        return Object.freeze({
          kind: 'NO_RETRY' as const,
          channel,
          attempt: ordinal,
          status: step.statusFact,
          cause:
            this.retryPolicy === null
              ? 'RETRY_UNCONFIGURED'
              : 'BOUNDS_EXHAUSTED',
        });
      }
      const retryJobEventId = this.deliveryPolicy.composeRetryJobEventId(
        fact.eventId,
        ordinal,
      );
      const schedule: NotificationDeliveryRetrySchedule = {
        notificationId,
        eventId: retryJobEventId,
        kind: NOTIFICATION_DELIVERY_EVENT_KIND,
        channels: [channel],
        attemptJustExecuted: ordinal,
        delayMs,
        processedAt: fact.processedAt,
      };
      await this.queuePort.scheduleRetry(schedule);
      return Object.freeze({
        kind: 'SCHEDULED_RETRY' as const,
        channel,
        attempt: ordinal,
        delayMs,
        retryJobEventId,
      });
    }
    return Object.freeze({
      kind: 'NO_RETRY' as const,
      channel,
      attempt: ordinal,
      status: step.statusFact,
      cause: step.statusFact === PERMANENT_STATUS ? 'PERMANENT' : 'UNKNOWN',
    });
  }

  private async resolveSection(
    notificationId: string,
    channel: string,
  ): Promise<SectionResolution> {
    const attempts = await this.repository.readChannelAttempts(
      notificationId,
      channel,
    );
    if (!Array.isArray(attempts)) {
      throw new Error('notification-delivery-repository-port-violation');
    }
    const rows = attempts as readonly DeliveryAttemptRecord[];
    for (const row of rows) {
      if (
        this.deliveryPolicy.validateStoredAttemptRow(
          row,
          notificationId,
          channel,
        ) !== null
      ) {
        throw new Error('notification-delivery-row-mapping-corrupt');
      }
    }
    const ordinals = rows.map((attemptRow) => attemptRow.attempt);
    if (this.deliveryPolicy.validateAttemptsContiguity(ordinals) !== null) {
      throw new Error('notification-delivery-row-mapping-corrupt');
    }
    let pendingOrdinal: number | null = null;
    let firstUnknownOrdinal: number | null = null;
    let firstPermanentOrdinal: number | null = null;
    for (const row of rows) {
      if (row.status === DELIVERED_STATUS) {
        return {
          kind: 'DELIVERED',
          settledAttemptId: row.id,
          nextOrdinal: rows.length + 1,
        };
      }
      if (row.status === PENDING_STATUS && pendingOrdinal === null) {
        pendingOrdinal = row.attempt;
      }
      if (row.status === UNKNOWN_STATUS && firstUnknownOrdinal === null) {
        firstUnknownOrdinal = row.attempt;
      }
      if (row.status === PERMANENT_STATUS && firstPermanentOrdinal === null) {
        firstPermanentOrdinal = row.attempt;
      }
    }
    if (firstUnknownOrdinal !== null) {
      return {
        kind: 'BLOCKED_TERMINAL',
        attempt: firstUnknownOrdinal,
        status: UNKNOWN_STATUS,
        cause: 'UNKNOWN',
      };
    }
    if (firstPermanentOrdinal !== null) {
      return {
        kind: 'BLOCKED_TERMINAL',
        attempt: firstPermanentOrdinal,
        status: PERMANENT_STATUS,
        cause: 'PERMANENT',
      };
    }
    return {
      kind: 'OPEN',
      pendingOrdinal,
      nextOrdinal: rows.length + 1,
    };
  }

  private async reservePending(
    notificationId: string,
    channel: string,
    ordinal: number,
  ): Promise<{
    reserved: boolean;
    existing: { id: string; status: string } | null;
  }> {
    const reserved = await this.repository.reserveAttempt({
      id: this.notificationPolicy.composeDeliveryId(
        notificationId,
        channel,
        ordinal,
      ),
      notificationId,
      channel,
      attempt: ordinal,
      status: PENDING_STATUS,
      externalMessageId: null,
    });
    if (reserved.reserved === true) {
      return { reserved: true, existing: null };
    }
    const existing = reserved.existing;
    if (existing === null) {
      throw new Error('notification-delivery-claim-conflict');
    }
    return {
      reserved: false,
      existing: { id: existing.id, status: existing.status },
    };
  }
}
