import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AssetsRepository } from '../src/assets/assets.repository.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BoundImageStorageService } from '../src/storage/bound-image-storage.service.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { StorageBindingVerifier } from '../src/storage/storage-binding.service.js';
import {
  locationFingerprint,
  roleLocation,
  serializeStorageMarker,
  type StorageRole,
} from '../src/storage/storage-marker.js';
import { assetAuthenticator, assetHeaders } from './helpers/asset-auth.js';
import { LegacyAssetsTestModule } from './helpers/legacy-assets-test.module.js';

const assetId = '550e8400-e29b-41d4-a716-446655440000';
const ids = {
  storage: '33333333-3333-4333-8333-333333333333',
  originals: '44444444-4444-4444-8444-444444444444',
  thumbnails: '66666666-6666-4666-8666-666666666666',
  filesystem: '55555555-5555-4555-8555-555555555555',
};

describe('bound media HTTP behavior with synthetic physical evidence', () => {
  let root: string;
  let app: NestFastifyApplication;
  let bindingPresent = true;
  const original = Buffer.from('synthetic original bytes');
  const thumbnail = Buffer.from('synthetic thumbnail bytes');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-bound-http-'));
    const config = new ConfigService({
      STORAGE_ROOT: root,
      STORAGE_ID: ids.storage,
      STORAGE_ORIGINALS_BINDING_ID: ids.originals,
      STORAGE_THUMBNAILS_BINDING_ID: ids.thumbnails,
      STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
      STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
    });
    for (const role of ['originals', 'thumbnails'] as const) {
      await mkdir(join(root, role));
      const location = roleLocation(root, process.cwd(), role);
      await writeFile(
        join(root, role, '.saefr-storage.json'),
        serializeStorageMarker({
          version: 2,
          storage_id: ids.storage,
          binding_id: role === 'originals' ? ids.originals : ids.thumbnails,
          role,
          physical_identity: {
            format: 'linux-ext4-handle-v1',
            profile: 'linux-ext4-v1',
            filesystem_uuid: ids.filesystem,
            directory_handle_type: 1,
            directory_handle_hex: role === 'originals' ? 'aabb' : 'ccdd',
            location_sha256: locationFingerprint(location, role),
          },
        }),
      );
    }
    await writeFile(join(root, 'originals', `${assetId}.jpg`), original);
    await writeFile(join(root, 'thumbnails', `${assetId}.jpg`), thumbnail);

    const database = {
      db: {
        selectFrom: () => ({
          selectAll: () => ({
            where: () => ({
              executeTakeFirst: async () =>
                bindingPresent
                  ? {
                      singleton: true,
                      storage_id: ids.storage,
                      originals_binding_id: ids.originals,
                      thumbnails_binding_id: ids.thumbnails,
                      storage_layout_version: 1,
                    }
                  : undefined,
            }),
          }),
        }),
      },
    } as unknown as DatabaseService;
    const observer = {
      async observe(role: StorageRole, location: string) {
        return {
          markerBytes: await readFile(join(location, '.saefr-storage.json')),
          identity: {
            format: 'linux-ext4-handle-v1' as const,
            profile: 'linux-ext4-v1' as const,
            filesystem_uuid: ids.filesystem,
            directory_handle_type: 1,
            directory_handle_hex: role === 'originals' ? 'aabb' : 'ccdd',
          },
        };
      },
      async observePinned(role: StorageRole, location: string) {
        return this.observe(role, location);
      },
    };
    const storage = new BoundImageStorageService(
      new LocalStorageProvider(
        new StorageBindingVerifier(database, config, observer),
        config,
      ),
      config,
    );
    const asset = {
      id: assetId,
      mime_type: 'image/jpeg',
      storage_path: join(root, 'originals', `${assetId}.jpg`),
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [LegacyAssetsTestModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(RequestAuthenticator)
      .useValue(assetAuthenticator)
      .overrideProvider(AssetsRepository)
      .useValue({ findFileById: vi.fn().mockResolvedValue(asset) })
      .overrideProvider(LocalStorageService)
      .useValue(storage)
      .compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ routerOptions: { ignoreTrailingSlash: true } }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('streams both media roles only under the verified synthetic binding', async () => {
    for (const [role, expected] of [
      ['original', original],
      ['thumbnail', thumbnail],
    ] as const) {
      const response = await app.inject({
        headers: assetHeaders(),
        method: 'GET',
        url: `/api/v1/assets/${assetId}/${role}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(response.rawPayload).toEqual(expected);
    }
  });

  it('returns sanitized 503 for both roles when the anchor is unavailable', async () => {
    bindingPresent = false;
    try {
      for (const role of ['original', 'thumbnail']) {
        const response = await app.inject({
          headers: assetHeaders(),
          method: 'GET',
          url: `/api/v1/assets/${assetId}/${role}`,
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
        expect(response.body).not.toContain(root);
        expect(response.body).not.toContain(ids.filesystem);
      }
    } finally {
      bindingPresent = true;
    }
  });
});
