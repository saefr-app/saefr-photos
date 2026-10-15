import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: NestFastifyApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Saefr Photos API')
    .setDescription(
      'REST API for Saefr Photos, a privacy-first, ' +
        'self-hosted photo and video management application.',
    )
    .setVersion('0.1.0')
    .addTag('health', 'Application health and readiness')
    .addTag('assets', 'Photo metadata, uploads and retrieval')
    .build();

  SwaggerModule.setup(
    'docs',
    app,
    () => SwaggerModule.createDocument(app, config),
    {
      jsonDocumentUrl: 'docs-json',
      customSiteTitle: 'Saefr Photos — API Documentation',
    },
  );
}
