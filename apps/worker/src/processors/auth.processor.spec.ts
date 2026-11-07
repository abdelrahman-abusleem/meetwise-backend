import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import { MailService } from '@meetwise/infrastructure/mail';
import { PasswordResetTokenService } from '@meetwise/security';
import {
  AUTH_JOB_NAMES,
  SendPasswordResetEmailJobData,
} from '@meetwise/infrastructure/queue';
import { AuthProcessor } from './auth.processor';

describe('ordinary reset issuance policy', () => {
  const userId = randomUUID();
  const findUnique = jest.fn<Promise<unknown>, [unknown]>();
  const issue = jest.fn<
    Promise<string | null>,
    [string, string, number, number]
  >();
  const send = jest.fn<Promise<void>, [unknown]>();
  let processor: AuthProcessor;
  beforeAll(async () => {
    const context = await Test.createTestingModule({
      providers: [
        AuthProcessor,
        { provide: PrismaService, useValue: { user: { findUnique } } },
        {
          provide: PasswordResetTokenService,
          useValue: { issueForRequest: issue },
        },
        { provide: MailService, useValue: { send } },
        {
          provide: ConfigService,
          useValue: new ConfigService({ WEB_APP_URL: 'http://127.0.0.1:1' }),
        },
      ],
    }).compile();
    processor = context.get(AuthProcessor);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    issue.mockResolvedValue('synthetic-reset');
    send.mockResolvedValue(undefined);
  });
  const job = {
    name: AUTH_JOB_NAMES.SEND_PASSWORD_RESET_EMAIL,
    data: {
      email: 'synthetic@example.invalid',
      userId,
      tokenVersion: 0,
      requestId: 'synthetic-request',
      requestTimestamp: 1,
    },
  } as unknown as Job<SendPasswordResetEmailJobData>;
  it.each([SystemRole.OWNER, 'INACTIVE', 'MISSING'])(
    'never issues or mails an ordinary reset for %s',
    async (role) => {
      findUnique.mockResolvedValue(
        role === 'MISSING'
          ? null
          : {
              id: userId,
              email: job.data.email,
              role,
              isActive: role !== 'INACTIVE',
            },
      );
      await processor.process(job);
      expect(issue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each([SystemRole.MEMBER, SystemRole.MANAGER])(
    'preserves ordinary reset issuance for active %s',
    async (role) => {
      findUnique.mockResolvedValue({
        id: userId,
        email: job.data.email,
        role,
        isActive: true,
        tokenVersion: 0,
      });
      await processor.process(job);
      expect(issue).toHaveBeenCalledWith(
        userId,
        job.data.requestId,
        job.data.requestTimestamp,
        job.data.tokenVersion,
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['stale epoch', 'reused email identity', 'legacy unbound request'])(
    'denies %s before reset issuance or mail',
    async (kind) => {
      findUnique.mockResolvedValue({
        id: userId,
        email: job.data.email,
        role: SystemRole.MEMBER,
        isActive: true,
        tokenVersion: 2,
      });
      const data = {
        ...job.data,
        userId: kind === 'reused email identity' ? randomUUID() : userId,
        tokenVersion: kind === 'stale epoch' ? 1 : 2,
      };
      if (kind === 'legacy unbound request') {
        delete (data as { tokenVersion?: number }).tokenVersion;
      }
      await processor.process({
        ...job,
        data,
      } as unknown as Job<SendPasswordResetEmailJobData>);
      expect(issue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('never issues or mails ordinary reset while a mandatory administrative password change is pending', async () => {
    findUnique.mockResolvedValue({
      id: userId,
      email: job.data.email,
      role: SystemRole.MEMBER,
      isActive: true,
      tokenVersion: 0,
      mustChangePassword: true,
    });
    await processor.process(job);
    expect(issue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
