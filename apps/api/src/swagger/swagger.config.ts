import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NodeEnvironment } from '@meetwise/infrastructure/config';

export function configureSwagger(
  app: INestApplication,
  configService: ConfigService,
): void {
  if (configService.get('NODE_ENV') === NodeEnvironment.PRODUCTION) {
    return;
  }

  const config = new DocumentBuilder()
    .setTitle('Meetwise API')
    .setDescription(
      'API documentation for the Meetwise meeting-to-execution platform',
    )
    .setVersion('0.0.1')
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, documentFactory, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
