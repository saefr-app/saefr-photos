// Isolated real-BullMQ probe. Only test continuations are held; production stop is real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { JobScheduler, Worker } from 'bullmq';
import { workerConfig } from '../../dist/worker/worker-config.js';
const { WorkerRuntime } = await import(pathToFileURL(process.argv[2]));
const config = workerConfig(process.env);
const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID;
assert.match(id ?? '', /^[a-f0-9]{64}$/);
const info = JSON.parse(
  execFileSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 5000 }),
)[0];
assert.equal(info.Id, id);
assert.equal(info.Config.Image, 'redis:7.4');
assert.equal(info.Config.Labels['dev.saefr.purpose'], 'm13a-disposable-redis');
assert.ok(info.Config.Cmd.includes(config.password));
assert.ok(info.HostConfig.AutoRemove && info.HostConfig.Tmpfs['/data']);
assert.ok(info.Mounts.every((m) => m.Type === 'tmpfs'));
assert.equal(info.NetworkSettings.Ports['6379/tcp'][0].HostIp, '127.0.0.1');
assert.equal(
  info.NetworkSettings.Ports['6379/tcp'][0].HostPort,
  String(config.port),
);
let release;
const held = new Promise((r) => {
  release = r;
});
let reached;
const pending = new Promise((r) => {
  reached = r;
});
let paused = false;
let closeCalls = 0;
// oxlint-disable-next-line typescript/unbound-method -- Child-only wrapper applies the original receiver explicitly.
const originalSchedule = JobScheduler.prototype.upsertJobScheduler;
JobScheduler.prototype.upsertJobScheduler = async function (...args) {
  if (!paused && args.at(-1)?.override === false) {
    paused = true;
    process.stdout.write('scheduler-held\n');
    reached();
    await held;
  }
  return originalSchedule.apply(this, args);
};
let consumer;
// oxlint-disable-next-line typescript/unbound-method -- Child-only wrapper applies the original receiver explicitly.
const originalRun = Worker.prototype.run;
Worker.prototype.run = function (...args) {
  consumer = this;
  return originalRun.apply(this, args);
};
/** @type {Promise<void> | undefined} */
let pauseTask;
// oxlint-disable-next-line typescript/unbound-method -- Applied to the original receiver.
const originalPause = Worker.prototype.pause;
Worker.prototype.pause = function (...args) {
  pauseTask = originalPause.apply(this, args);
  return pauseTask;
};
// oxlint-disable-next-line typescript/unbound-method -- Child-only wrapper applies the original receiver explicitly.
const originalClose = Worker.prototype.close;
Worker.prototype.close = async function (...args) {
  closeCalls++;
  const result = await originalClose.apply(this, args);
  process.stdout.write('consumer-close-ack\n');
  // Only the negative control reaches close while the scheduler is still held.
  release();
  return result;
};
let handled = 0;
const runtime = new WorkerRuntime(config, async () => {
  handled++;
});
await runtime.start();
process.stdout.write('runtime-ready\n');
await pending;
const result = await runtime.stop();
process.stdout.write('stop-settled\n');
assert.equal(result, false);
assert.equal(runtime.diagnostics().state, 'incomplete');
assert.equal(closeCalls, 0);
assert.equal(await runtime.stop(), false);
release();
for (let i = 0; i < 100 && runtime.diagnostics().consumerRunning; i++)
  await delay(20);
assert.equal(runtime.diagnostics().consumerRunning, false);
assert.equal(handled, 0);
assert.equal(await runtime.stop(), false);
// The draining pause may finish reconnecting the same paused blocker. Await
// that acknowledgement before test-only disposal; no production restart occurs.
assert.ok(pauseTask, 'Draining pause was not observed');
await pauseTask;
await consumer.close(true);
process.stdout.write('drained-without-late-processing\n');
