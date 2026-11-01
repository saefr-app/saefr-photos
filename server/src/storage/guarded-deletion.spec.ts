import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageBindingVerifier } from './storage-binding.service.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import type { ProviderExecutionGuard } from './storage-provider.js';
import type { StorageRole } from './storage-marker.js';

describe('explicit guarded local deletion boundaries on synthetic files', () => {
  let root: string;
  const b = {
    singleton: true,
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
    storage_layout_version: 1,
  };
  const target = {
    role: 'originals' as const,
    assetId: randomUUID(),
    extension: '.jpg' as const,
  };
  let syncs: number;
  let verified: boolean;
  let afterUnlink: (() => void) | undefined;
  let beforeSync: (() => void) | undefined;
  let afterSync: (() => void) | undefined;
  let unlinks: number;
  class Provider extends LocalStorageProvider {
    protected override async unlinkPath(path: string) {
      unlinks++;
      await super.unlinkPath(path);
      afterUnlink?.();
    }

    protected override async syncDirectory(
      role: StorageRole,
      directory?: FileHandle,
    ) {
      syncs++;
      beforeSync?.();
      await super.syncDirectory(role, directory);
      afterSync?.();
    }
  }
  let provider: Provider;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-b42-boundary-'));
    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));
    await writeFile(
      join(root, 'originals', `${target.assetId}.jpg`),
      'synthetic',
    );
    syncs = 0;
    verified = true;
    afterUnlink = undefined;
    beforeSync = undefined;
    afterSync = undefined;
    unlinks = 0;
    provider = new Provider(
      {
        assertVerified: async () => {
          if (!verified) throw new Error('synthetic replacement');
          return b;
        },
      } as StorageBindingVerifier,
      new ConfigService({ STORAGE_ROOT: root }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const bytes = () =>
    readFile(join(root, 'originals', `${target.assetId}.jpg`), 'utf8');
  it('does not fall back to manual removal when the explicit guard is missing', async () => {
    expect(
      await provider.removeExactGuarded(
        target,
        b,
        undefined as unknown as ProviderExecutionGuard,
      ),
    ).toEqual({ status: 'unavailable', durable: false });
    expect(await bytes()).toBe('synthetic');
    expect(syncs).toBe(0);
  });
  it('checks the synchronous local fence after asynchronous authorization yields', async () => {
    let open = true;
    const guard = {
      observe: async () => {
        open = false;
        return true;
      },
      canDispatch: () => open,
    };
    expect((await provider.removeExactGuarded(target, b, guard)).durable).toBe(
      false,
    );
    expect(await bytes()).toBe('synthetic');
    expect(syncs).toBe(0);
  });
  it('requires a fresh guard before directory persistence after unlink', async () => {
    let calls = 0;
    const guard = {
      observe: async () => ++calls === 1,
      canDispatch: () => true,
    };
    expect(await provider.removeExactGuarded(target, b, guard)).toEqual({
      status: 'uncertain',
      durable: false,
    });
    await expect(bytes()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(syncs).toBe(0);
  });
  it('guards explicit directory persistence after preparation', async () => {
    expect(
      await provider.confirmDirectoryPersistenceGuarded('originals', b, {
        observe: async () => false,
        canDispatch: () => true,
      }),
    ).toEqual({ status: 'unavailable' });
    expect(syncs).toBe(0);
    expect(await bytes()).toBe('synthetic');
  });
  it('revalidates binding after removal even if the execution guard allows dispatch', async () => {
    afterUnlink = () => {
      verified = false;
    };
    expect(
      await provider.removeExactGuarded(target, b, {
        observe: async () => true,
        canDispatch: () => true,
      }),
    ).toEqual({ status: 'uncertain', durable: false });
    await expect(bytes()).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(
    (['originals', 'thumbnails'] as const).flatMap((role) =>
      (['failed_sync', 'lost_ack', 'post_sync_verification'] as const).flatMap(
        (fault) => [true, false].map((guarded) => ({ role, fault, guarded })),
      ),
    ),
  )(
    'classifies absent $role $fault with guarded=$guarded without changing legacy results',
    async ({ role, fault, guarded }) => {
      const missing = { ...target, role };
      await rm(join(root, role, `${target.assetId}.jpg`), { force: true });
      if (fault === 'failed_sync')
        beforeSync = () => {
          throw new Error('Synthetic persistence failure');
        };
      else
        afterSync = () => {
          if (fault === 'lost_ack')
            throw new Error('Synthetic lost sync acknowledgement');
          verified = false;
        };
      const outcome = guarded
        ? await provider.removeExactGuarded(missing, b, {
            observe: async () => true,
            canDispatch: () => true,
          })
        : await provider.removeExact(missing, b);
      expect(outcome).toEqual({
        status: guarded ? 'uncertain' : 'unavailable',
        durable: false,
      });
      expect(syncs).toBe(1);
      expect(unlinks).toBe(0);
    },
  );
  it.each(
    (['originals', 'thumbnails'] as const).flatMap((role) =>
      [true, false].map((guarded) => ({ role, guarded })),
    ),
  )(
    'preserves successful authoritative absence for $role with guarded=$guarded',
    async ({ role, guarded }) => {
      const missing = { ...target, role };
      await rm(join(root, role, `${target.assetId}.jpg`), { force: true });
      const outcome = guarded
        ? await provider.removeExactGuarded(missing, b, {
            observe: async () => true,
            canDispatch: () => true,
          })
        : await provider.removeExact(missing, b);
      expect(outcome).toEqual({ status: 'absent', durable: true });
      expect(syncs).toBe(1);
      expect(unlinks).toBe(0);
    },
  );
  it.each(
    (['originals', 'thumbnails'] as const).flatMap((role) =>
      [true, false].map((guarded) => ({ role, guarded })),
    ),
  )(
    'preserves a genuine pre-I/O refusal for $role with guarded=$guarded',
    async ({ role, guarded }) => {
      const invalid = { ...target, role };
      const path = join(root, role, `${target.assetId}.jpg`);
      await rm(path, { force: true });
      await mkdir(path);
      const outcome = guarded
        ? await provider.removeExactGuarded(invalid, b, {
            observe: async () => true,
            canDispatch: () => true,
          })
        : await provider.removeExact(invalid, b);
      expect(outcome).toEqual({ status: 'unavailable', durable: false });
      expect(syncs).toBe(0);
      expect(unlinks).toBe(0);
    },
  );
});
