import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { LegacyAssetsTestModule } from './helpers/legacy-assets-test.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { assetAuthenticator, assetHeaders } from './helpers/asset-auth.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { MAX_UPLOAD_BYTES } from '../src/storage/image-limits.js';

function multipartBody(content: Buffer, mimeType = 'image/jpeg'): Buffer {
  const boundary = 'saefr-storage-test-boundary';

  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="photo.jpg"\r\n' +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('Image upload with isolated real storage (e2e)', () => {
  let root: string;
  let app: NestFastifyApplication;
  let createForActor: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-upload-http-test-'));
    createForActor = vi.fn().mockImplementation(async (_actor, asset) => ({
      status: 'committed',
      asset,
    }));

    const moduleFixture = await Test.createTestingModule({
      imports: [LegacyAssetsTestModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(RequestAuthenticator)
      .useValue(assetAuthenticator)
      .overrideProvider(AssetsRepository)
      .useValue({ createForActor })
      .overrideProvider(LocalStorageService)
      .useValue(
        new LocalStorageService(new ConfigService({ STORAGE_ROOT: root })),
      )
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ multipart: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function upload(content: Buffer, mimeType?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type':
          'multipart/form-data; boundary=saefr-storage-test-boundary',
      },
      payload: multipartBody(content, mimeType),
    });
  }

  async function expectNoFiles() {
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  }

  it('preserves uploaded original bytes exactly and creates a thumbnail', async () => {
    const original = await sharp({
      create: {
        width: 480,
        height: 320,
        channels: 3,
        background: '#224466',
      },
    })
      .jpeg()
      .toBuffer();

    const response = await upload(original);

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; size: number };
    expect(body.size).toBe(original.length);
    expect(await readFile(join(root, 'originals', `${body.id}.jpg`))).toEqual(
      original,
    );
    expect(
      (await sharp(join(root, 'thumbnails', `${body.id}.jpg`)).metadata())
        .format,
    ).toBe('jpeg');
    expect(createForActor).toHaveBeenCalledOnce();
  });

  it('rejects invalid image bytes without publishing files or metadata', async () => {
    const response = await upload(Buffer.from('not a JPEG'));

    expect(response.statusCode).toBe(415);
    expect(createForActor).not.toHaveBeenCalled();
    await expectNoFiles();
  });

  it('rejects an unsupported MIME type before writing files', async () => {
    const response = await upload(Buffer.from('<svg/>'), 'image/svg+xml');

    expect(response.statusCode).toBe(415);
    expect(createForActor).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects an oversized upload without publishing files or metadata', async () => {
    const response = await upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1));

    expect(response.statusCode).toBe(413);
    expect(createForActor).not.toHaveBeenCalled();
    await expectNoFiles();
  }, 10000);

  it('rejects truncated multipart data without publishing files', async () => {
    const original = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: '#224466',
      },
    })
      .jpeg()
      .toBuffer();
    const complete = multipartBody(original);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = await app.getUrl();
    const response = await fetch(`${origin}/api/v1/assets/upload`, {
      method: 'POST',
      headers: {
        ...assetHeaders(true),
        'content-type':
          'multipart/form-data; boundary=saefr-storage-test-boundary',
      },
      body: new Uint8Array(complete.subarray(0, complete.length - 4)),
      signal: AbortSignal.timeout(3000),
    });

    expect(response.status).toBe(400);
    expect(createForActor).not.toHaveBeenCalled();
    await expectNoFiles();
  }, 8000);

  it('removes the temporary file after a client disconnects mid-upload', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind a TCP port');
    }

    const socket = connect(address.port, '127.0.0.1');
    await once(socket, 'connect');

    try {
      socket.write(
        'POST /api/v1/assets/upload HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Cookie: saefr_session_dev=isolated-asset-session\r\n' +
          'Origin: http://127.0.0.1:3000\r\n' +
          'X-CSRF-Token: ' +
          assetHeaders(true)['X-CSRF-Token'] +
          '\r\n' +
          'Content-Type: multipart/form-data; boundary=saefr-storage-test-boundary\r\n' +
          'Content-Length: 1048576\r\n\r\n' +
          '--saefr-storage-test-boundary\r\n' +
          'Content-Disposition: form-data; name="file"; filename="photo.jpg"\r\n' +
          'Content-Type: image/jpeg\r\n\r\n',
      );
      socket.write(Buffer.alloc(128 * 1024, 0x41));

      await vi.waitFor(
        async () => {
          const files = await readdir(join(root, 'originals')).catch(() => []);
          expect(files.some((file) => file.endsWith('.uploading'))).toBe(true);
        },
        { timeout: 3000 },
      );
    } finally {
      socket.destroy();
    }

    await vi.waitFor(
      async () => {
        await expectNoFiles();
      },
      { timeout: 3000 },
    );
    expect(createForActor).not.toHaveBeenCalled();
  }, 8000);

  it('compensates for a database insert failure without deleting other media', async () => {
    const sentinel = join(root, 'unrelated.txt');
    const original = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: '#224466',
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(sentinel, 'keep me');
    createForActor.mockResolvedValueOnce({
      status: 'rolled_back',
      error: new Error('Simulated database failure'),
    });

    const response = await upload(original);

    expect(response.statusCode).toBe(500);
    expect(createForActor).toHaveBeenCalledOnce();
    await expectNoFiles();
    expect(await readFile(sentinel, 'utf8')).toBe('keep me');
  });
});
