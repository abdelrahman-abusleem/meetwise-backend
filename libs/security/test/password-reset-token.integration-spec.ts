import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { RedisService } from '@meetwise/infrastructure/redis';
import { PasswordResetTokenService } from '../src/password-reset-token.service';
describe('Password reset records (real Redis)', () => {
  const secret = randomBytes(48).toString('hex');
  const keys = new Set<string>();
  let module: TestingModule;
  let redis: RedisService;
  let service: PasswordResetTokenService;
  const fixture = () => {
    const userId = randomUUID();
    const key = `auth:password-reset:${userId}`;
    keys.add(key);
    return { userId, key, requestId: randomUUID(), timestamp: Date.now() };
  };
  beforeAll(async () => {
    if (!process.env.MEETWISE_RESET_TEST_REDIS_PORT)
      throw new Error(
        'An explicitly provided disposable Redis port is required',
      );
    module = await Test.createTestingModule({
      providers: [
        PasswordResetTokenService,
        RedisService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: Number(process.env.MEETWISE_RESET_TEST_REDIS_PORT),
            PASSWORD_RESET_SECRET: secret,
            PASSWORD_RESET_TTL_SECONDS: 300,
          }),
        },
      ],
    }).compile();
    await module.init();
    redis = module.get(RedisService);
    service = module.get(PasswordResetTokenService);
    expect(redis.isConnected()).toBe(true);
  });
  afterEach(async () => {
    for (const key of keys) await redis.delete(key);
    keys.clear();
  });
  afterAll(async () => {
    if (module) await module.close();
  });
  it('consumes a newly issued JSON record exactly once', async () => {
    const f = fixture();
    const token = await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    );
    expect(token).not.toBeNull();
    expect(
      JSON.parse((await redis.get(f.key))!) as {
        tokenHash: string;
      },
    ).toHaveProperty('tokenHash');
    await expect(service.consume(token!)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 0,
    });
    expect(await redis.exists(f.key)).toBe(false);
    await expect(service.consume(token!)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('allows exactly one winner across 25 simultaneous consumers', async () => {
    const f = fixture();
    const token = await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => service.consume(token!)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(24);
    expect(await redis.exists(f.key)).toBe(false);
  });
  it('does not destroy a valid record on a wrong token', async () => {
    const f = fixture();
    const token = (await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    ))!;
    const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    await expect(service.consume(wrong)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await redis.exists(f.key)).toBe(true);
    await expect(service.consume(token)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 0,
    });
  });
  it('binds the reset token to its user without deleting another user record', async () => {
    const f = fixture();
    const other = fixture();
    const token = (await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    ))!;
    const otherToken = (await service.issueForRequest(
      other.userId,
      other.requestId,
      other.timestamp,
      0,
    ))!;
    const otherRecord = await redis.get(other.key);
    await expect(
      service.consume(token.replace(f.userId, other.userId)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await redis.get(other.key)).toBe(otherRecord);
    await expect(service.consume(token)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 0,
    });
    await expect(service.consume(otherToken)).resolves.toEqual({
      userId: other.userId,
      tokenVersion: 0,
    });
  });
  it('rejects an old-key token even while its old record exists', async () => {
    const f = fixture();
    const rotated = new PasswordResetTokenService(
      redis,
      new ConfigService({
        PASSWORD_RESET_SECRET: randomBytes(48).toString('hex'),
        PASSWORD_RESET_TTL_SECONDS: 300,
      }),
    );
    const old = (await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    ))!;
    await expect(rotated.consume(old)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const replacement = (await rotated.issueForRequest(
      f.userId,
      randomUUID(),
      f.timestamp + 1,
      0,
    ))!;
    await expect(rotated.consume(replacement)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 0,
    });
  });
  it('keeps duplicate issuance idempotent and rejects stale requests', async () => {
    const f = fixture();
    const token = await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    );
    expect(
      await service.issueForRequest(f.userId, f.requestId, f.timestamp, 0),
    ).toBe(token);
    expect(
      await service.issueForRequest(f.userId, randomUUID(), f.timestamp - 1, 0),
    ).toBeNull();
    await expect(service.consume(token!)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 0,
    });
  });
  it('rejects a token whose record expired', async () => {
    const f = fixture();
    const token = (await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    ))!;
    await redis.getClient().pexpire(f.key, 1);
    const deadline = Date.now() + 1000;
    while (await redis.exists(f.key)) {
      if (Date.now() > deadline) throw new Error('Fixture did not expire');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(service.consume(token)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it.each([
    'not-json',
    'null',
    'true',
    '7',
    '"text"',
    '[]',
    '{}',
    '{"tokenHash":false}',
    '{"tokenHash":"wrong"}',
  ])(
    'fails closed on malformed or mismatched stored data (%s)',
    async (value) => {
      const f = fixture();
      const token = (await service.issueForRequest(
        f.userId,
        f.requestId,
        f.timestamp,
        0,
      ))!;
      await redis.set(f.key, value, 60);
      await expect(service.consume(token)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(await redis.get(f.key)).toBe(value);
    },
  );
  it('binds a nonzero account epoch into the credential and protects the record on epoch tampering', async () => {
    const f = fixture();
    const token = (await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      7,
    ))!;
    await expect(
      service.consume(token.replace('.7.', '.8.')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await redis.exists(f.key)).toBe(true);
    await expect(service.consume(token)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 7,
    });
  });
  it('does not return an unstored new-epoch credential for a duplicate request identity', async () => {
    const f = fixture();
    const token = await service.issueForRequest(
      f.userId,
      f.requestId,
      f.timestamp,
      0,
    );
    await expect(
      service.issueForRequest(f.userId, f.requestId, f.timestamp, 1),
    ).resolves.toBeNull();
    await expect(service.consume(token!)).resolves.toEqual({
      userId: f.userId,
      tokenVersion: 0,
    });
  });
});
