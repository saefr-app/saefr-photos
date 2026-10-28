import { Test } from '@nestjs/testing';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AssetsService } from '../src/assets/assets.service.js';
import { registerAssetAccess } from '../src/auth/asset-lockdown.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { assetActor } from './helpers/asset-auth.js';
import { DatabaseService } from '../src/database/database.service.js';

describe('production early asset authorization', () => {
  let app: NestFastifyApplication;
  const resolveActor = vi.fn().mockResolvedValue(null);

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(RequestAuthenticator)
      .useValue({ resolve: resolveActor })
      .overrideProvider(AssetsService)
      .useValue({
        findPage: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      })
      .compile();
    app =
      fixture.createNestApplication<NestFastifyApplication>(
        createHttpAdapter(),
      );
    registerAssetAccess(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => app.close());

  it('mounts the scoped asset service in AppModule', () => {
    expect(app.get(AssetsService)).toBeDefined();
  });

  it.each([
    ['GET', '/api/v1/assets'],
    ['GET', '/api/v1/assets/'],
    ['GET', '/api/v1/%61ssets'],
    ['GET', '/api/v1/assets/id'],
    ['GET', '/api/v1/assets/id/original?x=1'],
    ['GET', '/api/v1/assets/id/thumbnail'],
    ['GET', '/api/v1/assets/unknown/nested'],
    ['POST', '/api/v1/assets/upload'],
    ['POST', '/api/v1/assets/upload/'],
    ['HEAD', '/api/v1/assets/id/original'],
    ['HEAD', '/api/v1/assets/id/thumbnail'],
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

  it('permits unrestricted users/admins and rejects restricted accounts before parsing', async () => {
    for (const role of ['user', 'admin'] as const) {
      resolveActor.mockResolvedValue({ ...assetActor, role });
      const list = await app.inject({ method: 'GET', url: '/api/v1/assets/' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ items: [], next_cursor: null });
      resolveActor.mockResolvedValue({
        ...assetActor,
        role,
        passwordChangeRequired: true,
      });
      const upload = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/upload',
        headers: { 'content-type': 'multipart/form-data; boundary=bad' },
        payload: 'incomplete',
      });
      expect(upload.statusCode).toBe(403);
      expect(upload.json()).toEqual({
        statusCode: 403,
        message: 'Forbidden',
        error: 'Forbidden',
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
