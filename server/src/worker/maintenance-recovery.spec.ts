import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parseRecoveryHint,
  recoveryJobId,
} from './recovery-delivery-contract.js';
import {
  MaintenanceRecoveryAuthorization,
  createMaintenanceRecoveryAuthorization,
} from './maintenance-recovery-authorization.js';
import { RecoveryPermitService } from './recovery-permit.service.js';
import { RecoveryPermitError } from './recovery-permit.js';
import {
  RedisRecoveryDelivery,
  type RecoveryProducerQueue,
} from './redis-recovery-delivery.js';

describe('recovery delivery contracts and fresh B.2 observations', () => {
  const hint = { version: 1 as const, asset_id: randomUUID(), generation: '7' };

  it('uses only strict versioned opaque identifiers and a colon-free deterministic job ID', () => {
    expect(parseRecoveryHint(hint)).toEqual(hint);
    expect(recoveryJobId(hint)).toBe(`deletion-${hint.asset_id}-7`);
    expect(recoveryJobId(hint)).not.toContain(':');
  });

  it.each([
    null,
    [],
    {},
    { ...hint, version: 0 },
    { ...hint, generation: '0' },
    { ...hint, generation: '07' },
    { ...hint, generation: '9223372036854775808' },
    { ...hint, generation: 7 },
    { ...hint, asset_id: '../private' },
    { ...hint, owner_id: randomUUID() },
    { ...hint, permit_generation: '7' },
    { ...hint, path: '/private-photo' },
    { ...hint, execution_token: randomUUID() },
  ])(
    'rejects malformed, conflicting or authority-bearing hints %#',
    (input) => {
      expect(() => parseRecoveryHint(input)).toThrow('Invalid recovery hint');
    },
  );

  it('observes the actual B.2 service afresh and does not carry authorization across generations', async () => {
    let generation = '7';
    let armed = true;
    const readRuntime = vi.fn(async () => ({
      version: 1 as const,
      armed,
      generation,
      pairing_sha256: 'a'.repeat(64),
    }));
    const service = new RecoveryPermitService(
      { readRuntime },
      {
        verify: async () => ({
          fingerprint: 'a'.repeat(64),
          recordedGeneration: '0',
        }),
      },
    );
    const authorization = new MaintenanceRecoveryAuthorization(service);
    expect(await authorization.allowed('7')).toBe(true);
    generation = '8';
    expect(await authorization.allowed('7')).toBe(false);
    expect(await authorization.allowed('8')).toBe(true);
    armed = false;
    expect(await authorization.allowed('8')).toBe(false);
    expect(readRuntime.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it.each([
    'permit_unavailable',
    'permit_invalid',
    'permit_untrusted',
    'permit_busy',
  ] as const)(
    'fails closed for %s without propagating private errors',
    async (code) => {
      const permit = new RecoveryPermitService(
        {
          readRuntime: async () => {
            throw new RecoveryPermitError(code);
          },
        },
        {
          verify: async () => {
            throw new Error('private database URL');
          },
        },
      );
      expect(
        await new MaintenanceRecoveryAuthorization(permit).allowed('7'),
      ).toBe(false);
    },
  );

  it('fails closed for unavailable pairing and never consults it for malformed expected generations', async () => {
    const verify = vi.fn(async () => {
      throw new Error('private database password');
    });
    const permit = new RecoveryPermitService(
      {
        readRuntime: async () => ({
          version: 1,
          armed: true,
          generation: '7',
          pairing_sha256: 'a'.repeat(64),
        }),
      },
      { verify },
    );
    const authorization = new MaintenanceRecoveryAuthorization(permit);
    expect(await authorization.allowed('07')).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(await authorization.allowed('7')).toBe(false);
  });

  it('uses explicit dedicated permit configuration and has no ambient database fallback', () => {
    expect(() =>
      createMaintenanceRecoveryAuthorization({
        POSTGRES_PASSWORD: 'private-fixture',
      }),
    ).toThrow('Recovery permit blocked: permit_invalid');
  });

  it('quarantines a settled command when underlying producer disposal remains unknown', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn(async () => {
      throw new Error('Synthetic command timeout');
    });
    const factory = vi.fn(
      () =>
        ({
          getJob,
          stopProducer: () => new Promise<void>(() => undefined),
        }) as unknown as RecoveryProducerQueue,
    );
    const delivery = new RedisRecoveryDelivery(
      {
        host: '127.0.0.1',
        port: 1,
        tls: false,
        prefix: 'synthetic',
        concurrency: 1,
        controlIntervalMs: 1000,
      },
      factory,
    );
    try {
      const operation = delivery.inspect(hint);
      await vi.advanceTimersByTimeAsync(2100);
      expect(await operation).toEqual({ status: 'uncertain' });
      for (let i = 0; i < 3; i++)
        expect(await delivery.inspect(hint)).toEqual({ status: 'uncertain' });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(getJob).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
