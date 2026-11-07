import { Test, TestingModule } from '@nestjs/testing';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { SystemQueueService } from './services/system-queue.service';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';

describe('ApiController', () => {
  let apiController: ApiController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [
        ApiService,
        {
          provide: SystemQueueService,
          useValue: { enqueueSmokeTest: jest.fn() },
        },
      ],
    }).compile();

    apiController = app.get<ApiController>(ApiController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(apiController.getHello()).toBe('Hello World!');
    });
  });
});

describe('diagnostic HTTP surface (controlled queue, no infrastructure)', () => {
  let app: INestApplication;
  const enqueue = jest.fn<Promise<string>, []>();
  beforeAll(async () => {
    enqueue.mockResolvedValue('synthetic-job');
    const context = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [
        ApiService,
        {
          provide: SystemQueueService,
          useValue: { enqueueSmokeTest: enqueue },
        },
      ],
    }).compile();
    app = context.createNestApplication();
    app.useLogger(false);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => enqueue.mockClear());
  it.each([{}, { synthetic: 'diagnostic request' }])(
    'does not expose a queue mutation over HTTP (%j)',
    async (body) => {
      await request(app.getHttpServer() as Server)
        .post('/system/smoke-test')
        .send(body)
        .expect(404);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it('preserves the existing root response', async () => {
    await request(app.getHttpServer() as Server)
      .get('/')
      .expect(200, 'Hello World!');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
