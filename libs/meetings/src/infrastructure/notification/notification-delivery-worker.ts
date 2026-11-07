import type {
  NotificationDeliveryService,
  NotificationDeliveryTurnOutcome,
} from '../../application/notification-delivery.service';

export type NotificationDeliveryQueueVerdict = 'ACK' | 'DEAD_LETTER';

export interface NotificationDeliveryTurnRunResult {
  readonly verdict: NotificationDeliveryQueueVerdict;

  readonly outcome: NotificationDeliveryTurnOutcome;
}

export interface NotificationDeliveryWorkerRuntimeOptions {
  readonly service: NotificationDeliveryService;
}

export class NotificationDeliveryWorkerRuntime {
  private readonly service: NotificationDeliveryService;

  constructor(options: NotificationDeliveryWorkerRuntimeOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.service === null ||
      typeof options.service !== 'object'
    ) {
      throw new Error('notification-delivery-worker-service-required');
    }
    this.service = options.service;
  }

  async runTurn(payload: unknown): Promise<NotificationDeliveryTurnRunResult> {
    const outcome = await this.service.processDeliveryTurn(payload);
    if (outcome.kind === 'REFUSED') {
      return { verdict: 'DEAD_LETTER', outcome };
    }
    return { verdict: 'ACK', outcome };
  }
}
