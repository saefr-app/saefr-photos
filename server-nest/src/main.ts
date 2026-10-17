import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { setupSwagger } from './openapi/swagger.js';
import { RuntimeConfigError } from './runtime-config.js';

async function bootstrap(): Promise<void> {
  let app: NestFastifyApplication | undefined;

  try {
    const { AppModule } = await import('./app.module.js');

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({
        routerOptions: {
          ignoreTrailingSlash: true,
        },
      }),
      { abortOnError: false },
    );

    app.enableShutdownHooks();

    const config = app.get(ConfigService);

    if (config.getOrThrow<string>('NODE_ENV') !== 'production') {
      setupSwagger(app);
    }

    await app.listen({
      port: config.getOrThrow<number>('PORT'),
      host: config.getOrThrow<string>('HOST'),
    });
  } catch (error: unknown) {
    try {
      await app?.close();
    } catch {
      console.error('Application cleanup failed after startup error');
    }

    if (error instanceof RuntimeConfigError) {
      console.error(error.message);
    } else {
      console.error('Application startup failed');
    }

    process.exitCode = 1;
  }
}

await bootstrap();
