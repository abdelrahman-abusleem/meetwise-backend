import type { OutboxPublishPort } from '../../application/outbox-publish.port';
import type { OutboxEventEnvelope } from '../../domain/outbox-dispatch.policy';

export interface OutboxQueueLike {
  add(
    name: string,
    data: unknown,
    options?: OutboxJobOptionsLike,
  ): Promise<OutboxJobInfoLike>;
}

export interface OutboxJobOptionsLike {
  readonly jobId?: string;
}

export interface OutboxJobInfoLike {
  readonly id?: string;
}

export interface BullmqOutboxPublisherOptions {
  readonly queue: OutboxQueueLike;

  readonly jobName: string;
}

import { queueJobId } from '../queue/queue-job-id';

export class BullmqOutboxDispatcherPublisher implements OutboxPublishPort {
  private readonly queue: OutboxQueueLike;
  private readonly jobName: string;

  constructor(options: BullmqOutboxPublisherOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.queue === null ||
      typeof options.queue !== 'object' ||
      typeof options.queue.add !== 'function'
    ) {
      throw new Error('outbox-publisher-queue-required');
    }
    if (typeof options.jobName !== 'string' || options.jobName.trim() === '') {
      throw new Error('outbox-publisher-job-name-required');
    }
    this.queue = options.queue;
    this.jobName = options.jobName;
  }

  async publish(envelope: OutboxEventEnvelope): Promise<void> {
    if (envelope === null || typeof envelope !== 'object') {
      throw new Error('outbox-publisher-envelope-required');
    }
    await this.queue.add(this.jobName, envelope, {
      jobId: queueJobId(envelope.eventId),
    });
  }
}
