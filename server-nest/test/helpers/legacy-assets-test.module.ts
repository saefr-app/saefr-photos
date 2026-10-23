import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { AssetsModule } from '../../src/assets/assets.module.js';
import { AuthModule } from '../../src/auth/auth.module.js';
import { HealthModule } from '../../src/health/health.module.js';
import { SafeHttpExceptionFilter } from '../../src/errors/safe-http-exception.filter.js';
import { validateRuntimeConfig } from '../../src/runtime-config.js';

/** Isolated asset composition; production AppModule never mounts these routes. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateRuntimeConfig,
    }),
    AssetsModule,
    AuthModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SafeHttpExceptionFilter }],
})
export class LegacyAssetsTestModule {}
