import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

import { EnvironmentVariables } from '@meetwise/infrastructure/config';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import { MailService } from '@meetwise/infrastructure/mail';
import {
  AUTH_JOB_NAMES,
  QUEUE_NAMES,
  SendPasswordResetEmailJobData,
} from '@meetwise/infrastructure/queue';
import { PasswordResetTokenService } from '@meetwise/security';
import { isUUID } from 'class-validator';

@Processor(QUEUE_NAMES.AUTH)
export class AuthProcessor extends WorkerHost {
  private readonly webAppUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordResetTokenService: PasswordResetTokenService,
    private readonly mailService: MailService,
    configService: ConfigService<EnvironmentVariables, true>,
  ) {
    super();

    this.webAppUrl = configService.getOrThrow('WEB_APP_URL', {
      infer: true,
    });
  }

  async process(job: Job<SendPasswordResetEmailJobData>): Promise<void> {
    if (job.name !== AUTH_JOB_NAMES.SEND_PASSWORD_RESET_EMAIL) {
      throw new Error(`Unknown auth job: ${job.name}`);
    }

    if (
      !isUUID(job.data.userId) ||
      !Number.isInteger(job.data.tokenVersion) ||
      job.data.tokenVersion < 0
    )
      return;
    const user = await this.prisma.user.findUnique({
      where: {
        email: job.data.email,
      },
      select: {
        id: true,
        email: true,
        isActive: true,
        mustChangePassword: true,
        role: true,
        tokenVersion: true,
      },
    });

    if (
      !user ||
      !user.isActive ||
      user.mustChangePassword ||
      user.role === SystemRole.OWNER ||
      user.id !== job.data.userId ||
      user.tokenVersion !== job.data.tokenVersion
    ) {
      return;
    }

    const resetToken = await this.passwordResetTokenService.issueForRequest(
      user.id,
      job.data.requestId,
      job.data.requestTimestamp,
      job.data.tokenVersion,
    );

    if (!resetToken) {
      return;
    }

    const resetUrl = new URL('/reset-password', this.webAppUrl);

    resetUrl.searchParams.set('token', resetToken);

    await this.mailService.send({
      to: user.email,
      subject: 'Reset your Meetwise password',
      text: [
        'We received a request to reset your Meetwise password.',
        '',
        'Use the link below to choose a new password:',
        resetUrl.toString(),
        '',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
    });
  }
}
