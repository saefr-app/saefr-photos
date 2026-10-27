import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LegacyAssetsTestModule } from './helpers/legacy-assets-test.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { RequestAuthenticator } from '../src/auth/request-auth.js';
import { setupSwagger } from '../src/openapi/swagger.js';
import { assetAuthenticator, assetHeaders } from './helpers/asset-auth.js';

describe('Swagger documentation (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [LegacyAssetsTestModule],
    })
      .overrideProvider(RequestAuthenticator)
      .useValue(assetAuthenticator)
      .overrideProvider(DatabaseService)
      .useValue({
        ping: vi.fn().mockResolvedValue(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        routerOptions: {
          ignoreTrailingSlash: true,
        },
      }),
    );

    setupSwagger(app);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes the OpenAPI JSON document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: assetHeaders(),
    });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toMatchObject({
      info: {
        title: 'Saefr Photos API',
      },
      paths: {
        '/health': {
          get: {},
        },
        '/health/ready': {
          get: {},
        },
        '/api/v1/assets': {
          get: {},
        },
        '/api/v1/assets/upload': {
          post: {},
        },
        '/api/v1/assets/{assetId}': {
          get: {},
        },
        '/api/v1/assets/{assetId}/original': {
          get: {},
        },
        '/api/v1/assets/{assetId}/thumbnail': {
          get: {},
        },
      },
    });
  });

  it('documents multipart file uploads', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: assetHeaders(),
    });

    expect(response.json()).toMatchObject({
      paths: {
        '/api/v1/assets/upload': {
          post: {
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    required: ['file'],
                    properties: {
                      file: {
                        type: 'string',
                        format: 'binary',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('documents paginated gallery, Trash and pending-deletion responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs-json',
      headers: assetHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const document = response.json() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    for (const [path, schema] of [
      ['/api/v1/assets', 'AssetPageDto'],
      ['/api/v1/assets/trash', 'TrashPageDto'],
      ['/api/v1/assets/deletions', 'PendingDeletionPageDto'],
    ]) {
      expect(document.paths[path]).toMatchObject({
        get: {
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: { $ref: `#/components/schemas/${schema}` },
                },
              },
            },
          },
        },
      });
      expect(document.components.schemas[schema]).toMatchObject({
        properties: { items: { type: 'array' }, next_cursor: {} },
      });
    }
    expect(document.paths['/api/v1/assets/{assetId}/trash']).toMatchObject({
      post: { responses: { 200: {} } },
    });
    expect(document.paths['/api/v1/assets/{assetId}/restore']).toMatchObject({
      post: { responses: { 200: {} } },
    });
  });
});
