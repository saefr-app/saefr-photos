import { Module } from '@nestjs/common';

import { LocalStorageService } from './local-storage.service.js';

@Module({
  providers: [LocalStorageService],
  exports: [LocalStorageService],
})
export class StorageModule {}
