import { NotificationDeliveryService } from '../../application/notification-delivery.service';
import {
  NotificationDeliveryPolicy,
  type NotificationDeliveryRetryPolicyFact,
} from '../../domain/notification-delivery.policy';
import { NodemailerSmtpDeliveryProvider } from './nodemailer-smtp-delivery-provider';
import type { SmtpTransporterLike } from './nodemailer-smtp-delivery-provider';
import type { NotificationDeliveryRepository } from '../../application/notification-delivery.repository';
import { BullmqNotificationRetryScheduler } from './bullmq-notification-retry-scheduler';
import type { NotificationQueueLike } from './bullmq-notification-retry-scheduler';
import { NotificationDeliveryWorkerRuntime } from './notification-delivery-worker';

export interface NotificationDeliveryCoreConfig {
  readonly repository: NotificationDeliveryRepository;

  readonly transporter: SmtpTransporterLike;

  readonly fromAddress: string;

  readonly queue: NotificationQueueLike;

  readonly retryJobName: string;

  readonly retryPolicy: NotificationDeliveryRetryPolicyFact | null;

  readonly deliveryPolicy?: NotificationDeliveryPolicy;
}

export interface NotificationDeliveryCore {
  readonly repository: NotificationDeliveryRepository;
  readonly smtpProvider: NodemailerSmtpDeliveryProvider;
  readonly retryScheduler: BullmqNotificationRetryScheduler;
  readonly service: NotificationDeliveryService;
  readonly worker: NotificationDeliveryWorkerRuntime;
}

export function composeNotificationDeliveryCore(
  config: NotificationDeliveryCoreConfig,
): NotificationDeliveryCore {
  if (config === null || typeof config !== 'object') {
    throw new Error('notification-delivery-composition-config-required');
  }
  if (
    typeof config.repository !== 'object' ||
    config.repository === null ||
    typeof config.queue !== 'object' ||
    config.queue === null ||
    typeof config.transporter !== 'object' ||
    config.transporter === null
  ) {
    throw new Error('notification-delivery-composition-dependencies-required');
  }
  if (
    typeof config.fromAddress !== 'string' ||
    config.fromAddress.trim() === ''
  ) {
    throw new Error('notification-delivery-composition-from-address-required');
  }
  if (
    typeof config.retryJobName !== 'string' ||
    config.retryJobName.trim() === ''
  ) {
    throw new Error(
      'notification-delivery-composition-retry-job-name-required',
    );
  }
  const deliveryPolicy =
    config.deliveryPolicy ?? new NotificationDeliveryPolicy();

  const repository = config.repository;
  const smtpProvider = new NodemailerSmtpDeliveryProvider({
    transporter: config.transporter,
    fromAddress: config.fromAddress,
  });
  const retryScheduler = new BullmqNotificationRetryScheduler({
    queue: config.queue,
    jobName: config.retryJobName,
  });
  const service = new NotificationDeliveryService(
    repository,
    smtpProvider,
    retryScheduler,
    config.retryPolicy,
    deliveryPolicy,
  );
  const worker = new NotificationDeliveryWorkerRuntime({ service });

  return Object.freeze({
    repository,
    smtpProvider,
    retryScheduler,
    service,
    worker,
  });
}
