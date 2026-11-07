import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request, { Response } from 'supertest';
import { ApiModule } from '../src/api.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';
import { PasswordHasherService } from '../src/modules/auth/services/password-hasher.service';
import { SetupTokenService } from '../src/modules/setup/setup-token.service';
import { BotDisplayService } from '../src/modules/system-settings/bot-display.service';
import {
  assertHttpContract,
  assertRequestContract,
  assertImplementedDeclarations,
} from '../../../test/fixtures/phase2-contract.cjs';
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
describe('Implemented Phase2 contracts with production filter (real PostgreSQL/Redis)', () => {
  let app: INestApplication | undefined;
  let db: PrismaService, server: Server, hash: string;
  let ids: string[] = [];
  const origin = 'http://127.0.0.1:1',
    password = 'Synthetic-contract-password-482!';
  const actor = async (role: SystemRole = SystemRole.OWNER) => {
    const user = await db.user.create({
      data: {
        email: randomUUID() + '@example.invalid',
        name: 'Synthetic contract actor',
        passwordHash: hash,
        role,
      },
    });
    ids.push(user.id);
    const response = await request(server)
      .post('/auth/login')
      .set('Origin', origin)
      .send({ email: user.email, password })
      .expect(200);
    return { user, session: cookies(response), response };
  };
  const parity = (route: string, method: string, response: Response) => {
    assertHttpContract(
      route,
      method,
      response.status,
      response.body as unknown,
    );
    if (response.status >= 400) {
      const body = response.body as {
        statusCode: number;
        path: string;
        method: string;
      };
      expect(body.statusCode).toBe(response.status);
      expect(body.method).toBe(method.toUpperCase());
    }
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
        transformOptions: { exposeDefaultValues: true },
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
    expect(await db.user.count()).toBe(0);
    expect(await db.systemSetting.count()).toBe(0);
  }, SESSION_SETUP_TIMEOUT_MS);
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    await db.botDisplayChange.deleteMany({ where: { actorId: { in: ids } } });
    await db.authSession.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    ids = [];
    await db.systemSetting.deleteMany({ where: { singletonKey: 'system' } });
  });
  afterAll(async () => {
    await app?.close();
  });
  it('keeps implemented operation errors/security distinct from future proposals', () => {
    assertImplementedDeclarations();
  });
  it('keeps approved public probes accessible without credentials and auth mutations Origin-protected', async () => {
    expect(
      (await request(server).get('/health/live').expect(200)).body as unknown,
    ).toEqual({ status: 'ok' });
    await request(server).get('/health/ready').expect(200);
    for (const route of [
      '/auth/login',
      '/auth/forgot-password',
      '/auth/reset-password',
    ])
      parity(
        route,
        'post',
        await request(server)
          .post(route)
          .set('Origin', 'https://evil.invalid')
          .send({})
          .expect(403),
      );
  });
  it('documents real bootstrap route, credential and response without the proposed alias', async () => {
    const email = randomUUID() + '@example.invalid';
    const token = await app!.get(SetupTokenService).issue();
    const body = {
      companyName: 'Synthetic company',
      ownerName: 'Synthetic OWNER',
      ownerEmail: email,
      ownerPassword: password,
      companyLogoUrl: null,
    };

    try {
      const response = await request(server)
        .post('/setup/complete')
        .set('Origin', origin)
        .set('X-MeetWise-Setup-Token', token)
        .send(body)
        .expect(201);
      parity('/setup/complete', 'post', response);
      assertRequestContract('/setup/complete', 'post', body, true);
      const replay = await request(server)
        .post('/setup/complete')
        .set('Origin', origin)
        .set('X-MeetWise-Setup-Token', token)
        .send(body)
        .expect(404);
      parity('/setup/complete', 'post', replay);
      await request(server)
        .post('/auth/setup')
        .set('Origin', origin)
        .send(body)
        .expect(404);
    } finally {
      ids.push(
        ...(
          await db.user.findMany({ where: { email }, select: { id: true } })
        ).map((u) => u.id),
      );
    }
  });
  it('validates exact current-user wrapper, login, refresh, logout and password responses', async () => {
    const { user, session, response } = await actor();
    parity('/auth/login', 'post', response);
    parity(
      '/auth/me',
      'get',
      await request(server).get('/auth/me').set('Cookie', session).expect(200),
    );
    const rotated = await request(server)
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', session)
      .expect(200);
    parity('/auth/refresh', 'post', rotated);
    const next = cookies(rotated);
    parity(
      '/auth/logout',
      'post',
      await request(server)
        .post('/auth/logout')
        .set('Origin', origin)
        .set('Cookie', next)
        .expect(200),
    );
    const again = cookies(
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: user.email, password })
        .expect(200),
    );
    const body = { currentPassword: password, newPassword: password + '2' };
    parity(
      '/auth/password',
      'patch',
      await request(server)
        .patch('/auth/password')
        .set('Origin', origin)
        .set('Cookie', again)
        .send(body)
        .expect(200),
    );
    assertRequestContract('/auth/password', 'patch', body, true);
    assertRequestContract(
      '/auth/password',
      'patch',
      { ...body, role: 'OWNER' },
      false,
    );
  });
  it('documents allowlisted settings projection without digest or internal configuration', async () => {
    const { session } = await actor();
    const response = await request(server)
      .get('/system/settings')
      .set('Cookie', session)
      .expect(200);
    parity('/system/settings', 'get', response);
    expect(() =>
      assertHttpContract('/system/settings', 'get', 200, {
        ...(response.body as Record<string, unknown>),
        companyName: null,
      }),
    ).toThrow();
    expect(JSON.stringify(response.body)).not.toContain('bootstrapToken');
  });
  it.each([
    ['/auth/me', 'get'],
    ['/settings/bot', 'get'],
    ['/settings/modules', 'get'],
    ['/system/settings', 'get'],
    ['/users', 'post'],
    ['/users/{id}/reset-credentials', 'post'],
    ['/users/{id}/activation-credentials', 'post'],
    ['/departments/{departmentId}/members', 'get'],
  ])(
    'uses actual401 error envelope for anonymous %s',
    async (route, method) => {
      const url = route
        .replace('{id}', randomUUID())
        .replace('{departmentId}', randomUUID());
      const response =
        method === 'get'
          ? await request(server).get(url).expect(401)
          : await request(server)
              .post(url)
              .set('Origin', origin)
              .send({})
              .expect(401);
      parity(route, method, response);
      expect((response.body as { path: string }).path).toBe(url);
    },
  );
  it('validates forbidden current role and badOrigin using production envelopes', async () => {
    const { session } = await actor(SystemRole.MEMBER);
    parity(
      '/settings/bot',
      'get',
      await request(server)
        .get('/settings/bot')
        .set('Cookie', session)
        .expect(403),
    );
    parity(
      '/auth/logout',
      'post',
      await request(server)
        .post('/auth/logout')
        .set('Cookie', session)
        .set('Origin', 'https://evil.invalid')
        .expect(403),
    );
  });
  it('validates malformed/unknown DTO and invalid login/reset/activation credentials', async () => {
    parity(
      '/auth/login',
      'post',
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: 'bad', password, extra: true })
        .expect(400),
    );
    parity(
      '/auth/login',
      'post',
      await request(server)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: 'absent@example.invalid', password })
        .expect(401),
    );
    parity(
      '/auth/reset-password',
      'post',
      await request(server)
        .post('/auth/reset-password')
        .set('Origin', origin)
        .send({ resetToken: 'invalid', newPassword: password })
        .expect(400),
    );
    for (const route of ['/auth/accept-invite', '/auth/temporary-password'])
      parity(
        route,
        'post',
        await request(server)
          .post(route)
          .set('Origin', origin)
          .send({ newPassword: password })
          .expect(401),
      );
    parity(
      '/auth/forgot-password',
      'post',
      await request(server)
        .post('/auth/forgot-password')
        .set('Origin', origin)
        .send({ email: 'absent@example.invalid' })
        .expect(200),
    );
  });
  it('validates stale version, malformed patch, and sanitized internal failure', async () => {
    const { session } = await actor();
    await db.systemSetting.create({ data: { setupCompleted: true } });
    await request(server)
      .get('/settings/bot')
      .set('Cookie', session)
      .expect(200);
    parity(
      '/settings/bot',
      'patch',
      await request(server)
        .patch('/settings/bot')
        .set('Cookie', session)
        .set('Origin', origin)
        .set('If-Match', '"9"')
        .send({ displayName: 'Uncommitted' })
        .expect(412),
    );
    parity(
      '/settings/bot',
      'patch',
      await request(server)
        .patch('/settings/bot')
        .set('Cookie', session)
        .set('Origin', origin)
        .set('If-Match', '"0"')
        .send({ displayName: 'Invalid', credential: 'synthetic' })
        .expect(400),
    );
    jest
      .spyOn(app!.get(BotDisplayService), 'read')
      .mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_FAILURE'));
    const response = await request(server)
      .get('/settings/bot')
      .set('Cookie', session)
      .expect(500);
    parity('/settings/bot', 'get', response);
    expect(JSON.stringify(response.body)).not.toContain(
      'SYNTHETIC_PRIVATE_FAILURE',
    );
    expect((response.body as { message: string }).message).toBe(
      'Internal server error',
    );
  });
});
