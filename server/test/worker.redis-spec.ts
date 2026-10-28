import { Queue } from 'bullmq';
import { execFile as callback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SYNTHETIC_JOB,
  SYNTHETIC_SCHEDULER,
} from '../src/worker/job-contract.js';
import { workerConfig } from '../src/worker/worker-config.js';
import { WorkerRuntime } from '../src/worker/worker-runtime.js';

const port = process.env.SAEFR_REDIS_PORT;
const password = process.env.SAEFR_REDIS_PASSWORD;
const prefix = process.env.SAEFR_REDIS_PREFIX;
if (
  !process.env.SAEFR_REDIS_TEST_CONTAINER_ID ||
  !port ||
  !password ||
  !prefix
) {
  throw new Error('Disposable Redis runner required');
}

const connection = {
  host: '127.0.0.1',
  port: Number(port),
  password,
  maxRetriesPerRequest: 1,
};
const queue = new Queue('synthetic-verification', { connection, prefix });
const runtimes: WorkerRuntime[] = [];
const execFile = promisify(callback);

async function docker(...args: string[]) {
  return execFile('docker', args, { timeout: 15_000 });
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Synthetic worker condition was not reached');
}

beforeAll(async () => {
  await queue.waitUntilReady();
});
afterAll(async () => {
  for (const runtime of runtimes.reverse()) await runtime.stop();
  await queue.close();
});

