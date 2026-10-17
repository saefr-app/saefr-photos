import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';

import { AssetsModule } from './assets/assets.module.js';
import { HealthModule } from './health/health.module.js';
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
})
export class AppModule {}
