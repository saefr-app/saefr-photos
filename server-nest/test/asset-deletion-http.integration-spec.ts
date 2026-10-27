import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';

import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { sql, type Kysely } from 'kysely';
import type { Transaction } from 'kysely';
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

import { AssetDeletionAcceptanceRepository } from '../src/assets/asset-deletion-acceptance.repository.js';
import { AssetDeletionExecutor } from '../src/assets/asset-deletion.executor.js';
import { AssetDeletionService } from '../src/assets/asset-deletion.service.js';
import { lockAssetId } from '../src/assets/asset-id-coordination.js';
import { lifecycleEtag } from '../src/assets/asset-lifecycle-contract.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { Database } from '../src/database/database.types.js';
import {
  createMigrationDatabase,
  migrationConfig,
} from '../src/database/migrations/migration-config.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { registerAssetAccess } from '../src/auth/asset-lockdown.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { createHttpAdapter } from '../src/http-adapter.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import { testConfig } from './helpers/integration-database.js';

const owner = randomUUID();
const foreign = randomUUID();
const ownerSession = randomUUID();
const foreignSession = randomUUID();
const ownerToken = randomBytes(32);
const foreignToken = randomBytes(32);
const csrf = randomBytes(32);
const origin = 'http://127.0.0.1:3000';
const storage = {
  singleton: true,
  storage_id: randomUUID(),
  originals_binding_id: randomUUID(),
  thumbnails_binding_id: randomUUID(),
  storage_layout_version: 1,
};
const envKeys = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'NODE_ENV',
  'APP_ORIGIN',
];
const previous = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('M12E.2 deletion HTTP boundary on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let db: Kysely<unknown>;
  let app: NestFastifyApplication;
  let address: string;
  let databaseName: string;
  let appDatabase: DatabaseService;
  let available = true;
  let removed: string[] = [];
  let persistence: string[] = [];
  const closeObservers = new Map<string, () => void>();
  const provider = {
    capabilities: {
      bindingObservation: true,
      exactRemoval: true,
      authoritativeAbsence: true,
      deletionDurability: true,
    },
    verifyBinding: vi.fn(async () => {
      if (!available) throw new Error('Synthetic storage unavailable');
      return storage;
    }),
    removeExact: vi.fn(
      async (target: {
        role: string;
      }): Promise<{ status: 'removed' | 'uncertain'; durable: boolean }> => {
        removed.push(target.role);
        return { status: 'removed', durable: true };
      },
    ),
    confirmDirectoryPersistence: vi.fn(async (role: string) => {
      persistence.push(role);
      return { status: 'durable' as const };
    }),
  };

  function headers(account: 'owner' | 'foreign' = 'owner', unsafe = false) {
    return {
      Cookie: `saefr_session_dev=${(account === 'owner' ? ownerToken : foreignToken).toString('base64url')}`,
      ...(unsafe
        ? { Origin: origin, 'X-CSRF-Token': csrf.toString('base64url') }
        : {}),
    };
  }

  async function request(path: string, options: RequestInit = {}) {
    return fetch(`${address}${path}`, options);
  }

  async function asset(id: string, ownerId = owner, trashed = true) {
    await sql`insert into public.asset (id, owner_id, filename, mime_type, size,
      storage_path, created_at, trashed_at, lifecycle_version)
      values (${id}::uuid, ${ownerId}::uuid, 'synthetic.jpg', 'image/jpeg', 7,
      '/synthetic/test.jpg', clock_timestamp(),
      ${trashed ? sql`clock_timestamp()` : sql`null`}, 1)`.execute(db);
  }

  async function deletion(
    id: string,
    options: {
      account?: 'owner' | 'foreign';
      tag?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) {
    return request(`/api/v1/assets/${id}`, {
      method: 'DELETE',
      headers: {
        ...headers(options.account, true),
        ...(options.tag === undefined ? {} : { 'If-Match': options.tag }),
        ...options.headers,
      },
      body: options.body,
    });
  }

  beforeAll(async () => {
    const test = testConfig();
    admin = new DatabaseService(test);
    databaseName = `saefr_m12e2_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const config = migrationConfig({
      MIGRATION_POSTGRES_HOST: '127.0.0.1',
      MIGRATION_POSTGRES_PORT: String(test.getOrThrow<number>('POSTGRES_PORT')),
      MIGRATION_POSTGRES_DB: databaseName,
      MIGRATION_POSTGRES_USER: test.getOrThrow<string>('POSTGRES_USER'),
      MIGRATION_POSTGRES_PASSWORD: test.getOrThrow<string>('POSTGRES_PASSWORD'),
    });
    db = createMigrationDatabase(config);
    await migrateToLatest(db);
    await sql`insert into public.storage_binding
      (singleton, storage_id, originals_binding_id, thumbnails_binding_id, storage_layout_version)
      values (true, ${storage.storage_id}::uuid, ${storage.originals_binding_id}::uuid,
      ${storage.thumbnails_binding_id}::uuid, 1)`.execute(db);
    for (const [id, username] of [
      [owner, 'deletionowner'],
      [foreign, 'deletionforeign'],
    ] as const)
      await sql`insert into public.app_user (id, username, password_hash, role, status,
        password_change_required, created_at, updated_at)
        values (${id}::uuid, ${username}, 'synthetic-hash', 'user', 'active', false,
        clock_timestamp(), clock_timestamp())`.execute(db);
    for (const [id, userId, token] of [
      [ownerSession, owner, ownerToken],
      [foreignSession, foreign, foreignToken],
    ] as const)
      await sql`insert into public.auth_session (id, user_id, token_hash, csrf_token,
        created_at, expires_at) values (${id}::uuid, ${userId}::uuid,
        ${createHash('sha256').update(token).digest()}, ${csrf}, clock_timestamp(),
        clock_timestamp() + interval '1 hour')`.execute(db);
    for (const key of envKeys.filter((value) => value.startsWith('POSTGRES_')))
      process.env[key] = String(
        key === 'POSTGRES_DB' ? databaseName : test.getOrThrow(key),
      );
    process.env.NODE_ENV = 'test';
    process.env.APP_ORIGIN = origin;
    const { AppModule } = await import('../src/app.module.js');
    appDatabase = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: test.getOrThrow<number>('POSTGRES_PORT'),
        POSTGRES_DB: databaseName,
        POSTGRES_USER: test.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: test.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(appDatabase)
      .overrideProvider(LocalStorageProvider)
      .useValue(provider)
      .compile();
    app =
      module.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', (request, reply, done) => {
        const key = request.headers['x-test-close-key'];
        if (typeof key === 'string')
          reply.raw.once('close', () => closeObservers.get(key)?.());
        done();
      });
    registerAssetAccess(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = app.getHttpServer().address();
    if (!socket || typeof socket === 'string') throw new Error('No socket');
    address = `http://127.0.0.1:${socket.port}`;
  });

  beforeEach(async () => {
    await sql`delete from public.asset_deletion where owner_id in (${owner}::uuid, ${foreign}::uuid)`.execute(
      db,
    );
    await sql`delete from public.asset where owner_id in (${owner}::uuid, ${foreign}::uuid)`.execute(
      db,
    );
    available = true;
    removed = [];
    persistence = [];
    provider.removeExact.mockClear();
    provider.verifyBinding.mockClear();
    closeObservers.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  function abandonedSocket(
    method: 'DELETE' | 'POST',
    path: string,
    requestHeaders: Record<string, string>,
    onClose: () => void,
  ): ClientRequest {
    const key = randomUUID();
    closeObservers.set(key, onClose);
    const client = httpRequest(`${address}${path}`, {
      method,
      headers: { ...requestHeaders, 'X-Test-Close-Key': key },
    });
    client.on('error', () => undefined);
    client.on('response', (response) => response.resume());
    client.end();
    return client;
  }

  async function journalCount(id: string): Promise<number> {
    const result = await sql<{
      count: number;
    }>`select count(*)::integer as count
      from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
    return result.rows[0].count;
  }

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (admin && databaseName) {
      await sql`drop database if exists ${sql.id(databaseName)} with (force)`.execute(
        admin.db,
      );
      await admin.onModuleDestroy();
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires owner, Origin, CSRF and a current strong lifecycle tag', async () => {
    const id = randomUUID();
    await asset(id);
    const path = `/api/v1/assets/${id}`;
    expect((await request(path, { method: 'DELETE' })).status).toBe(401);
    expect(
      (await deletion(id, { account: 'foreign', tag: lifecycleEtag(id, '1') }))
        .status,
    ).toBe(404);
    expect(
      (
        await deletion(id, {
          tag: lifecycleEtag(id, '1'),
          headers: { Origin: 'http://evil.invalid' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(path, { method: 'DELETE', headers: headers() })).status,
    ).toBe(403);
    expect((await deletion(id)).status).toBe(428);
    for (const tag of [
      '*',
      `W/${lifecycleEtag(id, '1')}`,
      '"bad"',
      lifecycleEtag(randomUUID(), '1'),
      `${lifecycleEtag(id, '1')}, ${lifecycleEtag(id, '1')}`,
    ])
      expect((await deletion(id, { tag })).status).toBe(400);
    expect((await deletion(id, { tag: lifecycleEtag(id, '0') })).status).toBe(
      412,
    );
    expect(
      (
        await deletion(id, {
          tag: lifecycleEtag(id, '1'),
          body: '{}',
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await deletion(id, {
          tag: lifecycleEtag(id, '1'),
          headers: { 'X-CSRF-Token': 'invalid' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}`, {
          headers: headers('foreign'),
        })
      ).status,
    ).toBe(404);
    expect(provider.removeExact).not.toHaveBeenCalled();
  });

  it('keeps foreign and unknown operations indistinguishable and denies restricted accounts', async () => {
    const id = randomUUID();
    const missing = randomUUID();
    await asset(id);
    const foreignResponse = await deletion(id, {
      account: 'foreign',
      tag: lifecycleEtag(id, '1'),
    });
    const missingResponse = await deletion(missing, {
      account: 'foreign',
      tag: lifecycleEtag(missing, '1'),
    });
    expect(foreignResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual(await missingResponse.json());
    await sql`update public.app_user set role = 'admin' where id = ${foreign}::uuid`.execute(
      db,
    );
    try {
      expect(
        (
          await deletion(id, {
            account: 'foreign',
            tag: lifecycleEtag(id, '1'),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(`/api/v1/assets/deletions/${id}`, {
            headers: headers('foreign'),
          })
        ).status,
      ).toBe(404);
    } finally {
      await sql`update public.app_user set role = 'user' where id = ${foreign}::uuid`.execute(
        db,
      );
    }
    expect((await deletion('not-a-uuid', { tag: 'invalid' })).status).toBe(400);
    await sql`update public.app_user set password_change_required = true
      where id = ${owner}::uuid`.execute(db);
    try {
      expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
        403,
      );
    } finally {
      await sql`update public.app_user set password_change_required = false
        where id = ${owner}::uuid`.execute(db);
    }
    await sql`update public.app_user set status = 'disabled'
      where id = ${owner}::uuid`.execute(db);
    try {
      expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
        401,
      );
    } finally {
      await sql`update public.app_user set status = 'active'
        where id = ${owner}::uuid`.execute(db);
    }
    expect(provider.removeExact).not.toHaveBeenCalled();
  });

  it('keeps active assets and unverified storage intact', async () => {
    const active = randomUUID();
    await asset(active, owner, false);
    expect(
      (await deletion(active, { tag: lifecycleEtag(active, '1') })).status,
    ).toBe(409);
    const id = randomUUID();
    await asset(id);
    available = false;
    expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
      503,
    );
    const row = await sql<{
      count: number;
    }>`select count(*)::integer as count from public.asset_deletion
      where asset_id = ${id}::uuid`.execute(db);
    expect(row.rows[0].count).toBe(0);
    expect(provider.removeExact).not.toHaveBeenCalled();
  });

  it('accepts once, completes, exposes an exact private receipt and never retries a repeated DELETE', async () => {
    const id = randomUUID();
    await asset(id);
    const first = await deletion(id, { tag: lifecycleEtag(id, '1') });
    expect(first.status).toBe(200);
    expect(first.headers.get('location')).toBe(
      `/api/v1/assets/deletions/${id}`,
    );
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await first.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'asset_id',
      'completed_at',
      'last_error_code',
      'requested_at',
      'status',
    ]);
    expect(body.status).toBe('completed');
    expect(body.requested_at).toMatch(/\.\d{6}Z$/);
    expect(removed).toEqual(['originals', 'thumbnails']);
    expect(persistence).toEqual(['originals', 'thumbnails']);
    const status = await request(`/api/v1/assets/deletions/${id}`, {
      headers: headers(),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(body);
    available = false;
    expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
      200,
    );
    expect((await deletion(id, { tag: lifecycleEtag(id, '2') })).status).toBe(
      412,
    );
    expect(provider.removeExact).toHaveBeenCalledTimes(2);
    expect(
      (
        await request(`/api/v1/assets/${id}/restore`, {
          method: 'POST',
          headers: {
            ...headers('owner', true),
            'If-Match': lifecycleEtag(id, '1'),
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}/retry`, {
          method: 'POST',
          headers: {
            ...headers('owner', true),
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}/retry`, {
          method: 'POST',
          headers: headers('owner'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}/retry`, {
          method: 'POST',
          headers: headers('owner', true),
        })
      ).status,
    ).toBe(200);
    expect(provider.removeExact).toHaveBeenCalledTimes(2);
  });

  it('retains a pending committed journal until an explicit owner retry', async () => {
    const id = randomUUID();
    await asset(id);
    provider.removeExact.mockImplementationOnce(
      async (target: { role: string }) => {
        removed.push(target.role);
        return { status: 'uncertain' as const, durable: false as const };
      },
    );
    const first = await deletion(id, { tag: lifecycleEtag(id, '1') });
    expect(first.status).toBe(202);
    const body = (await first.json()) as { status: string };
    expect(body.status).toBe('pending');
    expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
      202,
    );
    expect(provider.removeExact).toHaveBeenCalledTimes(1);
    const status = await request(`/api/v1/assets/deletions/${id}`, {
      headers: headers(),
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { status: string }).status).toBe(
      'pending',
    );
    expect(provider.removeExact).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}/retry`, {
          method: 'POST',
          headers: headers('foreign', true),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}/retry`, {
          method: 'POST',
          headers: headers('owner', true),
        })
      ).status,
    ).toBe(200);
    expect(provider.removeExact).toHaveBeenCalledTimes(3);
  });

  it('serializes concurrent acceptance to one immutable journal', async () => {
    const id = randomUUID();
    await asset(id);
    provider.removeExact.mockImplementationOnce(
      async (target: { role: string }) => {
        removed.push(target.role);
        return { status: 'uncertain' as const, durable: false as const };
      },
    );
    const outcomes = await Promise.all([
      deletion(id, { tag: lifecycleEtag(id, '1') }),
      deletion(id, { tag: lifecycleEtag(id, '1') }),
    ]);
    expect(
      outcomes.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([202, 202]);
    const rows = await sql<{ count: number }>`select count(*)::integer as count
      from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
    expect(rows.rows[0].count).toBe(1);
    expect(provider.removeExact).toHaveBeenCalledTimes(1);
  });

  it('rejects stale deletion after Restore wins the asset-ID lock', async () => {
    const id = randomUUID();
    await asset(id);
    let started!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = appDatabase.db
      .transaction()
      .execute(async (transaction) => {
        await lockAssetId(transaction as Transaction<Database>, id);
        started();
        await gate;
        await sql`update public.asset set trashed_at = null, lifecycle_version = 2
        where id = ${id}::uuid`.execute(transaction);
      });
    await locked;
    const deleting = deletion(id, { tag: lifecycleEtag(id, '1') });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await sql<{ waiting: boolean }>`select exists (
          select 1 from pg_stat_activity where wait_event_type = 'Lock'
          and query like '%pg_advisory_xact_lock%') as waiting`.execute(
          appDatabase.db,
        );
        if (state.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await blocker;
    }
    expect((await deleting).status).toBe(412);
    expect(provider.removeExact).not.toHaveBeenCalled();
    const receipt = await sql<{
      count: number;
    }>`select count(*)::integer as count
      from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
    expect(receipt.rows[0].count).toBe(0);
  }, 10_000);

  it('refuses acceptance when the session expires during an asset-ID lock wait', async () => {
    const id = randomUUID();
    await asset(id);
    await sql`update public.auth_session set expires_at = clock_timestamp() + interval '2 seconds'
      where id = ${ownerSession}::uuid`.execute(db);
    let started!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = appDatabase.db
      .transaction()
      .execute(async (transaction) => {
        await lockAssetId(transaction as Transaction<Database>, id);
        started();
        await gate;
      });
    await locked;
    try {
      const pending = deletion(id, { tag: lifecycleEtag(id, '1') });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await sql<{ waiting: boolean }>`select exists (
          select 1 from pg_stat_activity where wait_event_type = 'Lock'
          and query like '%pg_advisory_xact_lock%') as waiting`.execute(
          appDatabase.db,
        );
        if (state.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waiting).toBe(true);
      await sql`select pg_sleep(greatest(0.0,
        extract(epoch from (expires_at - clock_timestamp()))) + 0.02)
        from public.auth_session where id = ${ownerSession}::uuid`.execute(
        appDatabase.db,
      );
      release();
      await blocker;
      expect((await pending).status).toBe(401);
      expect(provider.removeExact).not.toHaveBeenCalled();
      const receipt = await sql<{
        count: number;
      }>`select count(*)::integer as count
        from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
      expect(receipt.rows[0].count).toBe(0);
    } finally {
      release();
      await blocker;
      await sql`update public.auth_session set expires_at = clock_timestamp() + interval '1 hour'
        where id = ${ownerSession}::uuid`.execute(db);
    }
  }, 10_000);

  it('preserves an asset when the journal insert rolls back', async () => {
    const id = randomUUID();
    await asset(id);
    const repository = app.get(AssetDeletionAcceptanceRepository);
    const real = repository.confirmUncertain.bind(repository);
    const spy = vi
      .spyOn(repository, 'confirmUncertain')
      .mockImplementation(real);
    await sql`create or replace function public.reject_test_deletion() returns trigger
      language plpgsql as 'begin raise exception ''synthetic rollback''; end'`.execute(
      db,
    );
    await sql`create trigger reject_test_deletion before insert on public.asset_deletion
      for each row execute function public.reject_test_deletion()`.execute(db);
    try {
      expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
        503,
      );
      expect(provider.removeExact).not.toHaveBeenCalled();
      const still = await sql<{
        id: string;
      }>`select id from public.asset where id = ${id}::uuid`.execute(db);
      expect(still.rows[0]?.id).toBe(id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await sql`drop trigger reject_test_deletion on public.asset_deletion`.execute(
        db,
      );
      await sql`drop function public.reject_test_deletion()`.execute(db);
      spy.mockRestore();
    }
  });

  it('rejects a changed database storage anchor without accepting or removing media', async () => {
    const id = randomUUID();
    await asset(id);
    const replacement = randomUUID();
    provider.verifyBinding.mockImplementationOnce(async () => {
      await sql`update public.storage_binding set storage_id = ${replacement}::uuid
        where singleton = true`.execute(db);
      return storage;
    });
    try {
      expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
        503,
      );
      expect(provider.removeExact).not.toHaveBeenCalled();
      const receipt = await sql<{
        count: number;
      }>`select count(*)::integer as count
        from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
      expect(receipt.rows[0].count).toBe(0);
      const assetRow = await sql<{ id: string }>`select id from public.asset
        where id = ${id}::uuid`.execute(db);
      expect(assetRow.rows[0]?.id).toBe(id);
    } finally {
      await sql`update public.storage_binding set storage_id = ${storage.storage_id}::uuid
        where singleton = true`.execute(db);
    }
  });

  it('does not execute after a simulated lost COMMIT acknowledgement without independent confirmation', async () => {
    const id = randomUUID();
    await asset(id);
    const repository = app.get(AssetDeletionAcceptanceRepository);
    const realTransaction = appDatabase.db.transaction.bind(appDatabase.db);
    let injected = false;
    const transaction = vi
      .spyOn(appDatabase.db, 'transaction')
      .mockImplementation(() => {
        if (injected) return realTransaction();
        injected = true;
        return {
          setIsolationLevel: () => ({
            execute: async (
              callback: (tx: Transaction<Database>) => Promise<unknown>,
            ) => {
              await realTransaction()
                .setIsolationLevel('read committed')
                .execute(callback);
              throw new Error(
                'Synthetic acknowledgement loss after durable COMMIT',
              );
            },
          }),
        } as unknown as ReturnType<typeof appDatabase.db.transaction>;
      });
    const confirmation = vi
      .spyOn(repository, 'confirmUncertain')
      .mockResolvedValue(null);
    try {
      expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
        503,
      );
      expect(confirmation).toHaveBeenCalledTimes(1);
      expect(provider.removeExact).not.toHaveBeenCalled();
      const committed = await sql<{
        count: number;
      }>`select count(*)::integer as count
        from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
      expect(committed.rows[0].count).toBe(1);
    } finally {
      confirmation.mockRestore();
      transaction.mockRestore();
    }
  });

  it('executes only after positively confirming a simulated lost COMMIT acknowledgement', async () => {
    const id = randomUUID();
    await asset(id);
    const repository = app.get(AssetDeletionAcceptanceRepository);
    const realTransaction = appDatabase.db.transaction.bind(appDatabase.db);
    let injected = false;
    const transaction = vi
      .spyOn(appDatabase.db, 'transaction')
      .mockImplementation(() => {
        if (injected) return realTransaction();
        injected = true;
        return {
          setIsolationLevel: () => ({
            execute: async (
              callback: (tx: Transaction<Database>) => Promise<unknown>,
            ) => {
              await realTransaction()
                .setIsolationLevel('read committed')
                .execute(callback);
              throw new Error(
                'Synthetic acknowledgement loss after durable COMMIT',
              );
            },
          }),
        } as unknown as ReturnType<typeof appDatabase.db.transaction>;
      });
    let confirmed = false;
    const actual = repository.confirmUncertain.bind(repository);
    const confirmation = vi
      .spyOn(repository, 'confirmUncertain')
      .mockImplementation(async (target) => {
        const receipt = await actual(target);
        confirmed = receipt !== null;
        return receipt;
      });
    const removal = provider.removeExact.mockImplementation(
      async (target: { role: string }) => {
        expect(confirmed).toBe(true);
        removed.push(target.role);
        return { status: 'removed', durable: true };
      },
    );
    try {
      expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
        200,
      );
      expect(confirmation).toHaveBeenCalledTimes(1);
      expect(provider.removeExact).toHaveBeenCalledTimes(2);
    } finally {
      removal.mockRestore();
      confirmation.mockRestore();
      transaction.mockRestore();
    }
  });

  for (const method of ['DELETE', 'POST'] as const) {
    it(`${method} does not dispatch deletion after a disconnect during authentication`, async () => {
      const id = randomUUID();
      await asset(id);
      if (method === 'POST') {
        provider.removeExact.mockImplementationOnce(async () => ({
          status: 'uncertain' as const,
          durable: false,
        }));
        expect(
          (await deletion(id, { tag: lifecycleEtag(id, '1') })).status,
        ).toBe(202);
        provider.removeExact.mockClear();
        removed = [];
        persistence = [];
      }
      const entered = barrier();
      const release = barrier();
      const closed = barrier();
      const finished = barrier();
      const sessions = app.get(AuthSessionService);
      const actualResolve = sessions.resolve.bind(sessions);
      const authSpy = vi
        .spyOn(sessions, 'resolve')
        .mockImplementation(async (token) => {
          entered.release();
          await release.promise;
          return actualResolve(token);
        });
      const service = app.get(AssetDeletionService);
      const acceptanceSpy = vi.spyOn(
        app.get(AssetDeletionAcceptanceRepository),
        'accept',
      );
      const executionSpy = vi.spyOn(app.get(AssetDeletionExecutor), 'execute');
      let receivedSignal: AbortSignal | undefined;
      const actualAccept = service.accept.bind(service);
      const actualRetry = service.retry.bind(service);
      const serviceSpy =
        method === 'DELETE'
          ? vi.spyOn(service, 'accept').mockImplementation(async (...args) => {
              receivedSignal = args[3];
              try {
                return await actualAccept(...args);
              } finally {
                finished.release();
              }
            })
          : vi.spyOn(service, 'retry').mockImplementation(async (...args) => {
              receivedSignal = args[2];
              try {
                return await actualRetry(...args);
              } finally {
                finished.release();
              }
            });
      const client = abandonedSocket(
        method,
        method === 'DELETE'
          ? `/api/v1/assets/${id}`
          : `/api/v1/assets/deletions/${id}/retry`,
        {
          ...headers('owner', true),
          ...(method === 'DELETE'
            ? { 'If-Match': lifecycleEtag(id, '1') }
            : {}),
        },
        closed.release,
      );
      try {
        await entered.promise;
        client.destroy();
        await closed.promise;
        release.release();
        await finished.promise;
        expect(receivedSignal?.aborted).toBe(true);
        expect(acceptanceSpy).not.toHaveBeenCalled();
        expect(executionSpy).not.toHaveBeenCalled();
        expect(provider.removeExact).not.toHaveBeenCalled();
        expect(persistence).toEqual([]);
        expect(await journalCount(id)).toBe(method === 'DELETE' ? 0 : 1);
      } finally {
        client.destroy();
        release.release();
        serviceSpy.mockRestore();
        authSpy.mockRestore();
        acceptanceSpy.mockRestore();
        executionSpy.mockRestore();
      }
    }, 15_000);
  }

  it('keeps a committed acceptance pending when the client leaves before execution', async () => {
    const id = randomUUID();
    await asset(id);
    const entered = barrier();
    const release = barrier();
    const closed = barrier();
    const finished = barrier();
    const repository = app.get(AssetDeletionAcceptanceRepository);
    const actualAccept = repository.accept.bind(repository);
    const acceptanceSpy = vi
      .spyOn(repository, 'accept')
      .mockImplementation(async (...args) => {
        const result = await actualAccept(...args);
        entered.release();
        await release.promise;
        return result;
      });
    const service = app.get(AssetDeletionService);
    const actualServiceAccept = service.accept.bind(service);
    const serviceSpy = vi
      .spyOn(service, 'accept')
      .mockImplementation(async (...args) => {
        try {
          return await actualServiceAccept(...args);
        } finally {
          finished.release();
        }
      });
    const client = abandonedSocket(
      'DELETE',
      `/api/v1/assets/${id}`,
      { ...headers('owner', true), 'If-Match': lifecycleEtag(id, '1') },
      closed.release,
    );
    try {
      await entered.promise;
      client.destroy();
      await closed.promise;
      release.release();
      await finished.promise;
      expect(await journalCount(id)).toBe(1);
      const assetRow = await sql<{
        count: number;
      }>`select count(*)::integer as count
        from public.asset where id = ${id}::uuid`.execute(db);
      expect(assetRow.rows[0].count).toBe(0);
      expect(provider.removeExact).not.toHaveBeenCalled();
      const status = await request(`/api/v1/assets/deletions/${id}`, {
        headers: headers(),
      });
      expect(((await status.json()) as { status: string }).status).toBe(
        'pending',
      );
      expect(
        (
          await request(`/api/v1/assets/deletions/${id}/retry`, {
            method: 'POST',
            headers: headers('owner', true),
          })
        ).status,
      ).toBe(200);
    } finally {
      client.destroy();
      release.release();
      serviceSpy.mockRestore();
      acceptanceSpy.mockRestore();
    }
  }, 15_000);

  it('drains an issued provider call after disconnect without starting another', async () => {
    const id = randomUUID();
    await asset(id);
    const entered = barrier();
    const release = barrier();
    const closed = barrier();
    const finished = barrier();
    provider.removeExact.mockImplementationOnce(
      async (target: { role: string }) => {
        removed.push(target.role);
        entered.release();
        await release.promise;
        return { status: 'removed' as const, durable: true };
      },
    );
    const executor = app.get(AssetDeletionExecutor);
    const actualExecute = executor.execute.bind(executor);
    const executionSpy = vi
      .spyOn(executor, 'execute')
      .mockImplementation(async (...args) => {
        try {
          return await actualExecute(...args);
        } finally {
          finished.release();
        }
      });
    const client = abandonedSocket(
      'DELETE',
      `/api/v1/assets/${id}`,
      { ...headers('owner', true), 'If-Match': lifecycleEtag(id, '1') },
      closed.release,
    );
    try {
      await entered.promise;
      client.destroy();
      await closed.promise;
      expect((executor as unknown as { active: number }).active).toBe(1);
      expect(removed).toEqual(['originals']);
      release.release();
      await finished.promise;
      expect((executor as unknown as { active: number }).active).toBe(0);
      expect(removed).toEqual(['originals']);
      expect(persistence).toEqual([]);
      expect(
        (
          (await (
            await request(`/api/v1/assets/deletions/${id}`, {
              headers: headers(),
            })
          ).json()) as { status: string }
        ).status,
      ).toBe('pending');
    } finally {
      client.destroy();
      release.release();
      executionSpy.mockRestore();
    }
  }, 15_000);

  it('rejects nonempty framed bodies before acceptance for both deletion routes', async () => {
    const execution = vi.spyOn(app.get(AssetDeletionExecutor), 'execute');
    const cases = [
      [
        'JSON object',
        () => ({ body: '{}', headers: { 'Content-Type': 'application/json' } }),
      ],
      [
        'JSON null',
        () => ({
          body: 'null',
          headers: { 'Content-Type': 'application/json' },
        }),
      ],
      [
        'plain text',
        () => ({
          body: 'private synthetic text',
          headers: { 'Content-Type': 'text/plain' },
        }),
      ],
      [
        'octet stream',
        () => ({
          body: 'synthetic bytes',
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      ],
      [
        'multipart field',
        () => {
          const body = new FormData();
          body.set('field', 'synthetic');
          return { body, headers: {} };
        },
      ],
      [
        'multipart file',
        () => {
          const body = new FormData();
          body.set(
            'file',
            new Blob(['synthetic image bytes']),
            'synthetic.jpg',
          );
          return { body, headers: {} };
        },
      ],
    ] as const;
    for (const [name, make] of cases) {
      const id = randomUUID();
      await asset(id);
      const payload = make();
      const response = await request(`/api/v1/assets/${id}`, {
        method: 'DELETE',
        headers: {
          ...headers('owner', true),
          'If-Match': lifecycleEtag(id, '1'),
          ...payload.headers,
        },
        body: payload.body,
      });
      expect(response.status, name).toBe(400);
      expect(await response.json(), name).toEqual({
        statusCode: 400,
        message: 'Invalid request',
        error: 'Bad Request',
      });
      expect(await journalCount(id), name).toBe(0);
      const existing = await sql<{
        count: number;
      }>`select count(*)::integer as count
        from public.asset where id = ${id}::uuid`.execute(db);
      expect(existing.rows[0].count, name).toBe(1);
      expect(execution, name).not.toHaveBeenCalled();
      expect(provider.removeExact, name).not.toHaveBeenCalled();
      await sql`delete from public.asset where id = ${id}::uuid`.execute(db);
    }

    const id = randomUUID();
    await asset(id);
    provider.removeExact.mockImplementationOnce(async () => ({
      status: 'uncertain' as const,
      durable: false,
    }));
    expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
      202,
    );
    execution.mockClear();
    provider.removeExact.mockClear();
    removed = [];
    persistence = [];
    for (const [name, make] of cases) {
      const payload = make();
      const response = await request(`/api/v1/assets/deletions/${id}/retry`, {
        method: 'POST',
        headers: { ...headers('owner', true), ...payload.headers },
        body: payload.body,
      });
      expect(response.status, name).toBe(400);
      expect(await response.json(), name).toEqual({
        statusCode: 400,
        message: 'Invalid request',
        error: 'Bad Request',
      });
    }
    expect(await journalCount(id)).toBe(1);
    expect(execution).not.toHaveBeenCalled();
    expect(provider.removeExact).not.toHaveBeenCalled();
    expect(persistence).toEqual([]);
  }, 20_000);

  for (const method of ['DELETE', 'POST'] as const) {
    it(`${method} rejects chunked multipart before deletion work and preserves authentication order`, async () => {
      const execution = vi.spyOn(app.get(AssetDeletionExecutor), 'execute');
      const id = randomUUID();
      await asset(id);
      if (method === 'POST') {
        provider.removeExact.mockImplementationOnce(async () => ({
          status: 'uncertain' as const,
          durable: false,
        }));
        expect(
          (await deletion(id, { tag: lifecycleEtag(id, '1') })).status,
        ).toBe(202);
        execution.mockClear();
        provider.removeExact.mockClear();
      }
      const path =
        method === 'DELETE'
          ? `/api/v1/assets/${id}`
          : `/api/v1/assets/deletions/${id}/retry`;
      const boundary = 'synthetic-boundary';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nsynthetic\r\n--${boundary}--\r\n`;
      async function chunked(requestHeaders: Record<string, string>) {
        return new Promise<{ status: number; body: unknown }>(
          (resolve, reject) => {
            const client = httpRequest(
              `${address}${path}`,
              {
                method,
                headers: {
                  ...requestHeaders,
                  'Content-Type': `multipart/form-data; boundary=${boundary}`,
                  'Transfer-Encoding': 'chunked',
                },
              },
              (response) => {
                let received = '';
                response.setEncoding('utf8');
                response.on('data', (part: string) => {
                  received += part;
                });
                response.on('end', () =>
                  resolve({
                    status: response.statusCode ?? 0,
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
      }
      const authenticated = await chunked({
        ...headers('owner', true),
        ...(method === 'DELETE' ? { 'If-Match': lifecycleEtag(id, '1') } : {}),
      });
      expect(authenticated).toEqual({
        status: 400,
        body: {
          statusCode: 400,
          message: 'Invalid request',
          error: 'Bad Request',
        },
      });
      expect((await chunked({})).status).toBe(401);
      expect((await chunked(headers('owner', false))).status).toBe(403);
      expect(
        (
          await request(path, {
            method: 'PUT',
            headers: {
              ...headers('owner', true),
              'Content-Type': 'application/json',
            },
            body: '{}',
          })
        ).status,
      ).toBe(404);
      expect(await journalCount(id)).toBe(method === 'DELETE' ? 0 : 1);
      expect(execution).not.toHaveBeenCalled();
      expect(provider.removeExact).not.toHaveBeenCalled();
    }, 15_000);
  }

  it('continues to accept genuinely empty ordinary and explicit zero-length requests', async () => {
    const id = randomUUID();
    await asset(id);
    provider.removeExact.mockImplementationOnce(async () => ({
      status: 'uncertain' as const,
      durable: false,
    }));
    expect((await deletion(id, { tag: lifecycleEtag(id, '1') })).status).toBe(
      202,
    );
    expect(
      (
        await request(`/api/v1/assets/deletions/${id}/retry`, {
          method: 'POST',
          headers: {
            ...headers('owner', true),
            'Content-Length': '0',
            'Content-Type': 'application/json',
          },
        })
      ).status,
    ).toBe(200);
    const second = randomUUID();
    await asset(second);
    expect(
      (
        await deletion(second, {
          tag: lifecycleEtag(second, '1'),
          headers: { 'Content-Length': '0' },
        })
      ).status,
    ).toBe(200);
  });
});
