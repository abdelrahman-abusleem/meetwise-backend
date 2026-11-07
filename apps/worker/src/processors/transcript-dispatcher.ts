import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '@meetwise/infrastructure/database';
import { QUEUE_NAMES } from '@meetwise/infrastructure/queue';

@Injectable()
export class TranscriptDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TranscriptDispatcher.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private cursor: { id: string; createdAt: Date } | null = null;
  constructor(
    private readonly database: PrismaService,
    @InjectQueue(QUEUE_NAMES.TRANSCRIPT) private readonly queue: Queue,
  ) {}
  onModuleInit(): void {
    if (!process.env.TRANSCRIPT_KEYRING_FILE) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.dispatchPending()
        .catch(() => this.logger.error('Transcript inbox dispatch unavailable'))
        .finally(() => {
          this.busy = false;
        });
    }, 5_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  async dispatchPending(): Promise<number> {
    const rows = await this.database.$queryRaw<
      { id: string; createdAt: Date }[]
    >`SELECT i.id,i.created_at AS "createdAt" FROM transcript_inbox i JOIN meetings m ON m.id=i.meeting_id JOIN bot_sessions b ON b.id=i.bot_session_id AND b.meeting_id=m.id LEFT JOIN transcript_inbox_receipts r ON r.event_id=i.id AND r.consumer='transcript-ingest' WHERE r.event_id IS NULL AND m.lifecycle IN ('IN_PROGRESS','ENDED') AND m.schedule_version=b.schedule_version AND (${this.cursor === null} OR (i.created_at,i.id)>(${this.cursor?.createdAt ?? new Date(0)},${this.cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid)) ORDER BY i.created_at,i.id LIMIT 64`;
    for (const row of rows)
      await this.queue.add(
        'ingest-inbox.v1',
        { eventId: row.id },
        {
          jobId: 'transcript-' + row.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },

          removeOnFail: false,
          removeOnComplete: { count: 1_000 },
        },
      );

    this.cursor = rows.at(-1) ?? null;
    return rows.length;
  }
}
