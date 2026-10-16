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
  createMigrationProvider,
  INITIAL_ASSET_MIGRATION,
} from '../src/database/migrations/migration-provider.js';
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
      MIGRATION_POSTGRES_PORT: config.get<string>('POSTGRES_PORT'),
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
    await sql`insert into public.asset values
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
      await sql`select name, timestamp from public.kysely_migration order by name`.execute(
        db,
      )
    ).rows;
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
      'asset',
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
    expect(firstLedger).toHaveLength(1);
    expect(await migrateToLatest(db, true)).toEqual([]);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await ledger()).toEqual(firstLedger);
    expect(await assetSnapshot()).toEqual(original);
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
      ).toEqual([0, 1]);
      expect(await ledger()).toHaveLength(1);
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
    expect(await migrateToLatest(db)).toHaveLength(1);
  });

  it('refuses destructive rollback of a baseline', async () => {
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
      message: expect.stringContaining('cannot be rolled back'),
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
