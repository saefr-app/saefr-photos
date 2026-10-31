import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisConnection } from 'bullmq';
import { disposableRedis } from './helpers/disposable-redis.js';
import {
  createRecoveryQueue,
  RedisRecoveryDelivery,
  type RecoveryProducerQueue,
} from '../src/worker/redis-recovery-delivery.js';

async function schedulerProbe(module: string) {
  disposableRedis();
  const child = spawn(
    process.execPath,
    ['test/helpers/worker-scheduler-drain-child.mjs', module],
    {
      env: {
        ...process.env,
        SAEFR_REDIS_PREFIX: `${process.env.SAEFR_REDIS_PREFIX}_drain_${randomUUID()}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (b: Buffer) => {
    output += b.toString();
  });
  child.stderr.on('data', (b: Buffer) => {
    errors += b.toString();
  });
  let signal: NodeJS.Signals | null = null;
  child.once('exit', (_code, value) => {
    signal = value;
  });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  // Independent parent watchdog remains effective if the child's event loop spins.
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    return { code: await ended, signal, output, errors };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await ended;
  }
}

describe('post-readiness BullMQ disposal and full-loop drain', () => {
  let mutant: string;
  beforeAll(async () => {
    disposableRedis();
    mutant = await mkdtemp(join(tmpdir(), 'saefr-full-loop-mutant-'));
    await mkdir(join(mutant, 'worker'));
    const dist = join(process.cwd(), 'dist/worker');
    const source = await readFile(join(dist, 'worker-runtime.js'), 'utf8');
    const unsafe = source
      .replace(
        'worker.pause(false), SHUTDOWN_MS',
        'worker.pause(true), CLOSE_MS',
      )
      .replace(
        'if (this.runTask)\n                        await this.withDeadline(this.runTask, SHUTDOWN_MS);',
        '',
      )
      .replace(
        'drained = !worker.isRunning() && !this.activeProcessors.size;',
        'drained = true;',
      );
    // Require BOTH mutations: a missing seam must never pass as a negative control.
    expect(unsafe).not.toContain('drained = !worker.isRunning()');
    expect(unsafe).not.toContain(
      'this.withDeadline(this.runTask, SHUTDOWN_MS)',
    );
    await writeFile(join(mutant, 'worker/worker-runtime.mjs'), unsafe);
    for (const name of [
      'worker-config.js',
      'job-contract.js',
      'initialization-safe-redis-connection.js',
    ])
      await symlink(join(dist, name), join(mutant, 'worker', name));
    await symlink(
      join(process.cwd(), 'dist/errors'),
      join(mutant, 'errors'),
      'dir',
    );
    await symlink(
      join(process.cwd(), 'node_modules'),
      join(mutant, 'node_modules'),
      'dir',
    );
  });
  afterAll(async () => {
    if (mutant) await rm(mutant, { recursive: true, force: true });
  });

  it('keeps essential transports alive when a scheduler continuation cannot drain, then fences late work', async () => {
    const result = await schedulerProbe(
      join(process.cwd(), 'dist/worker/worker-runtime.js'),
    );
    expect(result.code, result.errors).toBe(0);
    expect(result.output).toContain('scheduler-held');
    expect(result.output).toContain('runtime-ready');
    expect(result.output).toContain('stop-settled');
    expect(result.output).toContain('drained-without-late-processing');
    expect(result.signal).toBeNull();
  }, 15000);

  it('detects the old close-before-drain non-yielding scheduler retry in an externally supervised control', async () => {
    const result = await schedulerProbe(
      join(mutant, 'worker/worker-runtime.mjs'),
    );
    expect(result.output).toContain('runtime-ready');
    expect(result.output).toContain('scheduler-held');
    expect(result.output).toContain('consumer-close-ack');
    expect(result.output).not.toContain('stop-settled');
    expect(result.signal).toBe('SIGKILL');
  }, 15000);

  it.each([false, true])(
    'requires initialized producer transport-end evidence across half-close (unsafe control: %s)',
    async (unsafe) => {
      const config = disposableRedis().config;
      const sockets: Socket[] = [];
      let loseAcknowledgement = false;
      let fin!: () => void;
      const observedFin = new Promise<void>((r) => {
        fin = r;
      });
      const proxy = createServer({ allowHalfOpen: true }, (client) => {
        const backend = connect({ host: '127.0.0.1', port: config.port });
        sockets.push(client, backend);
        client.on('error', () => undefined);
        backend.on('error', () => undefined);
        client.pipe(backend, { end: false });
        backend.on('data', (bytes) => {
          if (!client.destroyed) client.write(bytes);
        });
        client.on('end', fin);
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      const address = proxy.address();
      if (!address || typeof address === 'string')
        throw new Error('Proxy unavailable');
      let factories = 0;
      let queue!: RecoveryProducerQueue;
      const delivery = new RedisRecoveryDelivery(
        { ...config, port: address.port },
        () => {
          factories++;
          queue = createRecoveryQueue({ ...config, port: address.port });
          const getJob = queue.getJob.bind(queue);
          queue.getJob = async (...args: Parameters<typeof getJob>) => {
            const job = await getJob(...args);
            if (loseAcknowledgement) {
              loseAcknowledgement = false;
              throw new Error('Synthetic lost command acknowledgement');
            }
            return job;
          };
          if (unsafe) {
            // Test-only restoration of the old initialized path, not a mocked close result.
            // oxlint-disable-next-line typescript/unbound-method -- Applied to the real connection below.
            const oldClose = RedisConnection.prototype.close;
            queue.stopProducer = async () => {
              await oldClose.call(
                (queue as unknown as { connection: RedisConnection })
                  .connection,
                true,
              );
            };
          }
          return queue;
        },
      );
      try {
        const hint = {
          version: 1 as const,
          asset_id: randomUUID(),
          generation: '1',
        };
        expect((await delivery.inspect(hint)).status).toBe('missing');
        const client = await queue.client;
        let ended = false;
        const endedEvent = new Promise<void>((r) =>
          client.once('end', () => {
            ended = true;
            r();
          }),
        );
        loseAcknowledgement = true;
        expect((await delivery.inspect(hint)).status).toBe('uncertain');
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            observedFin,
            new Promise<never>((_r, reject) => {
              timer = setTimeout(
                () => reject(new Error('Expected owned proxy FIN')),
                1000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        expect(ended).toBe(false);

        const replacement = await delivery.inspect(hint);
        if (unsafe) {
          expect(factories).toBe(2); // detects the original premature replacement
          expect(replacement.status).toBe('missing');
        } else {
          expect(replacement.status).toBe('uncertain');
          expect(factories).toBe(1);
          // Positive local close evidence releases quarantine; it proves nothing about
          // whether the timed-out Redis command executed on the remote server.
          for (const socket of sockets) socket.destroy();
          await endedEvent;
          for (let i = 0; i < 50; i++) {
            if ((await delivery.inspect(hint)).status === 'missing') break;
            await new Promise((r) => setTimeout(r, 20));
          }
          expect(factories).toBe(2);
          expect((await delivery.inspect(hint)).status).toBe('missing');
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        try {
          expect(await delivery.close()).toBe(true);
        } finally {
          await new Promise<void>((r) => proxy.close(() => r()));
        }
      }
    },
    20000,
  );
});
