import { Readable } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LegacyAssetsTestModule } from './helpers/legacy-assets-test.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';

const asset = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  filename: 'holiday.jpg',
  mime_type: 'image/jpeg',
  size: 2450000,
  storage_path: '/storage/originals/550e8400-e29b-41d4-a716-446655440000.jpg',
  created_at: new Date('2026-10-15T12:00:00.000Z'),
};

const originalBytes = Buffer.from('original image bytes');
const thumbnailBytes = Buffer.from('thumbnail image bytes');

describe('Assets API (e2e)', () => {
  let app: NestFastifyApplication;

  const findAll = vi.fn().mockResolvedValue([asset]);

  const findById = vi.fn().mockImplementation(async (id: string) => {
    return id === asset.id ? asset : undefined;
  });

  const findFileById = vi.fn().mockImplementation(async (id: string) => {
    return id === asset.id ? asset : undefined;
  });

  const openOriginal = vi.fn().mockImplementation(async () => ({
    stream: Readable.from([originalBytes]),
    size: originalBytes.length,
  }));

  const openThumbnail = vi.fn().mockImplementation(async () => ({
    stream: Readable.from([thumbnailBytes]),
    size: thumbnailBytes.length,
  }));

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [LegacyAssetsTestModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({
        ping: vi.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(AssetsRepository)
      .useValue({
        findAll,
        findById,
        findFileById,
      })
      .overrideProvider(LocalStorageService)
      .useValue({
        openOriginal,
        openThumbnail,
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

  it('lists asset metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: asset.id,
        filename: asset.filename,
        mime_type: asset.mime_type,
        size: asset.size,
        created_at: '2026-10-15T12:00:00.000Z',
      },
    ]);

    expect(response.json()[0]).not.toHaveProperty('storage_path');
  });

  it('supports the trailing slash', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/',
    });

    expect(response.statusCode).toBe(200);
  });

  it('retrieves metadata by UUID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: asset.id,
      filename: asset.filename,
    });
  });

  it('returns 404 for an unknown asset', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/11111111-1111-4111-8111-111111111111',
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for an invalid UUID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
  });

  it('streams the original image', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/original`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload).toEqual(originalBytes);
  });

  it('streams the JPEG thumbnail', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/thumbnail`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.rawPayload).toEqual(thumbnailBytes);
  });

  it('returns 404 for a missing thumbnail file', async () => {
    openThumbnail.mockRejectedValueOnce(
      new NotFoundException('Asset file not found'),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/thumbnail`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for an unknown original image', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/11111111-1111-4111-8111-111111111111/original',
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects invalid UUIDs on file endpoints', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/invalid/thumbnail',
    });

    expect(response.statusCode).toBe(400);
  });
});
