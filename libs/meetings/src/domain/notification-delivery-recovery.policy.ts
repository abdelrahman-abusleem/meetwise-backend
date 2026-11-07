import { NOTIFICATION_CHANNELS } from './notification-create.policy';
import { DELIVERED_STATUS } from './notification-delivery.policy';

export const NOTIFICATION_RECOVERY_DUTY =
  'reconcile.notification.channel-attempt.v1';

export const RECOVERY_IN_APP_RESOLUTION = 'IN_APP_REACCEPT';
export const RECOVERY_SMTP_RESOLUTION = 'SMTP_UNCERTAIN';

export const RECOVERY_RESOLUTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    IN_APP: DELIVERED_STATUS,
  });

export type NotificationRecoveryFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'UNKNOWN_CHANNEL'
  | 'UNKNOWN_DUTY';

export type NotificationRecoveryFailureDecision = Readonly<{
  ok: false;
  reason: NotificationRecoveryFailure;
  preventEnumeration: boolean;
}>;

export type NotificationRecoveryDecision =
  Readonly<{ ok: true }> | NotificationRecoveryFailureDecision;

export interface NotificationRecoveryTurnFact {
  readonly duty: string;
  readonly notificationId: string;
  readonly channel: string;
  readonly attempt: number;
}

export interface ResolvedRecoveryTarget {
  readonly channel: string;
  readonly nextStatus: string;
  readonly resolution: string;
}

export class NotificationRecoveryPolicy {
  authorizeTurn(fact: unknown): NotificationRecoveryDecision {
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
      return this.reject('INVALID_REQUEST', false);
    }
    const turn = fact as Partial<NotificationRecoveryTurnFact>;
    if (
      typeof turn.notificationId !== 'string' ||
      turn.notificationId.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (turn.duty !== NOTIFICATION_RECOVERY_DUTY) {
      return this.reject('UNKNOWN_DUTY', false);
    }
    if (
      typeof turn.channel !== 'string' ||
      turn.channel.trim() === '' ||
      NOTIFICATION_CHANNELS.indexOf(turn.channel) === -1
    ) {
      return this.reject('UNKNOWN_CHANNEL', false);
    }
    if (
      typeof turn.attempt !== 'number' ||
      !Number.isSafeInteger(turn.attempt) ||
      turn.attempt < 1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return Object.freeze({ ok: true as const });
  }

  resolveTarget(channel: string): ResolvedRecoveryTarget {
    if (NOTIFICATION_CHANNELS.indexOf(channel) === -1) {
      throw new Error('notification-recovery-channel-resolution-defect');
    }
    const nextStatus = RECOVERY_RESOLUTIONS[channel];
    if (nextStatus === undefined) {
      throw new Error('notification-recovery-channel-resolution-defect');
    }
    return Object.freeze({
      channel,
      nextStatus,
      resolution:
        channel === 'IN_APP'
          ? RECOVERY_IN_APP_RESOLUTION
          : RECOVERY_SMTP_RESOLUTION,
    });
  }

  private reject(
    reason: NotificationRecoveryFailure,
    preventEnumeration: boolean,
  ): NotificationRecoveryFailureDecision {
    return Object.freeze({ ok: false as const, reason, preventEnumeration });
  }
}
