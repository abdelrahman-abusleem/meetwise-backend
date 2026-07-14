import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { configureSwagger } from './swagger/swagger.config';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  app.useGlobalFilters(new GlobalExceptionFilter());
  configureSwagger(app);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
