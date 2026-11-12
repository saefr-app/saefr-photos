import { Module } from '@nestjs/common';

import {
  createMaintenanceRuntime,
  MAINTENANCE_RUNTIME,
} from './maintenance-composition.js';
import type { MaintenanceRuntime } from './maintenance-runtime.js';
import { WorkerRuntime } from './worker-runtime.js';

// Deliberately imports neither AppModule nor DatabaseModule/AssetsModule.
@Module({
  providers: [
    {
      provide: WorkerRuntime,
      inject: [MAINTENANCE_RUNTIME],
      useFactory: (maintenance: MaintenanceRuntime | null) =>
        new WorkerRuntime(undefined, undefined, () => {
          void maintenance?.tick();
        }),
    },
    {
      provide: MAINTENANCE_RUNTIME,
      useFactory: () => createMaintenanceRuntime(process.env),
    },
  ],
  exports: [WorkerRuntime, MAINTENANCE_RUNTIME],
})
export class WorkerModule {}
