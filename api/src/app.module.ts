import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { Asset } from './entities/asset.entity';
import { Library } from './entities/library.entity';
import { LibraryMembership } from './entities/library-membership.entity';
import { User } from './entities/user.entity';
import { AssetProcessingProcessor } from './processing/asset-processing.processor';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST', 'postgres'),
        port: parseInt(config.get<string>('DB_PORT', '5432'), 10),
        username: config.get<string>('DB_USERNAME'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_DATABASE'),
        entities: [User, Library, LibraryMembership, Asset],
        // Auto-creates/updates tables from the entity definitions. Deliberate,
        // known, and temporary — pre-production convenience only. This must be
        // replaced with real TypeORM migrations before anything runs for real,
        // since synchronize can silently drop columns.
        synchronize: true,
      }),
    }),
    AuthModule,
    AssetsModule,
    // Imported here so the queue consumer below shares the same Redis
    // connection as the producer in AssetsService.
    QueueModule,
    TypeOrmModule.forFeature([Asset]),
  ],
  // The BullMQ consumer lives in this module, alongside the HTTP server, as a
  // plain provider. One process, one main.ts, one app.module.ts — no separate
  // worker container and no second bootstrap.
  providers: [AssetProcessingProcessor],
})
export class AppModule {}
