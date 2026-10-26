import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';

import { BoundImageStorageService } from './bound-image-storage.service.js';
import { LinuxPhysicalStorageObserver } from './linux-physical-storage.observer.js';
import { LocalStorageService } from './local-storage.service.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { M12ApplicationReadinessService } from './m12-application-readiness.service.js';
import { SchemaAwareImageStorageService } from './schema-aware-image-storage.service.js';
import { StorageBindingVerifier } from './storage-binding.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
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
    {
      // Preserve the established injection token for M11/component tests.
      // Resolve lazily so unauthenticated requests and health checks do not
      // require schema access during module construction.
      provide: LocalStorageService,
      inject: [DatabaseService, ConfigService, BoundImageStorageService],
      useFactory: (
        database: DatabaseService,
        config: ConfigService,
        bound: BoundImageStorageService,
      ) => new SchemaAwareImageStorageService(database, config, bound),
    },
    M12ApplicationReadinessService,
  ],
  exports: [
    LocalStorageService,
    StorageBindingVerifier,
    LocalStorageProvider,
    BoundImageStorageService,
    M12ApplicationReadinessService,
  ],
})
export class StorageModule {}
