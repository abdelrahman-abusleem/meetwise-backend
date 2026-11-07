import type {
  NotificationDeliveryQueuePort,
  NotificationDeliveryRetrySchedule,
} from '../../application/notification-delivery-queue.port';
import { NOTIFICATION_DELIVERY_EVENT_KIND } from '../../domain/notification-delivery.policy';

export interface NotificationQueueLike {
  add(
    name: string,
    data: unknown,
    options?: { readonly jobId?: string; readonly delay?: number },
  ): Promise<{ readonly id?: string }>;
}

export interface NotificationRetryTurnPayload {
  readonly kind: string;
  readonly eventId: string;
  readonly notificationId: string;
  readonly channels: readonly string[];
  readonly processedAt: string;
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`notification-retry-scheduler-${label}-required`);
  }
  return value;
}

export interface BullmqNotificationRetrySchedulerOptions {
  readonly queue: NotificationQueueLike;

  readonly jobName: string;
}

import { queueJobId } from '../queue/queue-job-id';

export class BullmqNotificationRetryScheduler implements NotificationDeliveryQueuePort {
  private readonly queue: NotificationQueueLike;
  private readonly jobName: string;

  constructor(options: BullmqNotificationRetrySchedulerOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.queue === null ||
      typeof options.queue !== 'object' ||
      typeof options.queue.add !== 'function'
    ) {
      throw new Error('notification-retry-scheduler-queue-required');
    }
    if (typeof options.jobName !== 'string' || options.jobName.trim() === '') {
      throw new Error('notification-retry-scheduler-job-name-required');
    }
    this.queue = options.queue;
    this.jobName = options.jobName;
  }

  async scheduleRetry(
    command: NotificationDeliveryRetrySchedule,
  ): Promise<void> {
    if (command === null || typeof command !== 'object') {
      throw new Error('notification-retry-scheduler-command-required');
    }
    const notificationId = requireNonemptyString(
      command.notificationId,
      'notification-id',
    );
    const eventId = requireNonemptyString(command.eventId, 'event-id');
    const kind = requireNonemptyString(command.kind, 'event-kind');
    requireNonemptyString(command.processedAt, 'processed-at');
    if (Number.isNaN(Date.parse(command.processedAt))) {
      throw new Error('notification-retry-scheduler-processed-at-required');
    }
    if (
      !Array.isArray(command.channels) ||
      command.channels.length === 0 ||
      command.channels.some((item) => typeof item !== 'string')
    ) {
      throw new Error('notification-retry-scheduler-channels-required');
    }
    if (
      typeof command.attemptJustExecuted !== 'number' ||
      !Number.isSafeInteger(command.attemptJustExecuted) ||
      command.attemptJustExecuted < 1
    ) {
      throw new Error('notification-retry-scheduler-attempt-required');
    }
    if (
      typeof command.delayMs !== 'number' ||
      !Number.isSafeInteger(command.delayMs) ||
      command.delayMs < 0
    ) {
      throw new Error('notification-retry-scheduler-delay-required');
    }

    if (kind !== NOTIFICATION_DELIVERY_EVENT_KIND) {
      throw new Error('notification-retry-scheduler-event-kind-mismatch');
    }

    const payload: NotificationRetryTurnPayload = {
      kind: command.kind,
      eventId,
      notificationId,
      channels: command.channels,
      processedAt: command.processedAt,
    };
    await this.queue.add(this.jobName, payload, {
      jobId: queueJobId(eventId),
      delay: command.delayMs,
    });
  }
}
