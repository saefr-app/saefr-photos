import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenanceConfig } from './maintenance-config.js';
import { createMaintenanceRuntime } from './maintenance-composition.js';
import { MaintenanceRuntime } from './maintenance-runtime.js';
import type { PermitDecision } from './recovery-permit.service.js';

const config = maintenanceConfig({ SAEFR_MAINTENANCE_ENABLED: 'true' });
const owner = { token: '00000000-0000-4000-8000-000000000001', epoch: '1' };
function fixture() {
  const coordinator = {
    acquire: vi.fn(async (_token: string) => ({
      status: 'ok' as const,
      value: owner,
    })),
    read: vi.fn(),
    renew: vi.fn(async () => ({ status: 'ok' as const, value: {} as never })),
  };
  const authorization = {
    observe: vi.fn(async (): Promise<PermitDecision> => ({
      allowed: true,
      generation: '7',
    })),
  };
  const recovery = {
    reconcilePage: vi.fn(async () => ({
      status: 'page' as const,
      checkpointed: 1,
      delivered: 0,
      deferred: 0,
    })),
    sweepCompleted: vi.fn(async () => ({
      status: 'complete' as const,
      cursor: null,
      closed: 0,
    })),
  };
  const close = vi.fn(async () => undefined);
  const runtime = new MaintenanceRuntime(
    config,
    coordinator,
    authorization,
    recovery,
    close,
  );
  return { runtime, coordinator, authorization, recovery, close };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded maintenance lifecycle', () => {
  it('defaults disabled without constructing database or permit clients', () => {
    expect(maintenanceConfig({}).enabled).toBe(false);
    expect(
      createMaintenanceRuntime({ POSTGRES_PASSWORD: 'private' }),
    ).toBeNull();
  });
  it.each([
    { SAEFR_MAINTENANCE_ENABLED: 'yes' },
    { SAEFR_MAINTENANCE_RENEW_MS: '60000' },
    { SAEFR_MAINTENANCE_INTERVAL_MS: '0' },
    { SAEFR_MAINTENANCE_BUDGET_MS: '60000' },
    { SAEFR_MAINTENANCE_PAGE_SIZE: '101' },
    { SAEFR_MAINTENANCE_SHUTDOWN_MS: '99999' },
  ])('rejects unsafe runtime configuration %#', (env) => {
    expect(() => maintenanceConfig(env)).toThrow();
  });
  it('requires explicit dedicated writer settings without ordinary credential fallback', () => {
    expect(() =>
      createMaintenanceRuntime({
        SAEFR_MAINTENANCE_ENABLED: 'true',
        POSTGRES_PASSWORD: 'private',
      }),
    ).toThrow('MAINTENANCE_POSTGRES_PORT');
  });
  it('performs only passive metadata work and never overlaps ticks', async () => {
    const f = fixture();
    let release!: () => void;
    f.recovery.reconcilePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 'page',
              checkpointed: 1,
              delivered: 0,
              deferred: 0,
            });
        }),
    );
    const first = f.runtime.tick();
    await vi.waitFor(() =>
      expect(f.recovery.reconcilePage).toHaveBeenCalledTimes(1),
    );
    expect(f.runtime.tick()).toBe(first);
    expect(f.recovery.reconcilePage.mock.calls[0]).toEqual([
      owner,
      '7',
      { continue: expect.any(Function), delivery: false },
    ]);
    release();
    await first;
    expect(await f.runtime.stop()).toBe(true);
  });
  it('renews independently of the 60-second reconciliation cadence', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.recovery.reconcilePage).toHaveBeenCalledTimes(1);
    expect(f.coordinator.renew).toHaveBeenCalledTimes(3);
    expect(await f.runtime.stop()).toBe(true);
  });
  it('does no metadata work while disarmed and exposes only bounded diagnostics', async () => {
    const f = fixture();
    f.authorization.observe.mockResolvedValue({
      allowed: false,
      reason: 'permit_disarmed',
    });
    await f.runtime.tick();
    expect(f.coordinator.acquire).not.toHaveBeenCalled();
    expect(f.recovery.reconcilePage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.runtime.diagnostics())).not.toContain(owner.token);
    expect(f.runtime.diagnostics().state).toBe('blocked');
    await f.runtime.stop();
  });
  it('stops after an unknown acquisition and confirms the exact identity next tick', async () => {
    const f = fixture();
    f.coordinator.acquire.mockResolvedValueOnce({
      status: 'uncertain',
    } as never);
    await f.runtime.tick();
    expect(f.recovery.reconcilePage).not.toHaveBeenCalled();
    const token = f.coordinator.acquire.mock.calls[0][0];
    f.coordinator.read.mockResolvedValue({
      leader_token: token,
      leader_epoch: '9',
      lease_live: true,
    });
    await f.runtime.tick();
    expect(f.coordinator.acquire).toHaveBeenCalledTimes(1);
    expect(f.recovery.reconcilePage).toHaveBeenCalledWith(
      { token, epoch: '9' },
      '7',
      expect.any(Object),
    );
    await f.runtime.stop();
  });
  it('does not progress a completion sweep after uncertain page work', async () => {
    const f = fixture();
    f.recovery.reconcilePage.mockResolvedValueOnce({
      status: 'uncertain',
    } as never);
    await f.runtime.tick();
    expect(f.recovery.sweepCompleted).not.toHaveBeenCalled();
    expect(f.runtime.diagnostics().ownsCoordinator).toBe(false);
    await f.runtime.stop();
  });
  it('fences continuation on renewal loss or a changed permit', async () => {
    const f = fixture();
    await f.runtime.tick();
    f.authorization.observe.mockResolvedValue({
      allowed: true,
      generation: '8',
    });
    await f.runtime.renew();
    expect(f.coordinator.renew).not.toHaveBeenCalled();
    expect(f.runtime.diagnostics().ownsCoordinator).toBe(false);
    await f.runtime.stop();
  });
  it('does not renew a tick stalled past its admission budget', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture();
    let release!: () => void;
    f.recovery.reconcilePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 'page',
              checkpointed: 0,
              delivered: 0,
              deferred: 0,
            });
        }),
    );
    const pending = f.runtime.tick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(21000);
    clock.mockReturnValue(21000);
    await f.runtime.renew();
    expect(f.coordinator.renew).not.toHaveBeenCalled();
    release();
    await pending;
    expect(f.recovery.sweepCompleted).not.toHaveBeenCalled();
    await f.runtime.stop();
  });
  it('bounds shutdown without releasing capacity or falsely claiming quiescence', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    f.recovery.reconcilePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 'page',
              checkpointed: 0,
              delivered: 0,
              deferred: 0,
            });
        }),
    );
    const pending = f.runtime.tick();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = f.runtime.stop();
    expect(f.runtime.stop()).toBe(stopped);
    await vi.advanceTimersByTimeAsync(8100);
    expect(await stopped).toBe(false);
    expect(f.runtime.diagnostics().state).toBe('incomplete');
    release();
    await pending;
    await f.runtime.tick();
    expect(f.recovery.sweepCompleted).not.toHaveBeenCalled();
    expect(f.recovery.reconcilePage).toHaveBeenCalledTimes(1);
  });
  it('drains on Nest module destruction and treats repeated shutdown as idempotent', async () => {
    const f = fixture();
    await f.runtime.tick();
    await f.runtime.onModuleDestroy();
    await f.runtime.onModuleDestroy();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.diagnostics().state).toBe('stopped');
    expect(() => f.runtime.start()).toThrow();
  });
});
