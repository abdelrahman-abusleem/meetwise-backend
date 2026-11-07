import {
  assertMember,
  assertMemberPage,
  assertMembershipSecurity,
} from '../../../test/fixtures/membership-contract.cjs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PrismaService,
  SystemRole,
  DepartmentRole,
  DepartmentKind,
} from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { DepartmentMembershipsService } from '../src/modules/departments/department-memberships.service';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';
function cookies(response: Response): string[] {
  const value: unknown = response.headers['set-cookie'];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw Error('Missing auth cookies');
  return value.map((v) => v.split(';')[0]);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('Department membership scope (owned PostgreSQL/Redis/HTTP)', () => {
  let app: INestApplication,
    db: PrismaService,
    server: Server,
    hash: string,
    ids: string[] = [],
    settingId: string,
    tech: string,
    sales: string;
  let owner: { id: string; email: string },
    manager: { id: string; email: string },
    admin: { id: string; email: string },
    peer: { id: string; email: string },
    member: { id: string; email: string };
  const origin = 'http://127.0.0.1:1',
    password = 'Synthetic-membership-password-482!';
  const grant = (role: DepartmentRole = DepartmentRole.MEMBER) => ({
    role,
    canCreateMeetings: false,
    canManageMeetings: false,
    canApproveMeetings: false,
  });
  const login = async (user: { email: string }) =>
    cookies(
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: user.email, password })
        .expect(200),
    );
  const add = (
    values: string[],
    dept = tech,
    id = member.id,
    role: DepartmentRole = DepartmentRole.MEMBER,
    version = 0,
    key = randomUUID(),
  ) =>
    request(server)
      .post(`/departments/${dept}/members`)
      .set('Cookie', values)
      .set('Origin', origin)
      .set('If-Match', '"' + version + '"')
      .set('Idempotency-Key', key)
      .send({ userId: id, ...grant(role) });
  const update = (
    values: string[],
    id = member.id,
    version = 1,
    key = randomUUID(),
    dept = tech,
  ) =>
    request(server)
      .patch(`/departments/${dept}/members/${id}`)
      .set('Cookie', values)
      .set('Origin', origin)
      .set('If-Match', '"' + version + '"')
      .set('Idempotency-Key', key)
      .send({ ...grant(), canCreateMeetings: true });
  const revoke = (values: string[], id = member.id, version = 1, dept = tech) =>
    request(server)
      .post(`/departments/${dept}/members/${id}/revoke`)
      .set('Cookie', values)
      .set('Origin', origin)
      .set('If-Match', '"' + version + '"')
      .set('Idempotency-Key', randomUUID())
      .send({});
  const list = (values: string[], dept = tech) =>
    request(server).get(`/departments/${dept}/members`).set('Cookie', values);
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
    db = app.get(PrismaService);
    server = app.getHttpServer() as Server;
    hash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    ids = [];
    const create = async (role: SystemRole) => {
      const user = await db.user.create({
        data: {
          email: randomUUID() + '@example.invalid',
          name: 'Synthetic membership user',
          role,
          passwordHash: hash,
        },
      });
      ids.push(user.id);
      return user;
    };
    owner = await create(SystemRole.OWNER);
    manager = await create(SystemRole.MANAGER);
    admin = await create(SystemRole.MEMBER);
    peer = await create(SystemRole.MEMBER);
    member = await create(SystemRole.MEMBER);
    settingId = (
      await db.systemSetting.create({
        data: { singletonKey: 'system', setupCompleted: true },
      })
    ).id;
    tech = (
      await db.department.create({
        data: { kind: DepartmentKind.TECH, status: 'ACTIVE', version: 1 },
      })
    ).id;
    sales = (
      await db.department.create({
        data: { kind: DepartmentKind.SALES, status: 'ACTIVE', version: 1 },
      })
    ).id;
    await db.departmentMembership.createMany({
      data: [
        { departmentId: tech, userId: admin.id, role: 'ADMIN' },
        { departmentId: tech, userId: peer.id, role: 'ADMIN' },
      ],
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    const depts = [tech, sales].filter(Boolean);
    await db.membershipEvent.deleteMany({
      where: { departmentId: { in: depts } },
    });
    await db.departmentMembership.deleteMany({
      where: { departmentId: { in: depts } },
    });
    await db.department.deleteMany({ where: { id: { in: depts } } });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.systemSetting.deleteMany({ where: { id: settingId } });
    ids = [];
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each(['OWNER', 'MANAGER'] as const)(
    'allows current %s to assign ADMIN and independent MEMBER memberships',
    async (role) => {
      const values = await login(role === 'OWNER' ? owner : manager);
      const response = await add(
        values,
        tech,
        member.id,
        DepartmentRole.ADMIN,
      ).expect(201);
      assertMember(response.body);
      assertMembershipSecurity();
      expect(response.headers.etag).toBe('"1"');
      expect(response.body).toMatchObject({
        departmentId: tech,
        userId: member.id,
        role: 'ADMIN',
        version: 1,
        canApproveMeetings: false,
        revokedAt: null,
      });
      expect(
        await db.departmentMembership.count({
          where: { departmentId: sales, userId: member.id },
        }),
      ).toBe(0);
      await add(values, sales).expect(201);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: member.id } })).role,
      ).toBe(SystemRole.MEMBER);
    },
  );
  it('limits own Department ADMIN to other ordinary scoped MEMBERs without global or peer escalation', async () => {
    const values = await login(admin);
    await add(values).expect(201);
    await update(values).expect(200);
    await update(values, peer.id).expect(403);
    await update(values, admin.id).expect(403);
    await update(values).send({ role: 'ADMIN' }).expect(403);
    await add(values, sales).expect(404);
    await list(values, sales).expect(404);
    await request(server)
      .post('/users')
      .set('Cookie', values)
      .set('Origin', origin)
      .send({})
      .expect(403);
    await request(server)
      .get('/system/settings')
      .set('Cookie', values)
      .expect(403);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: admin.id } })).role,
    ).toBe('MEMBER');
  });
  it('denies ordinary MEMBER and missing sessions before scoped membership disclosure', async () => {
    const values = await login(member);
    await add(values).expect(404);
    await list(values).expect(404);
    await list(values, randomUUID()).expect(404);
    await request(server).get(`/departments/${tech}/members`).expect(401);
    expect(await db.membershipEvent.count()).toBe(0);
  });
  it('requires Origin, strict DTOs, UUIDs, quoted revisions and bounded keys', async () => {
    const values = await login(owner);
    await request(server)
      .post(`/departments/${tech}/members`)
      .set('Cookie', values)
      .send({ userId: member.id, ...grant() })
      .expect(403);
    await add(values).set('If-Match', '0').expect(400);
    await add(values).set('If-Match', '"01"').expect(400);
    await add(values).set('Idempotency-Key', '').expect(400);
    await add(values).send({ systemRole: 'OWNER' }).expect(400);
    await add(values, 'GENERAL').expect(400);
    await add(values, tech, 'invalid').expect(400);
    await update(values).send({ canCreateMeetings: 'true' }).expect(400);
    expect(await db.membershipEvent.count()).toBe(0);
  });
  it('requires existing active nonpending users and a ready active department', async () => {
    const values = await login(owner);
    await add(values, tech, randomUUID()).expect(404);
    await db.user.update({
      where: { id: member.id },
      data: { isActive: false },
    });
    await add(values).expect(409);
    await db.user.update({
      where: { id: member.id },
      data: { isActive: true, mustChangePassword: true },
    });
    await add(values).expect(409);
    await db.user.update({
      where: { id: member.id },
      data: { mustChangePassword: false },
    });
    await db.department.update({
      where: { id: tech },
      data: { status: 'DISABLED' },
    });
    await add(values).expect(404);
    expect(await db.user.count()).toBe(5);
    expect(await db.membershipEvent.count()).toBe(0);
  });
  it('enforces revisions and duplicate-request guards without repeat audit', async () => {
    const values = await login(owner),
      key = randomUUID();
    await add(values, tech, member.id, 'MEMBER', 0, key).expect(201);
    await add(values, tech, member.id, 'MEMBER', 0, key).expect(409);
    await update(values, member.id, 0).expect(412);
    await update(values).expect(200);
    await update(values).expect(412);
    expect(await db.membershipEvent.count()).toBe(2);
  });
  it('serializes concurrent first grants and updates to one winner each', async () => {
    const a = await login(owner),
      b = await login(manager);
    const created = await Promise.all([add(a), add(b)]);
    expect(created.map((r) => r.status).sort()).toEqual([201, 412]);
    const changed = await Promise.all([update(a), update(b)]);
    expect(changed.map((r) => r.status).sort()).toEqual([200, 412]);
    expect(
      await db.membershipEvent.count({ where: { userId: member.id } }),
    ).toBe(2);
  });
  it('soft-revokes and explicitly regrants full scoped permissions without cross-department effects', async () => {
    const values = await login(owner);
    await add(values).expect(201);
    await add(values, sales).expect(201);
    const revoked = await revoke(values).expect(200);
    expect(revoked.headers.etag).toBe('"2"');
    const state = await db.departmentMembership.findUniqueOrThrow({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
    });
    expect(state.revokedAt).not.toBeNull();
    await update(values, member.id, 2).expect(409);
    await add(values, tech, member.id, 'MEMBER', 2).expect(201);
    expect(
      await db.departmentMembership.count({
        where: { userId: member.id, revokedAt: null },
      }),
    ).toBe(2);
    expect(
      (
        await db.departmentMembership.findUniqueOrThrow({
          where: {
            departmentId_userId: { departmentId: sales, userId: member.id },
          },
        })
      ).version,
    ).toBe(1);
  });
  it('checks scoped authority again when Department ADMIN was revoked after HTTP guards', async () => {
    const values = await login(admin),
      service = app.get(DepartmentMembershipsService),
      original = service.change.bind(service);
    jest.spyOn(service, 'change').mockImplementationOnce(async (...args) => {
      await db.departmentMembership.update({
        where: {
          departmentId_userId: { departmentId: tech, userId: admin.id },
        },
        data: { revokedAt: new Date(), version: { increment: 1 } },
      });
      return original(...args);
    });
    await add(values).expect(404);
    expect(await db.membershipEvent.count()).toBe(0);
  });
  it('rolls back membership state if real audit uniqueness fails', async () => {
    const values = await login(owner);
    await add(values).expect(201);
    await db.membershipEvent.create({
      data: {
        departmentId: tech,
        userId: member.id,
        actorId: owner.id,
        version: 2,
        action: 'UPDATED',
        requestHash: 'a'.repeat(64),
        snapshot: { synthetic: true },
      },
    });
    await update(values).expect(500);
    const current = await db.departmentMembership.findUniqueOrThrow({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
    });
    expect(current).toMatchObject({ version: 1, canCreateMeetings: false });
    await db.membershipEvent.deleteMany({
      where: { departmentId: tech, userId: member.id, version: 2 },
    });
    await update(values).expect(200);
  });
  it('authorizes scoped list before pagination and validates cursor bounds', async () => {
    const values = await login(admin);
    await add(values).expect(201);
    const first = await list(values).query({ limit: 1 }).expect(200);
    assertMemberPage(first.body);
    expect(first.body).toHaveProperty('items');
    await list(values).query({ limit: 101 }).expect(400);
    await list(values).query({ cursor: 'invalid' }).expect(400);
    await list(values, sales).query({ limit: 1 }).expect(404);
  });
  it('denies a session that expires while waiting for a department lock', async () => {
    const values = await login(owner);
    const bounded = await db.authSession.updateMany({
      where: { userId: owner.id },
      data: { expiresAt: new Date(Date.now() + 60000) },
    });
    expect(bounded.count).toBe(1);
    const locked = deferred(),
      release = deferred();
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM departments WHERE id=${tech}::uuid FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 8000 },
    );
    await locked.promise;
    const pending = add(values).then((response) => response);
    try {
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%SELECT id,status FROM departments%') AS waiting`;
        if (rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000);
      release.resolve();
      await blocker;
      expect((await pending).status).toBe(401);
      expect(await db.membershipEvent.count()).toBe(0);
    } finally {
      release.resolve();
      await blocker;
      await pending;
    }
  });
});
