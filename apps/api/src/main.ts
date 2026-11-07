import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiModule } from './api.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { configureSwagger } from './swagger/swagger.config';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);

  app.use(cookieParser());
  const configService = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: {
        exposeDefaultValues: true,
      },
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: {
        target: false,
        value: false,
      },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  configureSwagger(app, configService);

  const port = configService.getOrThrow<number>('PORT');
  await app.listen(port);
}
void bootstrap();
