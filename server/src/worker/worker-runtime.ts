import { Queue, Worker, type Job } from 'bullmq';

import { safeErrorCode } from '../errors/safe-error-code.js';
import {
  SYNTHETIC_JOB,
  SYNTHETIC_SCHEDULER,
  parseSyntheticJob,
  syntheticJob,
  type SyntheticJob,
} from './job-contract.js';
import { type WorkerConfig, workerConfig } from './worker-config.js';

const QUEUE_NAME = 'synthetic-verification';
const SCHEDULE_MS = 60_000;
const SHUTDOWN_MS = 5_000;
const CLOSE_MS = 2_000;
const MAX_PENDING_ENQUEUES = 4;

export interface WorkerDiagnostics {
  state:
    'stopped' | 'starting' | 'ready' | 'degraded' | 'stopping' | 'incomplete';
  processed: number;
  failed: number;
  schedulerRepairs: number;
  lastControlSuccessAt: string | null;
  pendingProducerOperations: number;
  consumerRunning: boolean;
}

export class WorkerRuntime {
  private readonly config: WorkerConfig;
  private queue?: Queue;
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private runTask?: Promise<void>;
  private runTaskFailed = false;
  private stopTask?: Promise<boolean>;
  private producerReset?: Promise<void>;
  private readonly pendingProducer = new Set<Promise<unknown>>();
  private readonly activeProcessors = new Set<Promise<unknown>>();
  private state: WorkerDiagnostics['state'] = 'stopped';
  private stopRequested = false;
  private producerHealthy = false;
  private consumerConnected = false;
  private processed = 0;
  private failed = 0;
  private schedulerRepairs = 0;
  private lastControlSuccessAt: string | null = null;
  private controlBusy = false;
  private lastDegradedLogAt = 0;

  constructor(
    config: WorkerConfig = workerConfig(process.env),
    private readonly processSynthetic: (
      job: SyntheticJob,
    ) => Promise<void> = async () => undefined,
  ) {
    this.config = config;
  }

  diagnostics(): WorkerDiagnostics {
    return {
      state: this.state,
      processed: this.processed,
      failed: this.failed,
      schedulerRepairs: this.schedulerRepairs,
      lastControlSuccessAt: this.lastControlSuccessAt,
      pendingProducerOperations: this.pendingProducer.size,
      consumerRunning: this.worker?.isRunning() ?? false,
    };
  }

  private connection(maxRetriesPerRequest: number | null) {
    return {
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      tls: this.config.tls ? {} : undefined,
      connectTimeout: 2_000,
      maxRetriesPerRequest,
      enableOfflineQueue: maxRetriesPerRequest === null,
      // The consumer's blocking reads must not use producer command deadlines.
      ...(maxRetriesPerRequest === null
        ? {}
        : { commandTimeout: 4_000, socketTimeout: 5_000 }),
      retryStrategy: (attempt: number) =>
        Math.min(100 * 2 ** Math.min(attempt, 5), 2_000),
    };
  }

  private requireStarting(): void {
    if (this.stopRequested || this.state !== 'starting')
      throw new Error('Synthetic worker startup cancelled');
  }

  private refreshHealth(): void {
    if (
      this.state === 'starting' ||
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.state === 'incomplete'
    )
      return;
    this.state =
      this.producerHealthy && this.consumerConnected && this.worker?.isRunning()
        ? 'ready'
        : 'degraded';
  }

