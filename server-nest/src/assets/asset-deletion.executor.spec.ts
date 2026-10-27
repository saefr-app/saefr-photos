import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetDeletionExecutor } from './asset-deletion.executor.js';
import type {
  AssetDeletionRepository,
  ExecutionAuthority,
} from './asset-deletion.repository.js';
import type { LocalStorageProvider } from '../storage/local-storage.provider.js';

const assetId = '00000000-0000-4000-8000-000000000001';
const ownerId = '00000000-0000-4000-8000-000000000002';
const token = '00000000-0000-4000-8000-000000000003';
const receipt = {
  asset_id: assetId,
  owner_id: ownerId,
  storage_id: '00000000-0000-4000-8000-000000000004',
  originals_binding_id: '00000000-0000-4000-8000-000000000005',
  thumbnails_binding_id: '00000000-0000-4000-8000-000000000006',
  storage_layout_version: 1,
  original_extension: '.jpg',
  accepted_lifecycle_version: '0',
  requested_at: new Date('2026-10-27T00:00:00Z'),
  requested_at_exact: '2026-10-27T00:00:00.000000',
  completed_at: null,
} as ExecutionAuthority;

function gate() {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  return { entered, release, waiting, held };
}

function harness() {
  const journal = {
    findExecutionAuthority: vi.fn(async () => receipt),
    claim: vi.fn(async () => ({ status: 'claimed' as const, token })),
    confirmClaim: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    recordFailure: vi.fn(async () => true),
    completeAfterVerifiedRemoval: vi.fn(async () => true),
  };
  const storage = {
    capabilities: {
      bindingObservation: true,
      exactRemoval: true,
      authoritativeAbsence: true,
      deletionDurability: true,
    },
    verifyBinding: vi.fn(async () => receipt),
    removeExact: vi.fn(async () => ({
      status: 'removed' as const,
      durable: true as const,
    })),
    confirmDirectoryPersistence: vi.fn(async () => ({
      status: 'durable' as const,
    })),
  };
  const executor = new AssetDeletionExecutor(
    journal as unknown as AssetDeletionRepository,
    storage as unknown as LocalStorageProvider,
  );
  return { executor, journal, storage };
}

afterEach(() => vi.restoreAllMocks());

describe('deletion work-start controls', () => {
  it('does not dispatch removal after cancellation during renewal', async () => {
    const { executor, journal, storage } = harness();
    const paused = gate();
    journal.renew.mockImplementation(async () => {
      paused.entered();
      await paused.held;
      return true;
    });
    const abort = new AbortController();
    const result = executor.execute(assetId, ownerId, abort.signal);
    await paused.waiting;
    abort.abort();
    paused.release();
    expect(await result).toBe('pending');
    expect(storage.removeExact).not.toHaveBeenCalled();
    expect(storage.confirmDirectoryPersistence).not.toHaveBeenCalled();
    expect(journal.completeAfterVerifiedRemoval).not.toHaveBeenCalled();
    // The completed attempt released its local slot for a later explicit call.
    expect(await executor.execute(assetId, ownerId)).toBe('completed');
  });

  it('does not dispatch removal when the deadline passes during renewal', async () => {
    const { executor, journal, storage } = harness();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const paused = gate();
    journal.renew.mockImplementation(async () => {
      paused.entered();
      await paused.held;
      return true;
    });
    const result = executor.execute(assetId, ownerId);
    await paused.waiting;
    now = 30_001;
    paused.release();
    expect(await result).toBe('pending');
    expect(storage.removeExact).not.toHaveBeenCalled();
    expect(storage.confirmDirectoryPersistence).not.toHaveBeenCalled();
  });

  it('does not dispatch removal after cancellation during binding verification', async () => {
    const { executor, storage } = harness();
    const paused = gate();
    let checks = 0;
    storage.verifyBinding.mockImplementation(async () => {
      if (++checks === 3) {
        paused.entered();
        await paused.held;
      }
      return receipt;
    });
    const abort = new AbortController();
    const result = executor.execute(assetId, ownerId, abort.signal);
    await paused.waiting;
    abort.abort();
    paused.release();
    expect(await result).toBe('pending');
    expect(storage.removeExact).not.toHaveBeenCalled();
  });

  it('drains an already-dispatched original removal but skips persistence after cancellation', async () => {
    const { executor, journal, storage } = harness();
    const paused = gate();
    storage.removeExact.mockImplementation(async () => {
      paused.entered();
      await paused.held;
      return { status: 'removed', durable: true };
    });
    const abort = new AbortController();
    let settled = false;
    const result = executor.execute(assetId, ownerId, abort.signal);
    void result.then(() => (settled = true));
    await paused.waiting;
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    paused.release();
    expect(await result).toBe('pending');
    expect(storage.removeExact).toHaveBeenCalledTimes(1);
    expect(storage.confirmDirectoryPersistence).not.toHaveBeenCalled();
    expect(journal.completeAfterVerifiedRemoval).not.toHaveBeenCalled();
  });

  it('preserves partial original removal and skips thumbnail after cancellation', async () => {
    const { executor, journal, storage } = harness();
    const paused = gate();
    let renewals = 0;
    journal.renew.mockImplementation(async () => {
      if (++renewals === 3) {
        paused.entered();
        await paused.held;
      }
      return true;
    });
    const abort = new AbortController();
    const result = executor.execute(assetId, ownerId, abort.signal);
    await paused.waiting;
    abort.abort();
    paused.release();
    expect(await result).toBe('pending');
    expect(storage.removeExact).toHaveBeenCalledTimes(1);
    expect(storage.removeExact).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'originals' }),
      receipt,
    );
    expect(storage.confirmDirectoryPersistence).toHaveBeenCalledTimes(1);
    expect(journal.completeAfterVerifiedRemoval).not.toHaveBeenCalled();
  });

  it('skips thumbnail persistence when the deadline passes during renewal', async () => {
    const { executor, journal, storage } = harness();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const paused = gate();
    let renewals = 0;
    journal.renew.mockImplementation(async () => {
      if (++renewals === 4) {
        paused.entered();
        await paused.held;
      }
      return true;
    });
    const result = executor.execute(assetId, ownerId);
    await paused.waiting;
    now = 30_001;
    paused.release();
    expect(await result).toBe('pending');
    expect(storage.removeExact).toHaveBeenCalledTimes(2);
    expect(storage.confirmDirectoryPersistence).toHaveBeenCalledTimes(1);
    expect(journal.completeAfterVerifiedRemoval).not.toHaveBeenCalled();
  });

  it('still completes an ordinary attempt without cancellation', async () => {
    const { executor, journal, storage } = harness();
    expect(await executor.execute(assetId, ownerId)).toBe('completed');
    expect(storage.removeExact).toHaveBeenCalledTimes(2);
    expect(storage.confirmDirectoryPersistence).toHaveBeenCalledTimes(2);
    expect(journal.completeAfterVerifiedRemoval).toHaveBeenCalledTimes(1);
  });
});
