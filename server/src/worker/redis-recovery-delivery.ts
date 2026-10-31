import { Queue, type Job } from 'bullmq';
import { InitializationSafeRedisConnection } from './initialization-safe-redis-connection.js';
import {
  RECOVERY_JOB,
  RECOVERY_QUEUE,
  parseRecoveryHint,
  recoveryJobId,
  type RecoveryHint,
} from './recovery-delivery-contract.js';
import type { WorkerConfig } from './worker-config.js';

export type RedisDeliveryResult = {
  status: 'missing' | 'queued' | 'terminal' | 'conflict' | 'uncertain';
};

export class RecoveryProducerQueue extends Queue {
  /** The injected connection settles initialization before removing its error listeners. */
  async stopProducer(): Promise<void> {
    this.closing ??= this.connection.close(true);
    await this.closing;
    this.closed = true;
  }
}

export function createRecoveryQueue(
  config: WorkerConfig,
): RecoveryProducerQueue {
  const queue = new RecoveryProducerQueue(
    RECOVERY_QUEUE,
    {
      prefix: config.prefix,
      connection: {
        host: config.host,
        port: config.port,
        password: config.password,
        tls: config.tls ? {} : undefined,
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 4000,
        socketTimeout: 5000,
        retryStrategy: (attempt) => (attempt > 1 ? null : 100),
      },
      defaultJobOptions: {
        attempts: 1,
        sizeLimit: 512,
        removeOnComplete: { count: 100, age: 86400 },
        removeOnFail: { count: 100, age: 86400 },
      },
    },
    InitializationSafeRedisConnection,
  );
  // Never log ioredis errors: they may contain target/credential details.
  queue.on('error', () => undefined);
  return queue;
}

async function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Recovery delivery unavailable')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded producer only. It neither creates a Worker nor establishes execution authority. */
export class RedisRecoveryDelivery {
  private queue?: RecoveryProducerQueue;
  private active?: Promise<RedisDeliveryResult>;
  private closed = false;
  private quarantined = false;

  constructor(
    config: WorkerConfig,
    private readonly factory: () => RecoveryProducerQueue = () =>
      createRecoveryQueue(config),
  ) {}

  inspect(hint: RecoveryHint): Promise<RedisDeliveryResult> {
    parseRecoveryHint(hint);
    return this.operation(async (queue) =>
      this.classify(await queue.getJob(recoveryJobId(hint)), hint),
    );
  }

  enqueue(hint: RecoveryHint): Promise<RedisDeliveryResult> {
    parseRecoveryHint(hint);
    return this.operation(async (queue) => {
      const existing = await this.classify(
        await queue.getJob(recoveryJobId(hint)),
        hint,
      );
      if (existing.status !== 'missing') return existing;
      await queue.add(RECOVERY_JOB, hint, { jobId: recoveryJobId(hint) });
      // BullMQ's returned Job can describe the supplied data even when a
      // competing producer won this ID. Read the persisted payload back.
      const stored = await this.classify(
        await queue.getJob(recoveryJobId(hint)),
        hint,
      );
      return stored.status === 'missing' ? { status: 'uncertain' } : stored;
    });
  }

  async close(): Promise<boolean> {
    this.closed = true;
    const queue = this.queue;
    if (!queue) return !this.active;
    return this.discard(queue, this.active);
  }

  private async classify(
    job: Job | undefined,
    expected: RecoveryHint,
  ): Promise<RedisDeliveryResult> {
    if (!job) return { status: 'missing' };
    try {
      const hint = parseRecoveryHint(job.data);
      if (
        job.name !== RECOVERY_JOB ||
        job.id !== recoveryJobId(expected) ||
        hint.asset_id !== expected.asset_id ||
        hint.generation !== expected.generation
      )
        return { status: 'conflict' };
    } catch {
      return { status: 'conflict' };
    }
    const state = await job.getState();
    if (state === 'completed' || state === 'failed')
      return { status: 'terminal' };
    if (state === 'unknown') return { status: 'missing' };
    return { status: 'queued' };
  }

  private async operation(
    action: (queue: Queue) => Promise<RedisDeliveryResult>,
  ): Promise<RedisDeliveryResult> {
    // One outstanding producer operation per adapter, including timed-out work.
    if (this.closed || this.active || this.quarantined)
      return { status: 'uncertain' };
    let queue: RecoveryProducerQueue;
    try {
      queue = this.queue ??= this.factory();
    } catch {
      return { status: 'uncertain' };
    }
    const task = Promise.resolve().then(() => action(queue));
    this.active = task;
    let settled = false;
    let returned = false;
    const onSettled = () => {
      settled = true;
      if (returned && this.active === task) this.active = undefined;
    };
    void task.then(onSettled, onSettled);
    try {
      return await deadline(task, 6000);
    } catch {
      // A rejected command promise does not prove its underlying socket stopped.
      await this.discard(queue, task);
      return { status: 'uncertain' };
    } finally {
      returned = true;
      // A timeout alone cannot free capacity or create another producer.
      if (settled) this.active = undefined;
    }
  }

  private async discard(
    queue: RecoveryProducerQueue,
    task?: Promise<unknown>,
  ): Promise<boolean> {
    // Retain capacity after a local timeout. Only positive retirement plus
    // settlement of the old command may release it, including late evidence.
    this.quarantined = true;
    const disposed = Promise.all([
      queue.stopProducer(),
      task?.catch(() => undefined),
    ]).then(
      () => {
        if (this.queue === queue) {
          this.queue = undefined;
          this.quarantined = false;
        }
        return true;
      },
      () => false,
    );
    try {
      return await deadline(disposed, 2000);
    } catch {
      return false;
    }
  }
}
