import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';

import { RuntimeConfigError } from './runtime-config.js';
import { safeErrorCode } from './errors/safe-error-code.js';
import { registerAssetAccess } from './auth/asset-lockdown.js';
import { AuthSessionService } from './auth/auth-session.service.js';
import { createHttpAdapter } from './http-adapter.js';

async function bootstrap(): Promise<void> {
  let app: NestFastifyApplication | undefined;

  try {
    const { AppModule } = await import('./app.module.js');

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      createHttpAdapter(),
      { abortOnError: false },
    );

    app.enableShutdownHooks();
    registerAssetAccess(app);

    const config = app.get(ConfigService);

    // Swagger is disabled by default during the M10 authorization transition.

    await app.get(AuthSessionService).assertReady();

    await app.listen({
      port: config.getOrThrow<number>('PORT'),
      host: config.getOrThrow<string>('HOST'),
    });
  } catch (error: unknown) {
    try {
      await app?.close();
    } catch (cleanupError: unknown) {
      console.error(
        `Application cleanup failed after startup error; ${safeErrorCode(cleanupError)}`,
      );
    }

    if (error instanceof RuntimeConfigError) {
      console.error(error.message);
    } else {
      console.error(`Application startup failed; ${safeErrorCode(error)}`);
    }

    process.exitCode = 1;
  }
}

await bootstrap();
