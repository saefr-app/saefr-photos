import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Dialect } from 'kysely';
import { Pool } from 'pg';
import sharp from 'sharp';
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

import { AssetsRepository } from '../src/assets/assets.repository.js';
import { AssetsService } from '../src/assets/assets.service.js';
import type { AuthenticatedActor } from '../src/auth/auth-session.service.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { Database } from '../src/database/database.types.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { LocalStorageService } from '../src/storage/local-storage.service.js';
import { OperatorAccountsService } from '../src/users/operator-accounts.service.js';
import { UsersService } from '../src/users/users.service.js';
import { testConfig } from './helpers/integration-database.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function observe<T>(promise: Promise<T>): Promise<T> {
  // Keep failures observable at the later assertion, including when the
  // controlled operation rejects before the lock holder is released.
  void promise.catch(() => undefined);
  return promise;
}

describe('M11 owner-scoped core on disposable PostgreSQL 18', () => {
  let database: DatabaseService;
  let dbConfig: ConfigService;
  let repository: AssetsRepository;
  let service: AssetsService;
  let root: string;
  let original: Buffer;
  let passwordHash: string;
  const currentPassword = 'Synthetic-Current-Password-12345';
  const replacementPassword = 'Synthetic-Replacement-Password-67890';
  const users = {
    a: randomUUID(),
    b: randomUUID(),
    admin: randomUUID(),
    disabled: randomUUID(),
  };
  const sessions = {
    a: randomUUID(),
    b: randomUUID(),
    admin: randomUUID(),
    disabled: randomUUID(),
  };

  function actor(name: keyof typeof users): AuthenticatedActor {
    return {
      userId: users[name],
      username: `m11c-${name}`,
      role: name === 'admin' ? 'admin' : 'user',
      sessionId: sessions[name],
      expiresAt: new Date(Date.now() + 3_600_000),
      passwordChangeRequired: false,
      csrfToken: Buffer.alloc(32, 1),
    };
  }

  async function insertOwned(ownerId: string, id = randomUUID()) {
    await database.db
      .insertInto('asset')
      .values({
        id,
        owner_id: ownerId,
        filename: 'fixture.jpg',
        mime_type: 'image/jpeg',
        size: 1,
        storage_path: `/isolated-test/originals/${id}.jpg`,
        created_at: new Date(),
      })
      .execute();
    return id;
  }

  async function upload(as: AuthenticatedActor) {
    return service.upload(as, {
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      stream: Readable.from([original]),
    });
  }

  async function files() {
    const originals = await readdir(join(root, 'originals')).catch(() => []);
    const thumbnails = await readdir(join(root, 'thumbnails')).catch(() => []);
    return { originals, thumbnails };
  }

  async function expectLockWait(fragment: string, count = 1) {
    await vi.waitFor(
      async () => {
        const waiting = await sql<{
          count: number;
        }>`select count(*)::integer as count
        from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock'
        and query like ${`%${fragment}%`}`.execute(database.db);
        expect(waiting.rows[0].count).toBeGreaterThanOrEqual(count);
      },
      { timeout: 5000 },
    );
  }

  beforeAll(async () => {
    dbConfig = testConfig();
    database = new DatabaseService(dbConfig);
    await database.ping();
    await migrateToLatest(database.db);
    repository = new AssetsRepository(database);
    original = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: '#225588',
      },
    })
      .jpeg()
      .toBuffer();
    passwordHash = await new PasswordService().hash(currentPassword);
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      await database.db
        .insertInto('app_user')
        .values({
          id: users[name],
          username: `m11c-${name}-${users[name].slice(0, 8)}`,
          password_hash: passwordHash,
          role: name === 'admin' ? 'admin' : 'user',
          status: name === 'disabled' ? 'disabled' : 'active',
          password_change_required: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-m11c-'));
    service = new AssetsService(
      repository,
      new LocalStorageService(new ConfigService({ STORAGE_ROOT: root })),
    );
    await database.db.deleteFrom('asset').execute();
    await database.db
      .deleteFrom('auth_session')
      .where('user_id', 'in', Object.values(users))
      .execute();
    await database.db
      .updateTable('app_user')
      .set({
        status: 'active',
        password_change_required: false,
        password_hash: passwordHash,
      })
      .where('id', 'in', [users.a, users.b, users.admin])
      .execute();
    for (const [index, name] of (['a', 'b', 'admin'] as const).entries()) {
      await database.db
        .insertInto('auth_session')
        .values({
          id: sessions[name],
          user_id: users[name],
          token_hash: Buffer.alloc(32, index + 1),
          csrf_token: Buffer.alloc(32, 1),
          created_at: new Date(),
          expires_at: new Date(Date.now() + 3_600_000),
        })
        .execute();
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.deleteFrom('asset').execute();
    await database.db
      .deleteFrom('auth_session')
      .where('user_id', 'in', Object.values(users))
      .execute();
    await database.db
      .deleteFrom('app_user')
      .where('id', 'in', Object.values(users))
      .execute();
    await database.onModuleDestroy();
  });

  it('scopes every repository read and gives administrators no global gallery', async () => {
    const a = await insertOwned(users.a);
    const b = await insertOwned(users.b);
    const admin = await insertOwned(users.admin);
    const disabled = await insertOwned(users.disabled);

    expect((await repository.findAll(users.a)).map((row) => row.id)).toEqual([
      a,
    ]);
    expect((await repository.findAll(users.b)).map((row) => row.id)).toEqual([
      b,
    ]);
    expect(
      (await repository.findAll(users.admin)).map((row) => row.id),
    ).toEqual([admin]);
    expect(
      (await repository.findAll(users.disabled)).map((row) => row.id),
    ).toEqual([disabled]);
    expect(await repository.findById(b, users.a)).toBeUndefined();
    expect(await repository.findFileById(b, users.a)).toBeUndefined();
    expect(await repository.findById(a, users.a)).toMatchObject({ id: a });
  });

  it('gives foreign and missing assets identical service errors before storage opens', async () => {
    const foreign = await insertOwned(users.b);
    const missing = randomUUID();
    const openOriginal = vi.fn();
    const openThumbnail = vi.fn();
    const storage = {
      openOriginal,
      openThumbnail,
    } as unknown as LocalStorageService;
    const scopedService = new AssetsService(repository, storage);
    for (const id of [foreign, missing]) {
      await expect(scopedService.findById(actor('a'), id)).rejects.toThrow(
        new NotFoundException('Asset not found'),
      );
      await expect(scopedService.getOriginal(actor('a'), id)).rejects.toThrow(
        new NotFoundException('Asset not found'),
      );
      await expect(scopedService.getThumbnail(actor('a'), id)).rejects.toThrow(
        new NotFoundException('Asset not found'),
      );
    }
    expect(openOriginal).not.toHaveBeenCalled();
    expect(openThumbnail).not.toHaveBeenCalled();
  });

  it('inserts the actor owner and preserves original bytes', async () => {
    const forged = {
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      stream: Readable.from([original]),
      owner_id: users.b,
    };
    const result = await service.upload(actor('a'), forged);
    const row = await database.db
      .selectFrom('asset')
      .select(['owner_id', 'storage_path'])
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(users.a);
    expect(result).not.toHaveProperty('owner_id');
    expect(result).not.toHaveProperty('storage_path');
    expect(await readFile(join(root, 'originals', `${result.id}.jpg`))).toEqual(
      original,
    );
    expect((await files()).thumbnails).toEqual([`${result.id}.jpg`]);
  });

  it('allows concurrent uploads with distinct UUID files and scoped owners', async () => {
    const results = await Promise.all([
      upload(actor('a')),
      upload(actor('a')),
      upload(actor('b')),
    ]);
    expect(new Set(results.map((result) => result.id)).size).toBe(3);
    const rows = await database.db
      .selectFrom('asset')
      .select(['id', 'owner_id'])
      .orderBy('id')
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.owner_id === users.a)).toHaveLength(2);
    expect(rows.filter((row) => row.owner_id === users.b)).toHaveLength(1);
    expect((await files()).originals).toHaveLength(3);
    expect((await files()).thumbnails).toHaveLength(3);
  });

  it('rejects restricted, disabled, revoked and expired final authority and cleans its files', async () => {
    await database.db
      .updateTable('app_user')
      .set({ password_change_required: true })
      .where('id', '=', users.a)
      .execute();
    await expect(upload(actor('a'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await files()).toEqual({ originals: [], thumbnails: [] });

    await database.db
      .updateTable('app_user')
      .set({ password_change_required: false, status: 'disabled' })
      .where('id', '=', users.a)
      .execute();
    await expect(upload(actor('a'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await database.db
      .updateTable('app_user')
      .set({ status: 'active' })
      .where('id', '=', users.a)
      .execute();

    await database.db
      .deleteFrom('auth_session')
      .where('id', '=', sessions.a)
      .execute();
    await expect(upload(actor('a'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await database.db
      .insertInto('auth_session')
      .values({
        id: sessions.a,
        user_id: users.a,
        token_hash: Buffer.alloc(32, 8),
        csrf_token: Buffer.alloc(32, 1),
        created_at: new Date(Date.now() - 60_000),
        expires_at: new Date(Date.now() - 1_000),
      })
      .execute();
    await expect(upload(actor('a'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(await files()).toEqual({ originals: [], thumbnails: [] });
    const rows = await database.db.selectFrom('asset').select('id').execute();
    expect(rows).toEqual([]);
  });

  it('classifies an acknowledged callback rollback and does not retry an insert', async () => {
    const id = await insertOwned(users.a);
    const result = await repository.createForActor(actor('a'), {
      id,
      filename: 'duplicate.jpg',
      mime_type: 'image/jpeg',
      size: 1,
      storage_path: `/isolated-test/originals/${id}.jpg`,
      created_at: new Date(),
    });
    expect(result.status).toBe('rolled_back');
    const rows = await database.db
      .selectFrom('asset')
      .select('id')
      .where('id', '=', id)
      .execute();
    expect(rows).toEqual([{ id }]);
  });

  it.each(['acquire', 'begin'] as const)(
    'cleans only newly published files after %s fails before callback entry',
    async (stage) => {
      const pool = new Pool({
        host: '127.0.0.1',
        port: dbConfig.getOrThrow<number>('POSTGRES_PORT'),
        database: dbConfig.getOrThrow<string>('POSTGRES_DB'),
        user: dbConfig.getOrThrow<string>('POSTGRES_USER'),
        password: dbConfig.getOrThrow<string>('POSTGRES_PASSWORD'),
      });
      const postgres = new PostgresDialect({ pool });
      const failure = new Error(`private ${stage} failure`);
      let inserts = 0;
      let releases = 0;
      const faultingDialect: Dialect = {
        createAdapter: () => postgres.createAdapter(),
        createIntrospector: (db) => postgres.createIntrospector(db),
        createQueryCompiler: () => postgres.createQueryCompiler(),
        createDriver: () => {
          const driver = postgres.createDriver();
          return {
            init: (options) => driver.init(options),
            acquireConnection: (options) =>
              stage === 'acquire'
                ? Promise.reject(failure)
                : driver.acquireConnection(options),
            beginTransaction: (connection, settings) =>
              stage === 'begin'
                ? Promise.reject(failure)
                : driver.beginTransaction(connection, settings),
            commitTransaction: (connection) =>
              driver.commitTransaction(connection),
            rollbackTransaction: (connection) =>
              driver.rollbackTransaction(connection),
            releaseConnection: async (connection, options) => {
              releases += 1;
              await driver.releaseConnection(connection, options);
            },
            destroy: (options) => driver.destroy(options),
          };
        },
      };
      const faultingDb = new Kysely<Database>({
        dialect: faultingDialect,
        plugins: [
          {
            transformQuery: ({ node }) => {
              if (node.kind === 'InsertQueryNode') inserts += 1;
              return node;
            },
            transformResult: async ({ result }) => result,
          },
        ],
      });
      const faultingRepository = new AssetsRepository({
        db: faultingDb,
      } as DatabaseService);
      const storage = new LocalStorageService(
        new ConfigService({ STORAGE_ROOT: root }),
      );
      const faultingService = new AssetsService(faultingRepository, storage);
      const sentinel = Buffer.from('unrelated existing photo');
      await mkdir(join(root, 'originals'), { recursive: true });
      await mkdir(join(root, 'thumbnails'), { recursive: true });
      await writeFile(join(root, 'originals', 'sentinel.jpg'), sentinel);
      await writeFile(join(root, 'thumbnails', 'sentinel.jpg'), sentinel);

      try {
        const outcome = await faultingRepository.createForActor(actor('a'), {
          id: randomUUID(),
          filename: 'probe.jpg',
          mime_type: 'image/jpeg',
          size: original.length,
          storage_path: '/isolated-test/probe.jpg',
          created_at: new Date(),
        });
        expect(outcome).toEqual({ status: 'not_started', error: failure });

        await expect(
          faultingService.upload(actor('a'), {
            filename: 'photo.jpg',
            mimeType: 'image/jpeg',
            stream: Readable.from([original]),
          }),
        ).rejects.toMatchObject({ status: 503, cause: failure });
        expect(inserts).toBe(0);
        expect(
          await database.db.selectFrom('asset').select('id').execute(),
        ).toEqual([]);
        expect(await files()).toEqual({
          originals: ['sentinel.jpg'],
          thumbnails: ['sentinel.jpg'],
        });
        expect(await readFile(join(root, 'originals', 'sentinel.jpg'))).toEqual(
          sentinel,
        );
        expect(
          await readFile(join(root, 'thumbnails', 'sentinel.jpg')),
        ).toEqual(sentinel);

        // Cleanup failure must not replace the original database failure.
        vi.spyOn(storage, 'deleteImage').mockRejectedValueOnce(
          new Error('private cleanup path'),
        );
        await expect(
          faultingService.upload(actor('a'), {
            filename: 'photo.jpg',
            mimeType: 'image/jpeg',
            stream: Readable.from([original]),
          }),
        ).rejects.toMatchObject({ status: 503, cause: failure });
        expect(inserts).toBe(0);
        expect(
          await database.db.selectFrom('asset').select('id').execute(),
        ).toEqual([]);
        expect(await readFile(join(root, 'originals', 'sentinel.jpg'))).toEqual(
          sentinel,
        );
        expect(
          await readFile(join(root, 'thumbnails', 'sentinel.jpg')),
        ).toEqual(sentinel);
        expect((await files()).originals).toHaveLength(2);
        expect((await files()).thumbnails).toHaveLength(2);
      } finally {
        await faultingDb.destroy();
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        expect(releases).toBe(stage === 'begin' ? 3 : 0);
      }
    },
  );

  it('retains published files when rollback acknowledgement is lost', async () => {
    await database.db
      .updateTable('app_user')
      .set({ password_change_required: true })
      .where('id', '=', users.a)
      .execute();
    const pool = new Pool({
      host: '127.0.0.1',
      port: dbConfig.getOrThrow<number>('POSTGRES_PORT'),
      database: dbConfig.getOrThrow<string>('POSTGRES_DB'),
      user: dbConfig.getOrThrow<string>('POSTGRES_USER'),
      password: dbConfig.getOrThrow<string>('POSTGRES_PASSWORD'),
    });
    const postgres = new PostgresDialect({ pool });
    let rollbacks = 0;
    let commits = 0;
    const lostRollback: Dialect = {
      createAdapter: () => postgres.createAdapter(),
      createIntrospector: (db) => postgres.createIntrospector(db),
      createQueryCompiler: () => postgres.createQueryCompiler(),
      createDriver: () => {
        const driver = postgres.createDriver();
        return {
          init: (options) => driver.init(options),
          acquireConnection: (options) => driver.acquireConnection(options),
          beginTransaction: (connection, settings) =>
            driver.beginTransaction(connection, settings),
          commitTransaction: async (connection) => {
            commits += 1;
            await driver.commitTransaction(connection);
          },
          rollbackTransaction: async (connection) => {
            await driver.rollbackTransaction(connection);
            rollbacks += 1;
            throw new Error('simulated lost ROLLBACK acknowledgement');
          },
          releaseConnection: (connection, options) =>
            driver.releaseConnection(connection, options),
          destroy: (options) => driver.destroy(options),
        };
      },
    };
    const faultingDb = new Kysely<Database>({ dialect: lostRollback });
    try {
      const faultingService = new AssetsService(
        new AssetsRepository({ db: faultingDb } as DatabaseService),
        new LocalStorageService(new ConfigService({ STORAGE_ROOT: root })),
      );
      await expect(
        faultingService.upload(actor('a'), {
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          stream: Readable.from([original]),
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(rollbacks).toBe(1);
      expect(commits).toBe(0);
      expect(
        await database.db.selectFrom('asset').select('id').execute(),
      ).toEqual([]);
      expect((await files()).originals).toHaveLength(1);
      expect((await files()).thumbnails).toHaveLength(1);
    } finally {
      await faultingDb.destroy();
      expect(pool.totalCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    }
  });

  it('a committed revocation before the upload user lock prevents insertion', async () => {
    const locked = deferred();
    const release = deferred();
    const revocation = observe(
      database.db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('app_user')
          .select('id')
          .where('id', '=', users.a)
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.release();
        await release.promise;
        await transaction
          .deleteFrom('auth_session')
          .where('id', '=', sessions.a)
          .execute();
      }),
    );
    await locked.promise;
    const pending = observe(upload(actor('a')));
    try {
      await expectLockWait('app_user');
    } finally {
      release.release();
    }
    await revocation;
    await expect(pending).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await files()).toEqual({ originals: [], thumbnails: [] });
    expect(
      await database.db.selectFrom('asset').select('id').execute(),
    ).toEqual([]);
  }, 10000);

  it('a committed logout wins the session-row lock before an upload', async () => {
    const locked = deferred();
    const release = deferred();
    const holder = observe(
      database.db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('auth_session')
          .select('id')
          .where('id', '=', sessions.a)
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.release();
        await release.promise;
      }),
    );
    await locked.promise;
    const auth = new AuthSessionService(database, new PasswordService());
    const logout = observe(auth.logout(actor('a')));
    let pending: Promise<unknown> | undefined;
    try {
      await expectLockWait('auth_session');
      pending = observe(upload(actor('a')));
      await expectLockWait('auth_session', 2);
    } finally {
      release.release();
    }
    await holder;
    await logout;
    await expect(pending).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await files()).toEqual({ originals: [], thumbnails: [] });
    expect(
      await database.db.selectFrom('asset').select('id').execute(),
    ).toEqual([]);
  }, 10000);

  it.each(['logout-all', 'revoke'] as const)(
    '%s wins the user-row lock before an upload',
    async (action) => {
      const locked = deferred();
      const release = deferred();
      const holder = observe(
        database.db.transaction().execute(async (transaction) => {
          await transaction
            .selectFrom('app_user')
            .select('id')
            .where('id', '=', users.a)
            .forUpdate()
            .executeTakeFirstOrThrow();
          locked.release();
          await release.promise;
        }),
      );
      await locked.promise;
      const auth = new AuthSessionService(database, new PasswordService());
      const revocation = observe<unknown>(
        action === 'logout-all'
          ? auth.logoutAll(actor('a'))
          : auth.revoke(actor('a'), sessions.a),
      );
      let pending: Promise<unknown> | undefined;
      try {
        await expectLockWait('app_user');
        pending = observe(upload(actor('a')));
        await expectLockWait('app_user', 2);
      } finally {
        release.release();
      }
      await holder;
      await revocation;
      await expect(pending).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await files()).toEqual({ originals: [], thumbnails: [] });
      expect(
        await database.db.selectFrom('asset').select('id').execute(),
      ).toEqual([]);
    },
    10000,
  );

  it.each([
    'password change',
    'password recovery',
    'administrator disable',
  ] as const)(
    '%s wins the user lock before upload finalization',
    async (action) => {
      const locked = deferred();
      const release = deferred();
      const holder = observe(
        database.db.transaction().execute(async (transaction) => {
          await transaction
            .selectFrom('app_user')
            .select('id')
            .where('id', '=', users.a)
            .forUpdate()
            .executeTakeFirstOrThrow();
          locked.release();
          await release.promise;
        }),
      );
      await locked.promise;
      const passwords = new PasswordService();
      const operation = observe<unknown>(
        action === 'password change'
          ? new AuthSessionService(database, passwords).changePassword(
              actor('a'),
              currentPassword,
              replacementPassword,
            )
          : action === 'password recovery'
            ? new OperatorAccountsService(
                database.db,
                passwords,
              ).recoverPassword(users.a, replacementPassword)
            : new UsersService(database, passwords).disable(
                actor('admin'),
                users.a,
                currentPassword,
              ),
      );
      let pending: Promise<unknown> | undefined;
      try {
        await expectLockWait('app_user');
        pending = observe(upload(actor('a')));
        await expectLockWait('app_user', 2);
      } finally {
        release.release();
      }
      await holder;
      await operation;
      await expect(pending).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await files()).toEqual({ originals: [], thumbnails: [] });
      expect(
        await database.db.selectFrom('asset').select('id').execute(),
      ).toEqual([]);
    },
    15000,
  );

  it('checks database wall time after waiting for the user lock', async () => {
    const locked = deferred();
    const release = deferred();
    const holder = observe(
      database.db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('app_user')
          .select('id')
          .where('id', '=', users.a)
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.release();
        await release.promise;
      }),
    );
    await locked.promise;
    const pending = observe(upload(actor('a')));
    try {
      await expectLockWait('app_user');
      await sql`update auth_session set expires_at = clock_timestamp()
        where id = ${sessions.a}::uuid`.execute(database.db);
    } finally {
      release.release();
    }
    await holder;
    await expect(pending).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await files()).toEqual({ originals: [], thumbnails: [] });
    expect(
      await database.db.selectFrom('asset').select('id').execute(),
    ).toEqual([]);
  }, 10000);

  it.each([
    'logout',
    'logout-all',
    'revoke',
    'password change',
    'password recovery',
    'administrator disable',
  ] as const)(
    'allows an upload holding both locks to commit before %s',
    async (action) => {
      const locked = deferred();
      const release = deferred();
      const holder = observe(
        database.db.transaction().execute(async (transaction) => {
          await sql`lock table asset in share mode`.execute(transaction);
          locked.release();
          await release.promise;
        }),
      );
      await locked.promise;
      const pending = observe(upload(actor('a')));
      let revocation: Promise<unknown> | undefined;
      try {
        await expectLockWait('asset');
        const passwords = new PasswordService();
        const auth = new AuthSessionService(database, passwords);
        const operations = {
          logout: () => auth.logout(actor('a')),
          'logout-all': () => auth.logoutAll(actor('a')),
          revoke: () => auth.revoke(actor('a'), sessions.a),
          'password change': () =>
            auth.changePassword(
              actor('a'),
              currentPassword,
              replacementPassword,
            ),
          'password recovery': () =>
            new OperatorAccountsService(database.db, passwords).recoverPassword(
              users.a,
              replacementPassword,
            ),
          'administrator disable': () =>
            new UsersService(database, passwords).disable(
              actor('admin'),
              users.a,
              currentPassword,
            ),
        };
        revocation = observe<unknown>(operations[action]());
        await expectLockWait(action === 'logout' ? 'auth_session' : 'app_user');
      } finally {
        release.release();
      }
      await holder;
      const uploaded = await pending;
      await revocation;
      expect(
        await database.db
          .selectFrom('asset')
          .select('owner_id')
          .where('id', '=', uploaded.id)
          .executeTakeFirst(),
      ).toEqual({ owner_id: users.a });
      expect((await files()).originals).toEqual([`${uploaded.id}.jpg`]);
      expect((await files()).thumbnails).toEqual([`${uploaded.id}.jpg`]);
      expect(
        await database.db
          .selectFrom('auth_session')
          .select('id')
          .where('id', '=', sessions.a)
          .executeTakeFirst(),
      ).toBeUndefined();
    },
    15000,
  );

  it('serializes login and upload on the user row without deadlock', async () => {
    const locked = deferred();
    const release = deferred();
    const holder = observe(
      database.db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('app_user')
          .select('id')
          .where('id', '=', users.a)
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked.release();
        await release.promise;
      }),
    );
    await locked.promise;
    const login = observe(
      new AuthSessionService(database, new PasswordService()).login(
        `m11c-a-${users.a.slice(0, 8)}`,
        currentPassword,
      ),
    );
    const pending = observe(upload(actor('a')));
    try {
      await expectLockWait('app_user', 2);
    } finally {
      release.release();
      await Promise.allSettled([holder, login, pending]);
    }
    await holder;
    const [createdSession, uploaded] = await Promise.all([login, pending]);
    expect(createdSession.actor.userId).toBe(users.a);
    expect(
      await database.db
        .selectFrom('asset')
        .select('owner_id')
        .where('id', '=', uploaded.id)
        .executeTakeFirst(),
    ).toEqual({
      owner_id: users.a,
    });
    expect((await files()).originals).toEqual([`${uploaded.id}.jpg`]);
  }, 15000);

  it('retains committed media when Kysely loses the COMMIT acknowledgement', async () => {
    const pool = new Pool({
      host: '127.0.0.1',
      port: dbConfig.getOrThrow<number>('POSTGRES_PORT'),
      database: dbConfig.getOrThrow<string>('POSTGRES_DB'),
      user: dbConfig.getOrThrow<string>('POSTGRES_USER'),
      password: dbConfig.getOrThrow<string>('POSTGRES_PASSWORD'),
    });
    const postgres = new PostgresDialect({ pool });
    let commits = 0;
    const lostAcknowledgement: Dialect = {
      createAdapter: () => postgres.createAdapter(),
      createIntrospector: (db) => postgres.createIntrospector(db),
      createQueryCompiler: () => postgres.createQueryCompiler(),
      createDriver: () => {
        const driver = postgres.createDriver();
        return {
          init: (options) => driver.init(options),
          acquireConnection: (options) => driver.acquireConnection(options),
          beginTransaction: (connection, settings) =>
            driver.beginTransaction(connection, settings),
          commitTransaction: async (connection) => {
            await driver.commitTransaction(connection);
            commits += 1;
            throw new Error('simulated lost COMMIT acknowledgement');
          },
          rollbackTransaction: (connection) =>
            driver.rollbackTransaction(connection),
          releaseConnection: (connection, options) =>
            driver.releaseConnection(connection, options),
          destroy: (options) => driver.destroy(options),
        };
      },
    };
    const uncertainDb = new Kysely<Database>({ dialect: lostAcknowledgement });
    try {
      const uncertainService = new AssetsService(
        new AssetsRepository({ db: uncertainDb } as DatabaseService),
        new LocalStorageService(new ConfigService({ STORAGE_ROOT: root })),
      );
      await expect(
        uncertainService.upload(actor('a'), {
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          stream: Readable.from([original]),
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(commits).toBe(1);
      const rows = await database.db
        .selectFrom('asset')
        .select(['id', 'owner_id'])
        .where('owner_id', '=', users.a)
        .execute();
      expect(rows).toHaveLength(1);
      expect((await files()).originals).toEqual([`${rows[0].id}.jpg`]);
      expect((await files()).thumbnails).toEqual([`${rows[0].id}.jpg`]);
      expect(
        await readFile(join(root, 'originals', `${rows[0].id}.jpg`)),
      ).toEqual(original);
    } finally {
      await uncertainDb.destroy();
      expect(pool.totalCount).toBe(0);
    }
  });
});
