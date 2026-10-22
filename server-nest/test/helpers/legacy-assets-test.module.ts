import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { resolve } from 'node:path';

import { AssetsModule } from '../../src/assets/assets.module.js';
import { HealthModule } from '../../src/health/health.module.js';
import { SafeHttpExceptionFilter } from '../../src/errors/safe-http-exception.filter.js';
import { validateRuntimeConfig } from '../../src/runtime-config.js';

/** Existing media behavior remains testable without mounting ownerless routes in AppModule. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(process.cwd(), '../.env'),
        resolve(process.cwd(), '.env'),
      ],
      validate: validateRuntimeConfig,
    }),
    AssetsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SafeHttpExceptionFilter }],
})
export class LegacyAssetsTestModule {}
