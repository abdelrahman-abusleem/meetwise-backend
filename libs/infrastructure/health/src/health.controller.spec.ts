import type { INestApplication } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@meetwise/infrastructure/database';
import { RedisService } from '@meetwise/infrastructure/redis';
import type { Server } from 'node:http';
import request from 'supertest';
import { DatabaseHealthIndicator } from './database.health';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';

describe('Readiness dependency failures (HTTP with adapter fault injection)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  const query = jest.fn<Promise<unknown>, unknown[]>();
  const ping = jest.fn<Promise<string>, []>();
  const privateDetail = 'synthetic-private-adapter-detail-do-not-disclose';
  const down = (name: 'database' | 'redis') => ({
    status: 'down',
    message: name === 'database' ? 'Database unavailable' : 'Redis unavailable',
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        DatabaseHealthIndicator,
        RedisHealthIndicator,
        { provide: PrismaService, useValue: { $queryRaw: query } },
        { provide: RedisService, useValue: { getClient: () => ({ ping }) } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await app.init();
    server = app.getHttpServer() as Server;
  });
  beforeEach(() => {
    query.mockReset().mockResolvedValue([{ value: 1 }]);
    ping.mockReset().mockResolvedValue('PONG');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('returns the normal readiness contract when both adapters resolve', async () => {
    const dependencies = {
      database: { status: 'up' },
      redis: { status: 'up' },
    };
    await request(server).get('/health/ready').expect(200).expect({
      status: 'ok',
      info: dependencies,
      error: {},
      details: dependencies,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it.each(['database', 'redis'] as const)(
    'returns only a fixed safe message when %s rejects Error',
    async (name) => {
      const adapter = name === 'database' ? query : ping;
      adapter.mockRejectedValue(new Error(privateDetail));
      const response = await request(server).get('/health/ready').expect(503);
      const body: unknown = response.body;
      expect(body).toMatchObject({
        status: 'error',
        error: { [name]: down(name) },
        details: { [name]: down(name) },
      });
      expect(JSON.stringify(body)).not.toContain(privateDetail);
      expect(JSON.stringify(body)).not.toContain('stack');
    },
  );

  it('reports both failures without disclosing either adapter rejection', async () => {
    query.mockRejectedValue(new Error(privateDetail + '-db'));
    ping.mockRejectedValue(new Error(privateDetail + '-redis'));
    const response = await request(server).get('/health/ready').expect(503);
    const body: unknown = response.body;
    expect(body).toEqual({
      status: 'error',
      info: {},
      error: { database: down('database'), redis: down('redis') },
      details: { database: down('database'), redis: down('redis') },
    });
    expect(JSON.stringify(body)).not.toContain(privateDetail);
  });

  it.each(['database', 'redis'] as const)(
    'handles non-Error and hostile %s rejections without coercion',
    async (name) => {
      const inspect = jest.fn(() => {
        throw new Error('Must not inspect rejection');
      });
      const hostile = Object.defineProperty({}, 'message', { get: inspect });
      Object.defineProperty(hostile, 'toString', { value: inspect });
      const hostileError = Object.defineProperty(new Error(), 'message', {
        get: inspect,
      });
      const adapter = name === 'database' ? query : ping;
      for (const value of [null, privateDetail, hostile, hostileError]) {
        adapter.mockRejectedValue(value);
        const response = await request(server).get('/health/ready').expect(503);
        const body: unknown = response.body;
        expect(body).toMatchObject({ error: { [name]: down(name) } });
        expect(JSON.stringify(body)).not.toContain(privateDetail);
      }
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it('returns readiness to healthy after both adapters recover', async () => {
    query.mockRejectedValue(new Error(privateDetail));
    ping.mockRejectedValue(new Error(privateDetail));
    await request(server).get('/health/ready').expect(503);
    await request(server)
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
    query.mockResolvedValue([{ value: 1 }]);
    ping.mockResolvedValue('PONG');
    await request(server).get('/health/ready').expect(200);
  });

  it('keeps liveness independent of failed adapters', async () => {
    query.mockRejectedValue(new Error(privateDetail));
    ping.mockRejectedValue(new Error(privateDetail));
    await request(server)
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});
