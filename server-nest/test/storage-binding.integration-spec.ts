import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from '../src/storage/storage-binding.service.js';
import {
  locationFingerprint,
  roleLocation,
  serializeStorageMarker,
  type StorageMarkerV2,
  type StorageRole,
} from '../src/storage/storage-marker.js';
import { testConfig } from './helpers/integration-database.js';

const ids = {
  storage: '77777777-7777-4777-8777-777777777777',
  originals: '88888888-8888-4888-8888-888888888888',
  thumbnails: '99999999-9999-4999-8999-999999999999',
  fs: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

describe('M12C binding against disposable PostgreSQL 18', () => {
  let database: DatabaseService;
  beforeAll(async () => {
    database = new DatabaseService(testConfig());
    await database.ping();
    await migrateToLatest(database.db);
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  function verifier(root = '/synthetic/approved', copy = false) {
    const config = new ConfigService({
      STORAGE_ROOT: root,
      STORAGE_ID: ids.storage,
      STORAGE_ORIGINALS_BINDING_ID: ids.originals,
      STORAGE_THUMBNAILS_BINDING_ID: ids.thumbnails,
      STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
      STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
    });
    const observe = vi.fn(async (role: StorageRole) => {
      const identity = {
        format: 'linux-ext4-handle-v1' as const,
        profile: 'linux-ext4-v1' as const,
        filesystem_uuid: ids.fs,
        directory_handle_type: 1,
        directory_handle_hex: role === 'originals' ? 'aabb' : 'ccdd',
      };
      const marker: StorageMarkerV2 = {
        version: 2,
        storage_id: ids.storage,
        binding_id: role === 'originals' ? ids.originals : ids.thumbnails,
        role,
        physical_identity: {
          ...identity,
          location_sha256: locationFingerprint(
            roleLocation('/synthetic/approved', process.cwd(), role),
            role,
          ),
        },
      };
      return {
        markerBytes: serializeStorageMarker(marker),
        identity: copy
          ? { ...identity, directory_handle_hex: 'eeee' }
          : identity,
      };
    });
    return {
      service: new StorageBindingVerifier(database, config, {
        observe,
      } as PhysicalStorageObserver),
      observe,
    };
  }

  it('refuses empty binding and consults no storage', async () => {
    const { service, observe } = verifier();
    await expect(service.assertVerified()).rejects.toMatchObject({
      status: 503,
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it('verifies both roles only for the installed database tuple', async () => {
    await sql`insert into public.storage_binding values
      (true, ${ids.storage}::uuid, ${ids.originals}::uuid,
       ${ids.thumbnails}::uuid, 1)`.execute(database.db);
    try {
      const { service, observe } = verifier();
      await expect(service.assertVerified()).resolves.toMatchObject({
        storage_id: ids.storage,
      });
      expect(observe).toHaveBeenCalledTimes(2);
      await expect(
        verifier('/synthetic/substituted').service.assertVerified(),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        verifier('/synthetic/approved', true).service.assertVerified(),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await sql`delete from public.storage_binding where singleton = true`.execute(
        database.db,
      );
    }
  });
});
