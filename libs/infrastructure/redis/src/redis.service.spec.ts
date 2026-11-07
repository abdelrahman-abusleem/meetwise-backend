import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

function rejectedValues(): [string, () => unknown][] {
  return [
    [
      'credential-bearing error',
      () => new Error('SYNTHETIC-REDIS-SECRET\r\nredis://private.invalid'),
    ],
    ['string', () => 'SYNTHETIC-REDIS-SECRET'],
    ['null', () => null],
    [
      'hostile Error fields',
      () => {
        const error = new Error();
        for (const field of ['message', 'stack'])
          Object.defineProperty(error, field, {
            get() {
              throw new Error('Unsafe error inspection');
            },
          });
        return error;
      },
    ],
    [
      'hostile coercion',
      () => ({
        [Symbol.toPrimitive]() {
          throw new Error('Unsafe coercion');
        },
      }),
    ],
    [
      'hostile prototype',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('Unsafe instanceof');
            },
          },
        ),
    ],
  ];
}

describe('RedisService safe failure events', () => {
  let module: TestingModule;
  let service: RedisService;
  let client: Redis;
  let connect: jest.SpyInstance;
  let ping: jest.SpyInstance;
  let disconnect: jest.SpyInstance;
  let warnings: unknown[][];
  let consoleErrors: unknown[][];

  beforeEach(async () => {
    warnings = [];
    consoleErrors = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args);
    });
    module = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            REDIS_HOST: 'redis.example.invalid',
            REDIS_PORT: 6379,
          }),
        },
      ],
    }).compile();
    service = module.get(RedisService);
    client = service.getClient();

    connect = jest.spyOn(client, 'connect').mockResolvedValue(undefined);
    ping = jest.spyOn(client, 'ping').mockResolvedValue('PONG');
    disconnect = jest
      .spyOn(client, 'disconnect')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  it('preserves lazy connection, retry and offline-queue settings', () => {
    expect(client.options).toMatchObject({
      host: 'redis.example.invalid',
      port: 6379,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    expect(client.options.retryStrategy?.(1)).toBe(200);
    expect(client.options.retryStrategy?.(20)).toBe(2000);
    expect(client.status).toBe('wait');
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects and pings successfully without warning', async () => {
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  describe.each(['connect', 'ping'] as const)('%s rejection', (operation) => {
    it.each(rejectedValues())(
      'logs only the startup event for %s',
      async (_name, value) => {
        (operation === 'connect' ? connect : ping).mockRejectedValueOnce(
          value(),
        );
        await expect(service.onModuleInit()).resolves.toBeUndefined();
        expect(warnings).toEqual([['Redis startup connection failed']]);
        expect(consoleErrors).toEqual([]);
        expect(ping).toHaveBeenCalledTimes(operation === 'connect' ? 0 : 1);
        expect(service.isConnected()).toBe(false);
      },
    );
  });

  it.each(rejectedValues())(
    'handles the installed ioredis error-event path for %s',
    (_name, value) => {
      expect(() => client.silentEmit('error', value())).not.toThrow();
      expect(warnings).toEqual([['Redis client error']]);
      expect(consoleErrors).toEqual([]);
      expect(service.isConnected()).toBe(false);
    },
  );

  it('can verify startup after an earlier failure without changing retry policy', async () => {
    connect.mockRejectedValueOnce(new Error('SYNTHETIC-SECRET'));
    await service.onModuleInit();
    await service.onModuleInit();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([['Redis startup connection failed']]);
  });

  it('preserves explicit shutdown disconnect', () => {
    service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
