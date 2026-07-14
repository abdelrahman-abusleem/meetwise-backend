import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  if (process.env.NODE_ENV === 'production') {
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
