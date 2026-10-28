import { WorkerRuntime } from '../../dist/worker/worker-runtime.js';

const runtime = new WorkerRuntime(undefined, async () => {
  process.stdout.write('Synthetic test processor held\n');
  await new Promise(() => undefined);
});

process.once('SIGTERM', () => {
  runtime.requestStop();
  void runtime.stop().then(
    (complete) => process.exit(complete ? 0 : 1),
    () => process.exit(1),
  );
});

try {
  await runtime.start();
  await runtime.enqueueSynthetic('held-processor');
} catch {
  process.exit(1);
}
