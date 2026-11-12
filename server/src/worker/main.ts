import { NestFactory } from '@nestjs/core';

import { safeErrorCode } from '../errors/safe-error-code.js';
import { WorkerConfigError } from './worker-config.js';
import { WorkerModule } from './worker.module.js';
import { WorkerRuntime } from './worker-runtime.js';
import { MAINTENANCE_RUNTIME } from './maintenance-composition.js';
import type { MaintenanceRuntime } from './maintenance-runtime.js';

let closing = false;
let runtime: WorkerRuntime | undefined;
let context:
  Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
let starting: Promise<void>;
let maintenance: MaintenanceRuntime | null = null;
let syntheticTask: Promise<void> | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let cancelRetry: (() => void) | undefined;
let shutdownTask: Promise<void> | undefined;

function shutdown(): Promise<void> {
  if (shutdownTask) return shutdownTask;
  closing = true;
  runtime?.requestStop();
  maintenance?.requestStop();
  clearTimeout(retryTimer);
  cancelRetry?.();
  shutdownTask = (async () => {
    // A pending Redis startup must not outlive the signal handler.
    const watchdog = setTimeout(() => {
      console.error('Synthetic worker shutdown deadline exceeded');
      process.exit(1);
    }, 15_000);
    try {
      await starting.catch(() => undefined);
      const [complete, metadataComplete] = await Promise.all([
        runtime?.stop(),
        maintenance?.stop(),
      ]);
      await syntheticTask;
      await context?.close();
      if (complete === false || metadataComplete === false) {
        process.exitCode = 1;
        // A pending synthetic callback or socket may still hold the event loop.
        process.exit(1);
      }
      // BullMQ can install a late timer after close() resolves. Keep the
      // deadline alive through shutdown, then allow natural successful exit.
      watchdog.unref();
    } catch (error) {
      console.error(
        `Synthetic worker shutdown failed; ${safeErrorCode(error)}`,
      );
      process.exit(1);
    }
  })();
  return shutdownTask;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

console.log('Synthetic worker starting');
starting = (async () => {
  context = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });
  if (closing) return;
  maintenance = context.get<MaintenanceRuntime | null>(MAINTENANCE_RUNTIME);
  maintenance?.start();
  if (maintenance) console.log('Maintenance metadata runtime started');
  const startedRuntime = context.get(WorkerRuntime);
  runtime = startedRuntime;
  if (maintenance) {
    // Database maintenance starts before Redis; failed synthetic startup cannot gate it.
    syntheticTask = (async () => {
      let candidate = startedRuntime;
      while (!closing) {
        runtime = candidate;
        try {
          await candidate.start();
          if (!closing) console.log('Synthetic worker ready');
          return;
        } catch {
          if (closing) return;
          if (!(await candidate.stop()))
            throw new Error('Synthetic worker cleanup incomplete');
          console.error('Synthetic worker startup unavailable; retry deferred');
          await new Promise<void>((resolve) => {
            cancelRetry = resolve;
            retryTimer = setTimeout(resolve, 5000);
          });
          cancelRetry = undefined;
          if (!closing)
            candidate = new WorkerRuntime(undefined, undefined, () => {
              void maintenance?.tick();
            });
        }
      }
    })();
    void syntheticTask.catch(() => {
      process.exitCode = 1;
      void shutdown();
    });
    return;
  }
  try {
    await startedRuntime.start();
  } catch (error) {
    if (closing) return;
    throw error;
  }
  if (!closing) console.log('Synthetic worker ready');
})();

void starting.catch(async (error: unknown) => {
  console.error(
    error instanceof WorkerConfigError
      ? error.message
      : `Synthetic worker startup failed; ${safeErrorCode(error)}`,
  );
  process.exitCode = 1;
  await shutdown();
});
