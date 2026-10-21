import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { type Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import {
  createMigrationDatabase,
  migrationConfig,
} from '../src/database/migrations/migration-config.js';
import {
  AUTHENTICATION_MIGRATION,
  createMigrationProvider,
  INITIAL_ASSET_MIGRATION,
} from '../src/database/migrations/migration-provider.js';
import * as initialAsset from '../src/database/migrations/versions/202610170001_initial_asset.js';
import {
  getMigrationStatus,
  migrateToLatest,
} from '../src/database/migrations/migration-runner.js';
import { testConfig } from './helpers/integration-database.js';

const execFile = promisify(execFileCallback);

describe('PostgreSQL migrations and legacy baselining', () => {
  let admin: DatabaseService;
  let db: Kysely<unknown>;
  let databaseName: string;
  let migrationEnv: NodeJS.ProcessEnv;
  let temporaryRole: string | undefined;

  beforeAll(async () => {
    const config = testConfig(); // Verify Docker ownership, tmpfs and port first.
    admin = new DatabaseService(config);
    const identity = await sql<{
      name: string;
      role: string;
      version: number;
    }>`select
      current_database() as name, current_user as role,
      current_setting('server_version_num')::integer as version`.execute(
      admin.db,
    );
    expect(identity.rows[0].name).toBe(config.get<string>('POSTGRES_DB'));
    expect(identity.rows[0].role).toBe('saefr_m7_test');
    expect(identity.rows[0].version).toBeGreaterThanOrEqual(180000);
    expect(identity.rows[0].version).toBeLessThan(190000);
    migrationEnv = {
      MIGRATION_POSTGRES_HOST: '127.0.0.1',
      MIGRATION_POSTGRES_PORT: String(
        config.getOrThrow<number>('POSTGRES_PORT'),
      ),
      MIGRATION_POSTGRES_USER: config.get<string>('POSTGRES_USER'),
      MIGRATION_POSTGRES_PASSWORD: config.get<string>('POSTGRES_PASSWORD'),
    };
  });

  beforeEach(async () => {
    databaseName = `saefr_m8_${randomUUID().replaceAll('-', '')}`;
    // Every scenario gets its own database inside the already verified container.
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    migrationEnv.MIGRATION_POSTGRES_DB = databaseName;
    db = createMigrationDatabase(migrationConfig(migrationEnv));
  });

  afterEach(async () => {
    await db?.destroy();
    if (databaseName) {
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    }
    if (temporaryRole) {
      await sql`drop role ${sql.id(temporaryRole)}`.execute(admin.db);
      temporaryRole = undefined;
    }
  });

  afterAll(async () => {
    await admin?.onModuleDestroy();
  });

  async function tables() {
    return (
      await sql<{
        name: string;
      }>`select tablename as name from pg_catalog.pg_tables
      where schemaname = 'public' order by tablename`.execute(db)
    ).rows.map((row) => row.name);
  }

  async function legacyFixture() {
    // Independent fixture from the maintainer's psql schema inspection.
    await sql`create table public.asset (
      id uuid not null primary key, filename varchar not null, mime_type varchar not null,
      size integer not null, storage_path varchar not null,
      created_at timestamp with time zone not null
    )`.execute(db);
    await sql`insert into public.asset
      (id, filename, mime_type, size, storage_path, created_at) values
      ('00000000-0000-4000-8000-000000000001', 'legacy.jpg', 'image/jpeg', 1234,
       '/preserved/originals/legacy.jpg', '2026-10-16 17:30:00+05:30'),
      ('00000000-0000-4000-8000-000000000002', 'legacy.png', 'image/png', 2147483647,
       '/preserved/originals/space and unicode Ω.png', '2026-10-15 23:59:00-04:00')`.execute(
      db,
    );
  }

  async function assetSnapshot() {
    return (
      await sql`select c.oid, c.relfilenode,
      (select jsonb_agg(to_jsonb(a) order by a.id) from public.asset a) as records
      from pg_catalog.pg_class c where c.oid = 'public.asset'::regclass`.execute(
        db,
      )
    ).rows;
  }

  async function ledger() {
    return (
      await sql<{
        name: string;
        timestamp: string;
      }>`select name, timestamp from public.kysely_migration order by name`.execute(
        db,
      )
    ).rows;
  }

  async function migrateM8Only(baselineLegacy = false) {
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: {
        async getMigrations() {
          return {
            [INITIAL_ASSET_MIGRATION]: {
              up: (connection) => initialAsset.up(connection, baselineLegacy),
              down: initialAsset.down,
            },
          };
        },
      },
    });
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }

  it('reports fresh status without creating metadata, then creates the exact schema', async () => {
    expect((await getMigrationStatus(db)).installation).toBe('fresh');
    expect(await tables()).toEqual([]);
    expect(await migrateToLatest(db)).toEqual([
      {
        migrationName: INITIAL_ASSET_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
      {
        migrationName: AUTHENTICATION_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
    ]);
    const columns =
      await sql`select column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' and table_name = 'asset'
      order by column_name`.execute(db);
    expect(columns.rows).toEqual([
      {
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'filename',
        data_type: 'character varying',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'id',
        data_type: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'mime_type',
        data_type: 'character varying',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'size',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'storage_path',
        data_type: 'character varying',
        is_nullable: 'NO',
        column_default: null,
      },
    ]);
    expect(await tables()).toEqual([
      'app_user',
      'asset',
      'auth_session',
      'kysely_migration',
      'kysely_migration_lock',
    ]);
    expect((await getMigrationStatus(db)).installation).toBe('managed');
  });

  it('baselines legacy data only with opt-in and preserves rows, paths, table identity and ledger on repeats', async () => {
    await legacyFixture();
    const original = await assetSnapshot();
    expect((await getMigrationStatus(db)).installation).toBe('legacy');
    await expect(migrateToLatest(db)).rejects.toThrow('--baseline-legacy');
    expect(await tables()).toEqual(['asset']);
    expect(await assetSnapshot()).toEqual(original);
    await migrateToLatest(db, true);
    expect(await assetSnapshot()).toEqual(original);
    const firstLedger = await ledger();
    expect(firstLedger).toHaveLength(2);
    expect(await migrateToLatest(db, true)).toEqual([]);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await ledger()).toEqual(firstLedger);
    expect(await assetSnapshot()).toEqual(original);
  });

  it('upgrades an M8-managed installation without changing historical assets or ledger entries', async () => {
    await migrateM8Only();
    await sql`insert into public.asset
      (id, filename, mime_type, size, storage_path, created_at) values
      ('00000000-0000-4000-8000-000000000003', 'managed.jpg', 'image/jpeg', 42,
       '/preserved/originals/managed.jpg', '2026-10-19 08:30:00+05:30')`.execute(
      db,
    );
    const original = await assetSnapshot();
    const originalLedger = await ledger();
    expect(originalLedger.map((row) => row.name)).toEqual([
      INITIAL_ASSET_MIGRATION,
    ]);
    expect((await getMigrationStatus(db)).migrations).toEqual([
      { name: INITIAL_ASSET_MIGRATION, applied: true },
      { name: AUTHENTICATION_MIGRATION, applied: false },
    ]);

    expect(await migrateToLatest(db)).toEqual([
      {
        migrationName: AUTHENTICATION_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
    ]);
    expect(await assetSnapshot()).toEqual(original);
    expect((await ledger())[0]).toEqual(originalLedger[0]);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await assetSnapshot()).toEqual(original);
  });

  it('creates exactly the proposed required auth columns without defaults', async () => {
    await migrateToLatest(db);
    const columns = await sql<{
      table_name: string;
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
      column_default: string | null;
    }>`select table_name, column_name, data_type, character_maximum_length,
      is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name in ('app_user', 'auth_session')
      order by table_name, column_name`.execute(db);
    expect(columns.rows).toHaveLength(14);
    expect(
      columns.rows.every(
        (row) => row.is_nullable === 'NO' && row.column_default === null,
      ),
    ).toBe(true);
    expect(
      columns.rows.map((row) => [
        row.table_name,
        row.column_name,
        row.data_type,
        row.character_maximum_length,
      ]),
    ).toEqual([
      ['app_user', 'created_at', 'timestamp with time zone', null],
      ['app_user', 'id', 'uuid', null],
      ['app_user', 'password_change_required', 'boolean', null],
      ['app_user', 'password_hash', 'text', null],
      ['app_user', 'role', 'character varying', 16],
      ['app_user', 'status', 'character varying', 16],
      ['app_user', 'updated_at', 'timestamp with time zone', null],
      ['app_user', 'username', 'character varying', 64],
      ['auth_session', 'created_at', 'timestamp with time zone', null],
      ['auth_session', 'csrf_token', 'bytea', null],
      ['auth_session', 'expires_at', 'timestamp with time zone', null],
      ['auth_session', 'id', 'uuid', null],
      ['auth_session', 'token_hash', 'bytea', null],
      ['auth_session', 'user_id', 'uuid', null],
    ]);
    expect(
      (await getMigrationStatus(db)).migrations.every(
        (migration) => migration.applied,
      ),
    ).toBe(true);
  });

  it('enforces username, role, status, session hash, CSRF, expiry and foreign-key constraints', async () => {
    await migrateToLatest(db);
    await sql`insert into public.app_user values
      ('00000000-0000-4000-8000-000000000011', 'alice', 'test-hash', 'user', 'active', false,
       '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z')`.execute(db);
    await expect(
      sql`insert into public.app_user values
      ('00000000-0000-4000-8000-000000000012', 'alice', 'test-hash', 'user', 'active', false,
       '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z')`.execute(db),
    ).rejects.toMatchObject({ code: '23505' });
    for (const [username, role, status] of [
      ['Alice', 'user', 'active'],
      ['bob', 'owner', 'active'],
      ['bob', 'user', 'pending'],
    ]) {
      await expect(
        sql`insert into public.app_user values
        ('00000000-0000-4000-8000-000000000012', ${username}, 'test-hash', ${role}, ${status}, false,
         '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z')`.execute(db),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await sql`insert into public.auth_session values
      ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000011',
       ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 2)},
       '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z')`.execute(db);
    await expect(
      sql`insert into public.auth_session values
      ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000011',
       ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 3)},
       '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z')`.execute(db),
    ).rejects.toMatchObject({ code: '23505' });
    for (const [userId, tokenHash, csrfToken, expires, code] of [
      [
        '00000000-0000-4000-8000-000000000099',
        Buffer.alloc(32, 4),
        Buffer.alloc(32, 5),
        '2026-10-22T00:00:00Z',
        '23503',
      ],
      [
        '00000000-0000-4000-8000-000000000011',
        Buffer.alloc(31, 4),
        Buffer.alloc(32, 5),
        '2026-10-22T00:00:00Z',
        '23514',
      ],
      [
        '00000000-0000-4000-8000-000000000011',
        Buffer.alloc(32, 4),
        Buffer.alloc(31, 5),
        '2026-10-22T00:00:00Z',
        '23514',
      ],
      [
        '00000000-0000-4000-8000-000000000011',
        Buffer.alloc(32, 4),
        Buffer.alloc(32, 5),
        '2026-10-20T00:00:00Z',
        '23514',
      ],
    ] as const) {
      await expect(
        sql`insert into public.auth_session values
        ('00000000-0000-4000-8000-000000000022', ${userId},
         ${tokenHash}, ${csrfToken}, '2026-10-21T00:00:00Z', ${expires})`.execute(
          db,
        ),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      sql`delete from public.app_user where username = 'alice'`.execute(db),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('rejects a partial auth table before M10 and leaves the M8 data/history alone', async () => {
    await migrateM8Only();
    const original = await assetSnapshot();
    const originalLedger = await ledger();
    await sql`create table public.app_user (id uuid primary key)`.execute(db);
    await expect(migrateToLatest(db)).rejects.toThrow(
      'reserved authentication relation',
    );
    expect(await assetSnapshot()).toEqual(original);
    expect(await ledger()).toEqual(originalLedger);
    expect(await tables()).not.toContain('auth_session');
  });

  it('rejects a reserved auth index name before M10', async () => {
    await migrateM8Only();
    await sql`create table public.unrelated (id uuid)`.execute(db);
    await sql`create index auth_session_user_id_idx on public.unrelated (id)`.execute(
      db,
    );
    await expect(migrateToLatest(db)).rejects.toThrow(
      'reserved authentication relation',
    );
    expect((await ledger()).map((row) => row.name)).toEqual([
      INITIAL_ASSET_MIGRATION,
    ]);
  });

  it.each([
    ['missing session table', 'drop table public.auth_session'],
    ['extra user column', 'alter table public.app_user add column extra text'],
    [
      'nullable password hash',
      'alter table public.app_user alter column password_hash drop not null',
    ],
    [
      'unexpected timestamp default',
      'alter table public.app_user alter column created_at set default now()',
    ],
    [
      'missing username check',
      'alter table public.app_user drop constraint app_user_username_format_check',
    ],
    [
      'missing foreign key',
      'alter table public.auth_session drop constraint auth_session_user_id_fkey',
    ],
    [
      'extra session index',
      'create index auth_session_extra_idx on public.auth_session (created_at)',
    ],
    ['missing expiry index', 'drop index public.auth_session_expires_at_idx'],
    [
      'user row security',
      'alter table public.app_user enable row level security',
    ],
  ])('rejects M10 schema drift: %s', async (_name, mutation) => {
    await migrateToLatest(db);
    const original = await assetSnapshot();
    const originalLedger = await ledger();
    await sql.raw(mutation).execute(db); // Static test SQL, verified disposable database.
    await expect(getMigrationStatus(db)).rejects.toThrow(
      'Incompatible M10 authentication schema',
    );
    await expect(migrateToLatest(db)).rejects.toThrow(
      'Incompatible M10 authentication schema',
    );
    expect(await assetSnapshot()).toEqual(original);
    expect(await ledger()).toEqual(originalLedger);
  });

  it('rejects M10 ledger entry without M10 schema', async () => {
    await migrateM8Only();
    const original = await assetSnapshot();
    const m10Timestamp = new Date(
      Date.parse((await ledger())[0].timestamp) + 1000,
    ).toISOString();
    await sql`insert into public.kysely_migration values
      (${AUTHENTICATION_MIGRATION}, ${m10Timestamp})`.execute(db);
    const originalLedger = await ledger();
    await expect(migrateToLatest(db)).rejects.toThrow(
      'Incompatible M10 authentication schema',
    );
    expect(await assetSnapshot()).toEqual(original);
    expect(await ledger()).toEqual(originalLedger);
  });

  it('rolls back M10 tables and ledger if a later version fails, then upgrades on retry', async () => {
    await migrateM8Only();
    const originalAsset = await assetSnapshot();
    const originalLedger = await ledger();
    const provider = createMigrationProvider();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: {
        async getMigrations() {
          return {
            ...(await provider.getMigrations()),
            '202610210002_test_failure': {
              async up(transaction) {
                await sql`create table public.must_rollback (id integer)`.execute(
                  transaction,
                );
                throw new Error('Intentional test migration failure');
              },
            },
          };
        },
      },
    });
    expect((await migrator.migrateToLatest()).error).toBeDefined();
    expect(await tables()).toEqual([
      'asset',
      'kysely_migration',
      'kysely_migration_lock',
    ]);
    expect(await assetSnapshot()).toEqual(originalAsset);
    expect(await ledger()).toEqual(originalLedger);
    expect(await migrateToLatest(db)).toHaveLength(1);
    expect((await ledger()).map((row) => row.name)).toEqual([
      INITIAL_ASSET_MIGRATION,
      AUTHENTICATION_MIGRATION,
    ]);
  });

  it('refuses baseline mode on an empty database', async () => {
    await expect(migrateToLatest(db, true)).rejects.toThrow(
      'missing public.asset',
    );
    expect(await tables()).toEqual([]);
  });

  it('serializes concurrent fresh runners and applies the version only once', async () => {
    const other = createMigrationDatabase(migrationConfig(migrationEnv));
    try {
      const results = await Promise.all([
        migrateToLatest(db),
        migrateToLatest(other),
      ]);
      expect(
        results.map((result) => result.length).sort((a, b) => a - b),
      ).toEqual([0, 2]);
      expect(await ledger()).toHaveLength(2);
    } finally {
      await other.destroy();
    }
  });

  it.each([
    [
      'timestamp without timezone',
      'alter table public.asset alter column created_at type timestamp without time zone',
    ],
    ['bigint size', 'alter table public.asset alter column size type bigint'],
    ['missing column', 'alter table public.asset drop column mime_type'],
    ['extra column', 'alter table public.asset add column extra text'],
    [
      'nullable column',
      'alter table public.asset alter column filename drop not null',
    ],
    [
      'bounded varchar',
      'alter table public.asset alter column filename type varchar(255)',
    ],
    [
      'column default',
      'alter table public.asset alter column created_at set default now()',
    ],
    [
      'missing primary key',
      'alter table public.asset drop constraint asset_pkey',
    ],
    [
      'renamed primary key',
      'alter table public.asset rename constraint asset_pkey to other_pkey',
    ],
    [
      'extra constraint',
      'alter table public.asset add constraint positive_size check (size > 0)',
    ],
    ['extra index', 'create index extra_idx on public.asset(filename)'],
    ['row security', 'alter table public.asset enable row level security'],
  ])(
    'rejects %s without repairing the schema or changing records',
    async (_name, mutation) => {
      await legacyFixture();
      await sql.raw(mutation).execute(db); // Static test SQL, only in the verified disposable DB.
      const original = await assetSnapshot();
      await expect(migrateToLatest(db, true)).rejects.toThrow(
        'Incompatible public.asset',
      );
      expect(await assetSnapshot()).toEqual(original);
      expect(await tables()).toEqual(['asset']);
    },
  );

  it('rejects a view occupying the asset name', async () => {
    await sql`create view public.asset as select 1 as id`.execute(db);
    await expect(migrateToLatest(db, true)).rejects.toThrow(
      'ordinary permanent table',
    );
    expect(await tables()).toEqual([]);
  });

  it('rejects partial Kysely metadata without creating the missing table', async () => {
    await legacyFixture();
    await sql`create table public.kysely_migration (name varchar(255) primary key, timestamp varchar(255) not null)`.execute(
      db,
    );
    const original = await assetSnapshot();
    await expect(migrateToLatest(db, true)).rejects.toThrow(
      'Incomplete or incompatible',
    );
    expect(await tables()).toEqual(['asset', 'kysely_migration']);
    expect(await assetSnapshot()).toEqual(original);
  });

  it('refuses an unknown migration history and leaves it unchanged', async () => {
    await migrateToLatest(db);
    await sql`insert into public.kysely_migration values ('999999999999_unknown', '2026-10-17T00:00:00.000Z')`.execute(
      db,
    );
    const original = await ledger();
    await expect(migrateToLatest(db)).rejects.toThrow(
      'Incompatible migration history',
    );
    expect(await ledger()).toEqual(original);
  });

  it.each([
    [
      'missing ledger key',
      'alter table public.kysely_migration drop constraint kysely_migration_pkey',
    ],
    [
      'unexpected ledger default',
      "alter table public.kysely_migration alter column timestamp set default 'invalid'",
    ],
    ['missing lock row', 'delete from public.kysely_migration_lock'],
  ])('rejects damaged metadata: %s', async (_name, mutation) => {
    await migrateToLatest(db);
    await sql.raw(mutation).execute(db);
    const original = await ledger();
    await expect(migrateToLatest(db)).rejects.toThrow('Incompatible Kysely');
    expect(await ledger()).toEqual(original);
  });

  it('refuses to recreate an asset table missing from a managed database', async () => {
    await migrateToLatest(db);
    await sql`drop table public.asset`.execute(db);
    const original = await ledger();
    await expect(migrateToLatest(db)).rejects.toThrow('Refusing to recreate');
    expect(await ledger()).toEqual(original);
    expect(await tables()).not.toContain('asset');
  });

  it('fails cleanly when the migration role has no schema creation privileges', async () => {
    temporaryRole = `m8_role_${randomUUID().replaceAll('-', '')}`;
    await sql`create role ${sql.id(temporaryRole)}`.execute(admin.db);
    await db.connection().execute(async (connection) => {
      await sql`set role ${sql.id(temporaryRole!)}`.execute(connection);
      try {
        await expect(migrateToLatest(connection)).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await sql`reset role`.execute(connection);
      }
    });
    expect(await tables()).toEqual([]);
  });

  it('rolls back pending schema and ledger entries when a later migration fails, and permits retry', async () => {
    const provider = createMigrationProvider();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: {
        async getMigrations() {
          return {
            ...(await provider.getMigrations()),
            '202610170002_test_failure': {
              async up(transaction) {
                await sql`create table public.must_rollback (id integer)`.execute(
                  transaction,
                );
                throw new Error('Intentional test migration failure');
              },
            },
          };
        },
      },
    });
    expect((await migrator.migrateToLatest()).error).toBeDefined();
    expect(await tables()).toEqual([
      'kysely_migration',
      'kysely_migration_lock',
    ]);
    expect(await ledger()).toEqual([]);
    expect(await migrateToLatest(db)).toHaveLength(2);
  });

  it('refuses destructive rollback of authentication and a baseline', async () => {
    await legacyFixture();
    await migrateToLatest(db, true);
    const original = await assetSnapshot();
    const originalLedger = await ledger();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: createMigrationProvider(),
    });
    expect((await migrator.migrateDown()).error).toMatchObject({
      message: expect.stringContaining('cannot be rolled back automatically'),
    });
    expect(await assetSnapshot()).toEqual(original);
    expect(await ledger()).toEqual(originalLedger);
  });

  async function cli(args: string[]) {
    return execFile(
      process.execPath,
      [resolve('dist/database/migrations/cli.js'), ...args],
      {
        env: {
          ...process.env,
          POSTGRES_HOST: 'invalid.invalid',
          POSTGRES_DB: 'not_the_test_db',
          ...migrationEnv,
        },
        timeout: 15000,
      },
    );
  }

  it('runs the compiled CLI for read-only status, fresh migration and a repeat', async () => {
    expect((await cli(['status'])).stdout).toContain('Installation: fresh');
    expect(await tables()).toEqual([]);
    expect(
      (await cli(['up', `--confirm-database=${databaseName}`])).stdout,
    ).toContain(`${INITIAL_ASSET_MIGRATION}: applied`);
    expect(
      (await cli(['up', `--confirm-database=${databaseName}`])).stdout,
    ).toContain('no migrations applied');
    expect((await cli(['status'])).stdout).toContain('Installation: managed');
  });

  it('returns a nonzero CLI error for unapproved legacy baselining, then baselines with opt-in', async () => {
    await legacyFixture();
    const original = await assetSnapshot();
    await expect(
      cli(['up', `--confirm-database=${databaseName}`]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--baseline-legacy'),
    });
    expect(await tables()).toEqual(['asset']);
    await cli([
      'up',
      `--confirm-database=${databaseName}`,
      '--baseline-legacy',
    ]);
    expect(await assetSnapshot()).toEqual(original);
  });
});
