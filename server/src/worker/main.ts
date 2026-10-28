import { NestFactory } from '@nestjs/core';

import { safeErrorCode } from '../errors/safe-error-code.js';
import { WorkerConfigError } from './worker-config.js';
import { WorkerModule } from './worker.module.js';
import { WorkerRuntime } from './worker-runtime.js';

let closing = false;
let runtime: WorkerRuntime | undefined;
let context:
  Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
let starting: Promise<void>;
let shutdownTask: Promise<void> | undefined;

function shutdown(): Promise<void> {
  if (shutdownTask) return shutdownTask;
  closing = true;
  runtime?.requestStop();
  shutdownTask = (async () => {
    // A pending Redis startup must not outlive the signal handler.
    const watchdog = setTimeout(() => {
      console.error('Synthetic worker shutdown deadline exceeded');
      process.exit(1);
    }, 15_000);
    try {
      await starting.catch(() => undefined);
      const complete = await runtime?.stop();
      await context?.close();
      if (complete === false) {
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
  process.once(signal, () => {
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
  const startedRuntime = context.get(WorkerRuntime);
  runtime = startedRuntime;
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
