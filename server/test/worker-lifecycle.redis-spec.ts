import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableRedis } from './helpers/disposable-redis.js';

async function probe(mode: string, modulePath?: string) {
  const child = spawn(
    process.execPath,
    [
      'test/helpers/worker-initialization-child.mjs',
      mode,
      ...(modulePath ? [modulePath] : []),
    ],
    {
      env: {
        PATH: process.env.PATH,
        ...(mode === 'real-consumer-sticky-error'
          ? {
              SAEFR_REDIS_HOST: '127.0.0.1',
              SAEFR_REDIS_PORT: String(disposableRedis().config.port),
              SAEFR_REDIS_PASSWORD: disposableRedis().config.password,
              SAEFR_REDIS_PREFIX: disposableRedis().config.prefix,
              SAEFR_REDIS_TEST_CONTAINER_ID: disposableRedis().id,
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    return { code: await ended, output, errors };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill('SIGKILL');
    await ended;
  }
}

describe('actual BullMQ initialization and WorkerRuntime shutdown barriers', () => {
  let mutant: string;
  beforeAll(async () => {
    disposableRedis(); // fail closed unless the caller uses the established owned runner
    mutant = await mkdtemp(join(tmpdir(), 'saefr-bullmq-init-mutant-'));
    const dist = join(process.cwd(), 'dist/worker');
    const source = await readFile(join(dist, 'worker-runtime.js'), 'utf8');
    const unsafe = source.replace(', InitializationSafeRedisConnection)', ')');
    expect(unsafe).not.toBe(source);
    // Preserve the compiled module's relative ../errors import in its temporary copy.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(mutant, 'worker'));
    await writeFile(join(mutant, 'worker/worker-runtime.mjs'), unsafe);
    for (const name of [
      'worker-config.js',
      'job-contract.js',
      'initialization-safe-redis-connection.js',
    ])
      await symlink(join(dist, name), join(mutant, 'worker', name));
    const unsafeCleanup = source
      .replace('await this.withDeadline(ended, CLOSE_MS);', '')
      .replace(
        'this.pendingProducer.size || this.cleanupFailed',
        'this.pendingProducer.size',
      );
    expect(unsafeCleanup).not.toBe(source);
    await writeFile(join(mutant, 'worker/unsafe-cleanup.mjs'), unsafeCleanup);
    const stickyOnly = source.replace(
      'this.pendingProducer.size || this.cleanupFailed',
      'this.pendingProducer.size',
    );
    expect(stickyOnly).not.toBe(source);
    expect(stickyOnly).toContain('await this.withDeadline(ended, CLOSE_MS);');
    await writeFile(join(mutant, 'worker/unsafe-sticky.mjs'), stickyOnly);
    const main = await readFile(join(dist, 'main.js'), 'utf8');
    const unsafeSignals = main.replace(
      'process.on(signal,',
      'process.once(signal,',
    );
    expect(unsafeSignals).not.toBe(main);
    await writeFile(join(mutant, 'worker/main.mjs'), unsafeSignals);
    for (const name of [
      'worker-runtime.js',
      'worker.module.js',
      'maintenance-composition.js',
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

  it.each([
    'before-start',
    'queue-error',
    'reconnecting-error',
    'recovery-error',
    'late-ready',
    'concurrent-stop',
    'consumer-late-ready',
    'after-initialization',
    'consumer-error',
    'consumer-close-error',
    'consumer-delayed-end',
    'stuck-init',
    'stuck-end',
  ])(
    'honors the shutdown contract at %s',
    async (mode) => {
      const result = await probe(mode);
      expect(result.code, result.errors).toBe(0);
      expect(result.output).toContain(`"mode":"${mode}"`);
      expect(result.errors).not.toContain(
        'synthetic-private-initialization-error',
      );
      expect(result.errors).not.toContain("Unhandled 'error' event");
    },
    15000,
  );

  it('detects the original unsafe Queue connection with an isolated negative control', async () => {
    const result = await probe(
      'queue-error',
      join(mutant, 'worker/worker-runtime.mjs'),
    );
    expect(result.code).toBe(1);
    expect(result.errors).toContain("Emitted 'error' event on RedisConnection");
    expect(result.errors).toContain('synthetic-private-initialization-error');
  }, 15000);
  it('detects false clean consumer disposal in a temporary negative control', async () => {
    const result = await probe(
      'consumer-close-error',
      join(mutant, 'worker/unsafe-cleanup.mjs'),
    );
    expect(result.code).toBe(1);
    expect(result.errors).toContain('AssertionError');
    expect(result.errors).toContain('true !== false');
  }, 15000);

  it.each([false, true])(
    'retains sticky cleanup failure after both real transports end (negative control: %s)',
    async (unsafe) => {
      const result = await probe(
        'real-consumer-sticky-error',
        unsafe ? join(mutant, 'worker/unsafe-sticky.mjs') : undefined,
      );
      expect(result.output).toContain('"terminations":2');
      expect(result.output).toContain('"injected":1');
      expect(result.errors).not.toContain(
        'synthetic-private-sticky-cleanup-error',
      );
      expect(result.errors).not.toContain("Unhandled 'error' event");
      expect(result.code, result.errors).toBe(unsafe ? 1 : 0);
      if (unsafe) {
        expect(result.output).toContain('"result":true');
        expect(result.errors).toContain('true !== false');
      } else expect(result.output).toContain('"result":false');
    },
    15000,
  );

  it.each([
    { signal: 'SIGTERM' as const, unsafe: false },
    { signal: 'SIGINT' as const, unsafe: false },
    { signal: 'SIGTERM' as const, unsafe: true },
  ])(
    'keeps actual main fenced through repeated $signal (unsafe signal control: $unsafe)',
    async ({ signal, unsafe }) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          './test/helpers/worker-startup-signal-driver.mjs',
          unsafe ? join(mutant, 'worker/main.mjs') : 'dist/worker/main.js',
        ],
        {
          env: {
            PATH: process.env.PATH,
            SAEFR_REDIS_HOST: '127.0.0.1',
            SAEFR_REDIS_PORT: '1',
            SAEFR_REDIS_PREFIX: 'synthetic-signal-control',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      if (!child.stdout || !child.stderr)
        throw new Error('Fixture pipes unavailable');
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const phases = new Set<string>();
      const waiters = new Map<string, () => void>();
      child.on('message', (message: unknown) => {
        if (
          !message ||
          typeof message !== 'object' ||
          !('phase' in message) ||
          typeof message.phase !== 'string'
        )
          return;
        phases.add(message.phase);
        waiters.get(message.phase)?.();
      });
      const phase = (name: string) =>
        phases.has(name)
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.set(name, resolve);
            });
      let exitSignal: NodeJS.Signals | null = null;
      child.once('exit', (_code, signal) => {
        exitSignal = signal;
      });
      const ended = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
      try {
        // A missing lifecycle phase is a failure even if the child exits early.
        await Promise.race([
          phase('initializing'),
          ended.then(() => {
            throw new Error('Child exited before initialization');
          }),
        ]);
        expect(child.kill(signal)).toBe(true);
        await Promise.race([
          phase('disposal-requested'),
          ended.then(() => {
            throw new Error('Child exited before disposal');
          }),
        ]);
        expect(child.kill(signal)).toBe(true);
        const otherSent = child.kill(
          signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM',
        );
        if (!unsafe) expect(otherSent).toBe(true);
        child.send({ release: true }, () => undefined);
        const code = await ended;
        if (unsafe) {
          expect(code).toBeNull();
          expect(exitSignal).toBe('SIGTERM'); // a fixture watchdog SIGKILL must not pass
        } else expect(code, errors).toBe(0);
        expect(output).toContain('Synthetic worker starting');
        expect(output).not.toContain('Synthetic worker ready');
        expect(errors).not.toContain(
          'synthetic-private-signal-initialization-error',
        );
        expect(errors).not.toContain("Emitted 'error' event");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill('SIGKILL');
        await ended;
      }
    },
    15000,
  );
});
