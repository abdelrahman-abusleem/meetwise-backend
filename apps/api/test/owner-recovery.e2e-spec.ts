import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Server } from 'node:http';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ApiModule } from '../src/api.module';
import { OwnerRecoveryModule } from '../../recovery/src/owner-recovery.module';
import { OwnerRecoveryService } from '../../recovery/src/owner-recovery.service';
import { ownerRecoveryDigest } from '../../recovery/src/owner-recovery-credential';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

describe('Server-local OWNER recovery (owned PostgreSQL/Redis/HTTP)', () => {
  let app: INestApplication;
  let db: PrismaService;
  let recovery: OwnerRecoveryService;
  let server: Server;
  let userId: string;
  let email: string;
  let passwordHash: string;
  const oldPassword = 'Synthetic-owner-old-482!';
  const newPassword = 'Synthetic-owner-new-693!';
  const origin = 'http://127.0.0.1:1';
  const cli = (args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      [path.resolve('dist/apps/recovery/main.js'), ...args],
      {
        cwd: path.resolve('.'),
        env: process.env,
        encoding: 'utf8',
        input,
        timeout: 30000,
        windowsHide: true,
      },
    );
  beforeAll(async () => {
    await prepareSessionDatabase();
    const module = await Test.createTestingModule({
      imports: [ApiModule, OwnerRecoveryModule],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    db = app.get(PrismaService);
    recovery = app.get(OwnerRecoveryService);
    server = app.getHttpServer() as Server;
    passwordHash = await app.get(PasswordHasherService).hash(oldPassword);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    email = randomUUID() + '@example.invalid';
    const user = await db.user.create({
      data: {
        email,
        name: 'Synthetic owner',
        role: SystemRole.OWNER,
        passwordHash,
      },
    });
    userId = user.id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!userId || !db) return;
    await db.ownerRecoveryEvent.deleteMany({ where: { userId } });
    await db.ownerRecoveryToken.deleteMany({ where: { userId } });
    await db.authSession.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('stores only a purpose-bound digest, replaces credentials and never changes bootstrap state', async () => {
    const before = await db.systemSetting.findMany();
    const first = await recovery.issue(email),
      second = await recovery.issue(email);
    const token = await db.ownerRecoveryToken.findUniqueOrThrow({
      where: { userId },
    });
    expect(token.digest).toBe(ownerRecoveryDigest(second));
    expect(JSON.stringify(token)).not.toContain(second);
    expect(
      token.expiresAt.getTime() - token.issuedAt.getTime(),
    ).toBeGreaterThan(890000);
    expect(
      token.expiresAt.getTime() - token.issuedAt.getTime(),
    ).toBeLessThanOrEqual(900000);
    await expect(recovery.consume(first, newPassword)).rejects.toThrow();
    await recovery.consume(second, newPassword);
    await expect(
      recovery.consume(second, 'Another-new-password!'),
    ).rejects.toThrow();
    expect(await db.systemSetting.findMany()).toEqual(before);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.role).toBe(SystemRole.OWNER);
    expect(
      await app
        .get(PasswordHasherService)
        .verify(newPassword, user.passwordHash),
    ).toBe(true);
    const events = await db.ownerRecoveryEvent.findMany({ where: { userId } });
    expect(events.map((e) => e.action).sort()).toEqual([
      'CONSUMED',
      'ISSUED',
      'ISSUED',
    ]);
    expect(JSON.stringify(events)).not.toContain(second);
    expect(JSON.stringify(events)).not.toContain(newPassword);
  });

  it.each([SystemRole.MANAGER, SystemRole.MEMBER])(
    'cannot issue or consume after current role becomes %s',
    async (role) => {
      const token = await recovery.issue(email);
      await db.user.update({ where: { id: userId }, data: { role } });
      await expect(recovery.issue(email)).rejects.toThrow();
      await expect(recovery.consume(token, newPassword)).rejects.toThrow();
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: userId } }))
          .passwordHash,
      ).toBe(passwordHash);
    },
  );

  it('denies inactive, expired and epoch-invalidated credentials without consuming them', async () => {
    const token = await recovery.issue(email);
    await db.user.update({ where: { id: userId }, data: { isActive: false } });
    await expect(recovery.consume(token, newPassword)).rejects.toThrow();
    await db.user.update({ where: { id: userId }, data: { isActive: true } });
    await db.ownerRecoveryToken.update({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(recovery.consume(token, newPassword)).rejects.toThrow();
    const next = await recovery.issue(email);
    await db.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    await expect(recovery.consume(next, newPassword)).rejects.toThrow();
    expect(
      (await db.ownerRecoveryToken.findUniqueOrThrow({ where: { userId } }))
        .consumedAt,
    ).toBeNull();
  });

  it('atomically permits only one concurrent consumption', async () => {
    const token = await recovery.issue(email);
    const results = await Promise.allSettled([
      recovery.consume(token, newPassword),
      recovery.consume(token, 'Other-synthetic-739!'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await db.ownerRecoveryEvent.count({
        where: { userId, action: 'CONSUMED' },
      }),
    ).toBe(1);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion,
    ).toBe(2);
  });

  it('rolls back token, password and epoch if the metadata audit fails', async () => {
    const token = await recovery.issue(email);
    const before = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await db.$executeRaw`ALTER TABLE owner_recovery_events ADD CONSTRAINT synthetic_consume_failure CHECK (action <> 'CONSUMED')`;
    try {
      await expect(recovery.consume(token, newPassword)).rejects.toThrow();
    } finally {
      await db.$executeRaw`ALTER TABLE owner_recovery_events DROP CONSTRAINT synthetic_consume_failure`;
    }
    expect(await db.user.findUniqueOrThrow({ where: { id: userId } })).toEqual(
      before,
    );
    expect(
      (await db.ownerRecoveryToken.findUniqueOrThrow({ where: { userId } }))
        .consumedAt,
    ).toBeNull();
    await recovery.consume(token, newPassword);
  });

  it('requires a different policy-compliant password before allowing recovery', async () => {
    const token = await recovery.issue(email);
    await expect(recovery.consume(token, 'short')).rejects.toThrow();
    await expect(recovery.consume(token, oldPassword)).rejects.toThrow();
    expect(
      (await db.ownerRecoveryToken.findUniqueOrThrow({ where: { userId } }))
        .consumedAt,
    ).toBeNull();
  });

  it('invalidates old HTTP sessions at issuance and sessions opened before consumption', async () => {
    const login = () =>
      request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email, password: oldPassword });
    const initial = await login().expect(200);
    const cookies = initial.headers['set-cookie'] as unknown as string[];
    const token = await recovery.issue(email);
    await request(server).get('/auth/me').set('Cookie', cookies).expect(401);
    await request(server)
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', cookies)
      .expect(401);
    const later = await login().expect(200);
    await recovery.consume(token, newPassword);
    await request(server)
      .get('/auth/me')
      .set('Cookie', later.headers['set-cookie'] as unknown as string[])
      .expect(401);
    await login().expect(401);
    await request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password: newPassword })
      .expect(200);
  });

  it('reveals once through the actual CLI, consumes via stdin and has no HTTP recovery route', async () => {
    const issue = cli(['issue', email]);
    expect(issue.status).toBe(0);
    expect(issue.stderr).toBe('');
    const token = issue.stdout.trim();
    expect(token).toMatch(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    await request(server)
      .post('/auth/owner-recovery')
      .set('Origin', origin)
      .send({ credential: token, newPassword })
      .expect(404);
    await request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({ resetToken: token, newPassword })
      .expect(400);
    const consume = cli(
      ['consume'],
      JSON.stringify({ credential: token, newPassword }),
    );
    expect(consume.status).toBe(0);
    expect(consume.stdout).toBe('');
    expect(consume.stderr).toBe('');
    const replay = cli(
      ['consume'],
      JSON.stringify({ credential: token, newPassword }),
    );
    expect(replay.status).toBe(1);
    expect(replay.stdout).toBe('');
    expect(replay.stderr).not.toContain(token);
    const invalid = cli(['consume'], '{"invalid":true}');
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).not.toContain('Error:');
  });
});
