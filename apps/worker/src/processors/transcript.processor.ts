import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '@meetwise/infrastructure/queue';
import { PostgresTranscriptConsumer } from '../../../../libs/meetings/src/infrastructure/transcript-ingest.postgres';

@Processor(QUEUE_NAMES.TRANSCRIPT)
export class TranscriptProcessor extends WorkerHost {
  constructor(private readonly consumer: PostgresTranscriptConsumer) {
    super();
  }
  async process(job: Job<unknown>): Promise<void> {
    const data = job.data;
    if (
      job.name !== 'ingest-inbox.v1' ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).length !== 1 ||
      !Object.hasOwn(data, 'eventId') ||
      typeof (data as Record<string, unknown>).eventId !== 'string'
    )
      throw new Error('Transcript job invalid');
    try {
      await this.consumer.consume((data as { eventId: string }).eventId);
    } catch {
      throw new Error('Transcript ingestion failed');
    }
  }
}
