import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@meetwise/infrastructure/database';
import { RedisService } from '@meetwise/infrastructure/redis';
import { AuthSessionService } from './auth-session.service';
import {
  AUTH_TOKEN_VERSION_KEY_PREFIX,
  AUTH_USER_ACTIVE_KEY_PREFIX,
} from '../../../common/constants/auth.constants';

const userId = '00000000-0000-4000-8000-000000000001';
const ttl = 604800;
const versionKey = `${AUTH_TOKEN_VERSION_KEY_PREFIX}:${userId}`;
const activeKey = `${AUTH_USER_ACTIVE_KEY_PREFIX}:${userId}`;
function failures(): [string, () => unknown][] {
  return [
    [
      'private detail',
      () => new Error('SYNTHETIC-REDIS-SECRET\r\nredis://private.invalid'),
    ],
    ['string', () => 'SYNTHETIC-SECRET'],
    ['null', () => null],
    [
      'hostile Error.message',
      () =>
        Object.defineProperty(new Error(), 'message', {
          get() {
            throw new Error('Unsafe error inspection');
          },
        }),
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

describe('AuthSessionService best-effort cache failure privacy', () => {
  let module: TestingModule;
  let service: AuthSessionService;
  let warnings: unknown[][];
  const redis = {
    deleteMany: jest.fn<Promise<void>, [string[]]>(),
    set: jest.fn<Promise<void>, [string, string | number, number?]>(),
    getNumber: jest.fn<Promise<number | null>, [string]>(),
    get: jest.fn<Promise<string | null>, [string]>(),
  };
  const findUnique = jest.fn<
    Promise<{ tokenVersion: number; isActive: boolean } | null>,
    [unknown]
  >();
  beforeEach(async () => {
    warnings = [];
    redis.deleteMany.mockReset().mockResolvedValue(undefined);
    redis.set.mockReset().mockResolvedValue(undefined);
    redis.getNumber.mockReset().mockResolvedValue(3);
    redis.get.mockReset().mockResolvedValue('1');
    findUnique
      .mockReset()
      .mockResolvedValue({ tokenVersion: 3, isActive: true });
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
    module = await Test.createTestingModule({
      providers: [
        AuthSessionService,
        { provide: RedisService, useValue: redis },
        { provide: PrismaService, useValue: { user: { findUnique } } },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_REFRESH_TTL_SECONDS: ttl }),
        },
      ],
    }).compile();
    service = module.get(AuthSessionService);
  });
  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  it('preserves cache keys, values and TTL on healthy creation/invalidation', async () => {
    await service.create(userId, 3, true);
    await service.clearCache(userId);
    expect(redis.set.mock.calls).toEqual([
      [versionKey, 3, ttl],
      [activeKey, 1, ttl],
    ]);
    expect(redis.deleteMany).toHaveBeenCalledWith([versionKey, activeKey]);
    expect(warnings).toEqual([]);
  });
  it('preserves active-state update and valid cached-state lookup', async () => {
    await service.updateActiveState(userId, false);
    expect(redis.set).toHaveBeenCalledWith(activeKey, 0, ttl);
    await expect(service.isValid(userId, 3)).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
  it('preserves stale/inactive cache denial without changing token policy', async () => {
    await expect(service.isValid(userId, 4)).resolves.toBe(false);
    redis.get.mockResolvedValue('0');
    await expect(service.isValid(userId, 3)).resolves.toBe(false);
    expect(warnings).toEqual([]);
  });
  it('preserves cache-miss database fallback and subsequent best-effort population', async () => {
    redis.getNumber.mockResolvedValue(null);
    await expect(service.isValid(userId, 3)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: { tokenVersion: true, isActive: true },
    });
    expect(redis.set.mock.calls).toEqual([
      [versionKey, 3, ttl],
      [activeKey, 1, ttl],
    ]);
    expect(warnings).toEqual([]);
  });

  describe.each([
    'clearCache',
    'updateActiveState',
    'getState',
    'cacheState',
  ] as const)('%s failures', (operation) => {
    it.each(failures())(
      'keeps best-effort behavior and fixed metadata for %s',
      async (_name, value) => {
        const rejected = value();
        if (operation === 'clearCache') {
          redis.deleteMany.mockRejectedValueOnce(rejected);
          await expect(service.clearCache(userId)).resolves.toBeUndefined();
        } else if (operation === 'updateActiveState') {
          redis.set.mockRejectedValueOnce(rejected);
          await expect(
            service.updateActiveState(userId, false),
          ).resolves.toBeUndefined();
        } else if (operation === 'getState') {
          redis.getNumber.mockRejectedValueOnce(rejected);
          await expect(service.isValid(userId, 3)).resolves.toBe(true);
          expect(findUnique).toHaveBeenCalledTimes(1);
        } else {
          redis.set.mockRejectedValueOnce(rejected);
          await expect(
            service.create(userId, 3, true),
          ).resolves.toBeUndefined();
        }
        expect(warnings).toEqual([[`Redis session ${operation} failed`]]);
        expect(JSON.stringify(warnings)).not.toContain(userId);
        expect(JSON.stringify(warnings)).not.toContain('SYNTHETIC');
      },
    );
  });
});
