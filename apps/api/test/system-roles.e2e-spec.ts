import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

function cookies(response: Response): string[] {
  const value: unknown = response.headers['set-cookie'];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error('Expected authentication cookies');
  return value.map((v) => v.split(';')[0]);
}

describe('Canonical system role permissions (owned PostgreSQL)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let userId: string;
  let email: string;
  let passwordHash: string;
  const password = 'Synthetic-role-password-482!';
  const login = () =>
    request(server)
      .post('/auth/login')
      .set('Origin', 'http://127.0.0.1:1')
      .send({ email, password })
      .expect(200);
  const settings = (values: string[]) =>
    request(server).get('/system/settings').set('Cookie', values);
  const role = (value: SystemRole) =>
    prisma.user.update({ where: { id: userId }, data: { role: value } });
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
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    passwordHash = await app.get(PasswordHasherService).hash(password);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    expect(await prisma.systemSetting.count()).toBe(0);
    email = randomUUID() + '@example.invalid';
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Synthetic role user',
        passwordHash,
        role: SystemRole.MEMBER,
      },
    });
    userId = user.id;
  });
  afterEach(async () => {
    if (!prisma || !userId) return;
    await prisma.authSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.systemSetting.deleteMany({
      where: { singletonKey: 'system' },
    });
    userId = '';
  });
  afterAll(async () => {
    await app?.close();
  });

  it('denies anonymous global configuration access before creating settings', async () => {
    await request(server).get('/system/settings').expect(401);
    expect(await prisma.systemSetting.count()).toBe(0);
  });
  it('denies MEMBER including request-supplied OWNER privilege', async () => {
    const values = cookies(await login());
    await settings(values)
      .set('X-System-Role', 'OWNER')
      .query({ role: 'OWNER' })
      .expect(403);
    expect(await prisma.systemSetting.count()).toBe(0);
  });
  it.each([SystemRole.OWNER, SystemRole.MANAGER])(
    'allows explicit %s global configuration access',
    async (value) => {
      await role(value);
      const response = await settings(cookies(await login())).expect(200);
      expect(response.body).not.toHaveProperty('bootstrapTokenHash');
    },
  );
  it('enforces current database demotion and promotion with an unchanged signed OWNER token', async () => {
    await role(SystemRole.OWNER);
    const values = cookies(await login());
    await role(SystemRole.MEMBER);
    await settings(values).expect(403);
    const me = await request(server)
      .get('/auth/me')
      .set('Cookie', values)
      .expect(200);
    expect(me.body).toMatchObject({ user: { role: 'MEMBER' } });
    await role(SystemRole.MANAGER);
    await settings(values).expect(200);
  });
  const signedRole = async (values: string[], value: string) => {
    if (!app) throw new Error('Missing app');
    const access = values.find((v) => v.startsWith('meetwise_access_token='));
    if (!access) throw new Error('Missing access cookie');
    const jwt = app.get(JwtService);
    const claims = jwt.decode<Record<string, unknown>>(
      decodeURIComponent(access.slice('meetwise_access_token='.length)),
    );
    for (const key of ['iat', 'exp', 'iss', 'aud']) delete claims[key];
    const token = await jwt.signAsync(
      { ...claims, role: value },
      {
        secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: 900,
        issuer: 'meetwise',
        audience: 'meetwise-api',
        algorithm: 'HS256',
      },
    );
    return ['meetwise_access_token=' + token];
  };
  it('does not trust a correctly signed OWNER claim for a current database MEMBER', async () => {
    const values = cookies(await login());
    await settings(await signedRole(values, 'OWNER')).expect(403);
    await request(server).get('/auth/me').set('Cookie', values).expect(200);
  });
  it('rejects obsolete global ADMIN claims without revoking a valid family', async () => {
    const values = cookies(await login());
    await settings(await signedRole(values, 'ADMIN')).expect(401);
    await request(server).get('/auth/me').set('Cookie', values).expect(200);
    expect(Object.values(SystemRole).sort()).toEqual([
      'MANAGER',
      'MEMBER',
      'OWNER',
    ]);
  });
  it('immediately denies disabled accounts, changed token versions and revoked families', async () => {
    await role(SystemRole.OWNER);
    const values = cookies(await login());
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    await settings(values).expect(401);
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: true, tokenVersion: 1 },
    });
    await settings(values).expect(401);
    const fresh = cookies(await login());
    await prisma.authSession.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
    await settings(fresh).expect(401);
  });
});
