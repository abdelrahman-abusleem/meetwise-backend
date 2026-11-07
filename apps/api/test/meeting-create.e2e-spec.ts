import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaService } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import { MeetingCreateStore } from '../src/modules/meetings/meeting-create.store';
import { CancellationRequestStore } from '../src/modules/meetings/cancellation-request.store';
import { CancellationDecisionStore } from '../src/modules/meetings/cancellation-decision.store';
import { assertCreatedMeeting } from '../../../test/fixtures/meeting-create-contract.cjs';
import {
  assertHttpContract,
  assertRequestContract,
} from '../../../test/fixtures/phase2-contract.cjs';
import {
  prepareSessionDatabase,
  rehearseCancellationUpgrade,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

describe('Atomic meeting draft creation (owned PostgreSQL/Redis/HTTP)', () => {
  let app: INestApplication, db: PrismaService, server: Server, hash: string;
  let owner: { id: string; email: string },
    member: { id: string; email: string },
    manager: { id: string; email: string };
  let tech: string, sales: string, setting: string;
  let createdUsers: string[] = [],
    createdDepartments: string[] = [];
  const password = 'Synthetic-meeting-fixture-password-482!',
    origin = 'http://127.0.0.1:1';
  const bodyOf = (response: Response) => {
    const body: unknown = response.body;
    assertCreatedMeeting(body);
    return body;
  };
  const login = async (email: string) => {
    const result: Response = await request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password })
      .expect(200);
    const values: unknown = result.headers['set-cookie'];
    if (
      !Array.isArray(values) ||
      !values.every((value) => typeof value === 'string')
    )
      throw Error('Missing synthetic session cookies');
    return values.map((value: string) => value.split(';')[0]);
  };
  const create = (cookies: string[], body: object, key = randomUUID()) =>
    request(server)
      .post('/meetings')
      .set('Cookie', cookies)
      .set('Origin', origin)
      .set('Idempotency-Key', key)
      .send(body);
  const revokeManager = async (cookies: string[]) => {
    const current = await db.departmentMembership.findUniqueOrThrow({
      where: {
        departmentId_userId: { departmentId: tech, userId: manager.id },
      },
    });
    return request(server)
      .post(`/departments/${tech}/members/${manager.id}/revoke`)
      .set('Cookie', cookies)
      .set('Origin', origin)
      .set('If-Match', '"' + current.version + '"')
      .set('Idempotency-Key', randomUUID())
      .send({});
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
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    db = app.get(PrismaService);
    server = app.getHttpServer() as Server;
    hash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    createdUsers = [];
    createdDepartments = [];
    setting = '';
    const user = async (role: 'OWNER' | 'MEMBER') => {
      const row = await db.user.create({
        data: {
          role,
          email: randomUUID() + '@example.invalid',
          name: 'Synthetic meeting user',
          passwordHash: hash,
        },
      });
      createdUsers.push(row.id);
      return row;
    };
    owner = await user('OWNER');
    member = await user('MEMBER');
    manager = await user('MEMBER');
    setting = (
      await db.systemSetting.create({
        data: { singletonKey: 'system', setupCompleted: true },
      })
    ).id;
    tech = (
      await db.department.create({ data: { kind: 'TECH', status: 'ACTIVE' } })
    ).id;
    createdDepartments.push(tech);
    sales = (
      await db.department.create({ data: { kind: 'SALES', status: 'ACTIVE' } })
    ).id;
    createdDepartments.push(sales);
    await db.departmentMembership.createMany({
      data: [
        {
          departmentId: tech,
          userId: member.id,
          role: 'MEMBER',
          canCreateMeetings: true,
          canManageMeetings: true,
        },
        {
          departmentId: tech,
          userId: manager.id,
          role: 'MEMBER',
          canManageMeetings: true,
        },
      ],
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    const ids = createdUsers;

    await db.$transaction(async (tx) => {
      const meetings = ids.length
        ? await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM meetings WHERE created_by_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
        : [];
      for (const { id } of meetings) {
        await tx.$executeRaw`DELETE FROM cancellation_decisions WHERE request_id IN (SELECT id FROM cancellation_requests WHERE meeting_id=${id}::uuid)`;
        await tx.$executeRaw`DELETE FROM cancellation_submissions WHERE request_id IN (SELECT id FROM cancellation_requests WHERE meeting_id=${id}::uuid)`;
        await tx.$executeRaw`DELETE FROM cancellation_request_audit WHERE request_id IN (SELECT id FROM cancellation_requests WHERE meeting_id=${id}::uuid)`;
        await tx.$executeRaw`DELETE FROM cancellation_requests WHERE meeting_id=${id}::uuid`;
        await tx.$executeRaw`DELETE FROM meeting_create_requests WHERE meeting_id=${id}::uuid`;
        await tx.$executeRaw`DELETE FROM meeting_creation_audit WHERE meeting_id=${id}::uuid`;
        await tx.$executeRaw`DELETE FROM outbox_events WHERE aggregate_id=${id}::uuid`;
        await tx.$executeRaw`DELETE FROM meeting_access WHERE meeting_id=${id}::uuid`;
        await tx.$executeRaw`DELETE FROM meetings WHERE id=${id}::uuid`;
      }
    });
    await db.membershipEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.departmentMembership.deleteMany({
      where: { userId: { in: ids } },
    });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.department.deleteMany({
      where: { id: { in: createdDepartments } },
    });
    if (setting) await db.systemSetting.delete({ where: { id: setting } });
  });
  afterAll(async () => {
    await app?.close();
  });
  const read = (cookies: string[], id: string) =>
    request(server)
      .get('/meetings/' + id)
      .set('Cookie', cookies);
  const cancelRequest = (
    cookies: string[],
    id: string,
    key: string = randomUUID(),
    reason = 'Synthetic cancellation reason',
  ) =>
    request(server)
      .post(`/meetings/${id}/cancellation-requests`)
      .set('Cookie', cookies)
      .set('Origin', origin)
      .set('Idempotency-Key', key)
      .send({ reason });
  const decideCancellation = (
    cookies: string[],
    id: string,
    decision: string,
    version = 0,
    key: string = randomUUID(),
  ) =>
    request(server)
      .post(`/cancellation-requests/${id}/decide`)
      .set('Cookie', cookies)
      .set('Origin', origin)
      .set('Idempotency-Key', key)
      .set('If-Match', '"' + version + '"')
      .send({ decision, reason: 'Synthetic decision reason' });
  it('cancellation decision approves a draft request once and invalidates its schedule version', async () => {
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic decision',
      }).expect(201),
    );
    const submitted = await cancelRequest(cookies, meeting.id).expect(201),
      id = (submitted.body as { id: string }).id,
      key = randomUUID();
    const first = await decideCancellation(
      cookies,
      id,
      'APPROVE',
      0,
      key,
    ).expect(200);
    expect(first.body).toEqual({
      id,
      meetingId: meeting.id,
      requestedById: owner.id,
      status: 'APPROVED',
      version: 1,
    });
    assertHttpContract(
      '/cancellation-requests/{requestId}/decide',
      'post',
      200,
      first.body,
    );
    expect(
      (await decideCancellation(cookies, id, 'APPROVE', 0, key).expect(200))
        .body,
    ).toEqual(first.body);
    await decideCancellation(cookies, id, 'REJECT', 0, key).expect(409);
    expect(
      await db.$queryRaw`SELECT lifecycle,version,schedule_version AS "scheduleVersion" FROM meetings WHERE id=${meeting.id}::uuid`,
    ).toEqual([{ lifecycle: 'CANCELLED', version: 1, scheduleVersion: 1 }]);
    expect(
      await db.$queryRaw`SELECT aggregate_version AS "aggregateVersion",payload FROM outbox_events WHERE aggregate_id=${meeting.id}::uuid AND type='meeting.cancelled.v1'`,
    ).toEqual([
      {
        aggregateVersion: 1,
        payload: { meetingId: meeting.id, scheduleVersion: 1 },
      },
    ]);
  });
  it('cancellation decision rejection preserves meeting and permits a new request', async () => {
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic rejected decision',
      }).expect(201),
    );
    const submitted = await cancelRequest(cookies, meeting.id).expect(201),
      id = (submitted.body as { id: string }).id;
    await decideCancellation(cookies, id, 'REJECT').expect(200);
    expect(bodyOf(await read(cookies, meeting.id).expect(200))).toEqual(
      meeting,
    );
    expect(
      await db.$queryRaw`SELECT id FROM outbox_events WHERE aggregate_id=${meeting.id}::uuid AND type='meeting.cancelled.v1'`,
    ).toEqual([]);
    await cancelRequest(cookies, meeting.id).expect(201);
  });
  it('cancellation decision denies a requester without administrative decision authority', async () => {
    const cookies = await login(member.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic member request',
      }).expect(201),
    );
    const submitted = await cancelRequest(cookies, meeting.id).expect(201),
      id = (submitted.body as { id: string }).id;
    await decideCancellation(cookies, id, 'APPROVE').expect(404);
    await decideCancellation(await login(owner.email), id, 'APPROVE', 3).expect(
      412,
    );
  });
  it(
    'cancellation decision upgrade preserves a pending request, receipt, audit and intent',
    async () => {
      await rehearseCancellationUpgrade(
        '20261026010000_cancellation_decisions',
      );
    },
    SESSION_SETUP_TIMEOUT_MS,
  );
  it('cancellation decision serializes competing current administrators with one winner', async () => {
    const cookies = await login(owner.email);
    await db.user.update({
      where: { id: manager.id },
      data: { role: 'MANAGER' },
    });
    const other = await login(manager.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic racing decision',
      }).expect(201),
    );
    const submitted = await cancelRequest(cookies, meeting.id).expect(201),
      id = (submitted.body as { id: string }).id;
    const results = await Promise.all([
      decideCancellation(cookies, id, 'APPROVE'),
      decideCancellation(other, id, 'REJECT'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(
      await db.$queryRaw`SELECT count(*)::int AS count FROM cancellation_request_audit WHERE request_id=${id}::uuid AND action IN ('cancellation.approved.v1','cancellation.rejected.v1')`,
    ).toEqual([{ count: 1 }]);
  });
  it('cancellation decision uses current same-department admin authority and rejects its removal', async () => {
    const ownerCookies = await login(owner.email),
      cookies = await login(member.email);
    const meeting = bodyOf(
      await create(ownerCookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic department decision',
      }).expect(201),
    );
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { role: 'ADMIN' },
    });
    let submitted = await cancelRequest(ownerCookies, meeting.id).expect(201);
    await decideCancellation(
      cookies,
      (submitted.body as { id: string }).id,
      'REJECT',
    ).expect(200);
    submitted = await cancelRequest(ownerCookies, meeting.id).expect(201);
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { role: 'MEMBER' },
    });
    await decideCancellation(
      cookies,
      (submitted.body as { id: string }).id,
      'APPROVE',
    ).expect(404);
  });
  it('cancellation decision fails closed for active capture and unsupported reassignment', async () => {
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic active capture decision',
      }).expect(201),
    );
    const submitted = await cancelRequest(cookies, meeting.id).expect(201),
      id = (submitted.body as { id: string }).id;
    await db.$executeRaw`UPDATE meetings SET lifecycle='IN_PROGRESS' WHERE id=${meeting.id}::uuid`;
    await decideCancellation(cookies, id, 'APPROVE').expect(409);
    await decideCancellation(cookies, id, 'REASSIGN').expect(422);
    expect(
      await db.$queryRaw`SELECT status,version FROM cancellation_requests WHERE id=${id}::uuid`,
    ).toEqual([{ status: 'REQUESTED', version: 0 }]);
    expect(
      await db.$queryRaw`SELECT lifecycle,version FROM meetings WHERE id=${meeting.id}::uuid`,
    ).toEqual([{ lifecycle: 'IN_PROGRESS', version: 0 }]);
  });
  it('cancellation decision validates authentication, Origin, UUID, If-Match and body', async () => {
    await request(server)
      .post(`/cancellation-requests/${randomUUID()}/decide`)
      .set('Origin', origin)
      .send({ decision: 'APPROVE' })
      .expect(401);
    const cookies = await login(owner.email);
    await decideCancellation(cookies, 'invalid-id', 'APPROVE').expect(400);
    await request(server)
      .post(`/cancellation-requests/${randomUUID()}/decide`)
      .set('Cookie', cookies)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"0"')
      .send({ decision: 'APPROVE' })
      .expect(403);
    await request(server)
      .post(`/cancellation-requests/${randomUUID()}/decide`)
      .set('Cookie', cookies)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .send({ decision: 'APPROVE' })
      .expect(400);
    await request(server)
      .post(`/cancellation-requests/${randomUUID()}/decide`)
      .set('Cookie', cookies)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"0"')
      .send({ decision: 'APPROVE', approvedById: member.id })
      .expect(400);
  });
  it('cancellation decision invalidates the current scheduled generation and never revives terminal meetings', async () => {
    const cookies = await login(owner.email);
    for (const lifecycle of ['SCHEDULED', 'ENDED', 'CANCELLED']) {
      const meeting = bodyOf(
        await create(cookies, {
          kind: 'GENERAL',
          title: 'Synthetic lifecycle decision',
        }).expect(201),
      );
      const submitted = await cancelRequest(cookies, meeting.id).expect(201),
        id = (submitted.body as { id: string }).id;
      await db.$executeRaw`UPDATE meetings SET lifecycle=${lifecycle},version=4,schedule_version=7 WHERE id=${meeting.id}::uuid`;
      await decideCancellation(cookies, id, 'APPROVE').expect(
        lifecycle === 'SCHEDULED' ? 200 : 409,
      );
      expect(
        await db.$queryRaw`SELECT lifecycle,version,schedule_version AS "scheduleVersion" FROM meetings WHERE id=${meeting.id}::uuid`,
      ).toEqual([
        {
          lifecycle: lifecycle === 'SCHEDULED' ? 'CANCELLED' : lifecycle,
          version: lifecycle === 'SCHEDULED' ? 5 : 4,
          scheduleVersion: lifecycle === 'SCHEDULED' ? 8 : 7,
        },
      ]);
    }
  });
  it('cancellation decision rolls back its receipt and all writes if expiry occurs before commit', async () => {
    const cookies = await login(owner.email);
    const family = await db.authSession.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic final expiry',
      }).expect(201),
    );
    const submitted = await cancelRequest(cookies, meeting.id).expect(201),
      id = (submitted.body as { id: string }).id,
      key = randomUUID();
    const store = app.get(CancellationDecisionStore),
      persist = store.persist.bind(store);
    jest.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
      const result = await persist(...args);
      jest.spyOn(Date, 'now').mockReturnValue(family.expiresAt.getTime() + 1);
      return result;
    });
    try {
      await decideCancellation(cookies, id, 'APPROVE', 0, key).expect(401);
    } finally {
      jest.restoreAllMocks();
    }
    expect(
      await db.$queryRaw`SELECT lifecycle,version FROM meetings WHERE id=${meeting.id}::uuid`,
    ).toEqual([{ lifecycle: 'DRAFT', version: 0 }]);
    expect(
      await db.$queryRaw`SELECT status,version FROM cancellation_requests WHERE id=${id}::uuid`,
    ).toEqual([{ status: 'REQUESTED', version: 0 }]);
    expect(
      await db.$queryRaw`SELECT request_id FROM cancellation_decisions WHERE request_id=${id}::uuid`,
    ).toEqual([]);
    await decideCancellation(cookies, id, 'APPROVE', 0, key).expect(200);
  });
  for (const method of ['appendAudit', 'appendOutbox'] as const)
    it(
      'cancellation decision rolls back request and meeting on ' +
        method +
        ' failure',
      async () => {
        const cookies = await login(owner.email);
        const meeting = bodyOf(
          await create(cookies, {
            kind: 'GENERAL',
            title: 'Synthetic decision rollback',
          }).expect(201),
        );
        const submitted = await cancelRequest(cookies, meeting.id).expect(201),
          id = (submitted.body as { id: string }).id,
          key = randomUUID();
        const store = app.get(CancellationDecisionStore);
        if (method === 'appendOutbox') {
          const outbox = store.appendOutbox.bind(store);
          jest
            .spyOn(store, 'appendOutbox')
            .mockImplementationOnce(async (...args) => {
              await outbox(...args);
              throw new Error('Synthetic failure after both durable intents');
            });
        } else
          jest
            .spyOn(store, 'appendAudit')
            .mockRejectedValueOnce(
              new Error('Synthetic decision persistence failure'),
            );
        await decideCancellation(cookies, id, 'APPROVE', 0, key).expect(500);
        expect(
          await db.$queryRaw`SELECT lifecycle,version,schedule_version AS "scheduleVersion" FROM meetings WHERE id=${meeting.id}::uuid`,
        ).toEqual([{ lifecycle: 'DRAFT', version: 0, scheduleVersion: 0 }]);
        expect(
          await db.$queryRaw`SELECT status,version,decided_by_id FROM cancellation_requests WHERE id=${id}::uuid`,
        ).toEqual([{ status: 'REQUESTED', version: 0, decided_by_id: null }]);
        expect(
          await db.$queryRaw`SELECT request_id FROM cancellation_decisions WHERE request_id=${id}::uuid`,
        ).toEqual([]);
        expect(
          await db.$queryRaw`SELECT id FROM outbox_events WHERE aggregate_id=${meeting.id}::uuid AND type IN ('cancellation.decided.v1','meeting.cancelled.v1')`,
        ).toEqual([]);
        jest.restoreAllMocks();
        await decideCancellation(cookies, id, 'APPROVE', 0, key).expect(200);
      },
    );
  it(
    'cancellation submission migration preserves a nonempty meeting and backup restore',
    async () => {
      await rehearseCancellationUpgrade();
    },
    SESSION_SETUP_TIMEOUT_MS,
  );
  it('cancellation submission serializes two different authorized requesters', async () => {
    const memberCookies = await login(member.email),
      ownerCookies = await login(owner.email);
    const meeting = bodyOf(
      await create(memberCookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic rival requests',
      }).expect(201),
    );
    const results = await Promise.all([
      cancelRequest(memberCookies, meeting.id),
      cancelRequest(ownerCookies, meeting.id),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(
      await db.$queryRaw`SELECT count(*)::int AS count FROM cancellation_requests WHERE meeting_id=${meeting.id}::uuid`,
    ).toEqual([{ count: 1 }]);
  });
  it('cancellation submission denies a revoked session family', async () => {
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic revoked family',
      }).expect(201),
    );
    await db.authSession.updateMany({
      where: { userId: owner.id },
      data: { revokedAt: new Date() },
    });
    await cancelRequest(cookies, meeting.id).expect(401);
  });
  it('cancellation submission persists one request and replays without cancelling the meeting', async () => {
    const cookies = await login(member.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic planning',
      }).expect(201),
    );
    const key = randomUUID();
    const first = await cancelRequest(cookies, meeting.id, key).expect(201);
    assertRequestContract(
      '/meetings/{meetingId}/cancellation-requests',
      'post',
      { reason: 'Synthetic cancellation reason' },
      true,
    );
    assertHttpContract(
      '/meetings/{meetingId}/cancellation-requests',
      'post',
      201,
      first.body,
    );
    const replay = await cancelRequest(cookies, meeting.id, key).expect(201);
    expect(replay.body).toEqual(first.body);
    const response = first.body as Record<string, unknown>;
    expect(response.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    expect(first.body).toEqual({
      id: response.id,
      meetingId: meeting.id,
      requestedById: member.id,
      status: 'REQUESTED',
      version: 0,
    });
    expect(first.headers['cache-control']).toBe('no-store');
    expect(
      await db.$queryRaw`SELECT status,version FROM cancellation_requests WHERE meeting_id=${meeting.id}::uuid`,
    ).toEqual([{ status: 'REQUESTED', version: 0 }]);
    expect(
      await db.$queryRaw`SELECT count(*)::int AS count FROM cancellation_request_audit WHERE request_id=${(first.body as { id: string }).id}::uuid`,
    ).toEqual([{ count: 1 }]);
    const events = await db.$queryRaw<
      { payload: unknown }[]
    >`SELECT payload FROM outbox_events WHERE aggregate_id=${meeting.id}::uuid AND type='cancellation.requested.v1'`;
    expect(events).toEqual([
      {
        payload: {
          meetingId: meeting.id,
          requestId: (first.body as { id: string }).id,
        },
      },
    ]);
    expect(bodyOf(await read(cookies, meeting.id).expect(200))).toEqual(
      meeting,
    );
    await cancelRequest(cookies, meeting.id, key, 'Changed reason').expect(409);
  });
  it('cancellation submission serializes rival requests and same-key cross-device replay', async () => {
    const [left, right] = await Promise.all([
      login(member.email),
      login(member.email),
    ]);
    const meeting = bodyOf(
      await create(left, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic planning',
      }).expect(201),
    );
    const key = randomUUID();
    const [a, b] = await Promise.all([
      cancelRequest(left, meeting.id, key),
      cancelRequest(right, meeting.id, key),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    await cancelRequest(await login(owner.email), meeting.id).expect(409);
  });
  it('cancellation submission requires authentication and denies hidden department resources', async () => {
    await request(server)
      .post(`/meetings/${randomUUID()}/cancellation-requests`)
      .set('Origin', origin)
      .send({ reason: 'Synthetic' })
      .expect(401);
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'SALES',
        departmentId: sales,
        title: 'Synthetic sales',
      }).expect(201),
    );
    await cancelRequest(await login(member.email), meeting.id).expect(404);
  });
  it('cancellation submission validates Origin, UUID, key and an allowlisted nonblank body', async () => {
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic validation',
      }).expect(201),
    );
    await request(server)
      .post(`/meetings/${meeting.id}/cancellation-requests`)
      .set('Cookie', cookies)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Synthetic' })
      .expect(403);
    await cancelRequest(cookies, 'invalid-uuid').expect(400);
    await cancelRequest(cookies, meeting.id, '').expect(400);
    for (const input of [
      { reason: '   ' },
      { reason: 'x'.repeat(1001) },
      { reason: 42 },
      { reason: 'Synthetic', actorId: member.id },
      { reason: 'Synthetic', status: 'APPROVED' },
    ]) {
      await request(server)
        .post(`/meetings/${meeting.id}/cancellation-requests`)
        .set('Cookie', cookies)
        .set('Origin', origin)
        .set('Idempotency-Key', randomUUID())
        .send(input)
        .expect(400);
    }
  });
  it('cancellation submission does not grant ordinary metadata viewers request authority', async () => {
    const meeting = bodyOf(
      await create(await login(owner.email), {
        kind: 'GENERAL',
        title: 'Synthetic public planning',
      }).expect(201),
    );
    const cookies = await login(member.email);
    await read(cookies, meeting.id).expect(200);
    await cancelRequest(cookies, meeting.id).expect(404);
    await db.$executeRaw`INSERT INTO meeting_access(meeting_id,user_id,role) VALUES(${meeting.id}::uuid,${member.id}::uuid,'REVIEWER')`;
    await cancelRequest(cookies, meeting.id).expect(201);
  });
  it('cancellation submission rechecks current scoped authority before an idempotent replay', async () => {
    const meeting = bodyOf(
      await create(await login(owner.email), {
        kind: 'SALES',
        departmentId: sales,
        title: 'Synthetic revocation',
      }).expect(201),
    );
    await db.$executeRaw`INSERT INTO meeting_access(meeting_id,user_id,role) VALUES(${meeting.id}::uuid,${member.id}::uuid,'REVIEWER')`;
    const cookies = await login(member.email),
      key = randomUUID();
    await cancelRequest(cookies, meeting.id, key).expect(201);
    await db.$executeRaw`DELETE FROM meeting_access WHERE meeting_id=${meeting.id}::uuid AND user_id=${member.id}::uuid`;
    await cancelRequest(cookies, meeting.id, key).expect(404);
  });
  for (const lifecycle of ['ENDED', 'CANCELLED'])
    it(
      'cancellation submission rejects terminal ' + lifecycle + ' meetings',
      async () => {
        const cookies = await login(owner.email);
        const meeting = bodyOf(
          await create(cookies, {
            kind: 'GENERAL',
            title: 'Synthetic terminal',
          }).expect(201),
        );
        await db.$executeRaw`UPDATE meetings SET lifecycle=${lifecycle} WHERE id=${meeting.id}::uuid`;
        await cancelRequest(cookies, meeting.id).expect(409);
        expect(
          await db.$queryRaw`SELECT id FROM cancellation_requests WHERE meeting_id=${meeting.id}::uuid`,
        ).toEqual([]);
      },
    );
  for (const method of ['appendAudit', 'appendOutbox'] as const)
    it(
      'cancellation submission rolls back all effects on ' +
        method +
        ' failure',
      async () => {
        const cookies = await login(owner.email);
        const meeting = bodyOf(
          await create(cookies, {
            kind: 'GENERAL',
            title: 'Synthetic rollback',
          }).expect(201),
        );
        const failure = jest
          .spyOn(app.get(CancellationRequestStore), method)
          .mockRejectedValueOnce(new Error('Synthetic persistence failure'));
        const key = randomUUID();
        await cancelRequest(cookies, meeting.id, key).expect(500);
        expect(
          await db.$queryRaw`SELECT id FROM cancellation_requests WHERE meeting_id=${meeting.id}::uuid`,
        ).toEqual([]);
        expect(
          await db.$queryRaw`SELECT id FROM outbox_events WHERE aggregate_id=${meeting.id}::uuid AND type='cancellation.requested.v1'`,
        ).toEqual([]);
        failure.mockRestore();
        await cancelRequest(cookies, meeting.id, key).expect(201);
      },
    );
  it('cancellation submission checks session expiry after an actual meeting lock wait', async () => {
    const cookies = await login(owner.email);
    const meeting = bodyOf(
      await create(cookies, {
        kind: 'GENERAL',
        title: 'Synthetic lock',
      }).expect(201),
    );
    const family = await db.authSession.findFirstOrThrow({
      where: { userId: owner.id },
    });
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM meetings WHERE id=${meeting.id}::uuid FOR UPDATE`;
        acquired();
        await gate;
      },
      { timeout: 10000 },
    );
    let pending: Promise<Response> | undefined;
    try {
      await Promise.race([
        ready,
        blocker.then(() => {
          throw Error('Lock ended before acquisition');
        }),
      ]);
      pending = cancelRequest(cookies, meeting.id).then((result) => result);
      const deadline = Date.now() + 4000;
      let observed = false;
      while (Date.now() < deadline) {
        const wait = await db.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM meetings WHERE id=%FOR UPDATE%') AS present`;
        if (wait[0].present) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue(family.expiresAt.getTime() + 1);
      release();
      expect((await pending).status).toBe(401);
    } finally {
      release();
      await blocker;
      await pending;
      jest.restoreAllMocks();
    }
    expect(
      await db.$queryRaw`SELECT id FROM cancellation_requests WHERE meeting_id=${meeting.id}::uuid`,
    ).toEqual([]);
  });
  it('requires authentication and a valid UUID for metadata', async () => {
    await request(server)
      .get('/meetings/' + randomUUID())
      .expect(401);
    await read(await login(owner.email), 'invalid-identifier').expect(400);
  });
  it('reads COMPANY metadata using current authenticated facts without exposing other fields', async () => {
    const created = bodyOf(
      await create(await login(owner.email), {
        kind: 'GENERAL',
        title: 'Company planning',
        joinUrl: 'https://meet.google.com/abc-defg-hij',
      }).expect(201),
    );
    const result = await read(await login(member.email), created.id).expect(
      200,
    );
    expect(bodyOf(result)).toEqual(created);
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('conceals hidden and absent resources identically and rechecks an explicit grant revocation', async () => {
    const created = bodyOf(
      await create(await login(owner.email), {
        kind: 'SALES',
        departmentId: sales,
        title: 'Sales planning',
      }).expect(201),
    );
    const cookies = await login(member.email);
    const hidden = await read(cookies, created.id).expect(404);
    const absent = await read(cookies, randomUUID()).expect(404);

    const concealed = {
      statusCode: 404,
      message: 'Not Found',
      error: 'NotFoundException',
    };
    expect(hidden.body).toMatchObject(concealed);
    expect(absent.body).toMatchObject(concealed);
    await db.$executeRaw`INSERT INTO meeting_access(meeting_id,user_id,role) VALUES(${created.id}::uuid,${member.id}::uuid,'VIEWER')`;
    expect(bodyOf(await read(cookies, created.id).expect(200))).toEqual(
      created,
    );
    await db.$executeRaw`DELETE FROM meeting_access WHERE meeting_id=${created.id}::uuid AND user_id=${member.id}::uuid`;
    await read(cookies, created.id).expect(404);
  });
  it('separates PRIVATE metadata administration from ordinary department membership', async () => {
    const created = bodyOf(
      await create(await login(owner.email), {
        kind: 'TECH',
        departmentId: tech,
        visibility: 'PRIVATE',
        title: 'Private planning',
      }).expect(201),
    );
    const cookies = await login(member.email);
    await read(cookies, created.id).expect(404);
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { role: 'ADMIN' },
    });
    expect(bodyOf(await read(cookies, created.id).expect(200))).toEqual(
      created,
    );
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { revokedAt: new Date() },
    });
    await read(cookies, created.id).expect(404);
  });
  it('reloads system role and session revocation instead of trusting the stale cookie', async () => {
    const created = bodyOf(
      await create(await login(owner.email), {
        kind: 'GENERAL',
        visibility: 'PRIVATE',
        title: 'Private planning',
      }).expect(201),
    );
    await db.user.update({
      where: { id: manager.id },
      data: { role: 'MANAGER' },
    });
    const cookies = await login(manager.email);
    await read(cookies, created.id).expect(200);
    await db.user.update({
      where: { id: manager.id },
      data: { role: 'MEMBER' },
    });
    await read(cookies, created.id).expect(404);
    await db.authSession.updateMany({
      where: { userId: manager.id },
      data: { revokedAt: new Date() },
    });
    await read(cookies, created.id).expect(401);
  });
  it('denies metadata when a live session expires during a real resource lock wait', async () => {
    const created = bodyOf(
      await create(await login(owner.email), {
        kind: 'GENERAL',
        title: 'Synthetic locked metadata',
      }).expect(201),
    );
    const cookies = await login(member.email);
    const family = await db.authSession.findFirstOrThrow({
      where: { userId: member.id },
    });
    let release!: () => void, acquired!: () => void;
    const acquiredLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM meetings WHERE id=${created.id}::uuid FOR UPDATE`;
        acquired();
        await releaseLock;
      },
      { timeout: 10000 },
    );
    let pending: Promise<Response> | undefined;
    try {
      await Promise.race([
        acquiredLock,
        blocker.then(() => {
          throw Error('Lock holder ended before acquisition');
        }),
      ]);
      pending = read(cookies, created.id).then((response) => response);
      const deadline = Date.now() + 4000;
      let observed = false;
      while (Date.now() < deadline) {
        const waiting = await db.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM meetings WHERE id=%FOR SHARE%') AS present`;
        if (waiting[0].present) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue(family.expiresAt.getTime() + 1);
      release();
      expect((await pending).status).toBe(401);
    } finally {
      release();
      await blocker;
      await pending;
      jest.restoreAllMocks();
    }
  });
  it('denies unauthenticated creation', async () => {
    await request(server)
      .post('/meetings')
      .set('Origin', origin)
      .send({ kind: 'GENERAL', title: 'x' })
      .expect(401);
  });
  it('enforces trusted Origin with real session guard', async () => {
    await request(server)
      .post('/meetings')
      .set('Cookie', await login(owner.email))
      .set('Origin', 'https://example.invalid')
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GENERAL', title: 'x' })
      .expect(403);
  });
  it('creates GENERAL without guests, matches response and persists all five effects', async () => {
    const result = await create(await login(owner.email), {
      kind: 'GENERAL',
      title: 'Planning',
    }).expect(201);
    expect(result.body).toMatchObject({
      kind: 'GENERAL',
      visibility: 'COMPANY',
      departmentId: null,
      lifecycle: 'DRAFT',
      createdById: owner.id,
      meetingAdminId: owner.id,
      version: 0,
      scheduleVersion: 0,
    });
    expect(result.headers['cache-control']).toBe('no-store');
    const body = bodyOf(result);
    const access = await db.$queryRaw<
      { can_read_transcript: boolean }[]
    >`SELECT can_read_transcript FROM meeting_access WHERE meeting_id=${body.id}::uuid`;
    expect(access).toEqual([{ can_read_transcript: false }]);
    const events = await db.$queryRaw<
      { payload: unknown }[]
    >`SELECT payload FROM outbox_events WHERE aggregate_id=${body.id}::uuid`;
    expect(events).toEqual([{ payload: { meetingId: body.id } }]);
  });
  it('uses department defaults and rejects SALES without membership', async () => {
    const cookies = await login(member.email);
    const result = await create(cookies, {
      kind: 'TECH',
      departmentId: tech,
      title: 'x',
    }).expect(201);
    expect(bodyOf(result).visibility).toBe('DEPARTMENT');
    await create(cookies, {
      kind: 'SALES',
      departmentId: sales,
      title: 'x',
    }).expect(404);
  });
  it('denies creation while the department is not ACTIVE', async () => {
    const cookies = await login(owner.email);
    for (const status of ['DISABLED'] as const) {
      await db.department.update({ where: { id: tech }, data: { status } });
      await create(cookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic inactive case',
      }).expect(409);
    }
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM meetings WHERE created_by_id=${owner.id}::uuid`;
    expect(rows).toEqual([]);
  });
  it('rejects a session that expires while creation waits on the department lock', async () => {
    const cookies = await login(member.email);
    const family = await db.authSession.findFirstOrThrow({
      where: { userId: member.id },
    });
    let release!: () => void, acquired!: () => void;
    const acquiredLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM departments WHERE id=${tech}::uuid FOR UPDATE`;
        acquired();
        await releaseLock;
      },
      { timeout: 10000 },
    );
    let pending: Promise<Response> | undefined;
    try {
      await acquiredLock;
      pending = create(cookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'Synthetic expired case',
      }).then((response) => response);
      const deadline = Date.now() + 4000;
      let observed = false;
      while (Date.now() < deadline) {
        const waiting = await db.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM departments WHERE id=%FOR UPDATE%') AS present`;
        if (waiting[0].present) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observed).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue(family.expiresAt.getTime() + 1);
      release();
      expect((await pending).status).toBe(401);
    } finally {
      release();
      await blocker;
      await pending;
      jest.restoreAllMocks();
    }
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM meetings WHERE created_by_id=${member.id}::uuid`;
    expect(rows).toEqual([]);
  });
  it('denies PRIVATE to create-only actor even with eligible other manager', async () => {
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { canManageMeetings: false },
    });
    await create(await login(member.email), {
      kind: 'TECH',
      departmentId: tech,
      title: 'x',
      visibility: 'PRIVATE',
      meetingAdminId: manager.id,
    }).expect(403);
  });
  it('concurrent same-key identical requests produce one committed occurrence', async () => {
    const cookies = await login(owner.email),
      otherDevice = await login(owner.email),
      key = randomUUID(),
      body = { kind: 'GENERAL', title: 'x' };
    const results = await Promise.all([
      create(otherDevice, body, key),
      create(cookies, body, key),
    ]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(results[0].body).toEqual(results[1].body);
    const rows = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM meetings WHERE created_by_id=${owner.id}::uuid`;
    expect(rows[0].count).toBe(1n);
    await create(cookies, { ...body, title: 'different' }, key).expect(409);
  });
  it('rolls back every real write if an error occurs after persistence', async () => {
    const store = app.get(MeetingCreateStore),
      persist = store.persist.bind(store);
    jest.spyOn(store, 'persist').mockImplementation(async (...args) => {
      await persist(...args);
      throw Error('Synthetic rollback');
    });
    await create(await login(owner.email), {
      kind: 'GENERAL',
      title: 'x',
    }).expect(500);
    const rows = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM meetings WHERE created_by_id=${owner.id}::uuid`;
    expect(rows[0].count).toBe(0n);
    const receipts = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM meeting_create_requests WHERE actor_id=${owner.id}::uuid`;
    expect(receipts[0].count).toBe(0n);
  });
  it('rejects committing a meeting without its manager access row', async () => {
    const id = randomUUID();
    let inserted = false;
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO meetings(id,kind,visibility,title,created_by_id,meeting_admin_id) VALUES (${id}::uuid,'GENERAL','COMPANY','Synthetic constraint case',${owner.id}::uuid,${owner.id}::uuid)`;
        inserted = true;
      }),
    ).rejects.toThrow();
    expect(inserted).toBe(true);
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM meetings WHERE id=${id}::uuid`;
    expect(rows).toEqual([]);
  });
  it('enforces department kind at the database boundary', async () => {
    const id = randomUUID();
    await expect(
      db.$executeRaw`INSERT INTO meetings(id,kind,department_id,visibility,title,created_by_id,meeting_admin_id) VALUES (${id}::uuid,'TECH',${sales}::uuid,'DEPARTMENT','Synthetic constraint case',${owner.id}::uuid,${owner.id}::uuid)`,
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
    });
  });
  it('enforces creator immutability at the database boundary', async () => {
    const result = await create(await login(owner.email), {
      kind: 'GENERAL',
      title: 'Synthetic constraint case',
    }).expect(201);
    const id = bodyOf(result).id;
    await expect(
      db.$executeRaw`UPDATE meetings SET created_by_id=${member.id}::uuid WHERE id=${id}::uuid`,
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
    });
    const rows = await db.$queryRaw<
      { created_by_id: string }[]
    >`SELECT created_by_id FROM meetings WHERE id=${id}::uuid`;
    expect(rows).toEqual([{ created_by_id: owner.id }]);
  });
  it('rejects invalid scope and privileged DTO claims', async () => {
    const cookies = await login(owner.email);
    await create(cookies, {
      kind: 'GENERAL',
      departmentId: tech,
      title: 'x',
    }).expect(422);
    await create(cookies, {
      kind: 'GENERAL',
      title: 'x',
      createdById: member.id,
    }).expect(400);
  });
  it('requires an explicit-offset valid instant and stores numeric offsets as UTC', async () => {
    const cookies = await login(owner.email);
    for (const scheduledAt of [
      '2030-01-01',
      '2030-01-01T09:00:00',
      '2030-02-30T09:00:00Z',
    ]) {
      await create(cookies, {
        kind: 'GENERAL',
        title: 'x',
        scheduledAt,
      }).expect(400);
    }
    const result = await create(cookies, {
      kind: 'GENERAL',
      title: 'x',
      scheduledAt: '2030-01-01T12:00:00+03:00',
    }).expect(201);
    expect(bodyOf(result).scheduledAt).toBe('2030-01-01T09:00:00.000Z');
  });
  it('prevents revocation from orphaning a manager after creation wins', async () => {
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { canManageMeetings: false },
    });
    await create(await login(member.email), {
      kind: 'TECH',
      departmentId: tech,
      title: 'x',
      meetingAdminId: manager.id,
    }).expect(201);
    expect((await revokeManager(await login(owner.email))).status).toBe(409);
  });
  it('rejects creation when manager revocation wins first', async () => {
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { canManageMeetings: false },
    });
    expect((await revokeManager(await login(owner.email))).status).toBe(200);
    await create(await login(member.email), {
      kind: 'TECH',
      departmentId: tech,
      title: 'x',
      meetingAdminId: manager.id,
    }).expect(422);
  });
  it('serializes concurrent create versus manager revocation without an orphan', async () => {
    await db.departmentMembership.update({
      where: { departmentId_userId: { departmentId: tech, userId: member.id } },
      data: { canManageMeetings: false },
    });
    const memberCookies = await login(member.email),
      ownerCookies = await login(owner.email);
    const [creation, revocation] = await Promise.all([
      create(memberCookies, {
        kind: 'TECH',
        departmentId: tech,
        title: 'x',
        meetingAdminId: manager.id,
      }),
      revokeManager(ownerCookies),
    ]);
    expect([
      [201, 409],
      [422, 200],
    ]).toContainEqual([creation.status, revocation.status]);
  });
});
