import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Server } from 'node:http';
import { configureSwagger } from './swagger.config';

@Controller('swagger-probe')
class SwaggerProbeController {
  @Get()
  probe(): { ready: boolean } {
    return { ready: true };
  }
}

describe('Swagger environment boundary', () => {
  it.each(['development', 'production'])(
    '%s exposes only the intended routes',
    async (environment) => {
      const module = await Test.createTestingModule({
        controllers: [SwaggerProbeController],
      }).compile();
      const app = module.createNestApplication();
      try {
        configureSwagger(app, new ConfigService({ NODE_ENV: environment }));
        await app.init();
        const server = app.getHttpServer() as Server;
        await request(server)
          .get('/swagger-probe')
          .expect(200)
          .expect({ ready: true });
        if (environment === 'production') {
          await request(server).get('/docs').expect(404);
          await request(server).get('/docs-json').expect(404);
          await request(server).get('/docs-yaml').expect(404);
        } else {
          await request(server)
            .get('/docs')
            .expect(200)
            .expect('Content-Type', /html/);
          const response = await request(server).get('/docs-json').expect(200);
          const document = JSON.parse(response.text) as {
            openapi: string;
            paths: Record<string, unknown>;
          };
          expect(document.openapi).toMatch(/^3\./);
          expect(document.paths).toHaveProperty('/swagger-probe');
          await request(server)
            .get('/docs-yaml')
            .expect(200)
            .expect(/openapi: 3/)
            .expect(/swagger-probe:/);
        }
      } finally {
        await app.close();
      }
    },
  );
});
