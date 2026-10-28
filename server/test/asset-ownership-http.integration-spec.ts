import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import sharp from 'sharp';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { registerAssetAccess } from '../src/auth/asset-lockdown.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { migrateToM11 } from './helpers/m11-schema.js';
import {
  AUTHENTICATION_MIGRATION,
  createMigrationProvider,
} from '../src/database/migrations/migration-provider.js';
import { testConfig } from './helpers/integration-database.js';

const origin = 'http://127.0.0.1:3000';
const password = 'isolated M11 HTTP test password';
const privateError = 'private credential /private/photos/secret.jpg SQL secret';
type Client = { id: string; cookie: string; csrf: string; sessionId: string };
type WireResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  complete: boolean;
};

describe('M11 production owner-scoped HTTP boundary over real sockets', () => {
  let admin: DatabaseService;
  let database: DatabaseService;
  let config: ConfigService;
  let app: NestFastifyApplication;
  let storage: LocalStorageService;
  let sessions: AuthSessionService;
  let root: string;
  let databaseName: string;
  let port: number;
  let image: Buffer;
  const parsing = vi.fn();
  const clients: Record<string, Client> = {};
  const assets: Record<string, string> = {};
  const envKeys = [
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'APP_ORIGIN',
    'NODE_ENV',
    'STORAGE_ROOT',
  ];
  const oldEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );

  function dbConfig(name: string) {
    return new ConfigService({
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: config.getOrThrow<number>('POSTGRES_PORT'),
      POSTGRES_DB: name,
      POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
      POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
    });
  }

  // Unlike fetch, node:http preserves the exact encoded request target.
  function request(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: Buffer | string;
      unfinished?: boolean;
      onData?: () => void;
    } = {},
  ): Promise<WireResponse> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers: options.headers,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            options.onData?.();
          });
          res.on('error', () => {
            /* premature response close is asserted below */
          });
          res.on('close', () => {
            req.destroy();
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks),
              complete: res.complete,
            });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () =>
        req.destroy(new Error('HTTP fixture timeout')),
      );
      if (options.unfinished) req.flushHeaders();
      else req.end(options.body);
    });
  }
  function headers(client = clients.a, unsafe = false) {
    return {
      Cookie: client.cookie,
      ...(unsafe ? { Origin: origin, 'X-CSRF-Token': client.csrf } : {}),
    };
  }
  function safe(response: WireResponse) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
  }
  function denied(response: WireResponse, status: number, head = false) {
    expect(response.status).toBe(status);
    safe(response);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    if (head) expect(response.body.length).toBe(0);
    else {
      expect(response.headers['content-length']).toBe(
        String(response.body.length),
      );
      expect(response.body.toString()).not.toMatch(
        /owner_id|storage_path|private|FST_ERR|SQL/,
      );
    }
  }
  function multipart(withOwner = false) {
    return Buffer.concat([
      Buffer.from(
        withOwner
          ? `--m11\r\nContent-Disposition: form-data; name="owner_id"\r\n\r\n${clients.b.id}\r\n`
          : '',
      ),
      Buffer.from(
        '--m11\r\nContent-Disposition: form-data; name="file"; filename="synthetic.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
      ),
      image,
      Buffer.from('\r\n--m11--\r\n'),
    ]);
  }
  async function m10(db: DatabaseService) {
    const result = await new Migrator({
      db: db.db,
      provider: createMigrationProvider(),
    }).migrateTo(AUTHENTICATION_MIGRATION);
    if (result.error) throw result.error;
  }

  beforeAll(async () => {
    config = testConfig(); // Exact Docker identity, tmpfs, credentials and loopback checks before SQL.
    admin = new DatabaseService(config);
    databaseName = `saefr_m11_http_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    database = new DatabaseService(dbConfig(databaseName));
    root = await mkdtemp(join(tmpdir(), 'saefr-m11-http-'));
    await m10(database);
    assets.legacy = randomUUID();
    // A genuine pre-M11 NULL row, never a disabled constraint or runtime bypass.
    await sql`insert into asset (id,filename,mime_type,size,storage_path,created_at) values (${assets.legacy}::uuid,'legacy-synthetic.jpg','image/jpeg',12,'synthetic-inert-path',now())`.execute(
      database.db,
    );
    await migrateToM11(database.db);
    for (const key of envKeys.filter((key) => key.startsWith('POSTGRES_')))
      process.env[key] = String(dbConfig(databaseName).getOrThrow(key));
    process.env.APP_ORIGIN = origin;
    process.env.NODE_ENV = 'test';
    process.env.STORAGE_ROOT = root;
    const { AppModule } = await import('../src/app.module.js');
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app =
      fixture.createNestApplication<NestFastifyApplication>(
        createHttpAdapter(),
      );
    registerAssetAccess(app);
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('preParsing', async (_request, _reply, payload) => {
        parsing();
        return payload;
      });
    sessions = app.get(AuthSessionService);
    storage = app.get(LocalStorageService);
    await sessions.assertReady();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string')
      throw new Error('No loopback listener');
    port = address.port;
    const hash = await new PasswordService().hash(password);
    image = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#3478ab' },
    })
      .jpeg()
      .toBuffer();
    for (const name of [
      'a',
      'b',
      'admin',
      'restricted',
      'disabled',
      'expired',
      'revoked',
    ]) {
      const id = randomUUID();
      const username = `fixture_${name}`;
      await database.db
        .insertInto('app_user')
        .values({
          id,
          username,
          password_hash: hash,
          role: name === 'admin' ? 'admin' : 'user',
          status: 'active',
          password_change_required: name === 'restricted',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      const issued = await sessions.login(username, password);
      clients[name] = {
        id,
        cookie: `saefr_session_dev=${issued.credential}`,
        csrf: issued.actor.csrfToken.toString('base64url'),
        sessionId: issued.actor.sessionId,
      };
      if (['a', 'b', 'admin'].includes(name)) {
        const assetId = randomUUID();
        assets[name] = assetId;
        const stored = await storage.saveImage(
          assetId,
          'image/jpeg',
          Readable.from(image),
        );
        await database.db
          .insertInto('asset')
          .values({
            id: assetId,
            owner_id: id,
            filename: `${name}-synthetic.jpg`,
            mime_type: 'image/jpeg',
            storage_path: stored.storagePath,
            size: stored.size,
            created_at: new Date(),
          })
          .execute();
      }
    }
    await database.db
      .updateTable('app_user')
      .set({ status: 'disabled' })
      .where('id', '=', clients.disabled.id)
      .execute();
    await sql`update auth_session set created_at=now()-interval '2 days', expires_at=now()-interval '1 day' where id=${clients.expired.sessionId}::uuid`.execute(
      database.db,
    );
    await database.db
      .deleteFrom('auth_session')
      .where('id', '=', clients.revoked.sessionId)
      .execute();
  }, 30000);

  afterEach(() => {
    vi.restoreAllMocks();
    parsing.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    await database?.onModuleDestroy();
    if (databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
    if (root) await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(['a', 'b', 'admin'])(
    '%s lists and reads only personally owned photographs',
    async (name) => {
      const client = clients[name];
      const list = await request('/api/v1/assets/', {
        headers: headers(client),
      });
      expect(list.status).toBe(200);
      safe(list);
      const page = JSON.parse(list.body.toString()) as {
        items: Array<{ id: string; lifecycle_version: string }>;
        next_cursor: string | null;
      };
      expect(page.items.map((row) => row.id)).toEqual([assets[name]]);
      expect(page.items[0].lifecycle_version).toBe('0');
      expect(page.next_cursor).toBeNull();
      for (const suffix of ['', '/original', '/thumbnail']) {
        const res = await request(`/api/v1/assets/${assets[name]}${suffix}`, {
          headers: headers(client),
        });
        expect(res.status).toBe(200);
        safe(res);
        if (suffix) {
          expect(res.headers['content-type']).toBe('image/jpeg');
          expect(res.headers['content-disposition']).toBe('inline');
          expect(Number(res.headers['content-length'])).toBe(res.body.length);
          if (suffix === '/original') expect(res.body).toEqual(image);
          else expect((await sharp(res.body).metadata()).format).toBe('jpeg');
        } else
          expect(Object.keys(JSON.parse(res.body.toString())).sort()).toEqual([
            'created_at',
            'filename',
            'id',
            'mime_type',
            'size',
          ]);
      }
    },
  );

  it.each(['a', 'b', 'admin'])(
    '%s gets identical foreign, legacy and missing denials without opening files',
    async (name) => {
      const original = vi.spyOn(storage, 'openOriginal');
      const thumbnail = vi.spyOn(storage, 'openThumbnail');
      const foreign = name === 'a' ? assets.b : assets.a;
      for (const method of ['GET', 'HEAD'])
        for (const suffix of ['', '/original', '/thumbnail']) {
          const responses = [];
          for (const id of [foreign, assets.legacy, randomUUID()]) {
            const res = await request(`/api/v1/assets/${id}${suffix}`, {
              method,
              headers: { ...headers(clients[name]), Range: 'bytes=0-1' },
            });
            denied(res, 404, method === 'HEAD');
            responses.push(res);
            if (method === 'GET')
              expect(JSON.parse(res.body.toString())).toEqual({
                statusCode: 404,
                message: 'Asset not found',
                error: 'Not Found',
              });
          }
          expect(
            new Set(responses.map((res) => res.body.toString())).size,
          ).toBe(1);
          expect(
            new Set(responses.map((res) => res.headers['content-length'])).size,
          ).toBe(1);
        }
      expect(original).not.toHaveBeenCalled();
      expect(thumbnail).not.toHaveBeenCalled();
    },
  );

  it.each([
    'anonymous',
    'disabled',
    'expired',
    'revoked',
    'invalid',
    'duplicate',
    'bearer',
    'proxy',
    'restricted',
  ])(
    'rejects %s before any asset SQL, storage or unfinished multipart body',
    async (name) => {
      const h: Record<string, string> =
        name === 'anonymous' ? {} : headers(clients[name] ?? clients.a);
      if (name === 'invalid') h.Cookie = 'saefr_session_dev=invalid';
      if (name === 'duplicate') h.Cookie += `; ${clients.a.cookie}`;
      if (name === 'bearer') h.Authorization = 'Bearer synthetic-private-token';
      if (name === 'proxy')
        h['Proxy-Authorization'] = 'Basic synthetic-private-token';
      const repo = app.get(AssetsRepository);
      const reads = [
        vi.spyOn(repo, 'findAll'),
        vi.spyOn(repo, 'findById'),
        vi.spyOn(repo, 'findFileById'),
      ];
      const opens = [
        vi.spyOn(storage, 'openOriginal'),
        vi.spyOn(storage, 'openThumbnail'),
        vi.spyOn(storage, 'saveImage'),
      ];
      parsing.mockClear();
      for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
        const res = await request(
          method === 'POST'
            ? '/api/v1/assets/upload'
            : `/api/v1/assets/${assets.a}/original`,
          {
            method,
            headers: {
              ...h,
              'Content-Type': 'multipart/form-data; boundary=m11',
              'Content-Length': '1000000',
            },
            unfinished: true,
          },
        );
        denied(res, name === 'restricted' ? 403 : 401, method === 'HEAD');
      }
      expect(parsing).not.toHaveBeenCalled();
      for (const spy of [...reads, ...opens])
        expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    'missing-origin',
    'null-origin',
    'wrong-origin',
    'malformed-origin',
    'missing-csrf',
    'malformed-csrf',
    'wrong-csrf',
  ])(
    'rejects %s before parsing uploads and unknown unsafe namespace operations',
    async (kind) => {
      const h: Record<string, string> = headers(clients.a, true);
      if (kind === 'missing-origin') delete h.Origin;
      if (kind === 'null-origin') h.Origin = 'null';
      if (kind === 'wrong-origin') h.Origin = 'http://localhost:3000';
      if (kind === 'malformed-origin') h.Origin = origin + ',' + origin;
      if (kind === 'missing-csrf') delete h['X-CSRF-Token'];
      if (kind === 'malformed-csrf') h['X-CSRF-Token'] = '%%%';
      if (kind === 'wrong-csrf') h['X-CSRF-Token'] = clients.b.csrf;
      parsing.mockClear();
      const save = vi.spyOn(storage, 'saveImage');
      for (const [method, path] of [
        ['POST', '/api/v1/assets/upload/'],
        ['DELETE', '/api/v1/%61ssets/unknown/nested'],
        ['OPTIONS', '/api/v1/assets'],
        ['PATCH', 'http://127.0.0.1/api/v1/assets/unknown/nested'],
      ]) {
        const res = await request(path, {
          method,
          headers: {
            ...h,
            'Content-Type': 'multipart/form-data; boundary=bad',
            'Content-Length': '1000000',
          },
          unfinished: true,
        });
        denied(res, 403);
      }
      expect(save).not.toHaveBeenCalled();
      expect(parsing).not.toHaveBeenCalled();
    },
  );

  it('uses the historical M11 asset table for prepublication checks without a journal', async () => {
    const repository = app.get(AssetsRepository);
    await expect(
      repository.assertIdAvailableForPublication(randomUUID()),
    ).resolves.toBeUndefined();
    await expect(
      repository.assertIdAvailableForPublication(assets.a),
    ).rejects.toThrow('Asset identifier unavailable');
  });

  it('owns uploaded bytes from the actor, ignores forged headers/query and rejects owner fields', async () => {
    const res = await request(
      `/api/v1/assets/upload?owner_id=${clients.b.id}`,
      {
        method: 'POST',
        headers: {
          ...headers(clients.a, true),
          'X-Owner-Id': clients.b.id,
          'X-User-Id': clients.admin.id,
          'Content-Type': 'multipart/form-data; boundary=m11',
        },
        body: multipart(),
      },
    );
    expect(res.status).toBe(201);
    safe(res);
    const dto = JSON.parse(res.body.toString()) as { id: string };
    const row = await database.db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', dto.id)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(clients.a.id);
    expect(await readFile(join(root, 'originals', `${dto.id}.jpg`))).toEqual(
      image,
    );
    expect(
      (
        await request(`/api/v1/assets/${dto.id}/original`, {
          headers: headers(clients.a),
        })
      ).body,
    ).toEqual(image);
    denied(
      await request(`/api/v1/assets/${dto.id}/original`, {
        headers: headers(clients.b),
      }),
      404,
    );
    const before = await database.db.selectFrom('asset').select('id').execute();
    denied(
      await request('/api/v1/assets/upload', {
        method: 'POST',
        headers: {
          ...headers(clients.a, true),
          'Content-Type': 'multipart/form-data; boundary=m11',
        },
        body: multipart(true),
      }),
      400,
    );
    expect(
      await database.db.selectFrom('asset').select('id').execute(),
    ).toEqual(before);
  });

  it('uses one session lookup per asset request while keeping the guard active', async () => {
    const lookup = vi.spyOn(sessions, 'resolve');
    const res = await request('/api/v1/assets', { headers: headers() });
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('applies HEAD fallback to every GET route and ignores authorized Range', async () => {
    for (const path of [
      '/api/v1/assets',
      `/api/v1/assets/${assets.a}`,
      `/api/v1/assets/${assets.a}/original`,
      `/api/v1/assets/${assets.a}/thumbnail`,
    ]) {
      const get = await request(path, {
        headers: { ...headers(), Range: 'bytes=0-1' },
      });
      expect(get.status).toBe(200);
      safe(get);
      const head = await request(path, {
        method: 'HEAD',
        headers: { ...headers(), Range: 'bytes=999999-' },
      });
      expect(head.status).toBe(200);
      safe(head);
      expect(head.body.length).toBe(0);
      expect(head.headers['content-length']).toBe(
        get.headers['content-length'],
      );
      if (path.endsWith('/original')) expect(get.body).toEqual(image);
    }
  });

  it('enforces matched encoded and trailing-slash aliases, query strings and malformed identifiers', async () => {
    for (const path of [
      '/api/v1/%61ssets/',
      `/api/v1/assets/${assets.a}/%6friginal/?ignored=1`,
      `/api/v1/assets/${assets.a.replace('-', '%2D')}/thumbnail`,
      '/api/v1/assets/?owner_id=ignored',
      'http://127.0.0.1/api/v1/%61ssets/',
    ]) {
      denied(await request(path), 401);
      expect((await request(path, { headers: headers() })).status).toBe(
        path.includes('owner_id=') ? 400 : 200,
      );
    }
    denied(await request('/api/v1/assets/not-a-uuid'), 401);
    denied(
      await request('/api/v1/assets/not-a-uuid', { headers: headers() }),
      400,
    );
    for (const path of [
      '/api/v1/assets%2Fupload',
      '/api/v1/%2561ssets',
      '/api//v1/assets',
    ]) {
      const res = await request(path, { headers: headers() });
      expect(res.status).toBe(404);
    }
    for (const path of ['/api/v1/assets/unknown/nested', '/api/v1/assets/']) {
      denied(
        await request(path, {
          method: 'DELETE',
          headers: headers(clients.a, true),
        }),
        404,
      );
    }
  });

  it('sanitizes malformed router URLs before hooks and file work', async () => {
    const open = vi.spyOn(storage, 'openOriginal');
    for (const path of [
      '/api/v1/assets/%ZZ/original',
      '/api/v1/%E0%A4/assets',
      '/api/v1/assets/%/private',
    ]) {
      const res = await request(path);
      denied(res, 400);
      expect(JSON.parse(res.body.toString())).toEqual({
        statusCode: 400,
        message: 'Bad Request',
        error: 'Bad Request',
      });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('returns sanitized 503 on authentication database failure before parsing', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    vi.spyOn(sessions, 'resolve').mockRejectedValueOnce(
      new Error(privateError),
    );
    const save = vi.spyOn(storage, 'saveImage');
    const res = await request('/api/v1/assets/upload', {
      method: 'POST',
      headers: { ...headers(clients.a, true), 'Content-Length': '1000' },
      unfinished: true,
    });
    denied(res, 503);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.parse(res.body.toString())).toEqual({
      statusCode: 503,
      message: 'Database unavailable',
      error: 'Service Unavailable',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateError);
  });

  it.each(['original', 'thumbnail'] as const)(
    'sanitizes early %s stream failures without stale media headers',
    async (kind) => {
      const log = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      vi.spyOn(
        storage,
        kind === 'original' ? 'openOriginal' : 'openThumbnail',
      ).mockResolvedValueOnce({
        size: 987654,
        stream: new Readable({
          read() {
            this.destroy(new Error(privateError));
          },
        }),
      });
      const res = await request(`/api/v1/assets/${assets.a}/${kind}`, {
        headers: headers(),
      });
      denied(res, 500);
      expect(res.complete).toBe(true);
      expect(JSON.parse(res.body.toString())).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateError);
    },
  );

  it('terminates a started stream without a second response or unhandled exception', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const stream = new PassThrough();
    vi.spyOn(storage, 'openOriginal').mockResolvedValueOnce({
      size: 987654,
      stream,
    });
    try {
      const pending = request(`/api/v1/assets/${assets.a}/original`, {
        headers: headers(),
        onData: () => stream.destroy(new Error(privateError)),
      });
      stream.write('first-private-fixture-bytes');
      const res = await pending;
      expect(res.status).toBe(200);
      safe(res);
      expect(res.complete).toBe(false);
      expect(res.body.toString()).toBe('first-private-fixture-bytes');
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateError);
      expect((await request('/health')).status).toBe(200);
    } finally {
      stream.destroy();
    }
  });

  it('reports route capability only for unrestricted actors', async () => {
    for (const name of ['a', 'admin', 'restricted']) {
      const res = await request('/api/v1/me', {
        headers: headers(clients[name]),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body.toString()).assetsAvailable).toBe(
        name !== 'restricted',
      );
    }
  });

  it.each(['M10-only', 'valid-M11', 'partial-M11', 'tampered-ledger'])(
    'actual bootstrap for %s never migrates or changes records',
    async (state) => {
      const name = `saefr_m11_boot_${randomUUID().replaceAll('-', '')}`;
      await sql`create database ${sql.id(name)}`.execute(admin.db);
      const db = new DatabaseService(dbConfig(name));
      try {
        await m10(db);
        const legacyId = '00000000-0000-4000-8000-000000000011';
        const ownedId = '00000000-0000-4000-8000-000000000022';
        const userId = '00000000-0000-4000-8000-000000000033';
        const sessionId = '00000000-0000-4000-8000-000000000044';
        const createdAt = new Date('2026-10-01T12:00:00.000Z');
        const updatedAt = new Date('2026-10-02T12:00:00.000Z');
        const expiresAt = new Date('2027-10-01T12:00:00.000Z');
        // Seed the historical row before M11 installs its enforced NOT VALID
        // check. No fixture bypasses the resulting ownership constraint.
        await sql`insert into asset (id,filename,mime_type,size,storage_path,created_at)
          values (${legacyId}::uuid,'startup-legacy.jpg','image/jpeg',17,'synthetic/legacy-original.jpg',${createdAt})`.execute(
          db.db,
        );
        await db.db
          .insertInto('app_user')
          .values({
            id: userId,
            username: 'startup_fixture_user',
            password_hash: 'synthetic-startup-hash',
            role: 'user',
            status: 'active',
            password_change_required: false,
            created_at: createdAt,
            updated_at: updatedAt,
          })
          .execute();
        await db.db
          .insertInto('auth_session')
          .values({
            id: sessionId,
            user_id: userId,
            token_hash: Buffer.alloc(32, 0x11),
            csrf_token: Buffer.alloc(32, 0x22),
            created_at: createdAt,
            expires_at: expiresAt,
          })
          .execute();
        if (state !== 'M10-only') await migrateToM11(db.db);
        if (state !== 'M10-only')
          await db.db
            .insertInto('asset')
            .values({
              id: ownedId,
              owner_id: userId,
              filename: 'startup-owned.jpg',
              mime_type: 'image/jpeg',
              size: 29,
              storage_path: 'synthetic/owned-original.jpg',
              created_at: updatedAt,
            })
            .execute();
        if (state === 'partial-M11')
          await sql`drop index asset_owner_created_id_idx`.execute(db.db);
        if (state === 'tampered-ledger')
          await sql`update kysely_migration set timestamp='not-a-timestamp' where name=${AUTHENTICATION_MIGRATION}`.execute(
            db.db,
          );
        const snapshot = async () => ({
          ledger: (
            await sql`select * from kysely_migration order by name`.execute(
              db.db,
            )
          ).rows,
          lock: (await sql`select * from kysely_migration_lock`.execute(db.db))
            .rows,
          columns: (
            await sql`select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position`.execute(
              db.db,
            )
          ).rows,
          constraints: (
            await sql`select conname,pg_get_constraintdef(oid) as definition,convalidated from pg_constraint where connamespace='public'::regnamespace order by conname`.execute(
              db.db,
            )
          ).rows,
          indexes: (
            await sql`select indexname,indexdef from pg_indexes where schemaname='public' order by indexname`.execute(
              db.db,
            )
          ).rows,
          assets: await db.db
            .selectFrom('asset')
            .selectAll()
            .orderBy('id')
            .execute(),
          users: await db.db
            .selectFrom('app_user')
            .selectAll()
            .orderBy('id')
            .execute(),
          sessions: await db.db
            .selectFrom('auth_session')
            .selectAll()
            .orderBy('id')
            .execute(),
        });
        const before = await snapshot();
        expect(before.assets).toHaveLength(state === 'M10-only' ? 1 : 2);
        expect(before.users).toHaveLength(1);
        expect(before.sessions).toHaveLength(1);
        expect(before.assets.find((asset) => asset.id === legacyId)).toEqual(
          expect.objectContaining({
            id: legacyId,
            storage_path: 'synthetic/legacy-original.jpg',
            created_at: createdAt,
            ...(state === 'M10-only' ? {} : { owner_id: null }),
          }),
        );
        expect(before.users[0]).toEqual(
          expect.objectContaining({
            id: userId,
            created_at: createdAt,
            updated_at: updatedAt,
          }),
        );
        expect(before.sessions[0]).toEqual(
          expect.objectContaining({
            id: sessionId,
            user_id: userId,
            created_at: createdAt,
            expires_at: expiresAt,
          }),
        );
        if (state === 'M10-only') {
          expect(Object.hasOwn(before.assets[0], 'owner_id')).toBe(false);
        } else {
          expect(before.assets.find((asset) => asset.id === ownedId)).toEqual(
            expect.objectContaining({
              id: ownedId,
              owner_id: userId,
              storage_path: 'synthetic/owned-original.jpg',
              created_at: updatedAt,
            }),
          );
        }
        const reserved = createServer();
        await new Promise<void>((resolve) =>
          reserved.listen(0, '127.0.0.1', resolve),
        );
        const address = reserved.address();
        if (!address || typeof address === 'string')
          throw new Error('No test port');
        const bootPort = address.port;
        await new Promise<void>((resolve) => reserved.close(() => resolve()));
        const child = spawn(process.execPath, ['dist/main.js'], {
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: String(bootPort),
            APP_ORIGIN: origin,
            STORAGE_ROOT: root,
            POSTGRES_HOST: '127.0.0.1',
            POSTGRES_PORT: String(config.getOrThrow('POSTGRES_PORT')),
            POSTGRES_DB: name,
            POSTGRES_USER: config.getOrThrow('POSTGRES_USER'),
            POSTGRES_PASSWORD: config.getOrThrow('POSTGRES_PASSWORD'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        let exited = false;
        const closed = new Promise<number | null>((resolve) =>
          child.once('close', (code) => {
            exited = true;
            resolve(code);
          }),
        );
        let listened = false;
        try {
          await vi.waitFor(
            async () => {
              try {
                const res = await fetch(`http://127.0.0.1:${bootPort}/health`, {
                  signal: AbortSignal.timeout(250),
                });
                listened ||= res.status === 200;
              } catch {
                /* startup not listening */
              }
              expect(exited || listened).toBe(true);
            },
            { timeout: 10000, interval: 20 },
          );
          if (state === 'valid-M11') {
            expect(listened).toBe(true);
            child.kill('SIGTERM');
          } else {
            expect(listened).toBe(false);
            expect(await closed).toBe(1);
            expect(output).toContain('Application startup failed');
          }
          await vi.waitFor(() => expect(exited).toBe(true), { timeout: 5000 });
          expect(await snapshot()).toEqual(before);
          expect(output).not.toContain(config.getOrThrow('POSTGRES_PASSWORD'));
          expect(output).not.toContain(name);
        } finally {
          if (!exited) {
            child.kill('SIGKILL');
            await closed;
          }
        }
      } finally {
        await db.onModuleDestroy();
        await sql`drop database ${sql.id(name)}`.execute(admin.db);
      }
    },
    20000,
  );
});
