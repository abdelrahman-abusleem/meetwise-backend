import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { ApiModule } from '../src/api.module';

describe('API (e2e with disposable services)', () => {
  let app: INestApplication | undefined;
  let httpServer: Server;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('/health/live (GET)', async () => {
    await request(httpServer)
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('/health/ready (GET) checks real PostgreSQL and Redis', async () => {
    const dependencies = {
      database: { status: 'up' },
      redis: { status: 'up' },
    };
    await request(httpServer).get('/health/ready').expect(200).expect({
      status: 'ok',
      info: dependencies,
      error: {},
      details: dependencies,
    });
  });

  it('returns 404 for an unknown route', async () => {
    await request(httpServer).get('/not-a-meetwise-route').expect(404);
  });
});
