import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DepartmentKind,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import { DepartmentModulesService } from '../src/modules/system-settings/department-modules.service';
import type { AuthenticatedUser } from '../src/modules/auth/auth.types';
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
describe('Department module enable from settings (owned PostgreSQL)', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  let service: DepartmentModulesService;
  let server: Server;
  let userId: string;
  let email: string;
  let passwordHash: string;
  const password = 'Synthetic-department-password-741!';
  const origin = 'http://127.0.0.1:1';
  const login = async () =>
    cookies(
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email, password })
        .expect(200),
    );
  const list = (values?: string[]) => {
    const call = request(server).get('/settings/modules');
    return values ? call.set('Cookie', values) : call;
  };
  const enable = (values: string[], kind = 'TECH') =>
    request(server)
      .post(`/settings/modules/${kind}/enable`)
      .set('Cookie', values)
      .set('Origin', origin);
  type ModuleState = {
    kind: string;
    status: string;
    version: number | null;
    departmentId: string | null;
  };
  const asModuleState = (body: unknown): ModuleState => body as ModuleState;
  const asModulesResponse = (body: unknown): { modules: ModuleState[] } =>
    body as { modules: ModuleState[] };
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
    service = app.get(DepartmentModulesService);
    passwordHash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    expect(await prisma.systemSetting.count()).toBe(0);
    email = randomUUID() + '@example.invalid';
    userId = (
      await prisma.user.create({
        data: {
          email,
          name: 'Synthetic module operator',
          role: SystemRole.OWNER,
          passwordHash,
        },
      })
    ).id;
    await prisma.systemSetting.create({
      data: {
        setupCompleted: true,
        bootstrapTokenHash: 'synthetic-private-digest',
      },
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!prisma || !userId) return;
    await prisma.departmentActivationEvent.deleteMany({});
    await prisma.authSession.deleteMany({ where: { userId } });
    await prisma.department.deleteMany({});
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.systemSetting.deleteMany({});
    userId = '';
  });
  afterAll(async () => {
    await app?.close();
  });

  it('requires authentication and denies MEMBER without any write', async () => {
    await list().expect(401);
    await request(server)
      .post('/settings/modules/TECH/enable')
      .set('Origin', origin)
      .expect(401);
    await prisma.user.update({
      where: { id: userId },
      data: { role: SystemRole.MEMBER },
    });
    const values = await login();
    await list(values).expect(403);
    await enable(values).expect(403);
    expect(await prisma.department.count()).toBe(0);
    expect(await prisma.departmentActivationEvent.count()).toBe(0);
  });
  it('derives both module kinds and never invents rows or GENERAL on read', async () => {
    const values = await login();
    const response = await list(values).expect(200);
    expect(asModulesResponse(response.body)).toEqual({
      modules: [
        { kind: 'TECH', status: 'DISABLED', version: null, departmentId: null },
        {
          kind: 'SALES',
          status: 'DISABLED',
          version: null,
          departmentId: null,
        },
      ],
    });
    expect(await prisma.department.count()).toBe(0);
    await enable(values, 'TECH').expect(200);
    const after = await list(values).expect(200);
    const tech = await prisma.department.findUniqueOrThrow({
      where: { kind: 'TECH' },
    });
    expect(asModulesResponse(after.body)).toEqual({
      modules: [
        { kind: 'TECH', status: 'ACTIVE', version: 1, departmentId: tech.id },
        {
          kind: 'SALES',
          status: 'DISABLED',
          version: null,
          departmentId: null,
        },
      ],
    });
    expect(JSON.stringify(after.body)).not.toContain(
      'synthetic-private-digest',
    );
    const rows = await prisma.department.findMany({
      select: { kind: true, status: true, version: true },
    });
    expect(rows).toEqual([{ kind: 'TECH', status: 'ACTIVE', version: 1 }]);
    expect(await prisma.department.count()).toBe(1);
  });
  it('enables an absent kind once, event metadata-only, and repeats idempotently', async () => {
    const values = await login();
    const first = await enable(values, 'SALES').expect(200);
    expect(Object.keys(asModuleState(first.body)).sort()).toEqual([
      'departmentId',
      'kind',
      'status',
      'version',
    ]);
    const sales = await prisma.department.findUniqueOrThrow({
      where: { kind: 'SALES' },
    });
    expect(asModuleState(first.body)).toEqual({
      kind: 'SALES',
      status: 'ACTIVE',
      version: 1,
      departmentId: sales.id,
    });
    const repeat = await enable(values, 'SALES').expect(200);
    expect(asModuleState(repeat.body)).toEqual(asModuleState(first.body));
    const events = await prisma.departmentActivationEvent.findMany({});
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual([
      'actorId',
      'createdAt',
      'departmentId',
      'fromStatus',
      'id',
      'toStatus',
      'version',
    ]);
    expect(events[0]).toMatchObject({
      actorId: userId,
      fromStatus: null,
      toStatus: 'ACTIVE',
      version: 1,
    });
    for (const kind of ['GENERAL', 'INTERN', 'tech', 'TECH%2FSALES']) {
      await enable(values, kind).expect(400);
    }
    expect(await prisma.department.count()).toBe(1);
    expect(await prisma.departmentActivationEvent.count()).toBe(1);
  });
  it.each(['OWNER', 'MANAGER', 'RACE'] as const)(
    'keeps independent-actor enables correct with %s winning schedule',
    async (winner) => {
      const managerEmail = randomUUID() + '@example.invalid';
      const manager = await prisma.user.create({
        data: {
          email: managerEmail,
          name: 'Synthetic module manager',
          role: SystemRole.MANAGER,
          passwordHash,
        },
      });
      try {
        const managerValues = cookies(
          await request(server)
            .post('/auth/login')
            .set('Origin', origin)
            .send({ email: managerEmail, password })
            .expect(200),
        );
        const committed = deferred();
        const original = service.enable.bind(service);
        jest
          .spyOn(service, 'enable')
          .mockImplementation(async (actor, kind) => {
            const isWinner =
              winner === 'OWNER'
                ? actor.id === userId
                : actor.id === manager.id;
            if (winner !== 'RACE' && !isWinner) await committed.promise;
            try {
              return await original(actor, kind);
            } finally {
              if (winner !== 'RACE' && isWinner) committed.resolve();
            }
          });
        const results = await Promise.all([
          enable(await login(), 'TECH'),
          enable(managerValues, 'TECH'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
        expect(await prisma.department.count()).toBe(1);
        const row = await prisma.department.findUnique({
          where: { kind: 'TECH' },
        });
        expect(row?.status).toBe('ACTIVE');
        expect(row?.version).toBe(1);
        expect(await prisma.departmentActivationEvent.count()).toBe(1);
        const events = await prisma.departmentActivationEvent.findMany({
          select: { actorId: true },
        });
        if (winner !== 'RACE')
          expect(events[0].actorId).toBe(
            winner === 'OWNER' ? userId : manager.id,
          );
      } finally {
        await prisma.departmentActivationEvent.deleteMany({
          where: { actorId: manager.id },
        });
        await prisma.authSession.deleteMany({ where: { userId: manager.id } });
        await prisma.user.delete({ where: { id: manager.id } });
      }
    },
  );
  it.each(['demotion', 'revocation'] as const)(
    'rechecks %s committed after the HTTP guards but before the write',
    async (kind) => {
      const values = await login();
      const family = await prisma.authSession.findFirstOrThrow({
        where: { userId },
      });
      const locked = deferred(),
        release = deferred(),
        entered = deferred();
      const original = service.enable.bind(service);
      jest
        .spyOn(service, 'enable')
        .mockImplementation(
          (actor: AuthenticatedUser, kind: DepartmentKind) => {
            entered.resolve();
            return original(actor, kind);
          },
        );
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
      const pending = enable(values).then((r) => r);
      try {
        await entered.promise;
      } finally {
        release.resolve();
      }
      await blocker;
      expect((await pending).status).toBe(kind === 'demotion' ? 403 : 401);
      expect(await prisma.department.count()).toBe(0);
      expect(await prisma.departmentActivationEvent.count()).toBe(0);
    },
  );
  it('rolls a failed activation flip back without partial event or status', async () => {
    const values = await login();
    await enable(values, 'TECH').expect(200);

    const row = await prisma.department.findUniqueOrThrow({
      where: { kind: 'TECH' },
    });
    await prisma.department.update({
      where: { id: row.id },
      data: { status: 'DISABLED', version: row.version },
    });
    await prisma.departmentActivationEvent.create({
      data: {
        actorId: userId,
        departmentId: row.id,
        toStatus: 'ACTIVE',
        version: 2,
      },
    });
    const before = await prisma.department.findUniqueOrThrow({
      where: { kind: 'TECH' },
    });
    const response = await enable(values, 'TECH').expect(500);
    expect(
      await prisma.department.findUniqueOrThrow({ where: { kind: 'TECH' } }),
    ).toEqual(before);
    expect(
      await prisma.departmentActivationEvent.count({
        where: { departmentId: row.id },
      }),
    ).toBe(2);
    expect(JSON.stringify(response.body)).not.toContain(
      'department_activation',
    );
    expect(JSON.stringify(response.body)).not.toContain('departments');
    expect(JSON.stringify(response.body)).not.toContain(
      'synthetic-private-digest',
    );
  });
  it('rejects uninitialized installations with 404 and no derived state', async () => {
    await prisma.systemSetting.updateMany({ data: { setupCompleted: false } });
    const values = await login();
    await list(values).expect(404);
    await enable(values).expect(404);
    expect(await prisma.department.count()).toBe(0);
    expect(await prisma.departmentActivationEvent.count()).toBe(0);
  });
});
