import { describe, expect, it } from 'vitest';
import { WorkerRuntime } from './worker-runtime.js';
import { workerConfig } from './worker-config.js';

describe('synthetic worker pre-start cancellation', () => {
  it('fences startup even when shutdown has no resources to close', async () => {
    const runtime = new WorkerRuntime(workerConfig({ SAEFR_REDIS_PORT: '1' }));
    expect(await runtime.stop()).toBe(true);
    await expect(runtime.start()).rejects.toThrow(
      'already started or stopping',
    );
    expect(await runtime.stop()).toBe(true);
    expect(runtime.diagnostics().consumerRunning).toBe(false);
  });

  it('honors a synchronous requestStop before initialization', async () => {
    const runtime = new WorkerRuntime(workerConfig({ SAEFR_REDIS_PORT: '1' }));
    runtime.requestStop();
    await expect(runtime.start()).rejects.toThrow(
      'already started or stopping',
    );
    expect(await runtime.stop()).toBe(true);
  });
});
