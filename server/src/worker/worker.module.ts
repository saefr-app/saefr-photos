import { Module } from '@nestjs/common';

import { WorkerRuntime } from './worker-runtime.js';

// Deliberately imports neither AppModule nor DatabaseModule/AssetsModule.
@Module({
  providers: [
    { provide: WorkerRuntime, useFactory: () => new WorkerRuntime() },
  ],
  exports: [WorkerRuntime],
})
export class WorkerModule {}
