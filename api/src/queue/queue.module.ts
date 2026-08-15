import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ASSET_PROCESSING_QUEUE } from './queue.constants';

/**
 * Owns the Redis connection and the asset-processing queue registration.
 * Imported by whichever module needs to produce (AssetsModule) or consume
 * (AppModule, which hosts the processor) jobs — Nest caches the module so the
 * root BullMQ connection is only configured once.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'redis'),
          port: parseInt(config.get<string>('REDIS_PORT', '6379'), 10),
        },
      }),
    }),
    // No retry/backoff defaults yet — hardening the job itself is a later step;
    // this pass only needs to prove the producer/consumer wiring works.
    BullModule.registerQueue({ name: ASSET_PROCESSING_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
