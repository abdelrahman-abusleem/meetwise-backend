import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { PrismaService } from '@meetwise/infrastructure/database';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SetupTokenService } from '../src/modules/setup/setup-token.service';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import type { Server } from 'node:http';
import request from 'supertest';
import { ApiModule } from '../src/api.module';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

describe('First OWNER bootstrap (owned PostgreSQL)', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let server: Server;
  let email: string;
  let licenseId: string | undefined;
  const origin = 'http://127.0.0.1:1';
  const body = () => ({
    companyName: 'Synthetic company',
    ownerName: 'Synthetic OWNER',
    ownerEmail: email,
    ownerPassword: 'Synthetic-password-482!',
  });
  const complete = (token?: string) => {
    const call = request(server).post('/setup/complete').set('Origin', origin);
    if (token !== undefined) call.set('X-MeetWise-Setup-Token', token);
    return call.send(body());
  };
  beforeAll(async () => {
    await prepareSessionDatabase();
    const module = await Test.createTestingModule({
      imports: [ApiModule],
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
    prisma = app.get(PrismaService);
    server = app.getHttpServer() as Server;
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    email = randomUUID() + '@example.invalid';
    licenseId = undefined;
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.systemSetting.count()).toBe(0);
    expect(await prisma.license.count()).toBe(0);
  });
  afterEach(async () => {
    if (!prisma) return;
    const users = await prisma.user.findMany({
      where: { email },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (licenseId)
      await prisma.license.deleteMany({ where: { id: licenseId } });

    await prisma.systemSetting.deleteMany({
      where: { singletonKey: 'system' },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('rejects missing token even if a historical ACTIVE License exists', async () => {
    const license = await prisma.license.create({
      data: {
        singletonKey: 'system',
        customerName: 'Synthetic legacy',
        installationId: randomUUID(),
        edition: 'TRIAL',
      },
    });
    licenseId = license.id;
    await complete().expect(403);
    expect(await prisma.user.count()).toBe(0);
  });
  const cli = () =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../../dist/apps/bootstrap/main.js')],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
  const issue = async () => {
    if (!app) throw new Error('Missing app');
    return app.get(SetupTokenService).issue();
  };

  it('issues a single CLI token with digest-only storage, exact15minute bounds and replacement invalidation', async () => {
    const before = Date.now();
    const result = cli();
    const after = Date.now();
    expect(result.status).toBe(0);
    expect(/^[A-Za-z0-9_-]{43}\r?\n$/.test(result.stdout)).toBe(true);
    expect(result.stderr).toBe('');
    const token = result.stdout.trim();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const state = await prisma.systemSetting.findUniqueOrThrow({
      where: { singletonKey: 'system' },
    });
    expect(state.bootstrapTokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(JSON.stringify(state)).not.toContain(token);
    expect(state.bootstrapExpiresAt?.getTime()).toBeGreaterThanOrEqual(
      before + 900000,
    );
    expect(state.bootstrapExpiresAt?.getTime()).toBeLessThanOrEqual(
      after + 900000,
    );
    const replacement = await issue();
    await complete(token).expect(403);
    await complete(replacement).expect(201);
  });

  it('initializes without a License, stores a proper OWNER password hash and never returns the token', async () => {
    const token = await issue();
    const response = await complete(token).expect(201);
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(owner.role).toBe('OWNER');
    if (!app) throw new Error('Missing app');
    expect(
      await app
        .get(PasswordHasherService)
        .verify(body().ownerPassword, owner.passwordHash),
    ).toBe(true);
    const state = await prisma.systemSetting.findUniqueOrThrow({
      where: { singletonKey: 'system' },
    });
    expect(state.setupCompleted).toBe(true);
    expect(state.bootstrapTokenHash).toBeNull();
    expect(state.bootstrapConsumedAt).not.toBeNull();
    expect(await prisma.license.count()).toBe(0);
    await complete(token).expect(404);
    await complete().expect(404);
    await request(server)
      .post('/setup/complete')
      .send({ malformed: true })
      .expect(404);
    await expect(issue()).rejects.toMatchObject({ status: 404 });
    const denied = cli();
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('Bootstrap token issuance failed.');
  });

  it('denies invalid, expired and consumed credentials without creating an OWNER or initializing', async () => {
    const token = await issue();
    const state = await prisma.systemSetting.findUniqueOrThrow({
      where: { singletonKey: 'system' },
    });
    for (const invalid of ['', 'invalid', randomUUID(), 'x'.repeat(43)])
      await complete(invalid).expect(403);
    expect(
      await prisma.systemSetting.findUnique({ where: { id: state.id } }),
    ).toEqual(state);
    await prisma.systemSetting.update({
      where: { id: state.id },
      data: { bootstrapExpiresAt: new Date(0) },
    });
    await complete(token).expect(403);
    await prisma.systemSetting.update({
      where: { id: state.id },
      data: {
        bootstrapExpiresAt: new Date(Date.now() + 60000),
        bootstrapConsumedAt: new Date(),
      },
    });
    await complete(token).expect(403);
    expect(await prisma.user.count()).toBe(0);
    expect(
      (
        await prisma.systemSetting.findUniqueOrThrow({
          where: { id: state.id },
        })
      ).setupCompleted,
    ).toBe(false);
  });

  it('serializes concurrent completion so exactly one OWNER is created', async () => {
    const token = await issue();
    const responses = await Promise.all([complete(token), complete(token)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('serializes replacement against completion without leaving a usable post-initialization token', async () => {
    const token = await issue();
    const [replacement, completed] = await Promise.allSettled([
      issue(),
      complete(token),
    ]);
    const state = await prisma.systemSetting.findUniqueOrThrow({
      where: { singletonKey: 'system' },
    });
    if (state.setupCompleted) {
      expect(await prisma.user.count()).toBe(1);
      await expect(issue()).rejects.toMatchObject({ status: 404 });
      if (replacement.status === 'fulfilled')
        await complete(replacement.value).expect(404);
    } else {
      expect(completed.status).toBe('fulfilled');
      if (completed.status === 'fulfilled')
        expect(completed.value.status).toBe(403);
      if (replacement.status !== 'fulfilled')
        throw new Error('Expected successful replacement');
      await complete(replacement.value).expect(201);
    }
  });

  it('rolls back consumption when existing-user safety rejects initialization', async () => {
    const token = await issue();
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Synthetic existing',
        passwordHash: 'unusable',
        role: 'MEMBER',
      },
    });
    await complete(token).expect(409);
    const state = await prisma.systemSetting.findUniqueOrThrow({
      where: { singletonKey: 'system' },
    });
    expect(state.bootstrapConsumedAt).toBeNull();
    expect(state.setupCompleted).toBe(false);
    await expect(issue()).rejects.toMatchObject({ status: 409 });
    await prisma.user.delete({ where: { id: user.id } });
    await complete(token).expect(201);
  });

  it('requires trusted Origin and has no proprietary License runtime endpoints', async () => {
    const token = await issue();
    await request(server)
      .post('/setup/complete')
      .set('X-MeetWise-Setup-Token', token)
      .send(body())
      .expect(403);
    await request(server).get('/system/license/status').expect(404);
    await request(server)
      .post('/system/license/activate')
      .send({ licenseKey: 'retired-synthetic-key' })
      .expect(404);
    await complete(token).expect(201);
  });
  it('keeps stdout token-only with an environment file and generic on connection failure', () => {
    const root = path.resolve(__dirname, '../../..');
    mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const folder = mkdtempSync(path.join(root, '.tmp/bootstrap-cli-'));
    writeFileSync(
      path.join(folder, '.env'),
      'MEETWISE_SYNTHETIC_CONFIG=example\n',
    );
    const entry = path.join(root, 'dist/apps/bootstrap/main.js');
    const success = spawnSync(process.execPath, [entry], {
      cwd: folder,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    expect(success.status).toBe(0);
    expect(/^[A-Za-z0-9_-]{43}\r?\n$/.test(success.stdout)).toBe(true);
    expect(success.stderr).toBe('');
    const failed = spawnSync(process.execPath, [entry], {
      cwd: folder,
      env: {
        ...process.env,
        DATABASE_URL:
          'postgresql://synthetic-user:synthetic-private-sentinel@127.0.0.1:1/nonexistent',
      },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toBe(
      'Bootstrap token issuance failed. Check installation state and database configuration.\n',
    );
  });
  it('does not expose private bootstrap state through the existing settings response', async () => {
    const token = await issue();
    const state = await prisma.systemSetting.findUniqueOrThrow({
      where: { singletonKey: 'system' },
    });
    await request(server).get('/system/settings').expect(401);
    await complete(token).expect(201);
    const login = await request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password: body().ownerPassword })
      .expect(200);
    const cookies: unknown = login.headers['set-cookie'];
    if (!Array.isArray(cookies) || !cookies.every((v) => typeof v === 'string'))
      throw new Error('Expected authentication cookies');
    const response = await request(server)
      .get('/system/settings')
      .set(
        'Cookie',
        cookies.map((v: string) => v.split(';')[0]),
      )
      .expect(200);
    const value: unknown = response.body;
    expect(value).not.toHaveProperty('bootstrapTokenHash');
    expect(value).not.toHaveProperty('bootstrapExpiresAt');
    expect(value).not.toHaveProperty('bootstrapConsumedAt');
    expect(JSON.stringify(value)).not.toContain(state.bootstrapTokenHash);
    expect(JSON.stringify(value)).not.toContain(token);
  });
});