describe('disposable Redis and BullMQ foundation', () => {
  it('refuses unavailable Redis on startup without an HTTP or database dependency', async () => {
    const original = process.env.SAEFR_REDIS_PORT;
    process.env.SAEFR_REDIS_PORT = '1';
    const runtime = new WorkerRuntime();
    process.env.SAEFR_REDIS_PORT = original;
    await expect(runtime.start()).rejects.toThrow();
    expect(runtime.diagnostics().state).toBe('stopped');
  }, 15_000);

  it('processes synthetic work, handles duplicates, and rejects malformed jobs', async () => {
    const handled: string[] = [];
    const runtime = new WorkerRuntime(
      workerConfig(process.env),
      async (job) => {
        handled.push(job.nonce);
      },
    );
    runtimes.push(runtime);
    await runtime.start();
    await runtime.enqueueSynthetic('duplicate-one');
    const first = await queue.getJob('duplicate-one');
    expect(first).toBeDefined();
    await runtime.enqueueSynthetic('duplicate-one');
    await eventually(async () => (await first?.getState()) === 'completed');
    const duplicate = await queue.getJob('duplicate-one');
    expect(duplicate).toBeDefined();
    expect(duplicate?.data).toEqual(first?.data);
    expect(handled.filter((nonce) => nonce === first?.data.nonce)).toHaveLength(
      1,
    );
    await queue.add(
      SYNTHETIC_JOB,
      { version: 1, nonce: 'bad', path: '/private/photo' },
      { jobId: 'invalid-payload', attempts: 1 },
    );
    await eventually(() => runtime.diagnostics().failed >= 1);
    const failed = await queue.getJob('invalid-payload');
    expect(failed?.failedReason).toBe('Invalid synthetic job');
    expect(failed?.failedReason).not.toContain('/private/photo');
    const stale = await queue.add(
      SYNTHETIC_JOB,
      { version: 0, nonce: first?.data.nonce },
      { jobId: 'stale-delayed', delay: 750, attempts: 1 },
    );
    expect(await stale.getState()).toBe('delayed');
    await eventually(async () => (await stale.getState()) === 'failed');
    expect((await queue.getJob('stale-delayed'))?.failedReason).toBe(
      'Invalid synthetic job',
    );
  });

  it('repairs a missing scheduler while running and on restart', async () => {
    const runtime = runtimes[0];
    expect(await queue.getJobScheduler(SYNTHETIC_SCHEDULER)).toBeDefined();
    await queue.removeJobScheduler(SYNTHETIC_SCHEDULER);
    expect(await queue.getJobScheduler(SYNTHETIC_SCHEDULER)).toBeUndefined();
    await eventually(
      async () =>
        (await queue.getJobScheduler(SYNTHETIC_SCHEDULER)) !== undefined,
    );
    expect(runtime.diagnostics().schedulerRepairs).toBeGreaterThanOrEqual(2);
    await runtime.stop();
    const restarted = new WorkerRuntime();
    runtimes.push(restarted);
    await restarted.start();
    await restarted.enqueueSynthetic('after-restart');
    await eventually(() => restarted.diagnostics().processed >= 1);
    expect(await restarted.stop()).toBe(true);
  });

  it('degrades during a verified Redis pause and repairs after resumption', async () => {
    const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID!;
    const info = JSON.parse((await docker('inspect', id)).stdout)[0];
    expect(info.Id).toBe(id);
    expect(info.Config.Labels['dev.saefr.purpose']).toBe(
      'm13a-disposable-redis',
    );
    const runtime = new WorkerRuntime();
    runtimes.push(runtime);
    await runtime.start();
    await docker('pause', id);
    try {
      await runtime.controlTick();
      await eventually(
        () => runtime.diagnostics().state === 'degraded',
        10_000,
      );
    } finally {
      await docker('unpause', id);
    }
    await eventually(() => runtime.diagnostics().state === 'ready', 12_000);
    expect(await runtime.stop()).toBe(true);
  }, 30_000);

  it('bounds silent Redis commands and repeated enqueues through producer settlement', async () => {
    const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID!;
    const runtime = new WorkerRuntime();
    runtimes.push(runtime);
    await runtime.start();
    const oldQueue = (runtime as unknown as { queue: Queue }).queue;
    const producer = await oldQueue.client;
    await docker('pause', id);
    try {
      const check = runtime.controlTick();
      await eventually(
        () => runtime.diagnostics().pendingProducerOperations > 0,
      );
      const pending = Array.from({ length: 12 }, (_, index) =>
        runtime.enqueueSynthetic(`silent-${index}`).then(
          () => 'accepted',
          () => 'rejected',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(
        runtime.diagnostics().pendingProducerOperations,
      ).toBeLessThanOrEqual(4);
      expect(
        (producer as unknown as { commandQueue: { length: number } })
          .commandQueue.length,
      ).toBeLessThanOrEqual(4);
      await Promise.all(pending);
      await check;
      await eventually(
        () => runtime.diagnostics().pendingProducerOperations === 0,
        10_000,
      );
      await eventually(
        () =>
          (producer as unknown as { commandQueue: { length: number } })
            .commandQueue.length === 0,
        3_000,
      );
      expect(runtime.diagnostics().state).toBe('degraded');
    } finally {
      await docker('unpause', id);
    }
    await eventually(() => runtime.diagnostics().state === 'ready', 12_000);
    expect(await runtime.stop()).toBe(true);
  }, 30_000);

  it('closes silent Redis producer commands and reports unsettled consumer shutdown', async () => {
    const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID!;
    const runtime = new WorkerRuntime({
      ...workerConfig(process.env),
      prefix: `${prefix}_silent_stop`,
    });
    runtimes.push(runtime);
    await runtime.start();
    const producer = await (runtime as unknown as { queue: Queue }).queue
      .client;
    await docker('pause', id);
    const pending = Array.from({ length: 3 }, (_, index) =>
      runtime.enqueueSynthetic(`stop-silent-${index}`).catch(() => undefined),
    );
    try {
      await eventually(
        () => runtime.diagnostics().pendingProducerOperations > 0,
      );
      expect(await runtime.stop()).toBe(false);
      expect(runtime.diagnostics().state).toBe('incomplete');
      expect(runtime.diagnostics().pendingProducerOperations).toBe(0);
      await eventually(
        () =>
          (producer as unknown as { commandQueue: { length: number } })
            .commandQueue.length === 0,
        3_000,
      );
    } finally {
      await docker('unpause', id);
      await Promise.all(pending);
    }
  }, 20_000);

  it('cancels startup before readiness without installing a control timer', async () => {
    const runtime = new WorkerRuntime();
    const starting = runtime.start();
    runtime.requestStop();
    await expect(starting).rejects.toThrow('startup cancelled');
    expect(runtime.diagnostics().state).toBe('stopped');
    expect(runtime.diagnostics().consumerRunning).toBe(false);
  });

  it('keeps degraded status when the consumer is stopped but Redis scheduler queries work', async () => {
    const runtime = new WorkerRuntime();
    runtimes.push(runtime);
    await runtime.start();
    const consumer = (
      runtime as unknown as {
        worker: {
          close: (force: boolean) => Promise<void>;
          isRunning: () => boolean;
        };
      }
    ).worker;
    await consumer.close(true);
    await eventually(() => !consumer.isRunning());
    await runtime.controlTick();
    expect(runtime.diagnostics().state).toBe('degraded');
    expect(runtime.diagnostics().consumerRunning).toBe(false);
    await runtime.stop();
  });

  it('reports incomplete shutdown after a processor exceeds the grace deadline', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = new WorkerRuntime(
      { ...workerConfig(process.env), prefix: `${prefix}_held` },
      async () => {
        entered();
        await held;
      },
    );
    runtimes.push(runtime);
    await runtime.start();
    await runtime.enqueueSynthetic('shutdown-over-grace');
    await processing;
    try {
      expect(await runtime.stop()).toBe(false);
      expect(runtime.diagnostics().state).toBe('incomplete');
    } finally {
      release();
    }
  }, 15_000);

  it('bounds shutdown with Redis unavailable and outstanding synthetic work', async () => {
    const id = process.env.SAEFR_REDIS_TEST_CONTAINER_ID!;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = new WorkerRuntime(
      { ...workerConfig(process.env), prefix: `${prefix}_outage` },
      async () => {
        entered();
        await held;
      },
    );
    runtimes.push(runtime);
    await runtime.start();
    await runtime.enqueueSynthetic('shutdown-redis-unavailable');
    await processing;
    await docker('pause', id);
    try {
      expect(await runtime.stop()).toBe(false);
      expect(runtime.diagnostics().state).toBe('incomplete');
    } finally {
      await docker('unpause', id);
      release();
    }
  }, 20_000);

  it('bounds concurrent synthetic work and waits for it during graceful stop', async () => {
    await runtimes.at(-1)!.stop();
    let active = 0;
    let maximum = 0;
    const runtime = new WorkerRuntime(
      { ...workerConfig(process.env), concurrency: 2 },
      async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        active--;
      },
    );
    runtimes.push(runtime);
    await runtime.start();
    for (let index = 0; index < 6; index++)
      await runtime.enqueueSynthetic(`bounded-${index}`);
    await eventually(() => runtime.diagnostics().processed >= 6);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(maximum).toBeGreaterThanOrEqual(1);
    await runtime.stop();
    expect(active).toBe(0);
    expect(runtime.diagnostics().state).toBe('stopped');
  });

  it('waits for an in-flight synthetic processor during graceful shutdown', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = new WorkerRuntime(workerConfig(process.env), async () => {
      entered();
      await held;
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.enqueueSynthetic('shutdown-held');
    await processing;
    let closed = false;
    const stopping = runtime.stop().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    release();
    await stopping;
    expect(closed).toBe(true);
  }, 10_000);

  it('retains at most 100 completed synthetic jobs in an isolated queue', async () => {
    const isolatedPrefix = `${prefix}_retention`;
    const isolatedQueue = new Queue('synthetic-verification', {
      connection,
      prefix: isolatedPrefix,
    });
    const runtime = new WorkerRuntime({
      ...workerConfig(process.env),
      prefix: isolatedPrefix,
    });
    runtimes.push(runtime);
    try {
      await runtime.start();
      for (let index = 0; index < 110; index++)
        await runtime.enqueueSynthetic(`retained-${index}`);
      await eventually(
        async () =>
          (await (await isolatedQueue.getJob('retained-109'))?.getState()) ===
          'completed',
        12_000,
      );
      expect(await isolatedQueue.getCompletedCount()).toBeLessThanOrEqual(100);
      expect(await isolatedQueue.getJob('retained-0')).toBeUndefined();
    } finally {
      await runtime.stop();
      await isolatedQueue.close();
    }
  }, 20_000);

  it('starts a separate worker process without HTTP or database config and exits on SIGTERM', async () => {
    const child = spawn(process.execPath, ['dist/worker/main.js'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        SAEFR_REDIS_HOST: '127.0.0.1',
        SAEFR_REDIS_PORT: port,
        SAEFR_REDIS_PASSWORD: password,
        SAEFR_REDIS_PREFIX: `${prefix}_process`,
        SAEFR_WORKER_CONTROL_INTERVAL_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    try {
      await eventually(() => output.includes('Synthetic worker ready'), 10_000);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(output).not.toContain(password);
      expect(output).not.toContain('POSTGRES_');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15_000);

  it('keeps the real process shutdown deadline through a late handle and repeated signals', async () => {
    const child = spawn(process.execPath, ['dist/worker/main.js'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--require=${process.cwd()}/test/helpers/worker-late-handle.cjs`,
        SAEFR_REDIS_HOST: '127.0.0.1',
        SAEFR_REDIS_PORT: port,
        SAEFR_REDIS_PASSWORD: password,
        SAEFR_REDIS_PREFIX: `${prefix}_late_handle`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    let hardKill: NodeJS.Timeout | undefined;
    try {
      await eventually(() => output.includes('Synthetic worker ready'), 10_000);
      const signaledAt = Date.now();
      hardKill = setTimeout(() => child.kill('SIGKILL'), 19_000);
      child.kill('SIGTERM');
      await eventually(
        () => output.includes('Synthetic test late handle armed'),
        5_000,
      );
      child.kill('SIGINT');
      expect(await exited).toBe(1);
      expect(Date.now() - signaledAt).toBeLessThan(18_000);
      expect(output).toContain('Synthetic worker shutdown deadline exceeded');
      expect(output.match(/shutdown deadline exceeded/g)).toHaveLength(1);
      expect(output).not.toContain(password);
    } finally {
      if (hardKill) clearTimeout(hardKill);
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
  }, 25_000);

  it('exits nonzero when an unresolved synthetic processor exceeds shutdown grace', async () => {
    const child = spawn(
      process.execPath,
      ['test/helpers/worker-held-processor.mjs'],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          SAEFR_REDIS_HOST: '127.0.0.1',
          SAEFR_REDIS_PORT: port,
          SAEFR_REDIS_PASSWORD: password,
          SAEFR_REDIS_PREFIX: `${prefix}_held_process`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    let hardKill: NodeJS.Timeout | undefined;
    try {
      await eventually(
        () => output.includes('Synthetic test processor held'),
        10_000,
      );
      const signaledAt = Date.now();
      hardKill = setTimeout(() => child.kill('SIGKILL'), 12_000);
      child.kill('SIGTERM');
      expect(await exited).toBe(1);
      expect(Date.now() - signaledAt).toBeLessThan(11_000);
      expect(output).toContain('Synthetic worker shutdown incomplete');
      expect(output).not.toContain(password);
    } finally {
      if (hardKill) clearTimeout(hardKill);
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
  }, 20_000);

  it('terminates a real worker process signaled before Redis startup finishes', async () => {
    const child = spawn(process.execPath, ['dist/worker/main.js'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        SAEFR_REDIS_HOST: '127.0.0.1',
        SAEFR_REDIS_PORT: '1',
        SAEFR_REDIS_PREFIX: `${prefix}_starting`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    try {
      await eventually(() => output.includes('Synthetic worker starting'));
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(output).not.toContain('Synthetic worker ready');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 12_000);
});
