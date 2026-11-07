import { QueueProducerService } from '@meetwise/infrastructure/queue';
import { PasswordResetTokenService } from '@meetwise/security';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import type { Response as ExpressResponse } from 'express';
import { RedisService } from '@meetwise/infrastructure/redis';
import { CookieService } from '../src/modules/auth/services/cookie.service';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';
function cookies(response: Response): string[] {
  const values: unknown = response.headers['set-cookie'];
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string'))
    throw new Error('Expected auth cookies');
  return values.map((v) => v.split(';')[0]);
}
function token(values: string[], name: string): string {
  const entry = values.find((value) => value.startsWith(name + '='));
  if (!entry) throw new Error('Missing auth cookie');
  return decodeURIComponent(entry.slice(name.length + 1));
}
describe('Auth HTTP device families (real PostgreSQL)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let jwt: JwtService;
  let config: ConfigService;
  let userId: string;
  let email: string;
  let passwordHash: string;
  const password = 'Synthetic-test-password-482!';
  const origin = 'http://127.0.0.1:1';
  const login = () =>
    request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password });
  const refresh = (values: string[]) =>
    request(server)
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', values);
  const me = (values: string[]) =>
    request(server).get('/auth/me').set('Cookie', values);
  const payload = (values: string[]) =>
    jwt.decode<Record<string, unknown>>(
      token(values, 'meetwise_refresh_token'),
    );
  const replacementPassword = 'Replacement-lock-wait-password-582!';
  const changePassword = (values: string[]) =>
    request(server)
      .patch('/auth/password')
      .set('Origin', origin)
      .set('Cookie', values)
      .send({ currentPassword: password, newPassword: replacementPassword });
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function waitForUserLock() {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%users%') AS waiting`;
      if (rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error('Password mutation never waited on the owned users row');
  }
  beforeAll(async () => {
    await prepareSessionDatabase();
    const module = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    config = app.get(ConfigService);
    passwordHash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    email = randomUUID() + '@example.invalid';
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Synthetic HTTP user',
        passwordHash,
        role: SystemRole.MEMBER,
      },
    });
    userId = user.id;
  });
  afterEach(async () => {
    if (!prisma || !userId) return;
    await prisma.authSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    userId = '';
  });
  afterAll(async () => {
    await app?.close();
  });
  it('keeps two login devices valid with independent families and unchanged account version', async () => {
    const a = cookies(await login().expect(200));
    const b = cookies(await login().expect(200));
    await me(a).expect(200);
    await me(b).expect(200);
    expect(payload(a).sid).not.toBe(payload(b).sid);
    expect(payload(a).jti).not.toBe(payload(b).jti);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .tokenVersion,
    ).toBe(0);
    expect(await prisma.authSession.count({ where: { userId } })).toBe(2);
  });
  it('rotates once with exact rolling expiry and revokes only the replayed family', async () => {
    const a = cookies(await login().expect(200));
    const b = cookies(await login().expect(200));
    const response = await refresh(a).expect(200);
    const next = cookies(response);
    expect(token(a, 'meetwise_refresh_token')).not.toBe(
      token(next, 'meetwise_refresh_token'),
    );
    const decoded = payload(next);
    expect(Number(decoded.exp) - Number(decoded.iat)).toBe(604800);
    const access = jwt.decode<Record<string, unknown>>(
      token(next, 'meetwise_access_token'),
    );
    expect(Number(access.exp) - Number(access.iat)).toBe(900);
    const family = await prisma.authSession.findUniqueOrThrow({
      where: { id: String(decoded.sid) },
    });
    expect(family.rotationCounter).toBe(1);
    expect(family.expiresAt.getTime()).toBe(Number(decoded.exp) * 1000);
    await me(next).expect(200);
    const failed = await refresh(a).expect(401);
    expect(failed.headers['set-cookie']).toBeUndefined();
    await me(next).expect(401);
    await refresh(next).expect(401);
    await me(b).expect(200);
  });
  it('serializes simultaneous refresh and strictly revokes the winner family after reuse', async () => {
    const a = cookies(await login().expect(200));
    const b = cookies(await login().expect(200));
    const results = await Promise.all([refresh(a), refresh(a)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = results.find((r) => r.status === 200);
    if (!winner) throw new Error('Expected one rotation winner');
    await me(cookies(winner)).expect(401);
    await me(b).expect(200);
  });
  it('logs out only the current family and rejects its refresh', async () => {
    const a = cookies(await login().expect(200));
    const b = cookies(await login().expect(200));
    await request(server)
      .post('/auth/logout')
      .set('Origin', origin)
      .set('Cookie', a)
      .expect(200);
    await me(a).expect(401);
    await refresh(a).expect(401);
    await me(b).expect(200);
  });
  it('denies expired family, inactive user and stale account epoch without Redis authorization', async () => {
    const a = cookies(await login().expect(200));
    const sid = String(payload(a).sid);
    await prisma.authSession.updateMany({
      where: { userId },
      data: { expiresAt: new Date(0) },
    });
    await me(a).expect(401);
    await refresh(a).expect(401);
    await prisma.authSession.update({
      where: { id: sid },
      data: { expiresAt: new Date(Date.now() + 60000) },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    await me(a).expect(401);
    await refresh(a).expect(401);
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: true, tokenVersion: 1 },
    });
    await me(a).expect(401);
    await refresh(a).expect(401);
  });
  it('password change invalidates every existing device without deleting session records', async () => {
    const a = cookies(await login().expect(200));
    const b = cookies(await login().expect(200));
    await request(server)
      .patch('/auth/password')
      .set('Origin', origin)
      .set('Cookie', a)
      .send({
        currentPassword: password,
        newPassword: 'Replacement-test-password-582!',
      })
      .expect(200);
    await me(a).expect(401);
    await me(b).expect(401);
    await refresh(b).expect(401);
    expect(await prisma.authSession.count({ where: { userId } })).toBe(2);
  });
  it.each([SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER])(
    'rejects %s password changes when the family expires during the user-row wait',
    async (role) => {
      await prisma.user.update({ where: { id: userId }, data: { role } });
      const values = cookies(await login().expect(200)),
        expiry = Date.now() + 60000;
      await prisma.authSession.updateMany({
        where: { userId },
        data: { expiresAt: new Date(expiry) },
      });
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      const families = await prisma.authSession.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
      });
      const locked = deferred(),
        release = deferred();
      const blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
          locked.resolve();
          await release.promise;
        },
        { timeout: 8000 },
      );
      await locked.promise;
      const pending = changePassword(values).then((r) => r);
      let clock: jest.SpyInstance | undefined;
      try {
        await waitForUserLock();
        expect(Date.now()).toBeLessThan(expiry);
        clock = jest.spyOn(Date, 'now').mockReturnValue(expiry + 1);
        release.resolve();
        await blocker;
        expect((await pending).status).toBe(401);
        expect(
          await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
        ).toEqual(before);
        expect(
          await prisma.authSession.findMany({
            where: { userId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(families);
      } finally {
        clock?.mockRestore();
        release.resolve();
        await blocker;
        await pending;
      }
    },
  );
  it('allows a still-current password change after a user-row wait and invalidates both devices', async () => {
    const a = cookies(await login().expect(200)),
      b = cookies(await login().expect(200));
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const locked = deferred(),
      release = deferred();
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 8000 },
    );
    await locked.promise;
    const pending = changePassword(a).then((r) => r);
    try {
      await waitForUserLock();
      release.resolve();
      await blocker;
      expect((await pending).status).toBe(200);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(
        await app!
          .get(PasswordHasherService)
          .verify(replacementPassword, after.passwordHash),
      ).toBe(true);
      await me(a).expect(401);
      await me(b).expect(401);
      expect(await prisma.authSession.count({ where: { userId } })).toBe(2);
    } finally {
      release.resolve();
      await blocker;
      await pending;
    }
  });
  it('serializes concurrent device password changes with one winner and no lost account epoch', async () => {
    const a = cookies(await login().expect(200)),
      b = cookies(await login().expect(200));
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const responses = await Promise.all([changePassword(a), changePassword(b)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .tokenVersion,
    ).toBe(before.tokenVersion + 1);
    await me(a).expect(401);
    await me(b).expect(401);
  });
  it('rolls password and epoch back when expiry occurs in an AFTER UPDATE trigger wait', async () => {
    const values = cookies(await login().expect(200)),
      expiry = Date.now() + 60000;
    await prisma.authSession.updateMany({
      where: { userId },
      data: { expiresAt: new Date(expiry) },
    });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const families = await prisma.authSession.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    });
    const locked = deferred(),
      release = deferred();
    let blocker: Promise<unknown> | undefined,
      pending: Promise<Response> | undefined,
      clock: jest.SpyInstance | undefined;
    let functionCreated = false,
      triggerCreated = false;
    try {
      await prisma.$executeRawUnsafe(
        'CREATE FUNCTION mw_test_password_epoch_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(2147483102); RETURN NEW; END $$',
      );
      functionCreated = true;
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER mw_test_password_epoch_gate AFTER UPDATE OF password_hash ON users FOR EACH ROW EXECUTE FUNCTION mw_test_password_epoch_gate()',
      );
      triggerCreated = true;
      blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(2147483102)::text`;
          locked.resolve();
          await release.promise;
        },
        { timeout: 8000 },
      );
      await locked.promise;
      pending = changePassword(values).then((r) => r);
      await waitForUserLock();
      clock = jest.spyOn(Date, 'now').mockReturnValue(expiry + 1);
      release.resolve();
      await blocker;
      expect((await pending).status).toBe(401);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      ).toEqual(before);
      expect(
        await prisma.authSession.findMany({
          where: { userId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(families);
    } finally {
      clock?.mockRestore();
      release.resolve();
      await blocker;
      await pending;
      if (triggerCreated)
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER mw_test_password_epoch_gate ON users',
        );
      if (functionCreated)
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION mw_test_password_epoch_gate()',
        );
    }
  });
  it('denies a password change after concurrent family revocation wins the family lock', async () => {
    const values = cookies(await login().expect(200));
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const locked = deferred(),
      release = deferred();
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE user_id=${userId}::uuid FOR UPDATE`;
        locked.resolve();
        await release.promise;
        await tx.authSession.updateMany({
          where: { userId },
          data: { revokedAt: new Date() },
        });
      },
      { timeout: 8000 },
    );
    await locked.promise;
    const pending = changePassword(values).then((r) => r);
    try {
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await prisma.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%auth_sessions%') AS waiting`;
        if (rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      release.resolve();
      await blocker;
      const response = await pending;
      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      ).toEqual(before);
      expect(
        (await prisma.authSession.findFirstOrThrow({ where: { userId } }))
          .revokedAt,
      ).not.toBeNull();
    } finally {
      release.resolve();
      await blocker;
      await pending;
    }
  });
  it('rejects legacy and purpose-confused JWTs without revoking an authentic family', async () => {
    const a = cookies(await login().expect(200));
    const legacy = await jwt.signAsync(
      {
        sub: userId,
        email,
        role: SystemRole.MEMBER,
        tokenVersion: 0,
        tokenType: 'refresh',
      },
      {
        secret: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: 604800,
      },
    );
    await refresh(['meetwise_refresh_token=' + legacy]).expect(401);
    await refresh([
      'meetwise_refresh_token=' + token(a, 'meetwise_access_token'),
    ]).expect(401);
    const claims = payload(a);
    delete claims.iat;
    delete claims.exp;
    delete claims.aud;
    delete claims.iss;
    for (const override of [
      { sid: 'invalid' },
      { sub: 'invalid' },
      { tokenVersion: -1 },
      { tokenType: 'access' },
      { v: 1 },
    ]) {
      const invalid = await jwt.signAsync(
        { ...claims, ...override },
        {
          secret: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: 604800,
          issuer: 'meetwise',
          audience: 'meetwise-api',
        },
      );
      await refresh(['meetwise_refresh_token=' + invalid]).expect(401);
    }
    const expired = await jwt.signAsync(claims, {
      secret: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: -1,
      issuer: 'meetwise',
      audience: 'meetwise-api',
    });
    await refresh(['meetwise_refresh_token=' + expired]).expect(401);
    await me(a).expect(200);
  });
  it('rejects missing and foreign Origin before cookie-authenticated mutation', async () => {
    await request(server)
      .post('/auth/login')
      .send({ email, password })
      .expect(403);
    await request(server)
      .post('/auth/login')
      .set('Origin', 'https://attacker.example.invalid')
      .send({ email, password })
      .expect(403);
    const a = cookies(await login().expect(200));
    await request(server).post('/auth/refresh').set('Cookie', a).expect(403);
    await request(server)
      .post('/auth/logout')
      .set('Origin', 'null')
      .set('Cookie', a)
      .expect(403);
    await me(a).expect(200);
  });
  it('keeps tokens out of JSON and cookies HttpOnly with SameSite and approved expiry', async () => {
    const response = await login().expect(200);
    const body: unknown = response.body;
    expect(JSON.stringify(body)).not.toContain('accessToken');
    expect(JSON.stringify(body)).not.toContain('refreshToken');
    const headers: unknown = response.headers['set-cookie'];
    expect(headers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HttpOnly'),
        expect.stringContaining('SameSite=Lax'),
      ]),
    );
  });
  it('ignores unavailable cache reads and refuses revoked sessions despite stale cache', async () => {
    const a = cookies(await login().expect(200));
    if (!app) throw new Error('App unavailable');
    const redis = app.get(RedisService);
    const read = jest
      .spyOn(redis, 'get')
      .mockRejectedValue(new Error('Synthetic cache unavailable'));
    try {
      await me(a).expect(200);
      const rotated = cookies(await refresh(a).expect(200));
      await prisma.authSession.updateMany({
        where: { userId },
        data: { revokedAt: new Date() },
      });
      read.mockResolvedValue('1');
      await me(rotated).expect(401);
      await refresh(rotated).expect(401);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
  it('uses Secure HttpOnly SameSite cookies in production with exact approved Max-Age', async () => {
    const module = await Test.createTestingModule({
      providers: [
        CookieService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            NODE_ENV: 'production',
            JWT_ACCESS_TTL_SECONDS: 900,
            JWT_REFRESH_TTL_SECONDS: 604800,
          }),
        },
      ],
    }).compile();
    try {
      const cookie = jest.fn<void, [string, string, Record<string, unknown>]>();
      const response = { cookie } as unknown as ExpressResponse;
      const cookieService = module.get(CookieService);
      cookieService.setAuthCookies(response, {
        accessToken: 'synthetic-access',
        refreshToken: 'synthetic-refresh',
        tokenType: 'Bearer',
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 604800,
        refreshTokenExpiresAt: new Date(),
      });
      expect(cookie.mock.calls[0][2]).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 900000,
      });
      expect(cookie.mock.calls[1][2]).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 604800000,
      });
    } finally {
      await module.close();
    }
  });
  it('rejects wrong signing key, algorithm, issuer, audience and unknown family before mutation', async () => {
    const a = cookies(await login().expect(200));
    const claims = payload(a);
    delete claims.iat;
    delete claims.exp;
    delete claims.aud;
    delete claims.iss;
    const secret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    const variants = [
      await jwt.signAsync(claims, {
        secret: 'synthetic-wrong-signing-key',
        expiresIn: 604800,
        issuer: 'meetwise',
        audience: 'meetwise-api',
      }),
      await jwt.signAsync(claims, {
        secret,
        algorithm: 'HS384',
        expiresIn: 604800,
        issuer: 'meetwise',
        audience: 'meetwise-api',
      }),
      await jwt.signAsync(claims, {
        secret,
        expiresIn: 604800,
        issuer: 'wrong',
        audience: 'meetwise-api',
      }),
      await jwt.signAsync(claims, {
        secret,
        expiresIn: 604800,
        issuer: 'meetwise',
        audience: 'wrong',
      }),
      await jwt.signAsync(
        { ...claims, sid: randomUUID() },
        {
          secret,
          expiresIn: 604800,
          issuer: 'meetwise',
          audience: 'meetwise-api',
        },
      ),
      await jwt.signAsync(claims, {
        secret,
        issuer: 'meetwise',
        audience: 'meetwise-api',
      }),
    ];
    for (const value of variants)
      await refresh(['meetwise_refresh_token=' + value]).expect(401);
    await me(a).expect(200);
  });
  it('returns current database role instead of stale signed role', async () => {
    const a = cookies(await login().expect(200));
    await prisma.user.update({
      where: { id: userId },
      data: { role: SystemRole.OWNER },
    });
    const response = await me(a).expect(200);
    expect(response.body).toMatchObject({ user: { role: 'OWNER' } });
  });
  it('denies an ordinary reset token issued before the account became OWNER without changing credentials or sessions', async () => {
    if (!app) throw new Error('Missing app');
    const values = cookies(await login().expect(200));
    const token = await app
      .get(PasswordResetTokenService)
      .issueForRequest(userId, randomUUID(), Date.now(), 0);
    expect(token).not.toBeNull();
    await prisma.user.update({
      where: { id: userId },
      data: { role: SystemRole.OWNER },
    });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const response = await request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({
        resetToken: token,
        newPassword: 'Replacement-synthetic-password-852!',
      })
      .expect(400);
    expect(response.headers['set-cookie']).toBeUndefined();
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
    await me(values).expect(200);
    await request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({
        resetToken: token,
        newPassword: 'Replacement-synthetic-password-852!',
      })
      .expect(400);
  });
  it('denies a reset credential issued before account epoch changed', async () => {
    if (!app) throw new Error('Missing app');
    const resetToken = await app
      .get(PasswordResetTokenService)
      .issueForRequest(userId, randomUUID(), Date.now(), 0);
    expect(resetToken).not.toBeNull();
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    await request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({ resetToken, newPassword: 'Synthetic-stale-reset-denied-945!' })
      .expect(400);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
  });
  it('atomically rejects an already-claimed old epoch when another valid reset wins during hashing', async () => {
    if (!app) throw new Error('Missing app');
    const tokens = app.get(PasswordResetTokenService);
    const hasher = app.get(PasswordHasherService);
    const originalHash = hasher.hash.bind(hasher);
    let signal: () => void = () => undefined,
      release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstPassword = 'Synthetic-first-reset-race-594!';
    const winningPassword = 'Synthetic-winning-reset-race-378!';
    const spy = jest.spyOn(hasher, 'hash').mockImplementation(async (value) => {
      if (value === firstPassword) {
        signal();
        await gate;
      }
      return originalHash(value);
    });
    const firstToken = await tokens.issueForRequest(
      userId,
      randomUUID(),
      Date.now(),
      0,
    );
    const first = request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({ resetToken: firstToken, newPassword: firstPassword })
      .then((result) => result.status);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        entered,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Reset did not reach hashing gate')),
            5000,
          );
        }),
      ]);
      const secondToken = await tokens.issueForRequest(
        userId,
        randomUUID(),
        Date.now(),
        0,
      );
      await request(server)
        .post('/auth/reset-password')
        .set('Origin', origin)
        .send({ resetToken: secondToken, newPassword: winningPassword })
        .expect(200);
      release();
      expect(await first).toBe(400);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.tokenVersion).toBe(1);
      expect(await hasher.verify(winningPassword, user.passwordHash)).toBe(
        true,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
      spy.mockRestore();
      await first;
    }
  });
  it('keeps generic responses while binding queued requests to an account identity', async () => {
    if (!app) throw new Error('Missing app');
    const queue = app.get(QueueProducerService);
    const spy = jest
      .spyOn(queue, 'enqueuePasswordResetEmail')
      .mockResolvedValue(undefined);
    try {
      const known = await request(server)
        .post('/auth/forgot-password')
        .set('Origin', origin)
        .send({ email })
        .expect(200);
      const unknown = await request(server)
        .post('/auth/forgot-password')
        .set('Origin', origin)
        .send({ email: randomUUID() + '@example.invalid' })
        .expect(200);
      expect(unknown.body).toEqual(known.body);
      expect(spy.mock.calls[0][1]).toEqual({ userId, tokenVersion: 0 });
      expect(spy.mock.calls[1][1].userId).not.toBe(userId);
    } finally {
      spy.mockRestore();
    }
  });
});
