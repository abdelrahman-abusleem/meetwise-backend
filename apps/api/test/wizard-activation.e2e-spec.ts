import {
  assertActivation,
  assertOnboarding,
  assertActivationSecurity,
} from '../../../test/fixtures/activation-contract.cjs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';
import { WizardActivationService } from '../src/modules/setup/wizard-activation.service';
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
describe('Wizard atomic internal activation (real PostgreSQL/Redis/HTTP)', () => {
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
        expect(r.status).toBeGreaterThanOrEqual(200);
      });
  const read = (c: string[], id: string) =>
    request(server)
      .get('/onboarding/draft/' + id)
      .set('Cookie', c)
      .expect((r: Response) => {
        expect(r.status).toBeGreaterThanOrEqual(200);
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
        expect(r.status).toBeGreaterThanOrEqual(200);
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
    await db.setupOutbox.deleteMany({
      where: { activation: { actorId: { in: ids } } },
    });
    await db.wizardActivation.deleteMany({ where: { actorId: { in: ids } } });
    await db.botDisplayChange.deleteMany({ where: { actorId: { in: ids } } });
    await db.departmentActivationEvent.deleteMany({
      where: { actorId: { in: ids } },
    });
    await db.department.deleteMany({
      where: { kind: { in: ['TECH', 'SALES'] } },
    });
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
  const config = (choice: 'TECH' | 'SALES' | 'BOTH' = 'TECH') => ({
    companyName: 'Approved Company',
    timezone: 'Asia/Riyadh',
    defaultLanguage: 'ar',
    defaultBotName: 'Shared Bot',
    departmentChoice: choice,
    departmentPlans: (choice === 'BOTH' ? ['TECH', 'SALES'] : [choice]).map(
      (kind) => ({ kind, operatorUserIds: [owner.id] }),
    ),
  });
  const activate = (c: string[], id: string, version = 1, key = randomUUID()) =>
    request(server)
      .post('/onboarding/activate')
      .set('Cookie', c)
      .set('Origin', origin)
      .set('If-Match', '"' + version + '"')
      .set('Idempotency-Key', key)
      .send({ draftId: id })
      .expect((r: Response) => {
        assertActivation(r.body, r.status);
        assertActivationSecurity();
      });
  const draft = async (c: string[], value: unknown = config()) =>
    body(await create(c, value).expect(201)).draftId as string;
  it.each(['TECH', 'SALES', 'BOTH'] as const)(
    'atomically activates%s with one global bot and durable internal audit/outbox',
    async (choice) => {
      const c = await login(owner),
        before = await db.systemSetting.findUniqueOrThrow({
          where: { id: settingId },
        }),
        id = await draft(c, config(choice));
      const r = await activate(c, id).expect(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(body(r)).toMatchObject({
        departmentChoice: choice,
        providerStatus: 'DISCONNECTED',
        captureEnabled: false,
        botDisplayVersion: 1,
      });
      const current = await db.systemSetting.findUniqueOrThrow({
        where: { id: settingId },
      });
      expect(current).toMatchObject({
        companyName: 'Approved Company',
        timezone: 'Asia/Riyadh',
        defaultLanguage: 'ar',
        defaultBotName: 'Shared Bot',
        wizardChoice: choice,
        setupCompleted: true,
        installationId: before.installationId,
        bootstrapTokenHash: before.bootstrapTokenHash,
        retentionDays: before.retentionDays,
        autoDeleteTranscripts: false,
        allowAudioStorage: false,
      });
      expect(await db.department.count({ where: { status: 'ACTIVE' } })).toBe(
        choice === 'BOTH' ? 2 : 1,
      );
      expect(await db.departmentMembership.count()).toBe(0);
      expect(await db.user.count()).toBe(3);
      expect(await db.wizardActivation.count()).toBe(1);
      expect(
        await db.setupOutbox.count({ where: { dispatchedAt: null } }),
      ).toBe(1);
      expect(
        (await db.setupDraft.findUniqueOrThrow({ where: { id } })).completedAt,
      ).not.toBeNull();
      expect(
        await db.setupDraftEvent.count({ where: { action: 'ACTIVATED' } }),
      ).toBe(1);
    },
  );
  it('allows current MANAGER activation without OWNER rebootstrap', async () => {
    const c = await login(manager),
      id = await draft(c);
    await activate(c, id).expect(200);
    expect(await db.user.count({ where: { role: 'OWNER' } })).toBe(1);
  });
  it('requires complete selection and current eligible operators', async () => {
    const c = await login(owner);
    for (const value of [
      {},
      { ...config(), departmentPlans: [] },
      {
        ...config(),
        departmentPlans: [{ kind: 'TECH', operatorUserIds: [member.id] }],
      },
      { ...config(), departmentChoice: 'BOTH' },
    ]) {
      const id = await draft(c, value);
      await activate(c, id).expect(400);
    }
    expect(await db.department.count()).toBe(0);
    expect(await db.wizardActivation.count()).toBe(0);
  });
  it('rejects unknown/inactive/pending operators without mutation', async () => {
    const c = await login(owner);
    for (const operatorId of [randomUUID(), manager.id]) {
      if (operatorId === manager.id)
        await db.user.update({
          where: { id: manager.id },
          data: { isActive: false },
        });
      const id = await draft(c, {
        ...config(),
        departmentPlans: [{ kind: 'TECH', operatorUserIds: [operatorId] }],
      });
      await activate(c, id).expect(400);
    }
    await db.user.update({
      where: { id: manager.id },
      data: { isActive: true, mustChangePassword: true },
    });
    const id = await draft(c, {
      ...config(),
      departmentPlans: [{ kind: 'TECH', operatorUserIds: [manager.id] }],
    });
    await activate(c, id).expect(400);
    expect(await db.department.count()).toBe(0);
  });
  it('denies MEMBER, unowned draft, badOrigin, unexpected fields and bad revision', async () => {
    const c = await login(owner),
      other = await login(manager),
      m = await login(member),
      id = await draft(c);
    await activate(m, id).expect(403);
    await activate(other, id).expect(404);
    await request(server)
      .post('/onboarding/activate')
      .set('Cookie', c)
      .set('Origin', 'https://foreign.invalid')
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ draftId: id })
      .expect(403);
    await request(server)
      .post('/onboarding/activate')
      .set('Cookie', c)
      .set('Origin', origin)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ draftId: id, providerApiKey: 'synthetic' })
      .expect(400);
    await activate(c, id, 2).expect(412);
    expect(await db.wizardActivation.count()).toBe(0);
  });
  it('replays identical key/outcome and rejects changed request or second activation', async () => {
    const c = await login(owner),
      id = await draft(c),
      other = await draft(c),
      key = randomUUID(),
      r = await activate(c, id, 1, key).expect(200);
    expect((await activate(c, id, 1, key).expect(200)).body).toEqual(r.body);
    await activate(c, other, 1, key).expect(409);
    await activate(c, id, 2, key).expect(409);
    await activate(c, other).expect(409);
    await create(c, config()).expect(409);
    await read(c, other).expect(200);
    await update(c, other, config()).expect(409);
    expect(await db.setupOutbox.count()).toBe(1);
  });
  it('serializes simultaneous first-run drafts to one activation', async () => {
    const c = await login(owner),
      m = await login(manager),
      idsToActivate = [await draft(c), await draft(m)];
    const results = await Promise.all([
      activate(c, idsToActivate[0]),
      activate(m, idsToActivate[1]),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await db.wizardActivation.count()).toBe(1);
    expect(await db.department.count()).toBe(1);
    expect(await db.setupOutbox.count()).toBe(1);
  });
  it('does not overwrite shared settings edited after draft creation', async () => {
    const c = await login(owner),
      id = await draft(c);
    await db.systemSetting.update({
      where: { id: settingId },
      data: { defaultBotName: 'New committed name', botDisplayVersion: 1 },
    });
    await activate(c, id).expect(409);
    expect(
      (await db.systemSetting.findUniqueOrThrow({ where: { id: settingId } }))
        .defaultBotName,
    ).toBe('New committed name');
    expect(await db.department.count()).toBe(0);
  });
  it('preserves selected active department and rejects unselected active department', async () => {
    const c = await login(owner);
    const existing = await db.department.create({
        data: { kind: 'SALES', status: 'ACTIVE', version: 4 },
      }),
      id = await draft(c);
    await activate(c, id).expect(409);
    const both = await draft(c, config('BOTH'));
    await activate(c, both).expect(200);
    expect(
      await db.department.findUnique({ where: { id: existing.id } }),
    ).toEqual(existing);
    expect(await db.departmentActivationEvent.count()).toBe(1);
  });
  it('fails closed on incompatible retained data policy instead of silently altering it', async () => {
    const c = await login(owner),
      id = await draft(c);
    await db.systemSetting.update({
      where: { id: settingId },
      data: { allowAudioStorage: true },
    });
    await activate(c, id).expect(409);
    expect(
      (await db.systemSetting.findUniqueOrThrow({ where: { id: settingId } }))
        .allowAudioStorage,
    ).toBe(true);
    expect(await db.department.count()).toBe(0);
  });
  it('rejects expired drafts and late actor demotion', async () => {
    const c = await login(manager),
      id = await draft(c),
      now = Date.now();
    await db.setupDraft.update({
      where: { id },
      data: {
        createdAt: new Date(now - 2 * day),
        lastActivityAt: new Date(now - 2 * day),
        expiresAt: new Date(now - day),
      },
    });
    await activate(c, id).expect(404);
    const fresh = await draft(c),
      service = app.get(WizardActivationService),
      original = service.activate.bind(service);
    jest.spyOn(service, 'activate').mockImplementationOnce(async (...args) => {
      await db.user.update({
        where: { id: manager.id },
        data: { role: 'MEMBER' },
      });
      return original(...args);
    });
    await activate(c, fresh).expect(403);
    expect(await db.wizardActivation.count()).toBe(0);
  });
  it('rolls back settings, bot audit, departments and draft if activation audit insertion fails', async () => {
    const c = await login(owner),
      id = await draft(c),
      before = await db.systemSetting.findUniqueOrThrow({
        where: { id: settingId },
      });
    await db.setupDraftEvent.create({
      data: {
        draftId: id,
        actorId: owner.id,
        version: 2,
        action: 'UPDATED',
        requestHash: 'a'.repeat(64),
      },
    });
    await activate(c, id).expect(500);
    expect(
      await db.systemSetting.findUniqueOrThrow({ where: { id: settingId } }),
    ).toEqual(before);
    expect(await db.department.count()).toBe(0);
    expect(await db.botDisplayChange.count()).toBe(0);
    expect(await db.setupOutbox.count()).toBe(0);
    expect(
      (await db.setupDraft.findUniqueOrThrow({ where: { id } })).version,
    ).toBe(1);
  });
  it('returns safe fresh onboarding state and never other actors drafts', async () => {
    const c = await login(owner);
    await draft(await login(manager));
    const r = await request(server)
      .get('/onboarding')
      .set('Cookie', c)
      .expect(200);
    assertOnboarding(r.body);
    expect(body(r)).toMatchObject({
      initialized: true,
      completed: false,
      departmentChoice: null,
      providerStatus: 'DISCONNECTED',
      captureEnabled: false,
    });
    expect(body(r)).not.toHaveProperty('drafts');
    expect(body(r)).not.toHaveProperty('bootstrapTokenHash');
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('rejects expiry after a genuine settings-row wait without partial writes', async () => {
    const c = await login(owner),
      id = await draft(c);
    await db.authSession.updateMany({
      where: { userId: owner.id },
      data: { expiresAt: new Date(Date.now() + 60000) },
    });
    const locked = deferred(),
      release = deferred(),
      blocker = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM system_settings WHERE id=${settingId}::uuid FOR UPDATE`;
          locked.resolve();
          await release.promise;
        },
        { timeout: 8000 },
      );
    await locked.promise;
    const pending = activate(c, id).then((x) => x);
    try {
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM system_settings%') AS waiting`;
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
      expect(await db.department.count()).toBe(0);
      expect(await db.wizardActivation.count()).toBe(0);
    } finally {
      release.resolve();
      await blocker;
      await pending;
    }
  });
  it('locks all operator identities in total UUID order for concurrent opposing actor plans', async () => {
    const c = await login(owner),
      m = await login(manager),
      a = {
        ...config(),
        departmentPlans: [
          { kind: 'TECH', operatorUserIds: [owner.id, manager.id] },
        ],
      },
      b = {
        ...config(),
        departmentPlans: [
          { kind: 'TECH', operatorUserIds: [manager.id, owner.id] },
        ],
      },
      one = await draft(c, a),
      two = await draft(m, b);
    const results = await Promise.all([activate(c, one), activate(m, two)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await db.wizardActivation.count()).toBe(1);
  });
  it.each(['ENABLE_FIRST', 'WIZARD_FIRST'] as const)(
    'preserves serial module-enable ordering:%s',
    async (order) => {
      const c = await login(owner),
        m = await login(manager),
        id = await draft(c);
      const enable = () =>
        request(server)
          .post('/settings/modules/SALES/enable')
          .set('Cookie', m)
          .set('Origin', origin)
          .send({});
      if (order === 'ENABLE_FIRST') {
        await enable().expect(200);
        await activate(c, id).expect(409);
        expect(
          (
            await db.systemSetting.findUniqueOrThrow({
              where: { id: settingId },
            })
          ).wizardCompletedAt,
        ).toBeNull();
        expect(await db.department.count({ where: { kind: 'TECH' } })).toBe(0);
      } else {
        await activate(c, id).expect(200);
        await enable().expect(200);
        expect(
          (
            await db.systemSetting.findUniqueOrThrow({
              where: { id: settingId },
            })
          ).wizardChoice,
        ).toBe('TECH');
        expect(await db.department.count({ where: { status: 'ACTIVE' } })).toBe(
          2,
        );
      }
    },
  );
  it('serializes an in-flight cross-actor draft write before activation completion', async () => {
    const c = await login(owner),
      m = await login(manager),
      id = await draft(c),
      locked = deferred(),
      release = deferred();

    await db.$executeRawUnsafe(
      'CREATE FUNCTION mw_test_draft_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(2147483101); RETURN NEW; END $$',
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER mw_test_draft_gate BEFORE INSERT ON setup_drafts FOR EACH ROW EXECUTE FUNCTION mw_test_draft_gate()',
    );
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(2147483101)::text`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 8000 },
    );
    await locked.promise;
    let completed = false;
    const writing = create(m, config()).then((r) => r);
    const wait = async (fragment: string) => {
      for (let i = 0; i < 200; i++) {
        const rows = await db.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}) AS waiting`;
        if (rows[0].waiting) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };
    let activating: Promise<Response> | undefined;
    try {
      expect(await wait('setup_drafts')).toBe(true);
      activating = activate(c, id).then((r) => {
        completed = true;
        return r;
      });
      expect(await wait('SELECT id FROM system_settings')).toBe(true);
      expect(completed).toBe(false);
      release.resolve();
      await blocker;
      expect((await writing).status).toBe(201);
      expect((await activating).status).toBe(200);
      await create(m, config()).expect(409);
    } finally {
      release.resolve();
      await blocker;
      await writing;
      await activating;
      await db.$executeRawUnsafe(
        'DROP TRIGGER mw_test_draft_gate ON setup_drafts',
      );
      await db.$executeRawUnsafe('DROP FUNCTION mw_test_draft_gate()');
    }
  });
});
