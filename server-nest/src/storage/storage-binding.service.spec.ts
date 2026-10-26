import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from './storage-binding.service.js';
import {
  locationFingerprint,
  roleLocation,
  serializeStorageMarker,
  type StorageMarkerV2,
  type StorageRole,
} from './storage-marker.js';

const storageId = '33333333-3333-4333-8333-333333333333';
const originalsId = '44444444-4444-4444-8444-444444444444';
const thumbnailsId = '66666666-6666-4666-8666-666666666666';
const uuid = '55555555-5555-4555-8555-555555555555';

function setup(
  options: {
    changedRoot?: string;
    copiedMarker?: boolean;
    swapped?: boolean;
    unavailable?: boolean;
    missingBinding?: boolean;
  } = {},
) {
  const binding = options.missingBinding
    ? undefined
    : {
        singleton: true,
        storage_id: storageId,
        originals_binding_id: originalsId,
        thumbnails_binding_id: thumbnailsId,
        storage_layout_version: 1,
      };
  const executeTakeFirst = vi.fn().mockResolvedValue(binding);
  const database = {
    db: {
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({ executeTakeFirst }),
        }),
      }),
    },
  } as unknown as DatabaseService;
  const config = new ConfigService({
    STORAGE_ROOT: options.changedRoot ?? '/synthetic/media',
    STORAGE_ID: storageId,
    STORAGE_ORIGINALS_BINDING_ID: originalsId,
    STORAGE_THUMBNAILS_BINDING_ID: thumbnailsId,
    STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
    STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
  });
  const observe = vi.fn(async (role: StorageRole, _location: string) => {
    if (options.unavailable) throw new Error('/private/storage/location');
    const observedRole = options.swapped
      ? role === 'originals'
        ? 'thumbnails'
        : 'originals'
      : role;
    const approvedLocation = roleLocation(
      '/synthetic/media',
      process.cwd(),
      observedRole,
    );
    const identity = {
      format: 'linux-ext4-handle-v1' as const,
      profile: 'linux-ext4-v1' as const,
      filesystem_uuid: uuid,
      directory_handle_type: 1,
      directory_handle_hex: role === 'originals' ? 'aabb' : 'ccdd',
    };
    const marker: StorageMarkerV2 = {
      version: 2,
      storage_id: storageId,
      binding_id: observedRole === 'originals' ? originalsId : thumbnailsId,
      role: observedRole,
      physical_identity: {
        ...identity,
        location_sha256: locationFingerprint(approvedLocation, observedRole),
      },
    };
    return {
      markerBytes: serializeStorageMarker(marker),
      identity: options.copiedMarker
        ? { ...identity, directory_handle_hex: 'eeff' }
        : identity,
    };
  });
  const verifier = new StorageBindingVerifier(database, config, {
    observe,
  } as PhysicalStorageObserver);
  return { verifier, observe };
}

describe('storage binding verifier (synthetic observation only)', () => {
  it('requires both observed roles and the database anchor', async () => {
    const { verifier, observe } = setup();
    await expect(verifier.assertVerified()).resolves.toMatchObject({
      storage_id: storageId,
    });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['changed root', { changedRoot: '/unrelated' }],
    ['copied marker', { copiedMarker: true }],
    ['swapped roles', { swapped: true }],
    ['missing mount', { unavailable: true }],
    ['missing database anchor', { missingBinding: true }],
  ] as const)(
    'fails closed for %s without leaking details',
    async (_label, options) => {
      const { verifier, observe } = setup(options);
      const failure = await verifier
        .assertVerified()
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 503 });
      expect(JSON.stringify(failure)).not.toContain('/private/');
      if ('missingBinding' in options) expect(observe).not.toHaveBeenCalled();
    },
  );
});
