import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AssetsService } from '../src/assets/assets.service.js';
import { registerAssetLockdown } from '../src/auth/asset-lockdown.js';
import { DatabaseService } from '../src/database/database.service.js';

describe('production asset lockdown before login activation', () => {
  let app: NestFastifyApplication;
  const resolveActor = vi.fn().mockResolvedValue(null);

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .compile();
    app = fixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        routerOptions: { ignoreTrailingSlash: true },
        multipart: true,
      }),
    );
    registerAssetLockdown(app, resolveActor);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => app.close());

  it('does not mount the legacy asset service in AppModule', () => {
    expect(() => app.get(AssetsService)).toThrow();
  });

  it.each([
    ['GET', '/api/v1/assets'],
    ['GET', '/api/v1/assets/'],
    ['GET', '/api/v1/assets/id/original?x=1'],
    ['GET', '/api/v1/assets/id/thumbnail'],
    ['GET', '/api/v1/assets/unknown/nested'],
    ['POST', '/api/v1/assets/upload'],
    ['HEAD', '/api/v1/assets/id/original'],
  ] as const)(
    'rejects anonymous %s %s before route or multipart work',
    async (method, url) => {
      resolveActor.mockResolvedValue(null);
      const response = await app.inject({
        method,
        url,
        headers: { range: 'bytes=0-5' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-range']).toBeUndefined();
      if (method === 'HEAD') expect(response.body).toBe('');
      else
        expect(response.json()).toEqual({
          statusCode: 401,
          message: 'Unauthorized',
          error: 'Unauthorized',
        });
    },
  );

  it('returns the same unavailable response to an authenticated user or administrator', async () => {
    resolveActor.mockResolvedValue({ id: 'user' });
    const user = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/id/original',
    });
    resolveActor.mockResolvedValue({ id: 'admin' });
    const admin = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/upload',
    });
    for (const response of [user, admin]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        statusCode: 503,
        message: 'Asset access is unavailable',
        error: 'Service Unavailable',
      });
    }
  });

  it('fails closed if session resolution fails', async () => {
    resolveActor.mockRejectedValueOnce(new Error('private database detail'));
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets' });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private database detail');
  });
});
