import {
  assertDisplayResponse,
  isValidDisplayPatch,
  assertOriginContract,
} from '../../../test/fixtures/display-contract.cjs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import { BotDisplayService } from '../src/modules/system-settings/bot-display.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

function cookies(response: Response): string[] {
  const value: unknown = response.headers['set-cookie'];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error('Missing auth cookies');
  return value.map((v) => v.split(';')[0]);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('Shared desired bot display (owned PostgreSQL)', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let service: BotDisplayService;
  let server: Server;
  let userId: string;
  let settingsId: string;
  let email: string;
  let passwordHash: string;
  const password = 'Synthetic-bot-name-password-482!';
  const origin = 'http://127.0.0.1:1';
  const login = async () =>
    cookies(
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email, password })
        .expect(200),
    );
  const patch = (
    values: string[],
    body: Record<string, unknown> = { displayName: 'Shared desired bot' },
    version = '"0"',
  ) =>
    request(server)
      .patch('/settings/bot')
      .set('Cookie', values)
      .set('Origin', origin)
      .set('If-Match', version)
      .send(body);
  const state = () =>
    prisma.systemSetting.findUniqueOrThrow({ where: { id: settingsId } });
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
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    service = app.get(BotDisplayService);
    passwordHash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    expect(await prisma.systemSetting.count()).toBe(0);
    email = randomUUID() + '@example.invalid';
    userId = (
      await prisma.user.create({
        data: {
          email,
          name: 'Synthetic display operator',
          role: SystemRole.OWNER,
          passwordHash,
        },
      })
    ).id;
    settingsId = (
      await prisma.systemSetting.create({
        data: {
          setupCompleted: true,
          defaultBotName: 'Original shared bot',
          bootstrapTokenHash: 'synthetic-private-digest',
        },
      })
    ).id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!prisma || !userId) return;
    await prisma.botDisplayChange.deleteMany({ where: { settingsId } });
    await prisma.authSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.systemSetting.deleteMany({ where: { id: settingsId } });
    userId = '';
  });
  afterAll(async () => {
    await app?.close();
  });

  it('requires authentication and denies MEMBER for reads and mutations without writes', async () => {
    await request(server).get('/settings/bot').expect(401);
    await request(server)
      .patch('/settings/bot')
      .set('Origin', origin)
      .send({ displayName: 'Denied' })
      .expect(401);
    await prisma.user.update({
      where: { id: userId },
      data: { role: SystemRole.MEMBER },
    });
    const values = await login();
    await request(server)
      .get('/settings/bot')
      .set('Cookie', values)
      .expect(403);
    await patch(values).expect(403);
    expect((await state()).botDisplayVersion).toBe(0);
    expect(await prisma.botDisplayChange.count()).toBe(0);
  });
  it.each([SystemRole.OWNER, SystemRole.MANAGER])(
    'lets %s read and update the single desired bot identity with a metadata-only audit',
    async (role) => {
      await prisma.user.update({ where: { id: userId }, data: { role } });
      const values = await login();
      const read = await request(server)
        .get('/settings/bot')
        .set('Cookie', values)
        .expect(200);
      expect(read.body).toEqual({
        id: settingsId,
        displayName: 'Original shared bot',
        version: 0,
      });
      assertDisplayResponse(read.body);
      assertOriginContract();
      expect(read.headers.etag).toBe('"0"');
      const response = await patch(values, {
        displayName: '  Team bot  ',
      }).expect(200);
      expect(response.body).toEqual({
        id: settingsId,
        displayName: 'Team bot',
        version: 1,
      });
      assertDisplayResponse(response.body);
      expect(response.headers.etag).toBe('"1"');
      expect(response.headers['cache-control']).toBe('no-store');
      const events = await prisma.botDisplayChange.findMany({
        where: { settingsId },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorId: userId,
        settingsId,
        version: 1,
      });
      expect(Object.keys(events[0]).sort()).toEqual([
        'actorId',
        'createdAt',
        'id',
        'settingsId',
        'version',
      ]);
      expect(await prisma.systemSetting.count()).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain(
        'synthetic-private-digest',
      );
    },
  );
  it('rejects missing/foreign Origin without mutation', async () => {
    const values = await login();
    for (const supplied of [
      undefined,
      'null',
      'https://foreign.example.invalid',
    ]) {
      const call = request(server)
        .patch('/settings/bot')
        .set('Cookie', values)
        .set('If-Match', '"0"');
      if (supplied !== undefined) call.set('Origin', supplied);
      await call.send({ displayName: 'Denied' }).expect(403);
    }
    expect((await state()).botDisplayVersion).toBe(0);
  });
  it('rejects unknown, empty, null, nonstring and oversized names', async () => {
    const values = await login();
    for (const body of [
      {},
      { displayName: '' },
      { displayName: '   ' },
      { displayName: null },
      { displayName: 42 },
      { displayName: 'x'.repeat(101) },
      { displayName: 'Valid', retentionDays: 1 },
      { displayName: 'Valid', bootstrapTokenHash: 'injected' },
    ]) {
      expect(isValidDisplayPatch(body)).toBe(false);
      await patch(values, body).expect(400);
    }
    expect((await state()).defaultBotName).toBe('Original shared bot');
    expect(await prisma.botDisplayChange.count()).toBe(0);
  });
  it('requires a well-formed If-Match and rejects stale versions', async () => {
    const values = await login();
    await request(server)
      .patch('/settings/bot')
      .set('Cookie', values)
      .set('Origin', origin)
      .send({ displayName: 'Valid' })
      .expect(428);
    for (const header of [
      '0',
      '*',
      'W/"0"',
      '"01"',
      '"-1"',
      '"2147483647"',
      '"0", "1"',
    ])
      await patch(values, { displayName: 'Valid' }, header).expect(400);
    await patch(values, { displayName: 'Valid' }, '"1"').expect(412);
    expect((await state()).botDisplayVersion).toBe(0);
  });
  it('serializes two writers using the same version with exactly one audit event', async () => {
    const values = await login();
    const results = await Promise.all([
      patch(values, { displayName: 'First' }),
      patch(values, { displayName: 'Second' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    expect((await state()).botDisplayVersion).toBe(1);
    expect(await prisma.botDisplayChange.count({ where: { settingsId } })).toBe(
      1,
    );
    await patch(values, { displayName: 'Retry' }, '"0"').expect(412);
  });
  it('rolls back name/version when the audit insert fails', async () => {
    await prisma.botDisplayChange.create({
      data: { actorId: userId, settingsId, version: 1 },
    });
    const before = await state();
    const response = await patch(await login()).expect(500);
    expect(await state()).toEqual(before);
    expect(await prisma.botDisplayChange.count()).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain(
      'synthetic-private-digest',
    );
    expect(JSON.stringify(response.body)).not.toContain('bot_display_changes');
  });
  it.each(['demotion', 'revocation'] as const)(
    'rechecks %s committed after HTTP guards but before the write',
    async (kind) => {
      const values = await login();
      const family = await prisma.authSession.findFirstOrThrow({
        where: { userId },
      });
      const locked = deferred(),
        release = deferred(),
        entered = deferred();
      const original = service.update.bind(service);
      jest.spyOn(service, 'update').mockImplementation((...args) => {
        entered.resolve();
        return original(...args);
      });
      const blocker = prisma.$transaction(
        async (tx) => {
          if (kind === 'demotion')
            await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
          else
            await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id=${family.id}::uuid FOR UPDATE`;
          locked.resolve();
          await release.promise;
          if (kind === 'demotion')
            await tx.user.update({
              where: { id: userId },
              data: { role: SystemRole.MEMBER },
            });
          else
            await tx.authSession.update({
              where: { id: family.id },
              data: { revokedAt: new Date() },
            });
        },
        { timeout: 10000 },
      );
      await locked.promise;
      const pending = patch(values).then((r) => r);
      try {
        await entered.promise;
      } finally {
        release.resolve();
      }
      await blocker;
      expect((await pending).status).toBe(kind === 'demotion' ? 403 : 401);
      expect((await state()).botDisplayVersion).toBe(0);
      expect(await prisma.botDisplayChange.count()).toBe(0);
    },
  );
  it('rejects uninitialized installations without creating or changing bot configuration', async () => {
    await prisma.systemSetting.update({
      where: { id: settingsId },
      data: { setupCompleted: false },
    });
    const values = await login();
    await request(server)
      .get('/settings/bot')
      .set('Cookie', values)
      .expect(404);
    await patch(values).expect(404);
    expect((await state()).botDisplayVersion).toBe(0);
  });
  it('denies a family that expires while waiting for the current user lock', async () => {
    const values = await login();
    const family = await prisma.authSession.findFirstOrThrow({
      where: { userId },
    });
    const expiry = Date.now() + 60000;
    await prisma.authSession.update({
      where: { id: family.id },
      data: { expiresAt: new Date(expiry) },
    });
    const locked = deferred(),
      release = deferred();
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 10000 },
    );
    await locked.promise;
    const pending = patch(values).then((r) => r);
    let clock: jest.SpyInstance | undefined;
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM users%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);

      clock = jest.spyOn(Date, 'now').mockReturnValue(expiry + 1);
      release.resolve();
      await blocker;
      expect((await pending).status).toBe(401);
      expect((await state()).botDisplayVersion).toBe(0);
      expect(await prisma.botDisplayChange.count()).toBe(0);
    } finally {
      clock?.mockRestore();
      release.resolve();
      await blocker;
      await pending;
    }
  });
  it.each([SystemRole.OWNER, SystemRole.MANAGER])(
    'denies%s when the family expires during a settings CAS lock wait',
    async (role) => {
      await prisma.user.update({ where: { id: userId }, data: { role } });
      const values = await login(),
        before = await state(),
        expiry = Date.now() + 60000;
      await prisma.authSession.updateMany({
        where: { userId },
        data: { expiresAt: new Date(expiry) },
      });
      const locked = deferred(),
        release = deferred(),
        blocker = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM system_settings WHERE id=${settingsId}::uuid FOR UPDATE`;
            locked.resolve();
            await release.promise;
          },
          { timeout: 8000 },
        );
      await locked.promise;
      const pending = patch(values).then((r) => r);
      let clock: jest.SpyInstance | undefined;
      try {
        let waiting = false;
        for (let i = 0; i < 200; i++) {
          const rows = await prisma.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%update%system_settings%') AS waiting`;
          if (rows[0].waiting) {
            waiting = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(waiting).toBe(true);
        clock = jest.spyOn(Date, 'now').mockReturnValue(expiry + 1);
        release.resolve();
        await blocker;
        expect((await pending).status).toBe(401);
        expect(await state()).toEqual(before);
        expect(await prisma.botDisplayChange.count()).toBe(0);
      } finally {
        clock?.mockRestore();
        release.resolve();
        await blocker;
        await pending;
      }
    },
  );
});
