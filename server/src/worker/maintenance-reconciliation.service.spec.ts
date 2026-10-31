import { describe, expect, it, vi } from 'vitest';

import {
  MaintenanceReconciliationRepository,
  reconciliationPageLimit,
} from './maintenance-reconciliation.repository.js';
import { MaintenanceReconciliationService } from './maintenance-reconciliation.service.js';

describe('passive reconciliation boundaries', () => {
  const owner = { token: '00000000-0000-4000-8000-000000000001', epoch: '1' };

  it.each([0, -1, 101, Infinity, NaN, 1.5])(
    'rejects unbounded or invalid page limit %s',
    (limit) => {
      expect(() => reconciliationPageLimit(limit)).toThrow('page limit');
    },
  );

  it('accepts bounded page sizes and defaults to 100', () => {
    expect(reconciliationPageLimit(1)).toBe(1);
    expect(reconciliationPageLimit(100)).toBe(100);
  });

  it('makes no database call without explicit synthetic authorization', async () => {
    const beginOrResume = vi.fn();
    const sweepPage = vi.fn();
    const discover = vi.fn();
    const coordinator = {
      beginOrResume,
      sweepPage,
    } as unknown as MaintenanceReconciliationRepository;
    const service = new MaintenanceReconciliationService(coordinator, {
      discover,
    });
    expect(await service.reconcilePage(owner)).toEqual({
      status: 'denied',
      checkpointed: 0,
      deferred: 0,
    });
    expect(await service.sweepCompleted(owner, null)).toMatchObject({
      status: 'denied',
    });
    expect(beginOrResume).not.toHaveBeenCalled();
    expect(sweepPage).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('does not interpret an uncertain pass COMMIT as permission to read or advance', async () => {
    const beginOrResume = vi.fn().mockResolvedValue({ status: 'uncertain' });
    const page = vi.fn();
    const advance = vi.fn();
    const coordinator = {
      beginOrResume,
      page,
      advance,
    } as unknown as MaintenanceReconciliationRepository;
    const service = new MaintenanceReconciliationService(coordinator, {
      discover: vi.fn(),
    });
    expect(
      await service.reconcilePage(owner, {
        purpose: 'synthetic-metadata-only',
      }),
    ).toMatchObject({ status: 'uncertain', checkpointed: 0 });
    expect(page).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});
