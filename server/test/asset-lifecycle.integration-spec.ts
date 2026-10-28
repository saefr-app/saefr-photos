import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { AssetsRepository } from '../src/assets/assets.repository.js';
import { lockAssetId } from '../src/assets/asset-id-coordination.js';
import { AssetsService } from '../src/assets/assets.service.js';
import {
  lifecycleEtag,
  parsePageQuery,
} from '../src/assets/asset-lifecycle-contract.js';
import type { AuthenticatedActor } from '../src/auth/auth-session.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { registerAssetAccess } from '../src/auth/asset-lockdown.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { testConfig } from './helpers/integration-database.js';

const owner = randomUUID();
const foreign = randomUUID();
const session = randomUUID();
const foreignSession = randomUUID();
const credential = randomBytes(32);
const foreignCredential = randomBytes(32);
const envKeys = [
  'APP_ORIGIN',
  'NODE_ENV',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
];
const oldEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);
const assetIds = [randomUUID(), randomUUID(), randomUUID()];

const actor: AuthenticatedActor = {
  userId: owner,
  username: 'lifecyclefixture',
  role: 'user',
  sessionId: session,
  expiresAt: new Date(Date.now() + 3_600_000),
  passwordChangeRequired: false,
  csrfToken: randomBytes(32),
};

