import { connect } from 'node:net';
import { PassThrough, Readable } from 'node:stream';

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

import { LegacyAssetsTestModule } from './helpers/legacy-assets-test.module.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { assetAuthenticator, assetHeaders } from './helpers/asset-auth.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';

const assetId = '550e8400-e29b-41d4-a716-446655440000';
const secret = 'password=private-value /private/photos/original.jpg';

describe('Safe HTTP errors (e2e)', () => {
  let app: NestFastifyApplication;
  const findPage = vi.fn();
  const findFileById = vi.fn();
  const openOriginal = vi.fn();
  const openThumbnail = vi.fn();
  const ping = vi.fn();
  let errorLog: ReturnType<typeof vi.spyOn>;
  let warningLog: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [LegacyAssetsTestModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ ping })
      .overrideProvider(RequestAuthenticator)
      .useValue(assetAuthenticator)
      .overrideProvider(AssetsRepository)
      .useValue({ findPage, findFileById })
      .overrideProvider(LocalStorageService)
      .useValue({ openOriginal, openThumbnail })
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
    findPage.mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: '28P01' }),
    );

    const response = await app.inject({
      headers: assetHeaders(),
      method: 'GET',
      url: '/api/v1/assets',
    });

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
      headers: assetHeaders(),
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

  it('sends safe JSON when a media stream fails before its first byte', async () => {
    findFileById.mockResolvedValueOnce({
      id: assetId,
      mime_type: 'image/jpeg',
      storage_path: '/private/photos/original.jpg',
    });
    const failure = Object.assign(new Error(secret), { code: 'EIO' });
    openOriginal.mockResolvedValueOnce({
      stream: new Readable({
        read() {
          this.destroy(failure);
        },
      }),
      size: 12345,
    });

    const response = await app.inject({
      headers: assetHeaders(),
      method: 'GET',
      url: `/api/v1/assets/${assetId}/original`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(Number(response.headers['content-length'])).toBe(
      Buffer.byteLength(response.body),
    );
    expect(response.json()).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('FST_ERR_REP_INVALID_PAYLOAD_TYPE');
    expect(errorLog).toHaveBeenCalledWith(
      'Request failure: GET /api/v1/assets/:assetId/original; EIO',
    );
  });

  it('closes an already started media response without sending JSON', async () => {
    findFileById.mockResolvedValueOnce({
      id: assetId,
      mime_type: 'image/jpeg',
      storage_path: '/private/photos/original.jpg',
    });
    const stream = new PassThrough();
    openOriginal.mockResolvedValueOnce({ stream, size: 12345 });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind a TCP port');
    }

    const socket = connect(address.port, '127.0.0.1');
    let received = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    socket.on('error', () => {
      // A reset is expected when an incomplete response is terminated.
    });

    try {
      socket.write(
        `GET /api/v1/assets/${assetId}/original HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Cookie: saefr_session_dev=isolated-asset-session\r\n' +
          'Connection: close\r\n\r\n',
      );
      stream.write('first');

      await vi.waitFor(() => {
        expect(received.toString()).toContain('\r\n\r\nfirst');
      });

      stream.destroy(new Error(secret));
      await vi.waitFor(() => {
        expect(socket.destroyed).toBe(true);
      });

      const wire = received.toString();
      expect(wire).toMatch(/^HTTP\/1\.1 200 /);
      expect(wire).toContain('first');
      expect(wire).not.toContain('HTTP/1.1 500');
      expect(wire).not.toContain('Internal server error');
      expect(wire).not.toContain(secret);
    } finally {
      socket.destroy();
      stream.destroy();
    }
  });

  it.each(['original', 'thumbnail'])(
    'preserves successful %s streaming',
    async (kind) => {
      const bytes = Buffer.from('successful-private-image-bytes');
      findFileById.mockResolvedValueOnce({
        id: assetId,
        mime_type: 'image/jpeg',
        storage_path: '/private/photos/original.jpg',
      });
      const stored = { stream: Readable.from([bytes]), size: bytes.length };
      if (kind === 'original') {
        openOriginal.mockResolvedValueOnce(stored);
      } else {
        openThumbnail.mockResolvedValueOnce(stored);
      }

      const response = await app.inject({
        headers: assetHeaders(),
        method: 'GET',
        url: `/api/v1/assets/${assetId}/${kind}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(Number(response.headers['content-length'])).toBe(bytes.length);
      expect(response.rawPayload).toEqual(bytes);
    },
  );

  it('sanitizes an arbitrary HTTP exception message', async () => {
    findPage.mockRejectedValueOnce(new HttpException(secret, 400));

    const response = await app.inject({
      headers: assetHeaders(),
      method: 'GET',
      url: '/api/v1/assets',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: 'Bad Request',
      error: 'Bad Request',
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('sanitizes a server-side HTTP exception message', async () => {
    findPage.mockRejectedValueOnce(new HttpException(secret, 500));

    const response = await app.inject({
      headers: assetHeaders(),
      method: 'GET',
      url: '/api/v1/assets',
    });

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

    const response = await app.inject({
      headers: assetHeaders(),
      method: 'GET',
      url: '/health/ready',
    });

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
      headers: assetHeaders(),
      method: 'GET',
      url: `/private/${encodeURIComponent(secret)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('private-value');
    expect(response.body).not.toContain('/private/photos');
  });
});
