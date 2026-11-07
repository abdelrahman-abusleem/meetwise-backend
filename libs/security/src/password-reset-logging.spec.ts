import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { RedisService } from '@meetwise/infrastructure/redis';
import { PasswordResetTokenService } from './password-reset-token.service';
import { PASSWORD_RESET_SERVICE_UNAVAILABLE } from './password-reset.constants';

describe('Password reset failure logging', () => {
  const userId = randomUUID();
  const requestId = randomUUID();
  const token = `MWPR2.${userId}.0.${randomBytes(32).toString('base64url')}`;
  let module: TestingModule;
  let service: PasswordResetTokenService;
  let warning: jest.SpiedFunction<Logger['warn']>;
  let errorLog: jest.SpiedFunction<Logger['error']>;
  let evaluate: jest.Mock<
    ReturnType<RedisService['evalScript']>,
    Parameters<RedisService['evalScript']>
  >;

  beforeEach(async () => {
    evaluate = jest.fn<
      ReturnType<RedisService['evalScript']>,
      Parameters<RedisService['evalScript']>
    >();
    module = await Test.createTestingModule({
      providers: [
        PasswordResetTokenService,
        { provide: RedisService, useValue: { evalScript: evaluate } },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            PASSWORD_RESET_SECRET: randomBytes(48).toString('hex'),
            PASSWORD_RESET_TTL_SECONDS: 300,
          }),
        },
      ],
    }).compile();
    service = module.get(PasswordResetTokenService);
    warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  const failures: Array<[string, () => unknown]> = [
    ['ordinary SDK error', () => new Error('Synthetic private SDK detail')],
    ['string rejection', () => 'Synthetic private SDK detail'],
    ['null rejection', () => null],
    [
      'unreadable error message',
      () =>
        Object.defineProperty(new Error(), 'message', {
          get() {
            throw new Error('Synthetic message inspection failure');
          },
        }),
    ],
    [
      'unreadable prototype',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('Synthetic prototype inspection failure');
            },
          },
        ),
    ],
    [
      'unreadable string conversion',
      () => ({
        toString() {
          throw new Error('Synthetic conversion failure');
        },
      }),
    ],
  ];

  for (const operation of ['issue', 'consume'] as const) {
    it.each(failures)(
      `${operation}: preserves generic unavailability and a fixed event for %s`,
      async (_label, makeFailure) => {
        evaluate.mockRejectedValue(makeFailure());
        const result =
          operation === 'issue'
            ? service.issueForRequest(userId, requestId, 1000, 0)
            : service.consume(token);

        await expect(result).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        await expect(result).rejects.toMatchObject({
          message: PASSWORD_RESET_SERVICE_UNAVAILABLE,
        });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          `Password reset token ${operation} failed`,
        );
        expect(errorLog).not.toHaveBeenCalled();
      },
    );
  }

  it('preserves generic unavailability when an issue result cannot be converted', async () => {
    evaluate.mockResolvedValue({
      [Symbol.toPrimitive]() {
        throw new Error('Synthetic result conversion failure');
      },
    });
    await expect(
      service.issueForRequest(userId, requestId, 1000, 0),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(warning).toHaveBeenCalledWith('Password reset token issue failed');
  });

  it.each([9, Number.NaN])(
    'logs a fixed event for an unexpected issue result (%s)',
    async (result) => {
      evaluate.mockResolvedValue(result);
      await expect(
        service.issueForRequest(userId, requestId, 1000, 0),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        'Unexpected password reset issue result',
      );
      expect(warning).not.toHaveBeenCalled();
    },
  );

  it('keeps successful issuance free of failure logs', async () => {
    evaluate.mockResolvedValue(1);
    await expect(
      service.issueForRequest(userId, requestId, 1000, 0),
    ).resolves.toMatch(/^MWPR2\./);
    expect(warning).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('keeps successful consumption free of failure logs', async () => {
    evaluate.mockResolvedValue(1);
    await expect(service.consume(token)).resolves.toEqual({
      userId,
      tokenVersion: 0,
    });
    expect(warning).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
