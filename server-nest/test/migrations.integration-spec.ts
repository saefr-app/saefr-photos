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
import { AssetsRepository } from '../src/assets/assets.repository.js';
import { AssetsService } from '../src/assets/assets.service.js';
import type { AuthenticatedActor } from '../src/auth/auth-session.service.js';
import type { LocalStorageService } from '../src/storage/local-storage.service.js';
import { AuthSessionService } from '../src/auth/auth-session.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import {
  createMigrationDatabase,
  migrationConfig,
} from '../src/database/migrations/migration-config.js';
import {
  ASSET_LIFECYCLE_MIGRATION,
  AUTHENTICATION_MIGRATION,
  ASSET_OWNERSHIP_MIGRATION,
  createMigrationProvider,
  INITIAL_ASSET_MIGRATION,
} from '../src/database/migrations/migration-provider.js';
import * as initialAsset from '../src/database/migrations/versions/202610170001_initial_asset.js';
import * as authenticationFoundation from '../src/database/migrations/versions/202610210001_authentication_foundation.js';
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
      (select jsonb_agg(to_jsonb(a) - 'owner_id' - 'trashed_at' - 'lifecycle_version' order by a.id)
        from public.asset a) as records
      from pg_catalog.pg_class c where c.oid = 'public.asset'::regclass`.execute(
        db,
      )
    ).rows;
  }

  async function fullAssetRecords() {
    return (
      await sql`select jsonb_agg(to_jsonb(a) order by a.id) as records
        from public.asset a`.execute(db)
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

  async function managedSnapshot() {
    return {
      history: await ledger(),
      tableNames: await tables(),
      asset: await assetSnapshot(),
      fullAssetRecords: await fullAssetRecords(),
      columns: (
        await sql`select table_name, column_name, data_type, is_nullable, column_default
          from information_schema.columns where table_schema = 'public'
            and table_name in ('asset', 'app_user', 'auth_session')
          order by table_name, ordinal_position`.execute(db)
      ).rows,
      constraints: (
        await sql`select c.relname, k.conname, k.contype, k.convalidated,
            k.conenforced, pg_catalog.pg_get_constraintdef(k.oid) as definition
          from pg_catalog.pg_constraint k
            join pg_catalog.pg_class c on c.oid = k.conrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname in ('asset', 'app_user', 'auth_session')
          order by c.relname, k.conname`.execute(db)
      ).rows,
      indexes: (
        await sql`select tablename, indexname, indexdef from pg_catalog.pg_indexes
          where schemaname = 'public'
            and tablename in ('asset', 'app_user', 'auth_session')
          order by tablename, indexname`.execute(db)
      ).rows,
      status: await getMigrationStatus(db),
    };
  }

  function m8Provider(baselineLegacy = false) {
    return {
      async getMigrations() {
        return {
          [INITIAL_ASSET_MIGRATION]: {
            up: (connection: Kysely<unknown>) =>
              initialAsset.up(connection, baselineLegacy),
            down: initialAsset.down,
          },
        };
      },
    };
  }

  function m10Provider() {
    return {
      async getMigrations() {
        return {
          [INITIAL_ASSET_MIGRATION]: initialAsset,
          [AUTHENTICATION_MIGRATION]: authenticationFoundation,
        };
      },
    };
  }

  function m11Provider(baselineLegacy = false) {
    return {
      async getMigrations() {
        const all =
          await createMigrationProvider(baselineLegacy).getMigrations();
        return {
          [INITIAL_ASSET_MIGRATION]: all[INITIAL_ASSET_MIGRATION],
          [AUTHENTICATION_MIGRATION]: all[AUTHENTICATION_MIGRATION],
          [ASSET_OWNERSHIP_MIGRATION]: all[ASSET_OWNERSHIP_MIGRATION],
        };
      },
    };
  }

  async function migrateM11Only(baselineLegacy = false) {
    const result = await new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: m11Provider(baselineLegacy),
    }).migrateToLatest();
    if (result.error) throw result.error;
  }

  async function migrateM8Only(baselineLegacy = false) {
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: m8Provider(baselineLegacy),
    });
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }

  async function migrateM10Only() {
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: m10Provider(),
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
      {
        migrationName: ASSET_OWNERSHIP_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
      {
        migrationName: ASSET_LIFECYCLE_MIGRATION,
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
        column_name: 'lifecycle_version',
        data_type: 'bigint',
        is_nullable: 'NO',
        column_default: '0',
      },
      {
        column_name: 'mime_type',
        data_type: 'character varying',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        column_name: 'owner_id',
        data_type: 'uuid',
        is_nullable: 'YES',
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
      {
        column_name: 'trashed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    expect(await tables()).toEqual([
      'app_user',
      'asset',
      'asset_deletion',
      'auth_session',
      'kysely_migration',
      'kysely_migration_lock',
      'storage_binding',
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
    expect(firstLedger).toHaveLength(4);
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
      { name: ASSET_OWNERSHIP_MIGRATION, applied: false },
      { name: ASSET_LIFECYCLE_MIGRATION, applied: false },
    ]);

    expect(await migrateToLatest(db)).toEqual([
      {
        migrationName: AUTHENTICATION_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
      {
        migrationName: ASSET_OWNERSHIP_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
      {
        migrationName: ASSET_LIFECYCLE_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
    ]);
    expect(await assetSnapshot()).toEqual(original);
    expect((await ledger())[0]).toEqual(originalLedger[0]);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await assetSnapshot()).toEqual(original);
  });

  it('upgrades an M10-managed installation without rewriting ownerless records or earlier history', async () => {
    await migrateM10Only();
    await sql`insert into public.asset
      (id, filename, mime_type, size, storage_path, created_at) values
      ('00000000-0000-4000-8000-000000000004', 'prior.jpg', 'image/jpeg', 42,
       '/preserved/originals/prior.jpg', '2026-10-19 08:30:00+05:30')`.execute(
      db,
    );
    const before = await assetSnapshot();
    const history = await ledger();
    expect((await getMigrationStatus(db)).migrations[2]).toEqual({
      name: ASSET_OWNERSHIP_MIGRATION,
      applied: false,
    });
    expect(await migrateToLatest(db)).toHaveLength(2);
    expect(await assetSnapshot()).toEqual(before);
    expect((await ledger()).slice(0, 2)).toEqual(history);
    expect(
      (
        await sql<{
          owner_id: string | null;
        }>`select owner_id from public.asset`.execute(db)
      ).rows,
    ).toEqual([{ owner_id: null }]);
    expect(await migrateToLatest(db)).toEqual([]);
  });

  it('creates the exact nullable ownership column, FK, check and ordering index', async () => {
    await migrateToLatest(db);
    const triggerProbe = await sql`select c.relname as relation,
      p.proname as function_name, pn.nspname as function_schema,
      t.tgtype::integer as event_type, t.tgenabled as enabled,
      t.tgisinternal as internal, t.tgdeferrable as deferrable,
      t.tginitdeferred as initially_deferred
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_trigger t on t.tgconstraint = k.oid
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
      join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
      where k.conrelid = 'public.asset'::regclass and k.conname = 'asset_owner_id_fkey'
      order by c.relname, p.proname`.execute(db);
    expect(triggerProbe.rows).toEqual([
      {
        relation: 'app_user',
        function_name: 'RI_FKey_noaction_upd',
        function_schema: 'pg_catalog',
        event_type: 17,
        enabled: 'O',
        internal: true,
        deferrable: false,
        initially_deferred: false,
      },
      {
        relation: 'app_user',
        function_name: 'RI_FKey_restrict_del',
        function_schema: 'pg_catalog',
        event_type: 9,
        enabled: 'O',
        internal: true,
        deferrable: false,
        initially_deferred: false,
      },
      {
        relation: 'asset',
        function_name: 'RI_FKey_check_ins',
        function_schema: 'pg_catalog',
        event_type: 5,
        enabled: 'O',
        internal: true,
        deferrable: false,
        initially_deferred: false,
      },
      {
        relation: 'asset',
        function_name: 'RI_FKey_check_upd',
        function_schema: 'pg_catalog',
        event_type: 17,
        enabled: 'O',
        internal: true,
        deferrable: false,
        initially_deferred: false,
      },
    ]);
    const column = await sql<{
      type: string;
      required: boolean;
      default: string | null;
    }>`
      select pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
        a.attnotnull as required, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default
      from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.asset'::regclass and a.attname = 'owner_id'`.execute(
      db,
    );
    expect(column.rows).toEqual([
      { type: 'uuid', required: false, default: null },
    ]);
    const constraints = await sql<{
      name: string;
      valid: boolean;
      enforced: boolean;
      definition: string;
    }>`
      select conname as name, convalidated as valid, conenforced as enforced,
        pg_catalog.pg_get_constraintdef(oid) as definition
      from pg_catalog.pg_constraint where conrelid = 'public.asset'::regclass
        and contype <> 'n' order by conname`.execute(db);
    expect(
      constraints.rows.map((row) => [row.name, row.valid, row.enforced]),
    ).toEqual([
      ['asset_lifecycle_version_check', true, true],
      ['asset_owner_id_fkey', true, true],
      ['asset_owner_required_check', false, true],
      ['asset_pkey', true, true],
      ['asset_trashed_at_finite_check', true, true],
    ]);
    expect(
      constraints.rows.find((row) => row.name === 'asset_owner_id_fkey')
        ?.definition,
    ).toContain('REFERENCES app_user(id) ON DELETE RESTRICT');
    expect(
      constraints.rows.find((row) => row.name === 'asset_owner_required_check')
        ?.definition,
    ).toContain('NOT VALID');
    const index = await sql<{
      definition: string;
    }>`select pg_catalog.pg_get_indexdef(indexrelid) as definition
      from pg_catalog.pg_index where indrelid = 'public.asset'::regclass and not indisprimary`.execute(
      db,
    );
    expect(index.rows.map((row) => row.definition).sort()).toEqual(
      [
        'CREATE INDEX asset_active_owner_created_id_idx ON public.asset USING btree (owner_id, created_at DESC, id DESC) WHERE (trashed_at IS NULL)',
        'CREATE INDEX asset_owner_created_id_idx ON public.asset USING btree (owner_id, created_at DESC, id DESC)',
        'CREATE INDEX asset_trash_owner_trashed_id_idx ON public.asset USING btree (owner_id, trashed_at DESC, id DESC) WHERE (trashed_at IS NOT NULL)',
      ].sort(),
    );
  });

  it.each([
    ['asset', 'RI_FKey_check_ins'],
    ['app_user', 'RI_FKey_restrict_del'],
  ])(
    'rejects a disabled M11 ownership FK trigger on %s without repair',
    async (relation, functionName) => {
      await legacyFixture();
      await migrateM11Only(true);
      const originalLedger = await ledger();
      const originalAssets = await assetSnapshot();
      const originalFullAssets = await fullAssetRecords();
      const originalStatus = await getMigrationStatus(db);
      const trigger = await sql<{ name: string }>`select t.tgname as name
        from pg_catalog.pg_constraint k
          join pg_catalog.pg_trigger t on t.tgconstraint = k.oid
          join pg_catalog.pg_proc p on p.oid = t.tgfoid
        where k.conrelid = 'public.asset'::regclass
          and k.conname = 'asset_owner_id_fkey'
          and t.tgrelid = ${`public.${relation}`}::regclass
          and p.proname = ${functionName}`.execute(db);
      expect(trigger.rows).toHaveLength(1);
      const table = sql.id('public', relation);
      const triggerName = sql.id(trigger.rows[0].name);
      await sql`alter table ${table} disable trigger ${triggerName}`.execute(
        db,
      );

      await expect(getMigrationStatus(db)).rejects.toThrow('Incompatible M11');
      await expect(migrateToLatest(db)).rejects.toThrow('Incompatible M11');
      await expect(
        new AuthSessionService(
          { db } as DatabaseService,
          new PasswordService(),
        ).assertReady(),
      ).rejects.toThrow('Incompatible M11');
      expect(await ledger()).toEqual(originalLedger);
      expect(await assetSnapshot()).toEqual(originalAssets);
      expect(await fullAssetRecords()).toEqual(originalFullAssets);

      await sql`alter table ${table} enable trigger ${triggerName}`.execute(db);
      expect(await getMigrationStatus(db)).toEqual(originalStatus);
      await new AuthSessionService(
        { db } as DatabaseService,
        new PasswordService(),
      ).assertReady();
      const authTriggers = await sql<{
        enabled: string;
      }>`select t.tgenabled as enabled
        from pg_catalog.pg_constraint k
          join pg_catalog.pg_trigger t on t.tgconstraint = k.oid
        where k.conrelid = 'public.auth_session'::regclass
          and k.conname = 'auth_session_user_id_fkey'`.execute(db);
      expect(authTriggers.rows).toHaveLength(4);
      expect(authTriggers.rows.every((row) => row.enabled === 'O')).toBe(true);
      expect(await ledger()).toEqual(originalLedger);
      expect(await assetSnapshot()).toEqual(originalAssets);
      expect(await fullAssetRecords()).toEqual(originalFullAssets);
    },
  );

  it('rejects new NULL ownership, unknown owners and NULL updates while retaining old ownerless rows', async () => {
    await legacyFixture();
    await migrateToLatest(db, true);
    const original = await assetSnapshot();
    const assets = new AssetsRepository({
      db: db as DatabaseService['db'],
    } as DatabaseService);
    const owner = '00000000-0000-4000-8000-000000000011';
    expect(await assets.findAll(owner)).toEqual([]);
    expect(
      await assets.findById('00000000-0000-4000-8000-000000000001', owner),
    ).toBeUndefined();
    expect(
      await assets.findFileById('00000000-0000-4000-8000-000000000001', owner),
    ).toBeUndefined();
    const storage = {
      openOriginal: async () => {
        throw new Error('ownerless storage must remain inaccessible');
      },
      openThumbnail: async () => {
        throw new Error('ownerless storage must remain inaccessible');
      },
    } as unknown as LocalStorageService;
    const service = new AssetsService(assets, storage);
    const actor: AuthenticatedActor = {
      userId: owner,
      username: 'assetowner',
      role: 'user',
      sessionId: '00000000-0000-4000-8000-000000000012',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      passwordChangeRequired: false,
      csrfToken: Buffer.alloc(32),
    };
    for (const id of [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000099',
    ]) {
      await expect(service.findById(actor, id)).rejects.toMatchObject({
        message: 'Asset not found',
        status: 404,
      });
      await expect(service.getOriginal(actor, id)).rejects.toMatchObject({
        message: 'Asset not found',
        status: 404,
      });
      await expect(service.getThumbnail(actor, id)).rejects.toMatchObject({
        message: 'Asset not found',
        status: 404,
      });
    }
    await expect(
      sql`insert into public.asset
      (id, filename, mime_type, size, storage_path, created_at) values
      ('00000000-0000-4000-8000-000000000005', 'new.jpg', 'image/jpeg', 1,
       '/isolated/new.jpg', now())`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.asset set filename = 'renamed.jpg'
      where id = '00000000-0000-4000-8000-000000000001'`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into public.asset
      (id, filename, mime_type, size, storage_path, created_at, owner_id) values
      ('00000000-0000-4000-8000-000000000005', 'new.jpg', 'image/jpeg', 1,
       '/isolated/new.jpg', now(), '00000000-0000-4000-8000-000000000099')`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await assetSnapshot()).toEqual(original);
    await sql`insert into public.app_user values
      ('00000000-0000-4000-8000-000000000011', 'assetowner', 'test-hash',
       'user', 'disabled', false, now(), now())`.execute(db);
    await sql`update public.asset set owner_id = '00000000-0000-4000-8000-000000000011'
      where id = '00000000-0000-4000-8000-000000000001'`.execute(db);
    await expect(
      sql`delete from public.app_user where username = 'assetowner'`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: '23001' });
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*) from public.asset where owner_id is null`.execute(db)
      ).rows[0].count,
    ).toBe('1');
  });

  it('rejects a premature ownership column before M11', async () => {
    await migrateM10Only();
    const history = await ledger();
    await sql`alter table public.asset add column owner_id uuid`.execute(db);
    await expect(migrateToLatest(db)).rejects.toThrow(
      'Incompatible public.asset',
    );
    expect(await ledger()).toEqual(history);
  });

  it('rejects a reserved ownership index name before applying M11', async () => {
    await migrateM10Only();
    const history = await ledger();
    await sql`create table public.unrelated_owner (id uuid)`.execute(db);
    await sql`create index asset_owner_created_id_idx on public.unrelated_owner (id)`.execute(
      db,
    );
    await expect(migrateToLatest(db)).rejects.toThrow(
      'reserved M11 ownership object name',
    );
    expect(await ledger()).toEqual(history);
    expect(
      (
        await sql<{
          present: boolean;
        }>`select exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'asset' and column_name = 'owner_id') as present`.execute(
          db,
        )
      ).rows[0].present,
    ).toBe(false);
  });

  it('serializes two M10-to-M12 runners and records each version once', async () => {
    await migrateM10Only();
    const other = createMigrationDatabase(migrationConfig(migrationEnv));
    try {
      const results = await Promise.all([
        migrateToLatest(db),
        migrateToLatest(other),
      ]);
      expect(
        results.map((result) => result.length).sort((a, b) => a - b),
      ).toEqual([0, 2]);
      expect(await ledger()).toHaveLength(4);
      expect((await getMigrationStatus(db)).migrations[2].applied).toBe(true);
    } finally {
      await other.destroy();
    }
  });

  it('rolls back M11 DDL and ledger when a following version fails', async () => {
    await migrateM10Only();
    const history = await ledger();
    const provider = createMigrationProvider();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: {
        async getMigrations() {
          return {
            ...(await provider.getMigrations()),
            '202610220002_test_failure': {
              async up() {
                throw new Error('Intentional test migration failure');
              },
            },
          };
        },
      },
    });
    expect((await migrator.migrateToLatest()).error).toBeDefined();
    expect(await ledger()).toEqual(history);
    expect(
      (
        await sql<{
          present: boolean;
        }>`select exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'asset' and column_name = 'owner_id') as present`.execute(
          db,
        )
      ).rows[0].present,
    ).toBe(false);
    expect(await migrateToLatest(db)).toHaveLength(2);
  });

  it('rejects an M11 ledger entry with only M10 schema', async () => {
    await migrateM10Only();
    const history = await ledger();
    const later = new Date(
      Date.parse(history.at(-1)!.timestamp) + 1,
    ).toISOString();
    await sql`insert into public.kysely_migration values
      (${ASSET_OWNERSHIP_MIGRATION}, ${later})`.execute(db);
    await expect(getMigrationStatus(db)).rejects.toThrow('Incompatible M11');
    await expect(migrateToLatest(db)).rejects.toThrow('Incompatible M11');
    expect((await ledger()).slice(0, 2)).toEqual(history);
  });

  it.each([
    [
      'owner default',
      'alter table public.asset alter column owner_id set default gen_random_uuid()',
    ],
    [
      'wrong FK action',
      [
        'alter table public.asset drop constraint asset_owner_id_fkey',
        'alter table public.asset add constraint asset_owner_id_fkey foreign key (owner_id) references public.app_user(id) on delete cascade',
      ],
    ],
    [
      'missing FK',
      'alter table public.asset drop constraint asset_owner_id_fkey',
    ],
    [
      'validated check',
      'alter table public.asset validate constraint asset_owner_required_check',
    ],
    [
      'wrong check',
      [
        'alter table public.asset drop constraint asset_owner_required_check',
        'alter table public.asset add constraint asset_owner_required_check check (size > 0) not valid',
      ],
    ],
    [
      'wrong index order',
      [
        'drop index public.asset_owner_created_id_idx',
        'create index asset_owner_created_id_idx on public.asset(owner_id, created_at, id)',
      ],
    ],
    ['missing index', 'drop index public.asset_owner_created_id_idx'],
    [
      'extra trigger',
      [
        'create function public.test_trigger() returns trigger language plpgsql as $$ begin return new; end $$',
        'create trigger test_asset_trigger before update on public.asset for each row execute function public.test_trigger()',
      ],
    ],
    ['row security', 'alter table public.asset enable row level security'],
  ])('rejects M11 schema drift: %s', async (_name, mutation) => {
    await migrateToLatest(db);
    const history = await ledger();
    for (const statement of typeof mutation === 'string'
      ? [mutation]
      : mutation) {
      await sql.raw(statement).execute(db); // Static SQL in isolated disposable database.
    }
    await expect(getMigrationStatus(db)).rejects.toThrow('Incompatible M12');
    await expect(migrateToLatest(db)).rejects.toThrow('Incompatible M12');
    expect(await ledger()).toEqual(history);
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
    expect(await migrateToLatest(db)).toHaveLength(3);
    expect((await ledger()).map((row) => row.name)).toEqual([
      INITIAL_ASSET_MIGRATION,
      AUTHENTICATION_MIGRATION,
      ASSET_OWNERSHIP_MIGRATION,
      ASSET_LIFECYCLE_MIGRATION,
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
      ).toEqual([0, 4]);
      expect(await ledger()).toHaveLength(4);
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
    expect(await migrateToLatest(db)).toHaveLength(4);
  });

  it('refuses M11 ownership rollback without changing history, schema or assets', async () => {
    await legacyFixture();
    await migrateM11Only(true);
    const original = await managedSnapshot();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: m11Provider(),
    });
    expect((await migrator.migrateDown()).error).toMatchObject({
      message: expect.stringContaining(
        'Ownership migration cannot be rolled back automatically',
      ),
    });
    expect(await managedSnapshot()).toEqual(original);
  });

  it('refuses M10 authentication rollback without changing history, schema or assets', async () => {
    await legacyFixture();
    await migrateM8Only(true);
    await migrateM10Only();
    const original = await managedSnapshot();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: m10Provider(),
    });
    expect((await migrator.migrateDown()).error).toMatchObject({
      message: expect.stringContaining(
        'Authentication migration cannot be rolled back automatically',
      ),
    });
    expect(await managedSnapshot()).toEqual(original);
  });

  it('refuses M8 legacy baseline rollback without changing history, schema or assets', async () => {
    await legacyFixture();
    await migrateM8Only(true);
    const original = await managedSnapshot();
    const migrator = new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: m8Provider(true),
    });
    expect((await migrator.migrateDown()).error).toMatchObject({
      message: expect.stringContaining(
        'The initial asset migration cannot be rolled back',
      ),
    });
    expect(await managedSnapshot()).toEqual(original);
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

  it('upgrades an M11 installation without changing historical rows or ledger entries', async () => {
    await legacyFixture();
    await migrateM11Only(true);
    const before = await assetSnapshot();
    const ledgerBefore = await ledger();
    expect(await migrateToLatest(db)).toEqual([
      {
        migrationName: ASSET_LIFECYCLE_MIGRATION,
        direction: 'Up',
        status: 'Success',
      },
    ]);
    expect(await assetSnapshot()).toEqual(before);
    expect((await ledger()).slice(0, 3)).toEqual(ledgerBefore);
    expect(
      (
        await sql<{
          owner_id: string | null;
          lifecycle_version: string;
          trashed_at: Date | null;
        }>`select owner_id, lifecycle_version::text as lifecycle_version,
      trashed_at from public.asset order by id`.execute(db)
      ).rows,
    ).toEqual([
      { owner_id: null, lifecycle_version: '0', trashed_at: null },
      { owner_id: null, lifecycle_version: '0', trashed_at: null },
    ]);
    expect(
      await sql<{ count: number }>`select count(*)::integer as count
      from public.storage_binding`.execute(db),
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it('serializes concurrent M11-to-M12 upgrades without duplicating the journal or ledger entry', async () => {
    await migrateM11Only();
    const other = createMigrationDatabase(migrationConfig(migrationEnv));
    try {
      const results = await Promise.all([
        migrateToLatest(db),
        migrateToLatest(other),
      ]);
      expect(
        results.map((result) => result.length).sort((a, b) => a - b),
      ).toEqual([0, 1]);
      expect((await ledger()).map((row) => row.name)).toEqual([
        INITIAL_ASSET_MIGRATION,
        AUTHENTICATION_MIGRATION,
        ASSET_OWNERSHIP_MIGRATION,
        ASSET_LIFECYCLE_MIGRATION,
      ]);
      expect(await tables()).toContain('asset_deletion');
    } finally {
      await other.destroy();
    }
  });

  it('refuses automatic M12 rollback without changing the schema or journal', async () => {
    await migrateToLatest(db);
    const before = await managedSnapshot();
    const result = await new Migrator({
      db,
      migrationTableSchema: 'public',
      provider: createMigrationProvider(),
    }).migrateDown();
    expect(result.error).toMatchObject({
      message: expect.stringContaining(
        'Asset lifecycle migration cannot be rolled back automatically',
      ),
    });
    expect(await managedSnapshot()).toEqual(before);
  });

  it('rejects premature lifecycle relations and a false M12 ledger entry', async () => {
    await migrateM11Only();
    await sql`create table public.asset_deletion (id integer)`.execute(db);
    await expect(getMigrationStatus(db)).rejects.toThrow('reserved M12');
    await sql`drop table public.asset_deletion`.execute(db);
    await sql`insert into public.kysely_migration (name, timestamp)
      values (${ASSET_LIFECYCLE_MIGRATION}, ${new Date(Date.now() + 60_000).toISOString()})`.execute(
      db,
    );
    await expect(getMigrationStatus(db)).rejects.toThrow('Incompatible M12');
  });

  it('starts with an empty binding, preserves an adopted synthetic row, and rejects invalid singleton rows', async () => {
    await migrateToLatest(db);
    const binding = {
      storage: '00000000-0000-4000-8000-000000000101',
      originals: '00000000-0000-4000-8000-000000000102',
      thumbnails: '00000000-0000-4000-8000-000000000103',
    };
    const rows = await sql<{ count: number }>`select count(*)::integer as count
      from public.storage_binding`.execute(db);
    expect(rows.rows[0].count).toBe(0);
    await expect(
      sql`insert into public.storage_binding values
      (false, ${binding.storage}::uuid, ${binding.originals}::uuid,
       ${binding.thumbnails}::uuid, 1)`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into public.storage_binding values
      (true, ${binding.storage}::uuid, ${binding.originals}::uuid,
       ${binding.originals}::uuid, 1)`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await sql`insert into public.storage_binding values
      (true, ${binding.storage}::uuid, ${binding.originals}::uuid,
       ${binding.thumbnails}::uuid, 1)`.execute(db);
    const before = await sql`select * from public.storage_binding`.execute(db);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(
      (await sql`select * from public.storage_binding`.execute(db)).rows,
    ).toEqual(before.rows);
    await expect(
      sql`insert into public.storage_binding values
      (true, ${binding.storage}::uuid, ${binding.originals}::uuid,
       ${binding.thumbnails}::uuid, 1)`.execute(db),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it.each([false, true])(
    'refuses HTTP readiness on M12 even with binding populated=%s',
    async (populated) => {
      await migrateToLatest(db);
      if (populated)
        await sql`insert into public.storage_binding values
      (true, '00000000-0000-4000-8000-000000000101',
       '00000000-0000-4000-8000-000000000102',
       '00000000-0000-4000-8000-000000000103', 1)`.execute(db);
      await expect(
        new AuthSessionService(
          { db } as DatabaseService,
          new PasswordService(),
        ).assertReady(),
      ).rejects.toThrow('Application schema is not ready');
      let startupOutput = '';
      try {
        await execFile(
          process.execPath,
          [resolve(process.cwd(), 'dist/main.js')],
          {
            cwd: process.cwd(),
            timeout: 8000,
            env: {
              PATH: process.env.PATH,
              NODE_ENV: 'test',
              HOST: '127.0.0.1',
              PORT: '34567',
              APP_ORIGIN: 'http://127.0.0.1:34567',
              STORAGE_ROOT: '/tmp/saefr-m12b-unused',
              POSTGRES_HOST: '127.0.0.1',
              POSTGRES_PORT: String(
                testConfig().getOrThrow<number>('POSTGRES_PORT'),
              ),
              POSTGRES_DB: databaseName,
              POSTGRES_USER: testConfig().getOrThrow<string>('POSTGRES_USER'),
              POSTGRES_PASSWORD:
                testConfig().getOrThrow<string>('POSTGRES_PASSWORD'),
            },
          },
        );
        throw new Error('M12B application unexpectedly started');
      } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 1)
          throw error;
        const stdout =
          'stdout' in error && typeof error.stdout === 'string'
            ? error.stdout
            : '';
        const stderr =
          'stderr' in error && typeof error.stderr === 'string'
            ? error.stderr
            : '';
        startupOutput = stdout + stderr;
      }
      expect(startupOutput).toContain('Application startup failed');
      expect(startupOutput).not.toContain('saefr-m12b-unused');
      expect(startupOutput).not.toContain(
        testConfig().getOrThrow<string>('POSTGRES_PASSWORD'),
      );
    },
  );

  it.each([
    'alter table public.asset alter column lifecycle_version drop default',
    'drop index public.asset_active_owner_created_id_idx',
    'alter table public.asset_deletion drop constraint asset_deletion_claim_pair_check',
    'alter table public.asset_deletion drop constraint asset_deletion_owner_id_fkey',
    'drop index public.asset_deletion_pending_owner_requested_id_idx',
    'alter table public.asset_deletion alter column requested_at set default now()',
    'alter table public.storage_binding drop constraint storage_binding_roles_check',
    'alter table public.storage_binding enable row level security',
  ])(
    'rejects incompatible M12 schema without repair: %s',
    async (statement) => {
      await migrateToLatest(db);
      const history = await ledger();
      await sql.raw(statement).execute(db);
      await expect(getMigrationStatus(db)).rejects.toThrow('Incompatible M12');
      await expect(migrateToLatest(db)).rejects.toThrow('Incompatible M12');
      expect(await ledger()).toEqual(history);
    },
  );

  it.each([
    ['asset_deletion', 'asset_id'],
    ['storage_binding', 'singleton'],
  ])(
    'rejects a standalone unique index and CHECK masquerading as the %s primary key',
    async (table, column) => {
      await migrateToLatest(db);
      expect((await getMigrationStatus(db)).installation).toBe('managed');
      const history = await ledger();
      const primaryKey = `${table}_pkey`;
      // Static identifiers from this test's two-case table, never user input.
      await sql
        .raw(`alter table public.${table} drop constraint ${primaryKey}`)
        .execute(db);
      await sql
        .raw(
          `alter table public.${table} add constraint ${primaryKey} check (true)`,
        )
        .execute(db);
      await sql
        .raw(`create unique index ${primaryKey} on public.${table} (${column})`)
        .execute(db);
      await expect(getMigrationStatus(db)).rejects.toThrow('Incompatible M12');
      await expect(migrateToLatest(db)).rejects.toThrow('Incompatible M12');
      expect(await ledger()).toEqual(history);
    },
  );
});
