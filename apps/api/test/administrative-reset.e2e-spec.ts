import {
  assertIssued,
  assertChanged,
  assertRequest,
  assertResetAuthentication,
} from '../../../test/fixtures/administrative-reset-contract.cjs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PrismaService,
  SystemRole,
  Prisma,
} from '@meetwise/infrastructure/database';
import { PasswordResetTokenService } from '@meetwise/security';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AdministrativeResetService } from '../src/modules/auth/administrative-reset.service';
import { administrativeResetDigest } from '../src/modules/auth/administrative-reset-credential';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import { OwnerRecoveryModule } from '../../recovery/src/owner-recovery.module';
import { OwnerRecoveryService } from '../../recovery/src/owner-recovery.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

function cookies(response: Response): string[] {
  const values: unknown = response.headers['set-cookie'];
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string'))
    throw Error('Missing cookies');
  return values.map((v) => v.split(';')[0]);
}
function issued(response: Response): string {
  const value: unknown = response.body;
  if (
    !value ||
    typeof value !== 'object' ||
    !('credential' in value) ||
    typeof value.credential !== 'string'
  )
    throw Error('Missing issued credential');
  return value.credential;
}
type User = Prisma.UserGetPayload<Record<string, never>>;
describe('Administrative password reset (owned PostgreSQL/Redis/HTTP)', () => {
  let app: INestApplication,
    db: PrismaService,
    server: Server,
    passwords: PasswordHasherService;
  let owner: User,
    manager: User,
    member: User,
    ids: string[] = [],
    hash: string;
  const origin = 'http://127.0.0.1:1',
    oldPassword = 'Synthetic-reset-old-481!',
    newPassword = 'Synthetic-reset-new-693!';
  const login = (user: User, password = oldPassword) =>
    request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email: user.email, password });
  const issue = (values: string[], target = member.id, key = randomUUID()) =>
    request(server)
      .post(`/users/${target}/reset-credentials`)
      .set('Origin', origin)
      .set('Cookie', values)
      .set('Idempotency-Key', key)
      .send({});
  const consume = (credential: string, password = newPassword) =>
    request(server)
      .post('/auth/temporary-password')
      .set('Origin', origin)
      .set('Authorization', 'Bearer ' + credential)
      .send({ newPassword: password });
  const freshMember = () =>
    db.user.findUniqueOrThrow({ where: { id: member.id } });
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
    server = app.getHttpServer() as Server;
    passwords = app
      .select(AuthModule)
      .get(PasswordHasherService, { strict: true });
    hash = await passwords.hash(oldPassword);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    ids = [];
    const create = async (role: SystemRole) => {
      const user = await db.user.create({
        data: {
          email: randomUUID() + '@example.invalid',
          name: 'Synthetic reset user',
          role,
          passwordHash: hash,
        },
      });
      ids.push(user.id);
      return user;
    };
    owner = await create(SystemRole.OWNER);
    manager = await create(SystemRole.MANAGER);
    member = await create(SystemRole.MEMBER);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db || !ids.length) return;
    await db.administrativeResetEvent.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { issuerId: { in: ids } }] },
    });
    await db.administrativeResetToken.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { issuerId: { in: ids } }] },
    });
    await db.ownerRecoveryEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.ownerRecoveryToken.deleteMany({ where: { userId: { in: ids } } });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    ids = [];
  });
  afterAll(async () => {
    await app?.close();
  });
  const roles = [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER];
  it.each(roles.flatMap((a) => roles.map((b) => [a, b] as const)))(
    'enforces real HTTP %s -> %s matrix',
    async (a, b) => {
      const users = {
        [SystemRole.OWNER]: owner,
        [SystemRole.MANAGER]: manager,
        [SystemRole.MEMBER]: member,
      };
      const allowed =
        (a === SystemRole.OWNER && b !== SystemRole.OWNER) ||
        (a === SystemRole.MANAGER && b === SystemRole.MEMBER);
      await issue(
        cookies(await login(users[a]).expect(200)),
        users[b].id,
      ).expect(allowed ? 200 : 403);
      expect(await db.administrativeResetEvent.count()).toBe(allowed ? 1 : 0);
    },
  );
  it('requires authenticated current authority, Origin, UUID, empty body and request key', async () => {
    const values = cookies(await login(owner).expect(200));
    await request(server)
      .post(`/users/${member.id}/reset-credentials`)
      .set('Origin', origin)
      .send({})
      .expect(401);
    await request(server)
      .post(`/users/${member.id}/reset-credentials`)
      .set('Cookie', values)
      .send({})
      .expect(403);
    await issue(values, 'invalid').expect(400);
    await request(server)
      .post(`/users/${member.id}/reset-credentials`)
      .set('Cookie', values)
      .set('Origin', origin)
      .send({})
      .expect(400);
    await issue(values).send({ role: 'OWNER' }).expect(400);
    await issue(values, randomUUID()).expect(404);
    expect(await db.administrativeResetEvent.count()).toBe(0);
  });
  it('stores digest only, bounds expiry, prevents repeat reveal and invalidates all old authentication', async () => {
    const values = cookies(await login(owner).expect(200)),
      old = cookies(await login(member).expect(200));
    const ordinary = await app
      .get(PasswordResetTokenService)
      .issueForRequest(member.id, randomUUID(), Date.now(), 0);
    const key = randomUUID(),
      response = await issue(values, member.id, key).expect(200),
      credential = issued(response);
    assertIssued(response.body);
    assertResetAuthentication();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(credential).toMatch(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    const state = await db.administrativeResetToken.findUniqueOrThrow({
      where: { userId: member.id },
    });
    expect(state.digest).toBe(administrativeResetDigest(credential));
    expect(state.expiresAt.getTime() - state.issuedAt.getTime()).toBe(900000);
    expect(JSON.stringify(state)).not.toContain(credential);
    expect(
      JSON.stringify(await db.administrativeResetEvent.findMany()),
    ).not.toContain(credential);
    expect(await freshMember()).toMatchObject({
      mustChangePassword: true,
      tokenVersion: 1,
      passwordHash: hash,
    });
    await issue(values, member.id, key).expect(409);
    expect((await freshMember()).tokenVersion).toBe(1);
    await login(member).expect(401);
    await request(server).get('/auth/me').set('Cookie', old).expect(401);
    await request(server)
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', old)
      .expect(401);
    await request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({ resetToken: ordinary, newPassword })
      .expect(400);

    const current = await app
      .get(PasswordResetTokenService)
      .issueForRequest(member.id, randomUUID(), Date.now() + 1, 1);
    await request(server)
      .post('/auth/reset-password')
      .set('Origin', origin)
      .send({ resetToken: current, newPassword })
      .expect(400);
    assertRequest({ newPassword });
    const changed = await consume(credential).expect(200);
    assertChanged(changed.body);
    expect(await freshMember()).toMatchObject({
      mustChangePassword: false,
      tokenVersion: 2,
      role: SystemRole.MEMBER,
    });
    await login(member, newPassword).expect(200);
    await login(member).expect(401);
    await consume(credential, 'Another-synthetic-new-789!').expect(403);
    expect(await db.administrativeResetEvent.count()).toBe(2);
  });
  it('replaces previous credential, and retains idempotency history across replacements', async () => {
    const values = cookies(await login(owner).expect(200)),
      key = randomUUID();
    const first = issued(await issue(values, member.id, key).expect(200));
    const second = issued(await issue(values).expect(200));
    await issue(values, member.id, key).expect(409);
    await consume(first).expect(403);
    await consume(second).expect(200);
    expect((await freshMember()).tokenVersion).toBe(3);
  });
  it('rejects expired, wrong-purpose, missing and malformed temporary credentials without changing state', async () => {
    const credential = issued(
      await issue(cookies(await login(owner).expect(200))).expect(200),
    );
    await request(server)
      .post('/auth/temporary-password')
      .set('Origin', origin)
      .send({ newPassword })
      .expect(401);
    await request(server)
      .post('/auth/temporary-password')
      .set('Authorization', 'Bearer ' + credential)
      .send({ newPassword })
      .expect(403);
    await consume(credential).send({ role: 'OWNER' }).expect(400);
    await consume(credential, oldPassword).expect(400);
    await consume('invalid').expect(403);
    const ownerCredential = await app
      .get(OwnerRecoveryService)
      .issue(owner.email);
    await consume(ownerCredential).expect(403);
    await db.administrativeResetToken.update({
      where: { userId: member.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await consume(credential).expect(403);
    expect(await freshMember()).toMatchObject({
      mustChangePassword: true,
      tokenVersion: 1,
      passwordHash: hash,
    });
  });
  it.each([
    'issuerEpoch',
    'issuerRole',
    'issuerInactive',
    'targetRole',
    'targetInactive',
    'targetEpoch',
  ] as const)('rechecks %s at consumption', async (change) => {
    const credential = issued(
      await issue(cookies(await login(manager).expect(200))).expect(200),
    );
    switch (change) {
      case 'issuerEpoch':
        await db.user.update({
          where: { id: manager.id },
          data: { tokenVersion: { increment: 1 } },
        });
        break;
      case 'issuerRole':
        await db.user.update({
          where: { id: manager.id },
          data: { role: SystemRole.MEMBER },
        });
        break;
      case 'issuerInactive':
        await db.user.update({
          where: { id: manager.id },
          data: { isActive: false },
        });
        break;
      case 'targetRole':
        await db.user.update({
          where: { id: member.id },
          data: { role: SystemRole.OWNER },
        });
        break;
      case 'targetInactive':
        await db.user.update({
          where: { id: member.id },
          data: { isActive: false },
        });
        break;
      case 'targetEpoch':
        await db.user.update({
          where: { id: member.id },
          data: { tokenVersion: { increment: 1 } },
        });
        break;
    }
    await consume(credential).expect(403);
    expect((await freshMember()).passwordHash).toBe(hash);
    expect(
      await db.administrativeResetEvent.count({
        where: { action: 'CONSUMED' },
      }),
    ).toBe(0);
  });
  it('serializes simultaneous claims to exactly one password update and audit', async () => {
    const credential = issued(
      await issue(cookies(await login(owner).expect(200))).expect(200),
    );
    const responses = await Promise.all([
      consume(credential),
      consume(credential, 'Another-synthetic-new-789!'),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
    expect((await freshMember()).tokenVersion).toBe(2);
    expect(
      await db.administrativeResetEvent.count({
        where: { action: 'CONSUMED' },
      }),
    ).toBe(1);
  });
  it('serializes two authorized issuers without deadlock; only the latest credential works', async () => {
    const a = cookies(await login(owner).expect(200)),
      b = cookies(await login(manager).expect(200));
    const responses = await Promise.all([issue(a), issue(b)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const state = await db.administrativeResetToken.findUniqueOrThrow({
      where: { userId: member.id },
    });
    const latest = responses.find(
      (r) => administrativeResetDigest(issued(r)) === state.digest,
    );
    const old = responses.find(
      (r) => administrativeResetDigest(issued(r)) !== state.digest,
    );
    if (!latest || !old) throw Error('Missing reset candidates');
    await consume(issued(old)).expect(403);
    await consume(issued(latest)).expect(200);
    expect((await freshMember()).tokenVersion).toBe(3);
  });
  it('rechecks authority after HTTP guards before transactional issuance', async () => {
    const values = cookies(await login(manager).expect(200)),
      service = app.get(AdministrativeResetService);
    const original = service.issue.bind(service);
    jest.spyOn(service, 'issue').mockImplementationOnce(async (...args) => {
      await db.user.update({
        where: { id: manager.id },
        data: { role: SystemRole.MEMBER },
      });
      return original(...args);
    });
    await issue(values).expect(403);
    expect((await freshMember()).tokenVersion).toBe(0);
  });
  it('rolls back claim, password and pending flag when audit insertion fails, allowing safe retry', async () => {
    const credential = issued(
      await issue(cookies(await login(owner).expect(200))).expect(200),
    );

    await db.administrativeResetEvent.create({
      data: {
        issuerId: owner.id,
        userId: member.id,
        tokenVersion: 2,
        action: 'CONSUMED',
      },
    });
    await consume(credential).expect(500);
    expect(await freshMember()).toMatchObject({
      mustChangePassword: true,
      tokenVersion: 1,
      passwordHash: hash,
    });
    expect(
      (
        await db.administrativeResetToken.findUniqueOrThrow({
          where: { userId: member.id },
        })
      ).consumedAt,
    ).toBeNull();
    await db.administrativeResetEvent.deleteMany({
      where: { userId: member.id, action: 'CONSUMED' },
    });
    await consume(credential).expect(200);
  });
  it('checks expiration again after password hashing and rolls back safely', async () => {
    const credential = issued(
      await issue(cookies(await login(owner).expect(200))).expect(200),
    );
    const original = passwords.hash.bind(passwords);
    jest.spyOn(passwords, 'hash').mockImplementationOnce(async (value) => {
      const hashed = await original(value);
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000);
      return hashed;
    });
    await consume(credential).expect(403);
    expect((await freshMember()).tokenVersion).toBe(1);
  });
  it('CLI-only OWNER recovery clears forced-change state without opening HTTP OWNER reset', async () => {
    await db.user.update({
      where: { id: owner.id },
      data: { mustChangePassword: true },
    });
    await login(owner).expect(401);
    const recovery = app.get(OwnerRecoveryService),
      credential = await recovery.issue(owner.email);
    await consume(credential).expect(403);
    await recovery.consume(credential, newPassword);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: owner.id } }))
        .mustChangePassword,
    ).toBe(false);
    await login(owner, newPassword).expect(200);
  });
});
