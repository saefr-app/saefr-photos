import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from '../src/storage/storage-binding.service.js';
import {
  StorageBindingProvisioner,
  type ProvisioningIdentityObserver,
} from '../src/storage/storage-binding-provisioner.js';
import type { StorageRole } from '../src/storage/storage-marker.js';
import { testConfig } from './helpers/integration-database.js';

const ids = {
  storageId: 'c1111111-1111-4111-8111-111111111111',
  originalsBindingId: 'c2222222-2222-4222-8222-222222222222',
  thumbnailsBindingId: 'c3333333-3333-4333-8333-333333333333',
};

describe('synthetic fresh storage provisioning on disposable PostgreSQL', () => {
  let database: DatabaseService;
  beforeAll(async () => {
    database = new DatabaseService(testConfig());
    await database.ping();
    await migrateToLatest(database.db);
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  async function fixture(changeAfterWrite = false) {
    const root = await mkdtemp(join(tmpdir(), 'saefr-provision-'));
    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));
    const config = new ConfigService({
      STORAGE_ROOT: root,
      STORAGE_ID: ids.storageId,
      STORAGE_ORIGINALS_BINDING_ID: ids.originalsBindingId,
      STORAGE_THUMBNAILS_BINDING_ID: ids.thumbnailsBindingId,
      STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
      STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
    });
    const physical = (role: StorageRole, changed = false) => ({
      format: 'linux-ext4-handle-v1' as const,
      profile: 'linux-ext4-v1' as const,
      filesystem_uuid: 'c4444444-4444-4444-8444-444444444444',
      directory_handle_type: 1,
      directory_handle_hex: changed
        ? 'ffcc'
        : role === 'originals'
          ? 'aabb'
          : 'ccdd',
    });
    let thumbnailObservations = 0;
    const identityObserver: ProvisioningIdentityObserver = {
      async observeIdentity(role) {
        if (role === 'thumbnails') thumbnailObservations++;
        return physical(role, changeAfterWrite && thumbnailObservations > 1);
      },
    };
    const markerObserver: PhysicalStorageObserver = {
      async observe(role, location) {
        return {
          markerBytes: await readFile(join(location, '.saefr-storage.json')),
          identity: physical(role),
        };
      },
    };
    const verifier = new StorageBindingVerifier(
      database,
      config,
      markerObserver,
    );
    return {
      root,
      provisioner: new StorageBindingProvisioner(
        database,
        config,
        identityObserver,
        markerObserver,
        verifier,
      ),
      verifier,
    };
  }

  it('writes two exclusive markers before the short singleton transaction', async () => {
    const setup = await fixture();
    try {
      await setup.provisioner.provisionFresh(ids);
      await expect(setup.verifier.assertVerified()).resolves.toMatchObject({
        storage_id: ids.storageId,
      });
      for (const role of ['originals', 'thumbnails']) {
        expect(await readdir(join(setup.root, role))).toEqual([
          '.saefr-storage.json',
        ]);
      }
      await expect(setup.provisioner.provisionFresh(ids)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
    } finally {
      await database.db.deleteFrom('storage_binding').execute();
      await rm(setup.root, { recursive: true, force: true });
    }
  });

  it('leaves partial evidence unadopted when post-write physical identity changes', async () => {
    const setup = await fixture(true);
    try {
      await expect(setup.provisioner.provisionFresh(ids)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
      expect(await readdir(join(setup.root, 'originals'))).toEqual([
        '.saefr-storage.json',
      ]);
      expect(await readdir(join(setup.root, 'thumbnails'))).toEqual([
        '.saefr-storage.json',
      ]);
      expect(
        await database.db.selectFrom('storage_binding').selectAll().execute(),
      ).toEqual([]);
      await expect(setup.provisioner.provisionFresh(ids)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  });
});
