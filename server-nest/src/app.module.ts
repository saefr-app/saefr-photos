import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { resolve } from 'node:path';

import { AssetsModule } from './assets/assets.module.js';
import { HealthModule } from './health/health.module.js';
import { SafeHttpExceptionFilter } from './errors/safe-http-exception.filter.js';
import { validateRuntimeConfig } from './runtime-config.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(process.cwd(), '../.env'),
        resolve(process.cwd(), '.env'),
      ],
      cache: true,
      validate: validateRuntimeConfig,
    }),
    HealthModule,
    AssetsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SafeHttpExceptionFilter }],
})
export class AppModule {}
