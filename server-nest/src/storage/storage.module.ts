import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';

import { BoundImageStorageService } from './bound-image-storage.service.js';
import { LinuxPhysicalStorageObserver } from './linux-physical-storage.observer.js';
import { LocalStorageService } from './local-storage.service.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { StorageBindingVerifier } from './storage-binding.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    LocalStorageService,
    {
      provide: LinuxPhysicalStorageObserver,
      useFactory: () => new LinuxPhysicalStorageObserver(),
    },
    {
      provide: StorageBindingVerifier,
      inject: [DatabaseService, ConfigService, LinuxPhysicalStorageObserver],
      useFactory: (
        database: DatabaseService,
        config: ConfigService,
        observer: LinuxPhysicalStorageObserver,
      ) => new StorageBindingVerifier(database, config, observer),
    },
    {
      provide: LocalStorageProvider,
      inject: [StorageBindingVerifier, ConfigService],
      useFactory: (verifier: StorageBindingVerifier, config: ConfigService) =>
        new LocalStorageProvider(verifier, config),
    },
    {
      provide: BoundImageStorageService,
      inject: [LocalStorageProvider, ConfigService],
      useFactory: (provider: LocalStorageProvider, config: ConfigService) =>
        new BoundImageStorageService(provider, config),
    },
  ],
  exports: [
    LocalStorageService,
    StorageBindingVerifier,
    LocalStorageProvider,
    BoundImageStorageService,
  ],
})
export class StorageModule {}
