import {
  BadRequestException,
  Controller,
  Get,
  INestApplication,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { GlobalExceptionFilter } from './global-exception.filter';

const privateDetail =
  'SYNTHETIC-PRIVATE-EXCEPTION\r\nredis://secret.example.invalid';
let failure: unknown;

@Controller('privacy-regression')
class FailureController {
  @Get('failure')
  fail(): never {
    throw failure;
  }
}

describe('GlobalExceptionFilter log privacy and HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  let logs: unknown[][];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FailureController],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.requestId = 'synthetic-request-id';
      next();
    });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  beforeEach(() => {
    logs = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['Error', (): Error => new Error(privateDetail), 500],
    [
      'HTTP 503',
      (): ServiceUnavailableException =>
        new ServiceUnavailableException(privateDetail),
      503,
    ],
    ['string', (): string => privateDetail, 500],
    ['null', (): null => null, 500],
  ] as const)(
    'keeps a generic HTTP response and safe log for %s',
    async (_name: string, value: () => unknown, status: number) => {
      failure = value();
      const response = await request(server)
        .get('/privacy-regression/failure?token=SYNTHETIC-QUERY-SECRET')
        .expect(status);
      const body: unknown = response.body;
      expect(body).toEqual({
        statusCode: status,
        timestamp: expect.any(String) as unknown,
        path: '/privacy-regression/failure',
        method: 'GET',
        message: 'Internal server error',
        error: 'Internal Server Error',
        requestId: 'synthetic-request-id',
      });
      expect(logs).toEqual([
        [`[synthetic-request-id] GET /privacy-regression/failure - ${status}`],
      ]);
      expect(JSON.stringify({ body, logs })).not.toContain('SYNTHETIC-PRIVATE');
      expect(JSON.stringify({ body, logs })).not.toContain('SYNTHETIC-QUERY');
    },
  );

  it('preserves public validation messages and does not error-log HTTP 400', async () => {
    failure = new BadRequestException([
      'First validation message',
      'Second validation message',
    ]);
    const response = await request(server)
      .get('/privacy-regression/failure')
      .expect(400);
    const body: unknown = response.body;
    expect(body).toMatchObject({
      statusCode: 400,
      message: ['First validation message', 'Second validation message'],
      error: 'Bad Request',
      path: '/privacy-regression/failure',
      method: 'GET',
      requestId: 'synthetic-request-id',
    });
    expect(logs).toEqual([]);
  });

  it('preserves unknown-route HTTP 404 and does not error-log it', async () => {
    const response = await request(server)
      .get('/privacy-regression/missing')
      .expect(404);
    const body: unknown = response.body;
    expect(body).toMatchObject({
      statusCode: 404,
      message: 'Cannot GET /privacy-regression/missing',
      error: 'Not Found',
    });
    expect(logs).toEqual([]);
  });

  it.each([
    ['Error', (): Error => new Error(privateDetail), 500],
    [
      'HTTP 503',
      (): ServiceUnavailableException =>
        new ServiceUnavailableException(privateDetail),
      503,
    ],
    [
      'HTTP 400',
      () => new BadRequestException('Public validation message'),
      400,
    ],
  ] as const)(
    'never evaluates an unsafe stack getter on %s',
    (_name, value, status) => {
      const exception = Object.defineProperty(value(), 'stack', {
        get() {
          throw new Error('Unsafe stack access');
        },
      });
      const req = {
        method: 'POST',
        path: '/synthetic-error',
        requestId: 'synthetic-id',
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const host = new ExecutionContextHost([req, res]);
      expect(() =>
        new GlobalExceptionFilter().catch(exception, host),
      ).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: status }),
      );
      expect(logs).toEqual(
        status < 500
          ? []
          : [[`[synthetic-id] POST /synthetic-error - ${status}`]],
      );
    },
  );

  it('retains the unknown correlation fallback without logging exception details', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    new GlobalExceptionFilter().catch(
      new Error(privateDetail),
      new ExecutionContextHost([
        { method: 'GET', path: '/synthetic-error' },
        res,
      ]),
    );
    expect(logs).toEqual([['[unknown] GET /synthetic-error - 500']]);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
