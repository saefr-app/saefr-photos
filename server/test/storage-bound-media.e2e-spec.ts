import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { AssetsRepository } from '../src/assets/assets.repository.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BoundImageStorageService } from '../src/storage/bound-image-storage.service.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { MAX_UPLOAD_BYTES } from '../src/storage/image-limits.js';
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
const boundary = 'saefr-storage-test-boundary';
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
  const created = vi.fn(
    async (
      _actor: unknown,
      asset: {
        id: string;
        filename: string;
        mime_type: string;
        size: number;
        created_at: Date;
      },
    ) => ({
      status: 'committed' as const,
      asset,
    }),
  );
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
      .useValue({
        findFileById: vi.fn().mockResolvedValue(asset),
        assertIdAvailableForPublication: vi.fn().mockResolvedValue(undefined),
        createForActor: created,
      })
      .overrideProvider(LocalStorageService)
      .useValue(storage)
      .compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        multipart: true,
        routerOptions: { ignoreTrailingSlash: true },
      }),
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

  function body(bytes: Buffer, extraPart = false): Buffer {
    return Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      bytes,
      Buffer.from(
        extraPart
          ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nno\r\n--${boundary}--\r\n`
          : `\r\n--${boundary}--\r\n`,
      ),
    ]);
  }

  function upload(bytes: Buffer, extraPart = false) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body(bytes, extraPart),
    });
  }

  it('classifies empty, invalid, oversized and malformed bound uploads without publishing', async () => {
    const prior = created.mock.calls.length;
    const invalid = Buffer.from('not a JPEG');
    for (const [bytes, expected] of [
      [Buffer.alloc(0), 415],
      [invalid, 415],
      [Buffer.alloc(MAX_UPLOAD_BYTES + 1), 413],
    ] as const) {
      const response = await upload(bytes);
      expect(response.statusCode).toBe(expected);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain('Fastify');
    }
    const jpeg = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: '#226699',
      },
    })
      .jpeg()
      .toBuffer();
    expect((await upload(jpeg, true)).statusCode).toBe(400);
    expect(created).toHaveBeenCalledTimes(prior);
    expect((await readdir(join(root, 'originals'))).sort()).toEqual(
      ['.saefr-storage.json', `${assetId}.jpg`].sort(),
    );
  }, 20_000);

  it('rejects a truncated real-socket multipart request as 400', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string')
      throw new Error('No test listener');
    const jpeg = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: '#225588',
      },
    })
      .jpeg()
      .toBuffer();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/assets/upload`,
      {
        method: 'POST',
        headers: {
          ...assetHeaders(true),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body: new Uint8Array(body(jpeg).subarray(0, -4)),
        signal: AbortSignal.timeout(4000),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(root);
  }, 8_000);

  it('cleans a bound upload stage when the source socket fails mid-stream', async () => {
    if (!app.getHttpServer().listening) {
      await app.listen({ host: '127.0.0.1', port: 0 });
    }
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string')
      throw new Error('No test listener');
    const prior = created.mock.calls.length;
    const socket = connect(address.port, '127.0.0.1');
    await once(socket, 'connect');
    try {
      socket.write(
        'POST /api/v1/assets/upload HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Cookie: saefr_session_dev=isolated-asset-session\r\n' +
          'Origin: http://127.0.0.1:3000\r\n' +
          `X-CSRF-Token: ${assetHeaders(true)['X-CSRF-Token']}\r\n` +
          `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
          'Content-Length: 1048576\r\n\r\n' +
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="photo.jpg"\r\n' +
          'Content-Type: image/jpeg\r\n\r\n',
      );
      socket.write(Buffer.alloc(128 * 1024, 0x41));
      await vi.waitFor(async () => {
        expect(
          (await readdir(join(root, 'originals'))).some((name) =>
            name.endsWith('.uploading'),
          ),
        ).toBe(true);
      });
    } finally {
      socket.destroy();
    }
    await vi.waitFor(async () => {
      expect(
        (await readdir(join(root, 'originals'))).some((name) =>
          name.endsWith('.uploading'),
        ),
      ).toBe(false);
    });
    expect(created).toHaveBeenCalledTimes(prior);
  }, 8_000);

  it('denies unavailable storage before parsing and preserves valid upload bytes', async () => {
    const jpeg = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: '#334466',
      },
    })
      .jpeg()
      .toBuffer();
    bindingPresent = false;
    try {
      const refused = await upload(jpeg);
      expect(refused.statusCode).toBe(503);
      expect(refused.body).not.toContain(root);
    } finally {
      bindingPresent = true;
    }
    const accepted = await upload(jpeg);
    expect(accepted.statusCode).toBe(201);
    const id = (accepted.json() as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(root, 'originals', `${id}.jpg`))).toEqual(jpeg);
  }, 10_000);
});