  private trackProducer<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() =>
      this.pendingProducer.delete(tracked),
    );
    this.pendingProducer.add(tracked);
    return tracked;
  }

  private createQueue(): Queue {
    const queue = new Queue(QUEUE_NAME, {
      connection: this.connection(1),
      prefix: this.config.prefix,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
    queue.on('error', (error: unknown) => {
      this.producerHealthy = false;
      this.degrade(error);
    });
    return queue;
  }

  private async resetProducer(failed: Queue): Promise<void> {
    if (this.stopRequested || this.queue !== failed) return;
    if (this.producerReset) return this.producerReset;
    this.producerHealthy = false;
    this.producerReset = (async () => {
      let disconnected = false;
      try {
        // Command timeouts alone leave entries in ioredis's commandQueue.
        // Disconnecting flushes them before the producer is replaced.
        const client = await this.withDeadline(failed.client, CLOSE_MS);
        const closing = failed.close();
        client.disconnect();
        try {
          await this.withDeadline(closing, CLOSE_MS);
        } catch {
          // BullMQ's quit may fail after a forced disconnect. The old producer
          // is safe to replace only after ioredis confirms its socket ended.
        }
        disconnected = client.status === 'end';
      } catch {
        this.degrade(new Error('Producer cleanup incomplete'));
        return;
      }
      if (!disconnected) {
        this.degrade(new Error('Producer connection still active'));
        return;
      }
      if (!this.stopRequested && this.queue === failed)
        this.queue = this.createQueue();
    })().finally(() => {
      this.producerReset = undefined;
    });
    return this.producerReset;
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' || this.stopRequested)
      throw new Error('Worker already started or stopping');
    this.state = 'starting';
    try {
      this.queue = this.createQueue();
      await this.withDeadline(this.queue.waitUntilReady(), 5_000);
      this.requireStarting();

      this.worker = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
          const processing = (async () => {
            if (job.name !== SYNTHETIC_JOB)
              throw new Error('Unsupported synthetic job');
            const payload = parseSyntheticJob(job.data);
            await this.processSynthetic(payload);
            this.processed++;
            return { ok: true };
          })();
          this.activeProcessors.add(processing);
          try {
            return await processing;
          } finally {
            this.activeProcessors.delete(processing);
          }
        },
        {
          connection: this.connection(null),
          prefix: this.config.prefix,
          concurrency: this.config.concurrency,
          autorun: false,
          lockDuration: 30_000,
        },
      );
      this.worker.on('error', (error: unknown) => {
        this.consumerConnected = false;
        this.degrade(error);
      });
      this.worker.on('ready', () => {
        this.consumerConnected = true;
        this.refreshHealth();
      });
      this.worker.on('failed', () => {
        this.failed++;
      });
      await this.withDeadline(this.worker.waitUntilReady(), 5_000);
      this.requireStarting();
      this.consumerConnected = true;
      this.runTask = this.worker.run().then(
        () => {
          this.consumerConnected = false;
          if (!this.stopRequested) this.degrade(new Error('Consumer exited'));
        },
        (error: unknown) => {
          this.consumerConnected = false;
          this.runTaskFailed = true;
          this.degrade(error);
        },
      );
      await this.controlTick();
      this.requireStarting();
      if (!this.lastControlSuccessAt)
        throw new Error('Synthetic scheduler unavailable');
      this.timer = setInterval(
        () => void this.controlTick(),
        this.config.controlIntervalMs,
      );
      this.timer.unref();
      this.state = 'degraded';
      this.refreshHealth();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  // The signal handler can cancel startup synchronously while Redis is awaited.
  requestStop(): void {
    this.stopRequested = true;
    if (this.state !== 'stopped' && this.state !== 'incomplete')
      this.state = 'stopping';
  }

  private degrade(error: unknown): void {
    if (
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.state === 'incomplete'
    )
      return;
    this.state = 'degraded';
    const now = Date.now();
    if (now - this.lastDegradedLogAt >= 60_000) {
      console.error(`Synthetic worker degraded; ${safeErrorCode(error)}`);
      this.lastDegradedLogAt = now;
    }
  }

  async controlTick(): Promise<void> {
    if (
      this.controlBusy ||
      this.producerReset ||
      !this.queue ||
      this.stopRequested ||
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.state === 'incomplete'
    )
      return;
    this.controlBusy = true;
    const queue = this.queue;
    try {
      const current = await this.trackProducer(
        queue.getJobScheduler(SYNTHETIC_SCHEDULER),
      );
      if (!current || current.every !== SCHEDULE_MS) {
        await this.trackProducer(
          queue.upsertJobScheduler(
            SYNTHETIC_SCHEDULER,
            { every: SCHEDULE_MS },
            { name: SYNTHETIC_JOB, data: syntheticJob() },
          ),
        );
        this.schedulerRepairs++;
      }
      this.lastControlSuccessAt = new Date().toISOString();
      this.producerHealthy = true;
      if (this.worker?.isRunning()) {
        const [client, blocker] = await Promise.all([
          this.worker.client,
          this.worker.waitUntilReady(),
        ]);
        this.consumerConnected =
          client.status === 'ready' && blocker.status === 'ready';
      }
      this.refreshHealth();
    } catch (error) {
      this.producerHealthy = false;
      this.degrade(error);
      await this.resetProducer(queue);
    } finally {
      this.controlBusy = false;
    }
  }

  async enqueueSynthetic(jobId?: string): Promise<void> {
    if (
      !this.queue ||
      this.producerReset ||
      this.state !== 'ready' ||
      this.stopRequested
    )
      throw new Error('Synthetic queue unavailable');
    if (jobId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(jobId))
      throw new Error('Invalid synthetic job ID');
    if (this.pendingProducer.size >= MAX_PENDING_ENQUEUES)
      throw new Error('Synthetic producer busy');
    const queue = this.queue;
    try {
      await this.trackProducer(
        queue.add(SYNTHETIC_JOB, syntheticJob(), { jobId }),
      );
    } catch {
      this.producerHealthy = false;
      this.degrade(new Error('Producer enqueue failed'));
      await this.resetProducer(queue);
      throw new Error('Synthetic enqueue unavailable');
    }
  }

  async stop(): Promise<boolean> {
    if (this.stopTask) return this.stopTask;
    if (this.state === 'stopped' && !this.queue && !this.worker) return true;
    if (this.state === 'incomplete') return false;
    this.requestStop();
    this.stopTask = this.closeResources();
    return this.stopTask;
  }

  private async closeResources(): Promise<boolean> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const worker = this.worker;
    const queue = this.queue;
    let complete = true;
    if (worker) {
      try {
        // This stops intake immediately. BullMQ close(false) cannot later be
        // upgraded to force, so drain the run loop before calling close(true).
        await this.withDeadline(worker.pause(true), CLOSE_MS);
        if (this.activeProcessors.size)
          await this.withDeadline(
            Promise.allSettled(this.activeProcessors),
            SHUTDOWN_MS,
          );
      } catch {
        complete = false;
      }
      try {
        await this.withDeadline(worker.close(true), CLOSE_MS);
      } catch {
        complete = false;
      }
      try {
        // Force close does not wait for the consumer's run loop. Confirm that
        // it has settled before reporting the runtime as stopped.
        if (this.runTask) await this.withDeadline(this.runTask, CLOSE_MS);
      } catch {
        complete = false;
      }
      if (this.runTaskFailed || worker.isRunning()) complete = false;
      if (this.activeProcessors.size) complete = false;
    }
    try {
      if (this.producerReset)
        await this.withDeadline(this.producerReset, CLOSE_MS);
      if (this.pendingProducer.size)
        await this.withDeadline(
          Promise.allSettled(this.pendingProducer),
          SHUTDOWN_MS,
        );
    } catch {
      complete = false;
    }
    if (queue) {
      try {
        await this.withDeadline(queue.close(), CLOSE_MS);
      } catch {
        complete = false;
        await this.withDeadline(queue.disconnect(), CLOSE_MS).catch(
          () => undefined,
        );
      }
    }
    if (this.pendingProducer.size) complete = false;
    if (complete) {
      this.worker = undefined;
      this.queue = undefined;
      this.state = 'stopped';
    } else {
      this.state = 'incomplete';
      console.error('Synthetic worker shutdown incomplete');
    }
    return complete;
  }

  private async withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Worker operation timed out')),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
