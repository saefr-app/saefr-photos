import { describe, expect, it } from 'vitest';

import { workerConfig } from './worker-config.js';
import { parseSyntheticJob, syntheticJob } from './job-contract.js';
import { syntheticGateAllows } from './synthetic-recovery-gate.js';

describe('M13A non-destructive contracts', () => {
  it('defaults to loopback and bounded single-job execution', () => {
    const config = workerConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.concurrency).toBe(1);
    expect(config.controlIntervalMs).toBe(60_000);
  });

  it('rejects unsafe remote or malformed configuration without reflecting secrets', () => {
    for (const env of [
      { SAEFR_REDIS_HOST: 'redis.example' },
      { SAEFR_REDIS_HOST: 'redis.example', SAEFR_REDIS_PASSWORD: 'private' },
      { SAEFR_WORKER_CONCURRENCY: '100' },
      { SAEFR_REDIS_PORT: '0' },
      { SAEFR_REDIS_PREFIX: 'unsafe:path/*' },
      { SAEFR_REDIS_TLS: 'yes' },
      { SAEFR_REDIS_HOST: 'bad..host' },
    ]) {
      expect(() => workerConfig(env)).toThrow();
      try {
        workerConfig(env);
      } catch (error) {
        expect(String(error)).not.toContain('private');
      }
    }
  });

  it('rejects payload extras and unsupported versions', () => {
    const valid = syntheticJob();
    expect(parseSyntheticJob(valid)).toEqual(valid);
    for (const value of [
      { ...valid, path: '/private/photo.jpg' },
      { ...valid, version: 2 },
      null,
      'hello',
    ]) {
      expect(() => parseSyntheticJob(value)).toThrow('Invalid synthetic job');
    }
  });

  it('fails closed for missing or malformed synthetic gate states', () => {
    expect(syntheticGateAllows(undefined)).toBe(false);
    expect(
      syntheticGateAllows({ kind: 'synthetic', version: 1, armed: false }),
    ).toBe(false);
    expect(syntheticGateAllows({ kind: 'real', version: 1, armed: true })).toBe(
      false,
    );
    expect(
      syntheticGateAllows({
        kind: 'synthetic',
        version: 1,
        armed: true,
        path: 'x',
      }),
    ).toBe(false);
    expect(
      syntheticGateAllows({ kind: 'synthetic', version: 1, armed: true }),
    ).toBe(true);
  });
});
