import {
  assertWizardDraft,
  assertWizardError,
  assertWizardSecurity,
} from '../../../test/fixtures/wizard-contract.cjs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';
import { WizardDraftsService } from '../src/modules/setup/wizard-drafts.service';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';
function cookies(response: Response): string[] {
  const v: unknown = response.headers['set-cookie'];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw Error('Missing cookies');
  return v.map((x) => x.split(';')[0]);
}
function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Expected object response');
  return value as Record<string, unknown>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('Wizard owned draft lifecycle (real PostgreSQL/Redis/HTTP)', () => {
  let app: INestApplication,
    db: PrismaService,
    server: Server,
    hash: string,
    settingId: string,
    ids: string[] = [];
  let owner: { id: string; email: string },
    manager: { id: string; email: string },
    member: { id: string; email: string };
  const origin = 'http://127.0.0.1:1',
    password = 'Synthetic-wizard-password-482!',
    day = 86400000;
  const login = async (u: { email: string }) =>
    cookies(
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: u.email, password })
        .expect(200),
    );
  const create = (c: string[], config: unknown = {}, key = randomUUID()) =>
    request(server)
      .post('/onboarding/draft')
      .set('Cookie', c)
      .set('Origin', origin)
      .set('Idempotency-Key', key)
      .send({ config })
      .expect((r: Response) => {
        if (r.status >= 400) assertWizardError(r.body, r.status);
      });
  const read = (c: string[], id: string) =>
    request(server)
      .get('/onboarding/draft/' + id)
      .set('Cookie', c)
      .expect((r: Response) => {
        if (r.status >= 400) assertWizardError(r.body, r.status);
      });
  const update = (
    c: string[],
    id: string,
    config: unknown = {},
    version = 1,
    key = randomUUID(),
  ) =>
    request(server)
      .patch('/onboarding/draft')
      .set('Cookie', c)
      .set('Origin', origin)
      .set('If-Match', '"' + version + '"')
      .set('Idempotency-Key', key)
      .send({ draftId: id, config })
      .expect((r: Response) => {
        if (r.status >= 400) assertWizardError(r.body, r.status);
      });
  beforeAll(async () => {
    await prepareSessionDatabase();
    const m = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = m.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new GlobalExceptionFilter());
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
    server = app.getHttpServer() as Server;
    hash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    ids = [];
    const user = async (role: SystemRole) => {
      const u = await db.user.create({
        data: {
          email: randomUUID() + '@example.invalid',
          name: 'Synthetic wizard user',
          role,
          passwordHash: hash,
        },
      });
      ids.push(u.id);
      return u;
    };
    owner = await user(SystemRole.OWNER);
    manager = await user(SystemRole.MANAGER);
    member = await user(SystemRole.MEMBER);
    settingId = (
      await db.systemSetting.create({
        data: { singletonKey: 'system', setupCompleted: true },
      })
    ).id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    await db.setupDraftEvent.deleteMany({ where: { actorId: { in: ids } } });
    await db.setupDraft.deleteMany({ where: { actorId: { in: ids } } });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    if (settingId)
      await db.systemSetting.deleteMany({ where: { id: settingId } });
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each(['OWNER', 'MANAGER'] as const)(
    'creates owned partial draft for%s without changing active installation',
    async (role) => {
      const c = await login(role === 'OWNER' ? owner : manager),
        before = await db.systemSetting.findUnique({
          where: { id: settingId },
        });
      const r = await create(c, {
        companyName: '  Company  ',
        timezone: 'Asia/Riyadh',
        defaultLanguage: 'ar',
        departmentChoice: 'BOTH',
        departmentPlans: [{ kind: 'TECH', operatorUserIds: [member.id] }],
      }).expect(201);
      assertWizardDraft(r.body);
      assertWizardSecurity();
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers.etag).toBe('"1"');
      expect(r.body).toMatchObject({
        version: 1,
        config: { companyName: 'Company', defaultLanguage: 'ar' },
      });
      expect(
        new Date(body(r).expiresAt as string).getTime() -
          new Date(body(r).createdAt as string).getTime(),
      ).toBe(day);
      expect(
        await db.systemSetting.findUnique({ where: { id: settingId } }),
      ).toEqual(before);
      expect(await db.department.count()).toBe(0);
      expect(await db.departmentMembership.count()).toBe(0);
    },
  );
  it('denies anonymous/MEMBER and missing or foreign Origin without drafts', async () => {
    await request(server)
      .post('/onboarding/draft')
      .send({ config: {} })
      .expect(401);
    const m = await login(member);
    await create(m).expect(403);
    const c = await login(owner);
    await request(server)
      .post('/onboarding/draft')
      .set('Cookie', c)
      .set('Idempotency-Key', randomUUID())
      .send({ config: {} })
      .expect(403);
    await request(server)
      .post('/onboarding/draft')
      .set('Cookie', c)
      .set('Origin', 'https://foreign.invalid')
      .set('Idempotency-Key', randomUUID())
      .send({ config: {} })
      .expect(403);
    expect(await db.setupDraft.count()).toBe(0);
  });
  it('rejects nulls, secrets, invalid timezone/language/GENERAL and duplicated plans', async () => {
    const c = await login(owner);
    for (const config of [
      null,
      [],
      { companyName: null },
      { companyName: ' ' },
      { providerApiKey: 'synthetic-never-store' },
      { timezone: 'Invalid/Zone' },
      { timezone: null },
      { timezone: '+01:00' },
      { departmentPlans: [null] },
      { defaultLanguage: 'fr' },
      { departmentChoice: 'GENERAL' },
      { departmentPlans: null },
      {
        departmentPlans: [
          { kind: 'TECH', operatorUserIds: [member.id] },
          { kind: 'TECH', operatorUserIds: [member.id] },
        ],
      },
      { departmentPlans: [{ kind: 'TECH', operatorUserIds: [] }] },
    ])
      await create(c, config).expect(400);
    await request(server)
      .post('/onboarding/draft')
      .set('Cookie', c)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(400);
    expect(await db.setupDraft.count()).toBe(0);
  });
  it('resumes own draft only, without refreshing activity or exposing baseline', async () => {
    const c = await login(owner),
      other = await login(manager),
      r = await create(c, { companyName: 'Draft' }).expect(201),
      id = body(r).draftId as string;
    const before = await db.setupDraft.findUniqueOrThrow({ where: { id } });
    const get = await read(c, id).expect(200);
    assertWizardDraft(get.body);
    expect(get.body).toEqual(r.body);
    expect(get.body).not.toHaveProperty('baseSettings');
    expect(await db.setupDraft.findUniqueOrThrow({ where: { id } })).toEqual(
      before,
    );
    await read(other, id).expect(404);
    await update(other, id).expect(404);
    await read(c, randomUUID()).expect(404);
  });
  it('replaces snapshot under revision and request-key guards', async () => {
    const c = await login(owner),
      key = randomUUID(),
      r = await create(c, { companyName: 'Old', timezone: 'UTC' }, key).expect(
        201,
      ),
      id = body(r).draftId as string;
    await create(c, {}, key).expect(409);
    const updateKey = randomUUID(),
      u = await update(
        c,
        id,
        { defaultBotName: 'New bot' },
        1,
        updateKey,
      ).expect(200);
    assertWizardDraft(u.body);
    expect(u.headers.etag).toBe('"2"');
    expect(body(u).config).toEqual({ defaultBotName: 'New bot' });
    await update(c, id, {}, 2, updateKey).expect(409);
    await update(c, id, {}, 1).expect(412);
    expect(await db.setupDraftEvent.count()).toBe(2);
  });
  it('allows exactly one concurrent writer at the same version', async () => {
    const c = await login(owner),
      r = await create(c).expect(201),
      id = body(r).draftId as string;
    const results = await Promise.all([
      update(c, id, { companyName: 'A' }),
      update(c, id, { companyName: 'B' }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 412]);
    expect(
      (await db.setupDraft.findUniqueOrThrow({ where: { id } })).version,
    ).toBe(2);
    expect(await db.setupDraftEvent.count()).toBe(2);
  });
  it('renews inactivity on writes but caps at original seven days', async () => {
    const c = await login(owner),
      r = await create(c).expect(201),
      id = body(r).draftId as string,
      now = Date.now(),
      created = new Date(now - 6.5 * day),
      activity = new Date(now - 0.1 * day);
    await db.setupDraft.update({
      where: { id },
      data: {
        createdAt: created,
        lastActivityAt: activity,
        expiresAt: new Date(created.getTime() + 7 * day),
      },
    });
    const result = await update(c, id, { companyName: 'Still active' }).expect(
      200,
    );
    expect(new Date(body(result).expiresAt as string)).toEqual(
      new Date(created.getTime() + 7 * day),
    );
  });
  it('rejects inactive, maximum-aged and completed drafts without renewing or deleting them', async () => {
    const c = await login(owner),
      now = Date.now();
    for (const state of [
      {
        createdAt: new Date(now - 2 * day),
        lastActivityAt: new Date(now - 2 * day),
        expiresAt: new Date(now - day),
      },
      {
        createdAt: new Date(now - 8 * day),
        lastActivityAt: new Date(now - 1.5 * day),
        expiresAt: new Date(now - day),
      },
      { completedAt: new Date(now) },
    ]) {
      const r = await create(c).expect(201),
        id = body(r).draftId as string;
      await db.setupDraft.update({ where: { id }, data: state });
      const before = await db.setupDraft.findUniqueOrThrow({ where: { id } });
      await read(c, id).expect(404);
      await update(c, id).expect(404);
      expect(await db.setupDraft.findUniqueOrThrow({ where: { id } })).toEqual(
        before,
      );
    }
    expect(await db.setupDraft.count()).toBe(3);
  });
  it('fails closed on corrupted stored secrets without echoing them', async () => {
    const c = await login(owner),
      r = await create(c).expect(201),
      id = body(r).draftId as string;
    await db.setupDraft.update({
      where: { id },
      data: { data: { providerApiKey: 'synthetic-do-not-disclose' } },
    });
    const response = await read(c, id).expect(503);
    expect(response.text).not.toContain('synthetic-do-not-disclose');
    expect(response.text).not.toContain('providerApiKey');
  });
  it('rechecks current actor role after HTTP guard and before draft write', async () => {
    const c = await login(manager),
      service = app.get(WizardDraftsService),
      original = service.create.bind(service);
    jest.spyOn(service, 'create').mockImplementationOnce(async (...args) => {
      await db.user.update({
        where: { id: manager.id },
        data: { role: 'MEMBER' },
      });
      return original(...args);
    });
    await create(c).expect(403);
    expect(await db.setupDraft.count()).toBe(0);
  });
  it('rolls back updated snapshot and activity when audit insert fails', async () => {
    const c = await login(owner),
      r = await create(c).expect(201),
      id = body(r).draftId as string,
      before = await db.setupDraft.findUniqueOrThrow({ where: { id } });
    await db.setupDraftEvent.create({
      data: {
        draftId: id,
        actorId: owner.id,
        version: 2,
        action: 'UPDATED',
        requestHash: 'f'.repeat(64),
      },
    });
    await update(c, id, { companyName: 'Must rollback' }).expect(500);
    expect(await db.setupDraft.findUniqueOrThrow({ where: { id } })).toEqual(
      before,
    );
    await db.setupDraftEvent.deleteMany({ where: { draftId: id, version: 2 } });
    await update(c, id, { companyName: 'Now succeeds' }).expect(200);
  });
  it('denies expired session after a real draft-row lock wait', async () => {
    const c = await login(owner),
      r = await create(c).expect(201),
      id = body(r).draftId as string;
    await db.authSession.updateMany({
      where: { userId: owner.id },
      data: { expiresAt: new Date(Date.now() + 60000) },
    });
    const locked = deferred(),
      release = deferred(),
      blocker = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM setup_drafts WHERE id=${id}::uuid FOR UPDATE`;
          locked.resolve();
          await release.promise;
        },
        { timeout: 8000 },
      );
    await locked.promise;
    const pending = update(c, id, { companyName: 'Denied' }).then((x) => x);
    try {
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM setup_drafts%') AS waiting`;
        if (rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000);
      release.resolve();
      await blocker;
      expect((await pending).status).toBe(401);
      expect(
        (await db.setupDraft.findUniqueOrThrow({ where: { id } })).version,
      ).toBe(1);
    } finally {
      release.resolve();
      await blocker;
      await pending;
    }
  });
});
