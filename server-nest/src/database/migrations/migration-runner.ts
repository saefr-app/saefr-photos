import { type Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import {
  inspectLegacyAsset,
  MigrationSafetyError,
} from './legacy-asset-schema.js';
import { createMigrationProvider } from './migration-provider.js';

async function withMigrationLock<DB, T>(
  db: Kysely<DB>,
  run: (connection: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return db.connection().execute(async (connection) => {
    // Serialize preflight and Kysely metadata bootstrap as well as migrations.
    // Kysely retains its own lock and transaction for applying version files.
    await sql`select pg_advisory_lock(708202610170001::bigint)`.execute(
      connection,
    );
    try {
      return await run(connection);
    } finally {
      await sql`select pg_advisory_unlock(708202610170001::bigint)`.execute(
        connection,
      );
    }
  });
}

async function inspectMigrationStatus<DB>(db: Kysely<DB>) {
  const version = await sql<{
    number: number;
  }>`select current_setting('server_version_num')::integer as number`.execute(
    db,
  );
  if (version.rows[0].number < 180000 || version.rows[0].number >= 190000) {
    throw new MigrationSafetyError(
      'This migration runner supports PostgreSQL 18. Review other server versions before migrating.',
    );
  }
  const publicSchema = await sql<{ present: boolean }>`select exists (
    select 1 from pg_catalog.pg_namespace where nspname = 'public') as present`.execute(
    db,
  );
  if (!publicSchema.rows[0].present)
    throw new MigrationSafetyError(
      'Schema public is missing. Review database provisioning; no schema was created.',
    );
  const assetExists = await inspectLegacyAsset(db);
  const tables = await sql<{
    name: string;
    valid: boolean;
  }>`select c.relname as name,
    (c.relkind = 'r' and c.relpersistence = 'p' and not c.relrowsecurity and not c.relforcerowsecurity
     and not c.relispartition and not exists (
       select 1 from pg_catalog.pg_trigger where tgrelid = c.oid and not tgisinternal)
     and not exists (select 1 from pg_catalog.pg_rewrite where ev_class = c.oid)
     and not exists (select 1 from pg_catalog.pg_inherits where inhrelid = c.oid or inhparent = c.oid)) as valid
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('kysely_migration', 'kysely_migration_lock')`.execute(
    db,
  );
  if (
    (tables.rows.length !== 0 && tables.rows.length !== 2) ||
    tables.rows.some((table) => !table.valid)
  ) {
    throw new MigrationSafetyError(
      'Incomplete or incompatible Kysely migration metadata. Both ordinary public.kysely_migration and public.kysely_migration_lock tables must exist together. No repair attempted.',
    );
  }

  let applied: Array<{ name: string; timestamp: string }> = [];
  if (tables.rows.length) {
    const columns = await sql<{
      table_name: string;
      name: string;
      type: string;
      required: boolean;
      default_expression: string | null;
      custom: boolean;
    }>`select
      c.relname as table_name, a.attname as name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as required,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression,
      (a.attidentity <> '' or a.attgenerated <> '' or a.attcollation <> t.typcollation) as custom
      from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_type t on t.oid = a.atttypid
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('kysely_migration', 'kysely_migration_lock')
        and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attname`.execute(db);
    const expected = [
      ['kysely_migration', 'name', 'character varying(255)'],
      ['kysely_migration', 'timestamp', 'character varying(255)'],
      ['kysely_migration_lock', 'id', 'character varying(255)'],
      ['kysely_migration_lock', 'is_locked', 'integer'],
    ];
    if (
      columns.rows.length !== expected.length ||
      columns.rows.some(
        (column, index) =>
          !column.required ||
          column.table_name !== expected[index][0] ||
          column.name !== expected[index][1] ||
          column.type !== expected[index][2] ||
          column.custom ||
          column.default_expression !==
            (column.name === 'is_locked' ? '0' : null),
      )
    ) {
      throw new MigrationSafetyError(
        'Incompatible Kysely metadata columns; no repair attempted.',
      );
    }
    const keys = await sql<{
      name: string;
      valid: boolean;
    }>`select c.relname as name,
      k.contype = 'p' and k.conname = c.relname || '_pkey' and k.convalidated and
      not k.condeferrable and not k.condeferred and
      k.conkey = array[(select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attname = case c.relname when 'kysely_migration' then 'name' else 'id' end)]::smallint[] as valid
      from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('kysely_migration', 'kysely_migration_lock')
        and k.contype <> 'n'`.execute(db);
    const indexes = await sql<{ valid: boolean }>`select
      i.indisprimary and i.indisunique and i.indisvalid and i.indisready and
      i.indnatts = 1 and i.indnkeyatts = 1 and i.indpred is null and i.indexprs is null as valid
      from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('kysely_migration', 'kysely_migration_lock')`.execute(
      db,
    );
    if (
      keys.rows.length !== 2 ||
      new Set(keys.rows.map((key) => key.name)).size !== 2 ||
      keys.rows.some((key) => !key.valid) ||
      indexes.rows.length !== 2 ||
      indexes.rows.some((index) => !index.valid)
    ) {
      throw new MigrationSafetyError(
        'Incompatible Kysely metadata keys or indexes; no repair attempted.',
      );
    }
    const locks = await sql<{
      id: string;
      is_locked: number;
    }>`select id, is_locked from public.kysely_migration_lock`.execute(db);
    if (
      locks.rows.length !== 1 ||
      locks.rows[0].id !== 'migration_lock' ||
      locks.rows[0].is_locked !== 0
    ) {
      throw new MigrationSafetyError(
        'Incompatible Kysely lock metadata; review it manually.',
      );
    }
    applied = (
      await sql<{ name: string; timestamp: string }>`select name, timestamp
      from public.kysely_migration order by timestamp, name`.execute(db)
    ).rows;
  }
  const available = Object.keys(
    await createMigrationProvider().getMigrations(),
  ).sort();
  if (
    applied.some(
      (migration, index) =>
        migration.name !== available[index] ||
        !Number.isFinite(Date.parse(migration.timestamp)),
    )
  ) {
    throw new MigrationSafetyError(
      'Incompatible migration history: unknown, duplicate, out-of-order or invalid applied migrations. Restore the matching migration files; do not edit the ledger.',
    );
  }
  if (!assetExists && applied.length) {
    throw new MigrationSafetyError(
      'Migration history exists but public.asset is missing. Refusing to recreate a previously migrated table.',
    );
  }
  if (!assetExists) {
    const collision = await sql<{ present: boolean }>`select exists (
      select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'asset_pkey') as present`.execute(
      db,
    );
    if (collision.rows[0].present)
      throw new MigrationSafetyError(
        'The name public.asset_pkey is already in use. No schema repair attempted.',
      );
  }
  return {
    installation: applied.length ? 'managed' : assetExists ? 'legacy' : 'fresh',
    migrations: available.map((name, index) => ({
      name,
      applied: index < applied.length,
    })),
  };
}

export async function getMigrationStatus<DB>(db: Kysely<DB>) {
  return withMigrationLock(db, inspectMigrationStatus);
}

export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  baselineLegacy = false,
) {
  return withMigrationLock(db, async (connection) => {
    const status = await inspectMigrationStatus(connection);
    if (status.installation === 'legacy' && !baselineLegacy) {
      throw new MigrationSafetyError(
        'Untracked public.asset requires explicit --baseline-legacy after schema review and backup.',
      );
    }
    if (status.installation === 'fresh' && baselineLegacy) {
      throw new MigrationSafetyError(
        'Cannot baseline a missing public.asset table. Use a fresh-install migration without --baseline-legacy.',
      );
    }
    const migrator = new Migrator({
      db: connection,
      migrationTableSchema: 'public',
      provider: createMigrationProvider(baselineLegacy),
    });
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
    return result.results ?? [];
  });
}

export function safeMigrationError(error: unknown): string {
  if (error instanceof MigrationSafetyError) return error.message;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  const reason =
    code === '42501'
      ? 'insufficient database privileges'
      : code === '55P03' || code === '57014'
        ? 'database lock or statement timeout'
        : code === '28P01'
          ? 'database authentication failed'
          : code === 'ECONNREFUSED' || code === 'ENOTFOUND'
            ? 'database unavailable'
            : 'database, migration history or migration execution error';
  return `Migration failed: ${reason}. Check configuration, schema and migration status. No destructive repair was attempted.`;
}
