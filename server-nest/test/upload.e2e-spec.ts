import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';

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
      async (id: string, mimeType: string, stream: AsyncIterable<Buffer>) => {
        let size = 0;

        for await (const chunk of stream) {
          size += Buffer.from(chunk).length;
        }

        return {
          storagePath: `/storage/originals/${id}.jpg`,
          mimeType,
          size,
        };
      },
    );

  const create = vi.fn().mockImplementation(async (asset) => asset);

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({
        ping: vi.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(AssetsRepository)
      .useValue({
        create,
      })
      .overrideProvider(LocalStorageService)
      .useValue({
        saveImage,
        deleteImage: vi.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
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
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects an unexpected file field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
      headers: {
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
});
