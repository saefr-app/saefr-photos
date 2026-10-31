import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RedisRecoveryDelivery,
  createRecoveryQueue,
  type RecoveryProducerQueue,
} from '../src/worker/redis-recovery-delivery.js';
import {
  RECOVERY_JOB,
  RECOVERY_QUEUE,
  recoveryJobId,
  type RecoveryHint,
} from '../src/worker/recovery-delivery-contract.js';
import type { WorkerConfig } from '../src/worker/worker-config.js';
import {
  disposableRedis,
  wipeDisposableRedis,
  restartDisposableRedis,
} from './helpers/disposable-redis.js';

async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Disposable delivery condition not reached');
}

describe('bounded recovery delivery on disposable Redis', () => {
  let config: WorkerConfig;
  let queue: RecoveryProducerQueue;
  let delivery: RedisRecoveryDelivery;
  const hint = (): RecoveryHint => ({
    version: 1,
    asset_id: randomUUID(),
    generation: '1',
  });

  beforeEach(async () => {
    config = {
      ...disposableRedis().config,
      prefix: `${process.env.SAEFR_REDIS_PREFIX}:delivery_${randomUUID()}`,
    };
    queue = createRecoveryQueue(config);
    await queue.waitUntilReady();
    delivery = new RedisRecoveryDelivery(config);
  });
  afterEach(async () => {
    expect(await delivery?.close()).toBe(true);
    await queue?.stopProducer();
  });

  it('deduplicates opaque hints without running a processor and bounds retained job options', async () => {
    const value = hint();
    expect((await delivery.enqueue(value)).status).toBe('queued');
    expect((await delivery.enqueue(value)).status).toBe('queued');
    const job = await queue.getJob(recoveryJobId(value));
    expect(job?.data).toEqual(value);
    expect(job?.opts).toMatchObject({
      attempts: 1,
      removeOnComplete: { count: 100, age: 86400 },
      removeOnFail: { count: 100, age: 86400 },
    });
    expect(await queue.getWaitingCount()).toBe(1);
    expect(await queue.getActiveCount()).toBe(0);
  });

  it('rejects a conflicting persisted payload and never overwrites it', async () => {
    const value = hint();
    await queue.add(
      RECOVERY_JOB,
      { ...value, path: '/synthetic-private' },
      { jobId: recoveryJobId(value) },
    );
    expect((await delivery.inspect(value)).status).toBe('conflict');
    expect((await delivery.enqueue(value)).status).toBe('conflict');
    expect((await queue.getJob(recoveryJobId(value)))?.data).toHaveProperty(
      'path',
    );
  });

  it('recovers a real enqueue with a lost acknowledgement without creating a second job', async () => {
    const value = hint();
    let once = true;
    const factory = () => {
      const real = createRecoveryQueue(config);
      return new Proxy(real, {
        get(target, key) {
          if (key === 'add')
            return async (...args: Parameters<typeof target.add>) => {
              const job = await target.add(...args);
              if (once) {
                once = false;
                throw new Error(
                  'Synthetic lost enqueue acknowledgement with private credentials',
                );
              }
              return job;
            };
          const property = Reflect.get(target, key);
          return typeof property === 'function'
            ? property.bind(target)
            : property;
        },
      });
    };
    await delivery.close();
    delivery = new RedisRecoveryDelivery(config, factory);
    expect(await delivery.enqueue(value)).toEqual({ status: 'uncertain' });
    expect((await delivery.inspect(value)).status).toBe('queued');
    expect((await delivery.enqueue(value)).status).toBe('queued');
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('rechecks a job that disappears between inspection and enqueue', async () => {
    const value = hint();
    await delivery.enqueue(value);
    expect((await delivery.inspect(value)).status).toBe('queued');
    await (await queue.getJob(recoveryJobId(value)))!.remove();
    expect((await delivery.enqueue(value)).status).toBe('queued');
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('reports retained completed and failed deliveries without interpreting them as authority', async () => {
    const good = hint();
    const bad = hint();
    const worker = new Worker(
      RECOVERY_QUEUE,
      async (job) => {
        if (job.data.asset_id === bad.asset_id)
          throw new Error('Synthetic failure');
        return { synthetic: true };
      },
      {
        prefix: config.prefix,
        connection: {
          host: config.host,
          port: config.port,
          password: config.password,
          maxRetriesPerRequest: null,
        },
      },
    );
    worker.on('error', () => undefined);
    try {
      await delivery.enqueue(good);
      await delivery.enqueue(bad);
      await eventually(
        async () =>
          (await queue.getJob(recoveryJobId(good)))
            ?.getState()
            .then((state) => state === 'completed') ?? false,
      );
      await eventually(
        async () =>
          (await queue.getJob(recoveryJobId(bad)))
            ?.getState()
            .then((state) => state === 'failed') ?? false,
      );
      expect((await delivery.inspect(good)).status).toBe('terminal');
      expect((await delivery.inspect(bad)).status).toBe('terminal');
      expect((await delivery.enqueue(good)).status).toBe('terminal');
    } finally {
      await worker.close();
    }
  });

  it('recovers hints after verified Redis data loss and restart', async () => {
    const value = hint();
    await delivery.enqueue(value);
    wipeDisposableRedis();
    expect((await delivery.inspect(value)).status).toBe('missing');
    expect((await delivery.enqueue(value)).status).toBe('queued');
    await restartDisposableRedis();
    disposableRedis();
    // The disposable Redis intentionally has no persistence; reconstruction
    // uses the same durable generation, never a Redis-derived authority.
    await eventually(
      async () => (await delivery.inspect(value)).status === 'missing',
    );
    expect((await delivery.enqueue(value)).status).toBe('queued');
  }, 20000);

  it('bounds silent commands and refuses another operation until the old producer settles', async () => {
    const value = hint();
    await delivery.enqueue(value);
    const { id } = disposableRedis();
    execFileSync('docker', ['pause', id], { timeout: 5000 });
    try {
      const pending = delivery.inspect(value);
      expect((await delivery.inspect(value)).status).toBe('uncertain');
      expect((await pending).status).toBe('uncertain');
    } finally {
      execFileSync('docker', ['unpause', id], { timeout: 5000 });
    }
    await eventually(
      async () => (await delivery.inspect(value)).status === 'queued',
    );
  }, 20000);
});