describe('M12 owner-scoped lifecycle with disposable PostgreSQL', () => {
  let database: DatabaseService;
  let httpDatabase: DatabaseService;
  let repository: AssetsRepository;
  let service: AssetsService;
  let app: NestFastifyApplication;
  let baseUrl: string;
  const previewBytes = Buffer.from('synthetic preview');
  const openThumbnail = vi.fn().mockImplementation(async () => ({
    stream: Readable.from([previewBytes]),
    size: previewBytes.length,
  }));

  beforeAll(async () => {
    const config = testConfig();
    database = new DatabaseService(config);
    await migrateToLatest(database.db);
    for (const [id, username] of [
      [owner, 'lifecyclefixture'],
      [foreign, 'lifecycleforeign'],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          id,
          username,
          password_hash: 'synthetic-hash',
          role: 'user',
          status: 'active',
          password_change_required: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    }
    await database.db
      .insertInto('auth_session')
      .values({
        id: session,
        user_id: owner,
        token_hash: createHash('sha256').update(credential).digest(),
        csrf_token: actor.csrfToken,
        created_at: new Date(),
        expires_at: actor.expiresAt,
      })
      .execute();
    await database.db
      .insertInto('auth_session')
      .values({
        id: foreignSession,
        user_id: foreign,
        token_hash: createHash('sha256').update(foreignCredential).digest(),
        csrf_token: randomBytes(32),
        created_at: new Date(),
        expires_at: actor.expiresAt,
      })
      .execute();
    repository = new AssetsRepository(database);
    service = new AssetsService(repository, {
      openThumbnail: async () => {
        throw new Error('not used');
      },
    } as never);
    for (const key of envKeys.filter((entry) => entry.startsWith('POSTGRES_')))
      process.env[key] = String(config.getOrThrow(key));
    process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
    process.env.NODE_ENV = 'test';
    const { AppModule } = await import('../src/app.module.js');
    httpDatabase = new DatabaseService(config);
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(httpDatabase)
      .overrideProvider(LocalStorageService)
      .useValue({ openThumbnail })
      .compile();
    app =
      fixture.createNestApplication<NestFastifyApplication>(
        createHttpAdapter(),
      );
    registerAssetAccess(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string')
      throw new Error('No test socket');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await database.db
      .deleteFrom('asset_deletion')
      .where('owner_id', 'in', [owner, foreign])
      .execute();
    await database.db
      .deleteFrom('asset')
      .where('owner_id', 'in', [owner, foreign])
      .execute();
  });

  afterAll(async () => {
    await app?.close();
    await database?.db
      .deleteFrom('asset_deletion')
      .where('owner_id', 'in', [owner, foreign])
      .execute();
    await database?.db
      .deleteFrom('asset')
      .where('owner_id', 'in', [owner, foreign])
      .execute();
    await database?.db
      .deleteFrom('auth_session')
      .where('id', 'in', [session, foreignSession])
      .execute();
    await database?.db
      .deleteFrom('app_user')
      .where('id', 'in', [owner, foreign])
      .execute();
    await database?.onModuleDestroy();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function headers(unsafe = false): Record<string, string> {
    return {
      Cookie: `saefr_session_dev=${credential.toString('base64url')}`,
      ...(unsafe
        ? {
            Origin: 'http://127.0.0.1:3000',
            'X-CSRF-Token': actor.csrfToken.toString('base64url'),
          }
        : {}),
    };
  }

  function foreignHeaders(): Record<string, string> {
    return {
      Cookie: `saefr_session_dev=${foreignCredential.toString('base64url')}`,
    };
  }

  async function addAsset(
    id: string,
    ownerId = owner,
    created = '2026-10-26T10:00:00.123456Z',
    storagePath = '/synthetic/originals/synthetic.jpg',
  ) {
    await sql`insert into public.asset
      (id, owner_id, filename, mime_type, size, storage_path, created_at)
      values (${id}::uuid, ${ownerId}::uuid, 'synthetic.jpg', 'image/jpeg', 5,
        ${storagePath}, ${created}::timestamptz)`.execute(database.db);
  }

  it('paginates equal-time UUIDs and microseconds without gaps', async () => {
    const ids = [...assetIds].sort();
    await addAsset(ids[0], owner, '2026-10-26T10:00:00.123456Z');
    await addAsset(ids[1], owner, '2026-10-26T10:00:00.123456Z');
    await addAsset(ids[2], owner, '2026-10-26T10:00:00.123457Z');
    const first = await service.findPage(
      actor,
      'active',
      parsePageQuery('/api/v1/assets?limit=1', owner, 'active'),
    );
    expect(first.items.map((item) => item.id)).toEqual([ids[2]]);
    expect(first.next_cursor).toBeTypeOf('string');
    const second = await service.findPage(
      actor,
      'active',
      parsePageQuery(
        `/api/v1/assets?limit=1&cursor=${first.next_cursor}`,
        owner,
        'active',
      ),
    );
    expect(second.items.map((item) => item.id)).toEqual([ids[1]]);
    const third = await service.findPage(
      actor,
      'active',
      parsePageQuery(
        `/api/v1/assets?limit=1&cursor=${second.next_cursor}`,
        owner,
        'active',
      ),
    );
    expect(third.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(third.next_cursor).toBeNull();
    expect(
      await service.findPage({ ...actor, userId: foreign }, 'active', {
        limit: 50,
        cursor: null,
      }),
    ).toEqual({ items: [], next_cursor: null });
  });

  it('paginates Trash by timestamp and UUID without returning active assets', async () => {
    const ids = [...assetIds].sort();
    for (const id of ids) await addAsset(id);
    await sql`update public.asset set trashed_at = '2026-10-26T10:10:00.123456Z'::timestamptz
      where id in (${ids[0]}::uuid, ${ids[1]}::uuid)`.execute(database.db);
    const first = await service.findPage(actor, 'trash', {
      limit: 1,
      cursor: null,
    });
    expect(first.items.map((item) => item.id)).toEqual([ids[1]]);
    expect(first.items[0].trashed_at).toBe('2026-10-26T10:10:00.123456Z');
    const second = await service.findPage(
      actor,
      'trash',
      parsePageQuery(
        `/api/v1/assets/trash?limit=1&cursor=${first.next_cursor}`,
        owner,
        'trash',
      ),
    );
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.next_cursor).toBeNull();
  });

  it('applies one transition, rejects stale contenders and hides Trash from normal reads', async () => {
    const id = assetIds[0];
    const directory = await mkdtemp(join(tmpdir(), 'saefr-m12d-bytes-'));
    onTestFinished(async () => rm(directory, { recursive: true, force: true }));
    const originalPath = join(directory, 'original.jpg');
    const thumbnailPath = join(directory, 'thumbnail.jpg');
    const original = randomBytes(128);
    const thumbnail = randomBytes(64);
    await writeFile(originalPath, original);
    await writeFile(thumbnailPath, thumbnail);
    await addAsset(id, owner, undefined, originalPath);
    const tag = lifecycleEtag(id, '0');
    const outcomes = await Promise.allSettled([
      repository.transition(actor, id, 'trashed', tag),
      repository.transition(actor, id, 'trashed', tag),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const current = outcomes.find(
      (outcome) => outcome.status === 'fulfilled',
    ) as PromiseFulfilledResult<
      Awaited<ReturnType<typeof repository.transition>>
    >;
    expect(current.value.lifecycle_version).toBe('1');
    expect(current.value.trashed_timestamp).toMatch(/\.\d{6}Z$/);
    expect(await repository.findById(id, owner)).toBeUndefined();
    expect(await repository.findFileById(id, owner)).toBeUndefined();
    expect(await repository.findTrashFileById(id, owner)).toMatchObject({ id });
    expect(await readFile(originalPath)).toEqual(original);
    expect(await readFile(thumbnailPath)).toEqual(thumbnail);
    const trash = await service.findPage(actor, 'trash', {
      limit: 1,
      cursor: null,
    });
    expect(trash.items).toMatchObject([{ id, lifecycle_version: '1' }]);
    expect(trash.next_cursor).toBeNull();
    const same = await repository.transition(
      actor,
      id,
      'trashed',
      lifecycleEtag(id, '1'),
    );
    expect(same).toEqual(current.value);
    const restored = await repository.transition(
      actor,
      id,
      'active',
      lifecycleEtag(id, '1'),
    );
    expect(restored).toMatchObject({
      id,
      lifecycle_version: '2',
      trashed_timestamp: null,
    });
    expect(await repository.findById(id, owner)).toMatchObject({
      id,
      lifecycle_version: '2',
    });
    const unchanged = await database.db
      .selectFrom('asset')
      .select(['created_at', 'storage_path'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(unchanged.created_at.toISOString()).toBe('2026-10-26T10:00:00.123Z');
    expect(unchanged.storage_path).toBe(originalPath);
    expect(await readFile(originalPath)).toEqual(original);
    expect(await readFile(thumbnailPath)).toEqual(thumbnail);
  });

  it('requires owner access before ETag errors and lists only pending owned receipts', async () => {
    const id = assetIds[0];
    await addAsset(id);
    await expect(
      repository.transition(
        { ...actor, userId: foreign, sessionId: foreignSession },
        id,
        'trashed',
        undefined,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      repository.transition(actor, id, 'trashed', undefined),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      repository.transition(actor, id, 'trashed', '*'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.transition(actor, id, 'trashed', lifecycleEtag(id, '1')),
    ).rejects.toMatchObject({ status: 412 });
    const receiptId = randomUUID();
    await database.db
      .insertInto('asset_deletion')
      .values({
        asset_id: receiptId,
        owner_id: owner,
        accepted_lifecycle_version: '1',
        storage_id: randomUUID(),
        originals_binding_id: randomUUID(),
        thumbnails_binding_id: randomUUID(),
        storage_layout_version: 1,
        original_extension: '.jpg',
        requested_at: new Date(),
        completed_at: null,
        last_error_code: null,
        execution_token: null,
        execution_expires_at: null,
      })
      .execute();
    const page = await service.findPendingDeletions(actor, {
      limit: 1,
      cursor: null,
    });
    expect(page.items).toMatchObject([
      { asset_id: receiptId, status: 'pending', completed_at: null },
    ]);
    expect(page.next_cursor).toBeNull();
    expect(
      await service.findPendingDeletions(
        { ...actor, userId: foreign },
        { limit: 1, cursor: null },
      ),
    ).toEqual({ items: [], next_cursor: null });
  });

  it('refuses a transition after session expiry while waiting for the asset lock', async () => {
    const id = assetIds[0];
    await addAsset(id);
    const other = new DatabaseService(testConfig());
    let pending: ReturnType<AssetsRepository['transition']> | undefined;
    try {
      await sql`update public.auth_session set expires_at = clock_timestamp() + interval '3 seconds'
        where id = ${session}::uuid`.execute(database.db);
      await database.db.transaction().execute(async (transaction) => {
        await lockAssetId(transaction, id);
        pending = new AssetsRepository(other).transition(
          actor,
          id,
          'trashed',
          lifecycleEtag(id, '0'),
        );
        void pending.catch(() => undefined);
        await vi.waitFor(async () => {
          const waiting = await sql<{
            count: number;
          }>`select count(*)::integer as count
            from pg_stat_activity where datname = current_database()
              and wait_event_type = 'Lock' and query like '%pg_advisory_xact_lock%'`.execute(
            database.db,
          );
          expect(waiting.rows[0].count).toBeGreaterThanOrEqual(1);
        });
        await vi.waitFor(
          async () => {
            const clock = await sql<{
              expired: boolean;
            }>`select clock_timestamp() >= expires_at as expired
            from public.auth_session where id = ${session}::uuid`.execute(
              database.db,
            );
            expect(clock.rows[0].expired).toBe(true);
          },
          { timeout: 10_000 },
        );
      });
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(await repository.findById(id, owner)).toMatchObject({
        lifecycle_version: '0',
      });
    } finally {
      await pending?.catch(() => undefined);
      await sql`update public.auth_session set expires_at = clock_timestamp() + interval '1 hour'
        where id = ${session}::uuid`.execute(database.db);
      await other.onModuleDestroy();
    }
  }, 15_000);

  it('paginates pending receipts by PostgreSQL microseconds and excludes completed or foreign receipts', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const insert = async (
      id: string,
      ownerId: string,
      requested: string,
      completed: boolean,
    ) => {
      await sql`insert into public.asset_deletion
        (asset_id, owner_id, accepted_lifecycle_version, storage_id,
         originals_binding_id, thumbnails_binding_id, storage_layout_version,
         original_extension, requested_at, completed_at)
        values (${id}::uuid, ${ownerId}::uuid, 1,
          ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
          1, '.jpg', ${requested}::timestamptz,
          ${completed ? requested : null}::timestamptz)`.execute(database.db);
    };
    await insert(ids[0], owner, '2026-10-26T10:00:00.123456Z', false);
    await insert(ids[1], owner, '2026-10-26T10:00:00.123457Z', false);
    await insert(ids[2], foreign, '2026-10-26T10:00:00.123458Z', false);
    const completedId = randomUUID();
    await insert(completedId, owner, '2026-10-26T10:00:00.123459Z', true);
    const first = await service.findPendingDeletions(actor, {
      limit: 1,
      cursor: null,
    });
    expect(first.items.map((item) => item.asset_id)).toEqual([ids[1]]);
    expect(first.items[0].requested_at).toBe('2026-10-26T10:00:00.123457Z');
    const second = await service.findPendingDeletions(
      actor,
      parsePageQuery(
        `/api/v1/assets/deletions?limit=1&cursor=${first.next_cursor}`,
        owner,
        'pending-deletions',
      ),
    );
    expect(second.items.map((item) => item.asset_id)).toEqual([ids[0]]);
    expect(second.next_cursor).toBeNull();
  });

  it('serializes account disabling ahead of a lifecycle transition', async () => {
    const id = assetIds[0];
    await addAsset(id);
    const other = new DatabaseService(testConfig());
    let pending: ReturnType<AssetsRepository['transition']> | undefined;
    try {
      await database.db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('app_user')
          .select('id')
          .where('id', '=', owner)
          .forUpdate()
          .executeTakeFirstOrThrow();
        pending = new AssetsRepository(other).transition(
          actor,
          id,
          'trashed',
          lifecycleEtag(id, '0'),
        );
        void pending.catch(() => undefined);
        await vi.waitFor(async () => {
          const waiting = await sql<{
            count: number;
          }>`select count(*)::integer as count
            from pg_stat_activity where datname = current_database()
              and wait_event_type = 'Lock' and query like '%app_user%'`.execute(
            database.db,
          );
          expect(waiting.rows[0].count).toBeGreaterThanOrEqual(1);
        });
        await transaction
          .updateTable('app_user')
          .set({ status: 'disabled' })
          .where('id', '=', owner)
          .execute();
      });
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(await repository.findById(id, owner)).toMatchObject({
        lifecycle_version: '0',
      });
    } finally {
      await pending?.catch(() => undefined);
      await database.db
        .updateTable('app_user')
        .set({ status: 'active' })
        .where('id', '=', owner)
        .execute();
      await other.onModuleDestroy();
    }
  }, 15_000);

  it('enforces real-socket route precedence, preconditions, Trash privacy and private preview', async () => {
    const id = assetIds[0];
    await addAsset(id);
    const list = await fetch(`${baseUrl}/api/v1/assets?limit=1`, {
      headers: headers(),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ id, lifecycle_version: '0' }],
      next_cursor: null,
    });
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/trash/${id}/thumbnail`, {
          headers: headers(),
        })
      ).status,
    ).toBe(404);
    const invalid = await fetch(`${baseUrl}/api/v1/assets?limit=1&limit=2`, {
      headers: headers(),
    });
    expect(invalid.status).toBe(400);
    const before = await fetch(`${baseUrl}/api/v1/assets/${id}`, {
      headers: headers(),
    });
    expect(before.headers.get('etag')).toBe(lifecycleEtag(id, '0'));
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/trash`, {
          method: 'POST',
          headers: headers(true),
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/trash`, {
          method: 'POST',
          headers: { ...headers(true), 'If-Match': '*' },
        })
      ).status,
    ).toBe(400);
    for (const invalidTag of [
      `W/${lifecycleEtag(id, '0')}`,
      `${lifecycleEtag(id, '0')}, ${lifecycleEtag(id, '0')}`,
    ]) {
      expect(
        (
          await fetch(`${baseUrl}/api/v1/assets/${id}/trash`, {
            method: 'POST',
            headers: { ...headers(true), 'If-Match': invalidTag },
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/trash`, {
          method: 'POST',
          headers: {
            ...headers(true),
            'If-Match': lifecycleEtag(id, '0'),
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/trash`, {
          method: 'POST',
          headers: { ...headers(), 'If-Match': lifecycleEtag(id, '0') },
        })
      ).status,
    ).toBe(403);
    const moved = await fetch(`${baseUrl}/api/v1/assets/${id}/trash`, {
      method: 'POST',
      headers: { ...headers(true), 'If-Match': lifecycleEtag(id, '0') },
    });
    expect(moved.status).toBe(200);
    expect(moved.headers.get('etag')).toBe(lifecycleEtag(id, '1'));
    expect(moved.headers.get('cache-control')).toBe('no-store');
    expect(await moved.json()).toMatchObject({
      id,
      state: 'trashed',
      lifecycle_version: '1',
    });
    expect(
      (await fetch(`${baseUrl}/api/v1/assets/${id}`, { headers: headers() }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/original`, {
          headers: headers(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/thumbnail`, {
          headers: headers(),
        })
      ).status,
    ).toBe(404);
    const trash = await fetch(`${baseUrl}/api/v1/assets/trash`, {
      headers: headers(),
    });
    expect(trash.status).toBe(200);
    expect(await trash.json()).toMatchObject({
      items: [{ id, lifecycle_version: '1' }],
      next_cursor: null,
    });
    const preview = await fetch(
      `${baseUrl}/api/v1/assets/trash/${id}/thumbnail`,
      { headers: headers() },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(previewBytes);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/trash/${id}/thumbnail`, {
          headers: foreignHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${baseUrl}/api/v1/assets/trash/${id}/thumbnail`)).status,
    ).toBe(401);
    openThumbnail.mockRejectedValueOnce(
      new ServiceUnavailableException('Storage unavailable'),
    );
    const unavailable = await fetch(
      `${baseUrl}/api/v1/assets/trash/${id}/thumbnail`,
      { headers: headers() },
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('content-type')).toMatch(
      /^application\/json/,
    );
    expect(await unavailable.text()).not.toContain('/private/');
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/${id}/restore`, {
          method: 'POST',
          headers: { ...headers(true), 'If-Match': lifecycleEtag(id, '0') },
        })
      ).status,
    ).toBe(412);
    const restored = await fetch(`${baseUrl}/api/v1/assets/${id}/restore`, {
      method: 'POST',
      headers: { ...headers(true), 'If-Match': lifecycleEtag(id, '1') },
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      id,
      state: 'active',
      lifecycle_version: '2',
      trashed_at: null,
    });
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/trash/${id}/thumbnail`, {
          headers: headers(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/assets/deletions`, {
          headers: headers(),
        })
      ).status,
    ).toBe(200);
  });

  it('rejects multipart fields and files on Trash and Restore before changing state', async () => {
    openThumbnail.mockClear();
    for (const target of ['trash', 'restore'] as const) {
      const id = randomUUID();
      await addAsset(id);
      if (target === 'restore')
        await repository.transition(
          actor,
          id,
          'trashed',
          lifecycleEtag(id, '0'),
        );
      const version = target === 'trash' ? '0' : '1';
      const body = new FormData();
      if (target === 'trash') body.set('field', 'synthetic private field');
      else body.set('file', new Blob(['synthetic private bytes']), 'test.jpg');
      const response = await fetch(`${baseUrl}/api/v1/assets/${id}/${target}`, {
        method: 'POST',
        headers: { ...headers(true), 'If-Match': lifecycleEtag(id, version) },
        body,
      });
      expect(response.status, target).toBe(400);
      expect(await response.json(), target).toEqual({
        statusCode: 400,
        message: 'Invalid request',
        error: 'Bad Request',
      });
      const rows = await sql<{
        lifecycle_version: string;
        trashed: boolean;
      }>`select lifecycle_version::text as lifecycle_version,
        trashed_at is not null as trashed from public.asset
        where id = ${id}::uuid`.execute(database.db);
      expect(rows.rows[0], target).toEqual({
        lifecycle_version: version,
        trashed: target === 'restore',
      });
      const journals = await sql<{
        count: number;
      }>`select count(*)::integer as count
        from public.asset_deletion where asset_id = ${id}::uuid`.execute(
        database.db,
      );
      expect(journals.rows[0].count).toBe(0);
      expect(openThumbnail).not.toHaveBeenCalled();
    }
  });

  it('rejects chunked multipart Trash and Restore before state changes', async () => {
    const boundary = 'synthetic-lifecycle-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nsynthetic\r\n--${boundary}--\r\n`;
    for (const target of ['trash', 'restore'] as const) {
      const id = randomUUID();
      await addAsset(id);
      if (target === 'restore')
        await repository.transition(
          actor,
          id,
          'trashed',
          lifecycleEtag(id, '0'),
        );
      const version = target === 'trash' ? '0' : '1';
      const response = await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const client = httpRequest(
            `${baseUrl}/api/v1/assets/${id}/${target}`,
            {
              method: 'POST',
              headers: {
                ...headers(true),
                'If-Match': lifecycleEtag(id, version),
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Transfer-Encoding': 'chunked',
              },
            },
            (reply) => {
              let received = '';
              reply.setEncoding('utf8');
              reply.on('data', (part: string) => {
                received += part;
              });
              reply.on('end', () =>
                resolve({
                  status: reply.statusCode ?? 0,
                  body: JSON.parse(received) as unknown,
                }),
              );
            },
          );
          client.on('error', reject);
          client.write(body.slice(0, 20));
          client.end(body.slice(20));
        },
      );
      expect(response, target).toEqual({
        status: 400,
        body: {
          statusCode: 400,
          message: 'Invalid request',
          error: 'Bad Request',
        },
      });
      const rows = await sql<{
        version: string;
      }>`select lifecycle_version::text as version
        from public.asset where id = ${id}::uuid`.execute(database.db);
      expect(rows.rows[0].version).toBe(version);
    }
  });

  it('rejects other framed lifecycle bodies and retains empty-body compatibility', async () => {
    for (const target of ['trash', 'restore'] as const) {
      const id = randomUUID();
      await addAsset(id);
      if (target === 'restore')
        await repository.transition(
          actor,
          id,
          'trashed',
          lifecycleEtag(id, '0'),
        );
      const version = target === 'trash' ? '0' : '1';
      for (const [body, contentType] of [
        ['{}', 'application/json'],
        ['null', 'application/json'],
        ['synthetic text', 'text/plain'],
        ['synthetic bytes', 'application/octet-stream'],
      ] as const) {
        const response = await fetch(
          `${baseUrl}/api/v1/assets/${id}/${target}`,
          {
            method: 'POST',
            headers: {
              ...headers(true),
              'If-Match': lifecycleEtag(id, version),
              'Content-Type': contentType,
            },
            body,
          },
        );
        expect(response.status, `${target} ${contentType}`).toBe(400);
        expect(await response.json()).toEqual({
          statusCode: 400,
          message: 'Invalid request',
          error: 'Bad Request',
        });
      }
      const unchanged = await sql<{
        version: string;
      }>`select lifecycle_version::text as version
        from public.asset where id = ${id}::uuid`.execute(database.db);
      expect(unchanged.rows[0].version).toBe(version);
      const success = await fetch(`${baseUrl}/api/v1/assets/${id}/${target}`, {
        method: 'POST',
        headers: {
          ...headers(true),
          'If-Match': lifecycleEtag(id, version),
          'Content-Length': '0',
          'Content-Type': 'application/json',
        },
      });
      expect(success.status).toBe(200);
      expect(success.headers.get('etag')).toBe(
        lifecycleEtag(id, String(Number(version) + 1)),
      );
    }
  });

  it('authenticates lifecycle requests before inspecting multipart framing', async () => {
    const id = randomUUID();
    await addAsset(id);
    const body = new FormData();
    body.set('field', 'synthetic private field');
    const path = `${baseUrl}/api/v1/assets/${id}/trash`;
    const unauthenticated = await fetch(path, { method: 'POST', body });
    expect(unauthenticated.status).toBe(401);
    const missingCsrf = await fetch(path, {
      method: 'POST',
      headers: {
        ...headers(),
        Origin: 'http://127.0.0.1:3000',
        'If-Match': lifecycleEtag(id, '0'),
      },
      body,
    });
    expect(missingCsrf.status).toBe(403);
    await database.db
      .updateTable('app_user')
      .set({ password_change_required: true })
      .where('id', '=', owner)
      .execute();
    try {
      const restricted = await fetch(path, {
        method: 'POST',
        headers: {
          ...headers(true),
          'If-Match': lifecycleEtag(id, '0'),
        },
        body,
      });
      expect(restricted.status).toBe(403);
    } finally {
      await database.db
        .updateTable('app_user')
        .set({ password_change_required: false })
        .where('id', '=', owner)
        .execute();
    }
    const rows = await sql<{
      version: string;
    }>`select lifecycle_version::text as version
      from public.asset where id = ${id}::uuid`.execute(database.db);
    expect(rows.rows[0].version).toBe('0');
  });

  it('denies restricted sessions on lifecycle routes', async () => {
    const ownedId = assetIds[0];
    await addAsset(ownedId);
    await database.db
      .updateTable('app_user')
      .set({ password_change_required: true })
      .where('id', '=', owner)
      .execute();
    try {
      for (const path of [
        '/api/v1/assets',
        '/api/v1/assets/trash',
        '/api/v1/assets/deletions',
        `/api/v1/assets/trash/${ownedId}/thumbnail`,
      ]) {
        expect(
          (await fetch(`${baseUrl}${path}`, { headers: headers() })).status,
        ).toBe(403);
      }
      expect(
        (
          await fetch(`${baseUrl}/api/v1/assets/${ownedId}/trash`, {
            method: 'POST',
            headers: {
              ...headers(true),
              'If-Match': lifecycleEtag(ownedId, '0'),
            },
          })
        ).status,
      ).toBe(403);
    } finally {
      await database.db
        .updateTable('app_user')
        .set({ password_change_required: false })
        .where('id', '=', owner)
        .execute();
    }
  });
});
