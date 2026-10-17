import { HttpException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';

const assetId = '550e8400-e29b-41d4-a716-446655440000';
const secret = 'password=private-value /private/photos/original.jpg';

describe('Safe HTTP errors (e2e)', () => {
  let app: NestFastifyApplication;
  const findAll = vi.fn();
  const findFileById = vi.fn();
  const openOriginal = vi.fn();
  const ping = vi.fn();
  let errorLog: ReturnType<typeof vi.spyOn>;
  let warningLog: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ ping })
      .overrideProvider(AssetsRepository)
      .useValue({ findAll, findFileById })
      .overrideProvider(LocalStorageService)
      .useValue({ openOriginal })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    warningLog = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
    warningLog.mockRestore();
  });

  it('hides database error text while logging a safe route and code', async () => {
    findAll.mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: '28P01' }),
    );

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Request failure: GET /api/v1/assets; PostgreSQL authentication failure',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
    expect(response.body).not.toContain(secret);
  });

  it('hides filesystem paths from media errors', async () => {
    findFileById.mockResolvedValueOnce({
      id: assetId,
      mime_type: 'image/jpeg',
      storage_path: '/private/photos/original.jpg',
    });
    openOriginal.mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: 'EACCES' }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${assetId}/original`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secret);
    expect(errorLog).toHaveBeenCalledWith(
      'Request failure: GET /api/v1/assets/:assetId/original; EACCES',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(assetId);
  });

  it('sanitizes an arbitrary HTTP exception message', async () => {
    findAll.mockRejectedValueOnce(new HttpException(secret, 400));

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: 'Bad Request',
      error: 'Bad Request',
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('sanitizes a server-side HTTP exception message', async () => {
    findAll.mockRejectedValueOnce(new HttpException(secret, 500));

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secret);
    expect(response.json()).toMatchObject({
      statusCode: 500,
      message: 'Internal server error',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Request failure: GET /api/v1/assets; unclassified',
    );
  });

  it('keeps readiness errors safe and logs the database category', async () => {
    ping.mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: 'ECONNREFUSED' }),
    );

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      statusCode: 503,
      message: 'Database unavailable',
    });
    expect(warningLog).toHaveBeenCalledWith(
      'Readiness check failed; ECONNREFUSED',
    );
    expect(JSON.stringify(warningLog.mock.calls)).not.toContain(secret);
  });

  it('does not reflect an unknown request path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/private/${encodeURIComponent(secret)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('private-value');
    expect(response.body).not.toContain('/private/photos');
  });
});
