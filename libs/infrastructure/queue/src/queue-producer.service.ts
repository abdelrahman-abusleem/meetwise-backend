import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';

import { AUTH_JOB_NAMES, QUEUE_NAMES } from './queue.constants';
import {
  ResetAccountIdentity,
  SendPasswordResetEmailJobData,
} from './queue.types';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';

const PASSWORD_RESET_DEDUPLICATION_TTL_MS = 60_000;

const COMPLETED_JOB_RETENTION_SECONDS = 60 * 60;
const FAILED_JOB_RETENTION_SECONDS = 24 * 60 * 60;

@Injectable()
export class QueueProducerService {
  private readonly logger = new Logger(QueueProducerService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.AUTH)
    private readonly authQueue: Queue<SendPasswordResetEmailJobData>,
  ) {}

  async enqueuePasswordResetEmail(
    email: string,
    account: ResetAccountIdentity,
  ): Promise<void> {
    if (
      !account ||
      !isUUID(account.userId) ||
      !Number.isInteger(account.tokenVersion) ||
      account.tokenVersion < 0 ||
      account.tokenVersion > 2147483647
    )
      throw new BadRequestException('Invalid reset account identity');
    const normalizedEmail = email.trim().toLowerCase();

    const requestTimestamp = Date.now();

    const requestId = `password-reset-${requestTimestamp}-${randomUUID()}`;

    const deduplicationId = createHash('sha256')
      .update(normalizedEmail, 'utf8')
      .digest('hex');

    try {
      await this.authQueue.add(
        AUTH_JOB_NAMES.SEND_PASSWORD_RESET_EMAIL,
        {
          email: normalizedEmail,
          userId: account.userId,
          tokenVersion: account.tokenVersion,
          requestId,
          requestTimestamp,
        },
        {
          jobId: requestId,

          deduplication: {
            id: `password-reset-${deduplicationId}`,
            ttl: PASSWORD_RESET_DEDUPLICATION_TTL_MS,
          },

          attempts: 6,
          backoff: {
            type: 'exponential',
            delay: 10_000,
          },
          removeOnComplete: {
            age: COMPLETED_JOB_RETENTION_SECONDS,
            count: 1000,
          },

          removeOnFail: {
            age: FAILED_JOB_RETENTION_SECONDS,
            count: 5000,
          },
        },
      );
    } catch {
      this.logger.error('Failed to enqueue password reset email job');

      throw new ServiceUnavailableException(
        'Password reset request service is temporarily unavailable',
      );
    }
  }
}
