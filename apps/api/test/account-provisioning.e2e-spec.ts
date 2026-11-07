import {
  assertProvisioned,
  assertActivationIssued,
  assertActivated,
  assertProvisioningSecurity,
} from '../../../test/fixtures/provisioning-contract.cjs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AccountProvisioningService } from '../src/modules/auth/account-provisioning.service';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import { activationDigest } from '../src/modules/auth/activation-credential';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';
function cookies(response: Response): string[] {
  const values: unknown = response.headers['set-cookie'];
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string'))
    throw Error('Missing auth cookies');
  return values.map((v) => v.split(';')[0]);
}
function secret(response: Response): string {
  if (response.status === 201) assertProvisioned(response.body);
  else assertActivationIssued(response.body);
  assertProvisioningSecurity();
  const body: unknown = response.body;
  if (
    !body ||
    typeof body !== 'object' ||
    !('activationSecret' in body) ||
    typeof body.activationSecret !== 'string'
  )
    throw Error('Missing activation credential');
  return body.activationSecret;
}
type User = Prisma.UserGetPayload<Record<string, never>>;
describe('Pending account provisioning (owned PostgreSQL/Redis/HTTP)', () => {
  let app: INestApplication,
    db: PrismaService,
    server: Server,
    owner: User,
    manager: User,
    member: User,
    ids: string[] = [],
    emails: string[] = [],
    hash: string,
    targetEmail: string;
  const origin = 'http://127.0.0.1:1',
    password = 'Synthetic-provisioner-old-482!',
    newPassword = 'Synthetic-activated-new-693!';
  const login = (email: string, pwd = password) =>
    request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email, password: pwd });
  const dto = (role: SystemRole = SystemRole.MEMBER, email = targetEmail) => ({
    email,
    name: 'Synthetic pending user',
    systemRole: role,
    onboardingMode: 'ONE_TIME_LOCAL_ACTIVATION',
  });
  const provision = (
    values: string[],
    role: SystemRole = SystemRole.MEMBER,
    key = randomUUID(),
    email = targetEmail,
  ) =>
    request(server)
      .post('/users')
      .set('Origin', origin)
      .set('Cookie', values)
      .set('Idempotency-Key', key)
      .send(dto(role, email));
  const activate = (credential: string) =>
    request(server)
      .post('/auth/accept-invite')
      .set('Origin', origin)
      .set('Authorization', 'Bearer ' + credential)
      .send({ newPassword });
  const replace = (values: string[], id: string, key = randomUUID()) =>
    request(server)
      .post(`/users/${id}/activation-credentials`)
      .set('Origin', origin)
      .set('Cookie', values)
      .set('Idempotency-Key', key)
      .send({});
  const revoke = (values: string[], id: string) =>
    request(server)
      .post(`/users/${id}/activation-credentials/revoke`)
      .set('Origin', origin)
      .set('Cookie', values)
      .send({});
  const target = () =>
    db.user.findUniqueOrThrow({ where: { email: targetEmail } });
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
    emails = [];
    const create = async (role: SystemRole) => {
      const user = await db.user.create({
        data: {
          email: randomUUID() + '@example.invalid',
          name: 'Synthetic issuer',
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
    targetEmail = randomUUID() + '@example.invalid';
    emails.push(targetEmail);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    const owned = await db.user.findMany({
      where: { OR: [{ id: { in: ids } }, { email: { in: emails } }] },
      select: { id: true },
    });
    const userIds = owned.map((u) => u.id);
    await db.activationEvent.deleteMany({
      where: {
        OR: [{ userId: { in: userIds } }, { issuerId: { in: userIds } }],
      },
    });
    await db.activationToken.deleteMany({
      where: {
        OR: [{ userId: { in: userIds } }, { issuerId: { in: userIds } }],
      },
    });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    ids = [];
    emails = [];
  });
  afterAll(async () => {
    await app?.close();
  });
  const roles = [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER];
  it.each(roles.flatMap((a) => roles.map((b) => [a, b] as const)))(
    'enforces HTTP provisioning %s -> %s',
    async (a, b) => {
      const actors = {
          [SystemRole.OWNER]: owner,
          [SystemRole.MANAGER]: manager,
          [SystemRole.MEMBER]: member,
        },
        allowed =
          (a === SystemRole.OWNER && b !== SystemRole.OWNER) ||
          (a === SystemRole.MANAGER && b === SystemRole.MEMBER);
      await provision(
        cookies(await login(actors[a].email).expect(200)),
        b,
      ).expect(allowed ? 201 : 403);
      expect(await db.user.count({ where: { role: SystemRole.OWNER } })).toBe(
        1,
      );
      expect(await db.activationEvent.count()).toBe(allowed ? 1 : 0);
    },
  );
  it('denies anonymous, wrong Origin, unsupported fields, missing keys and SMTP promises before writes', async () => {
    const values = cookies(await login(owner.email).expect(200));
    await request(server)
      .post('/users')
      .set('Origin', origin)
      .send(dto())
      .expect(401);
    await request(server)
      .post('/users')
      .set('Cookie', values)
      .send(dto())
      .expect(403);
    await request(server)
      .post('/users')
      .set('Cookie', values)
      .set('Origin', origin)
      .send(dto())
      .expect(400);
    await provision(values).send({ isActive: true }).expect(400);
    await provision(values)
      .send({ initialDepartmentId: randomUUID() })
      .expect(400);
    await provision(values).send({ onboardingMode: 'SMTP' }).expect(400);
    expect(await db.user.count()).toBe(3);
  });
  it('creates digest-only inactive pending identity with24h expiry; activates once without a session or email-verification claim', async () => {
    const values = cookies(await login(owner.email).expect(200)),
      response = await provision(values).expect(201),
      credential = secret(response),
      user = await target();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toMatchObject({
      user: {
        id: user.id,
        email: targetEmail,
        systemRole: 'MEMBER',
        active: false,
      },
      onboardingMode: 'ONE_TIME_LOCAL_ACTIVATION',
    });
    expect(response.body).not.toHaveProperty('user.passwordHash');
    expect(user).toMatchObject({
      isActive: false,
      mustChangePassword: true,
      tokenVersion: 0,
    });
    const state = await db.activationToken.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(state.digest).toBe(activationDigest(credential));
    expect(state.expiresAt.getTime() - state.issuedAt.getTime()).toBe(86400000);
    expect(JSON.stringify(state)).not.toContain(credential);
    expect(JSON.stringify(await db.activationEvent.findMany())).not.toContain(
      credential,
    );
    await login(targetEmail, newPassword).expect(401);
    await activate(credential).send({ role: 'OWNER' }).expect(400);
    const changed = await activate(credential).expect(200);
    assertActivated(changed.body);
    expect(changed.body).toMatchObject({ emailOwnershipVerified: false });
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await target()).toMatchObject({
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 1,
      role: SystemRole.MEMBER,
    });
    await activate(credential).expect(403);
    await login(targetEmail, newPassword).expect(200);
    expect(await db.activationEvent.count()).toBe(2);
  });
  it('never rediscloses an issuance on retry, or overwrites an existing normalized email', async () => {
    const values = cookies(await login(owner.email).expect(200)),
      key = randomUUID();
    await provision(values, SystemRole.MEMBER, key).expect(201);
    await provision(values, SystemRole.MEMBER, key).expect(409);
    await provision(values, SystemRole.MANAGER).expect(409);
    await provision(
      values,
      SystemRole.MEMBER,
      randomUUID(),
      ' ' + targetEmail.toUpperCase() + ' ',
    ).expect(409);
    expect(await db.user.count()).toBe(4);
    expect(await db.activationEvent.count()).toBe(1);
    expect((await target()).role).toBe(SystemRole.MEMBER);
  });
  it('serializes different issuers racing for one email to one identity, with loser rollback', async () => {
    const a = cookies(await login(owner.email).expect(200)),
      b = cookies(await login(manager.email).expect(200));
    const responses = await Promise.all([provision(a), provision(b)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.user.count()).toBe(4);
    expect(await db.activationToken.count()).toBe(1);
    expect(await db.activationEvent.count()).toBe(1);
  });
  it('replaces and revokes pending credentials without deleting identity/audit, and only permits pending targets', async () => {
    const values = cookies(await login(owner.email).expect(200)),
      first = secret(await provision(values).expect(201)),
      user = await target(),
      key = randomUUID();
    const second = secret(await replace(values, user.id, key).expect(200));
    await replace(values, user.id, key).expect(409);
    await activate(first).expect(403);
    await revoke(values, user.id).expect(204);
    await revoke(values, user.id).expect(204);
    await activate(second).expect(403);
    expect(await db.activationEvent.count()).toBe(3);
    expect((await target()).isActive).toBe(false);
    const third = secret(await replace(values, user.id).expect(200));
    await activate(third).expect(200);
    await replace(values, user.id).expect(403);
    await revoke(values, user.id).expect(403);
    await replace(values, member.id).expect(404);
  });
  it.each([
    'issuerRole',
    'issuerEpoch',
    'issuerInactive',
    'issuerPending',
    'targetRole',
    'targetEpoch',
  ] as const)('denies activation after %s changes', async (change) => {
    const credential = secret(
        await provision(cookies(await login(manager.email).expect(200))).expect(
          201,
        ),
      ),
      user = await target();
    switch (change) {
      case 'issuerRole':
        await db.user.update({
          where: { id: manager.id },
          data: { role: SystemRole.MEMBER },
        });
        break;
      case 'issuerEpoch':
        await db.user.update({
          where: { id: manager.id },
          data: { tokenVersion: { increment: 1 } },
        });
        break;
      case 'issuerInactive':
        await db.user.update({
          where: { id: manager.id },
          data: { isActive: false },
        });
        break;
      case 'issuerPending':
        await db.user.update({
          where: { id: manager.id },
          data: { mustChangePassword: true },
        });
        break;
      case 'targetRole':
        await db.user.update({
          where: { id: user.id },
          data: { role: SystemRole.OWNER },
        });
        break;
      case 'targetEpoch':
        await db.user.update({
          where: { id: user.id },
          data: { tokenVersion: { increment: 1 } },
        });
        break;
    }
    await activate(credential).expect(403);
    expect((await target()).isActive).toBe(false);
    expect(
      await db.activationEvent.count({ where: { action: 'CONSUMED' } }),
    ).toBe(0);
  });
  it('rejects missing, wrong, expired and wrong-origin credential without activating', async () => {
    const credential = secret(
        await provision(cookies(await login(owner.email).expect(200))).expect(
          201,
        ),
      ),
      user = await target();
    await request(server)
      .post('/auth/accept-invite')
      .set('Origin', origin)
      .send({ newPassword })
      .expect(401);
    await request(server)
      .post('/auth/accept-invite')
      .set('Authorization', 'Bearer ' + credential)
      .send({ newPassword })
      .expect(403);
    await activate(
      credential.slice(0, -1) + (credential.endsWith('A') ? 'B' : 'A'),
    ).expect(403);
    await db.activationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await activate(credential).expect(403);
    expect((await target()).isActive).toBe(false);
  });
  it('serializes concurrent consumption to one activation and audit', async () => {
    const credential = secret(
      await provision(cookies(await login(owner.email).expect(200))).expect(
        201,
      ),
    );
    const responses = await Promise.all([
      activate(credential),
      activate(credential),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
    expect((await target()).tokenVersion).toBe(1);
    expect(
      await db.activationEvent.count({ where: { action: 'CONSUMED' } }),
    ).toBe(1);
  });
  it('rolls back a consumed claim and user activation if a real audit constraint fails', async () => {
    const credential = secret(
        await provision(cookies(await login(owner.email).expect(200))).expect(
          201,
        ),
      ),
      user = await target();
    await db.activationEvent.create({
      data: {
        userId: user.id,
        issuerId: owner.id,
        tokenVersion: 1,
        action: 'CONSUMED',
      },
    });
    await activate(credential).expect(500);
    expect(await target()).toMatchObject({
      isActive: false,
      mustChangePassword: true,
      tokenVersion: 0,
      passwordHash: user.passwordHash,
    });
    expect(
      (
        await db.activationToken.findUniqueOrThrow({
          where: { userId: user.id },
        })
      ).consumedAt,
    ).toBeNull();
    await db.activationEvent.deleteMany({
      where: { userId: user.id, action: 'CONSUMED' },
    });
    await activate(credential).expect(200);
  });
  it('rechecks current issuer role between HTTP guard and account creation', async () => {
    const values = cookies(await login(manager.email).expect(200)),
      service = app.get(AccountProvisioningService),
      original = service.provision.bind(service);
    jest.spyOn(service, 'provision').mockImplementationOnce(async (...args) => {
      await db.user.update({
        where: { id: manager.id },
        data: { role: SystemRole.MEMBER },
      });
      return original(...args);
    });
    await provision(values).expect(403);
    expect(await db.user.count()).toBe(3);
  });
  it('rechecks expiration after hashing and preserves pending state', async () => {
    const credential = secret(
      await provision(cookies(await login(owner.email).expect(200))).expect(
        201,
      ),
    );
    const hasher = app
        .select(AuthModule)
        .get(PasswordHasherService, { strict: true }),
      original = hasher.hash.bind(hasher);
    jest.spyOn(hasher, 'hash').mockImplementationOnce(async (value) => {
      const result = await original(value);
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 86401000);
      return result;
    });
    await activate(credential).expect(403);
    expect((await target()).isActive).toBe(false);
  });
  it('serializes revocation versus activation without granting a revoked pending account', async () => {
    const values = cookies(await login(owner.email).expect(200)),
      credential = secret(await provision(values).expect(201)),
      user = await target();
    const responses = await Promise.all([
        revoke(values, user.id),
        activate(credential),
      ]),
      statuses = responses.map((r) => r.status).sort();
    expect([
      [200, 403],
      [204, 403],
    ]).toContainEqual(statuses);
    const current = await target(),
      state = await db.activationToken.findUniqueOrThrow({
        where: { userId: user.id },
      });
    if (current.isActive) {
      expect(state.consumedAt).not.toBeNull();
      expect(state.revokedAt).toBeNull();
      expect(
        await db.activationEvent.count({ where: { action: 'REVOKED' } }),
      ).toBe(0);
    } else {
      expect(state.revokedAt).not.toBeNull();
      expect(state.consumedAt).toBeNull();
      expect(
        await db.activationEvent.count({ where: { action: 'CONSUMED' } }),
      ).toBe(0);
    }
  });
});
