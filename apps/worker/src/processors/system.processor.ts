import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  QUEUE_NAMES,
  SmokeTestJobData,
  SYSTEM_JOB_NAMES,
} from '@meetwise/infrastructure/queue';

@Processor(QUEUE_NAMES.SYSTEM)
export class SystemProcessor extends WorkerHost {
  process(job: Job<SmokeTestJobData>): Promise<void> {
    if (job.name !== SYSTEM_JOB_NAMES.SMOKE_TEST) {
      return Promise.reject(new Error(`Unknown system job: ${job.name}`));
    }

    console.log('Worker received smoke-test job:', job.data);

    return Promise.resolve();
  }
}
