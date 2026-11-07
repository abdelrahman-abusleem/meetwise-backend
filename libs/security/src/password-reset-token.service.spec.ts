import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { RedisService } from '@meetwise/infrastructure/redis';
import { PasswordResetTokenService } from './password-reset-token.service';
describe('PasswordResetTokenService', () => {
  const secret = randomBytes(48).toString('hex');
  const userId = randomUUID();
  const token = `MWPR2.${userId}.0.${randomBytes(32).toString('base64url')}`;
  let module: TestingModule;
  let service: PasswordResetTokenService;
  let evalScript: jest.Mock<
    ReturnType<RedisService['evalScript']>,
    Parameters<RedisService['evalScript']>
  >;
  beforeEach(async () => {
    evalScript = jest.fn<
      ReturnType<RedisService['evalScript']>,
      Parameters<RedisService['evalScript']>
    >();
    module = await Test.createTestingModule({
      providers: [
        PasswordResetTokenService,
        {
          provide: RedisService,
          useValue: { evalScript, compareAndDelete: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            PASSWORD_RESET_SECRET: secret,
            PASSWORD_RESET_TTL_SECONDS: 300,
          }),
        },
      ],
    }).compile();
    service = module.get(PasswordResetTokenService);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });
  it('atomically consumes a stored reset record using its HMAC instead of the raw token', async () => {
    evalScript.mockResolvedValue(1);
    await expect(service.consume(token)).resolves.toEqual({
      userId,
      tokenVersion: 0,
    });
    expect(evalScript).toHaveBeenCalledWith(
      expect.any(String),
      [`auth:password-reset:${userId}`],
      [createHmac('sha256', secret).update(token).digest('hex')],
    );
    expect(JSON.stringify(evalScript.mock.calls)).not.toContain(token);
  });
  it('normalizes surrounding whitespace before computing the expected hash', async () => {
    evalScript.mockResolvedValue(1);
    await expect(service.consume(`  ${token}\n`)).resolves.toEqual({
      userId,
      tokenVersion: 0,
    });
  });
  it.each([0, 2, null, undefined, true, '1', {}, []])(
    'rejects an unexpected consume result (%p)',
    async (result: unknown) => {
      evalScript.mockResolvedValue(result);
      await expect(service.consume(token)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
  it.each([
    '',
    'not-a-token',
    `WRONG.${userId}.${randomBytes(32).toString('base64url')}`,
    'MWPR1.not-a-uuid.' + 'a'.repeat(43),
    `MWPR1.${userId}.short`,
    'x'.repeat(513),
  ])('rejects malformed input before accessing Redis (%#)', async (input) => {
    await expect(service.consume(input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(evalScript).not.toHaveBeenCalled();
  });
  it('maps Redis failure to service unavailability rather than invalid-token success', async () => {
    evalScript.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.consume(token)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('keeps stale request issuance denied', async () => {
    evalScript.mockResolvedValue(0);
    await expect(
      service.issueForRequest(userId, randomUUID(), Date.now(), 0),
    ).resolves.toBeNull();
  });
  it.each(['-1', '01', '2147483648', 'NaN', '1e2'])(
    'rejects noncanonical or out-of-range token epochs before Redis: %s',
    async (epoch) => {
      await expect(
        service.consume(`MWPR2.${userId}.${epoch}.${'a'.repeat(43)}`),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(evalScript).not.toHaveBeenCalled();
    },
  );
  it('rejects legacy unbound reset credentials before Redis', async () => {
    await expect(
      service.consume(`MWPR1.${userId}.${'a'.repeat(43)}`),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(evalScript).not.toHaveBeenCalled();
  });
});
