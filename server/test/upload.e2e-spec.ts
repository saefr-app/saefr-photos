import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { LegacyAssetsTestModule } from './helpers/legacy-assets-test.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { assetAuthenticator, assetHeaders } from './helpers/asset-auth.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { MAX_UPLOAD_BYTES } from '../src/storage/image-limits.js';

function multipartBody(
  field: string,
  filename: string,
  mimeType: string,
  content: Buffer,
): Buffer {
  const boundary = 'saefr-test-boundary';

  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('Image upload API (e2e)', () => {
  let app: NestFastifyApplication;

  const saveImage = vi
    .fn()
    .mockImplementation(
      async (
        id: string,
        mimeType: string,
        stream: AsyncIterable<Buffer>,
        verifyComplete?: () => Promise<void>,
      ) => {
        let size = 0;

        for await (const chunk of stream) {
          size += Buffer.from(chunk).length;
        }

        await verifyComplete?.();

        return {
          storagePath: `/storage/originals/${id}.jpg`,
          mimeType,
          size,
        };
      },
    );

  const createForActor = vi.fn().mockImplementation(async (_actor, asset) => ({
    status: 'committed',
    asset,
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [LegacyAssetsTestModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({
        ping: vi.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(RequestAuthenticator)
      .useValue(assetAuthenticator)
      .overrideProvider(AssetsRepository)
      .useValue({
        assertIdAvailableForPublication: vi.fn().mockResolvedValue(undefined),
        createForActor,
      })
      .overrideProvider(LocalStorageService)
      .useValue({
        saveImage,
        deleteImage: vi.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        multipart: true,
        routerOptions: {
          ignoreTrailingSlash: true,
        },
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a multipart upload and returns 201', async () => {
    const content = Buffer.from('test image bytes');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type': 'multipart/form-data; boundary=saefr-test-boundary',
      },
      payload: multipartBody('file', 'holiday.jpg', 'image/jpeg', content),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      filename: 'holiday.jpg',
      mime_type: 'image/jpeg',
      size: content.length,
    });

    expect(response.json()).toHaveProperty('id');
    expect(response.json()).not.toHaveProperty('storage_path');
    expect(saveImage).toHaveBeenCalledOnce();
    expect(createForActor).toHaveBeenCalledOnce();
  });

  it('rejects an unexpected file field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type': 'multipart/form-data; boundary=saefr-test-boundary',
      },
      payload: multipartBody(
        'wrong_field',
        'holiday.jpg',
        'image/jpeg',
        Buffer.from('test'),
      ),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a file larger than 20 MiB before creating metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type': 'multipart/form-data; boundary=saefr-test-boundary',
      },
      payload: multipartBody(
        'file',
        'large.jpg',
        'image/jpeg',
        Buffer.alloc(MAX_UPLOAD_BYTES + 1),
      ),
    });

    expect(response.statusCode).toBe(413);
    expect(createForActor).not.toHaveBeenCalled();
  });

  it('rejects a multipart request without a boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type': 'multipart/form-data',
      },
      payload: Buffer.from('incomplete form'),
    });

    expect(response.statusCode).toBe(400);
    expect(createForActor).not.toHaveBeenCalled();
  });

  it('rejects an extra multipart part after the image', async () => {
    const complete = multipartBody(
      'file',
      'holiday.jpg',
      'image/jpeg',
      Buffer.from('test image bytes'),
    );
    const extra = Buffer.concat([
      complete.subarray(0, complete.length - 4),
      Buffer.from(
        '\r\n--saefr-test-boundary\r\n' +
          'Content-Disposition: form-data; name="extra"\r\n\r\n' +
          'value\r\n--saefr-test-boundary--\r\n',
      ),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
        ...assetHeaders(true),
        'content-type': 'multipart/form-data; boundary=saefr-test-boundary',
      },
      payload: extra,
    });

    expect(response.statusCode).toBe(400);
    expect(createForActor).not.toHaveBeenCalled();
  });
});
