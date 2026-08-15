import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../entities/asset.entity';
import { LibraryMembership } from '../entities/library-membership.entity';
import { QueueModule } from '../queue/queue.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, LibraryMembership]), QueueModule],
  controllers: [AssetsController],
  providers: [AssetsService],
})
export class AssetsModule {}
