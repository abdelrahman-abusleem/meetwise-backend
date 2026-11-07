export interface NotificationDeliveryRetrySchedule {
  readonly notificationId: string;

  readonly eventId: string;

  readonly kind: string;

  readonly channels: readonly string[];

  readonly attemptJustExecuted: number;

  readonly delayMs: number;

  readonly processedAt: string;
}

export interface NotificationDeliveryQueuePort {
  scheduleRetry(command: NotificationDeliveryRetrySchedule): Promise<void>;
}
