import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  QUEUE_NAMES,
  SmokeTestJobData,
  SYSTEM_JOB_NAMES,
} from '@meetwise/infrastructure/queue';

@Injectable()
export class SystemQueueService {
  constructor(
    @InjectQueue(QUEUE_NAMES.SYSTEM)
    private readonly systemQueue: Queue<SmokeTestJobData>,
  ) {}

  async enqueueSmokeTest(): Promise<string> {
    const job = await this.systemQueue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, {
      message: 'Hello from Meetwise API',
      sentAt: new Date().toISOString(),
    });

    return job.id ?? 'unknown';
  }
}
