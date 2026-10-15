import {
  afterAll,
  beforeAll,
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

import { AppModule } from '../src/app.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { DatabaseService } from '../src/database/database.service.js';

const asset = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  filename: 'holiday.jpg',
  mime_type: 'image/jpeg',
  size: 2450000,
  created_at: new Date('2026-10-15T12:00:00.000Z'),
};

describe('Assets API (e2e)', () => {
  let app: NestFastifyApplication;

  const findAll = vi.fn().mockResolvedValue([asset]);

  const findById = vi.fn().mockImplementation(async (id: string) => {
    return id === asset.id ? asset : undefined;
  });

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
        findAll,
        findById,
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

  it('GET /api/v1/assets returns asset metadata', async () => {
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

  it('GET /api/v1/assets/:id returns one asset', async () => {
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

  it('returns 404 for a missing asset', async () => {
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
});
