import { type Kysely, sql } from 'kysely';

export class MigrationSafetyError extends Error {}

/** Frozen contract for 202610170001_initial_asset; do not evolve with app types. */
export async function inspectLegacyAsset<DB>(db: Kysely<DB>): Promise<boolean> {
  const relation = await sql<{
    kind: string;
    persistence: string;
    restricted: boolean;
  }>`select c.relkind as kind, c.relpersistence as persistence,
      (c.relrowsecurity or c.relforcerowsecurity or c.relispartition or
       exists (select 1 from pg_catalog.pg_inherits i
         where i.inhrelid = c.oid or i.inhparent = c.oid)) as restricted
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'asset'`.execute(db);
  if (!relation.rows.length) return false;
  const table = relation.rows[0];
  if (table.kind !== 'r' || table.persistence !== 'p' || table.restricted) {
    throw new MigrationSafetyError(
      'Incompatible public.asset: expected an ordinary permanent table without RLS, partitioning or inheritance.',
    );
  }

  const columns = await sql<{
    name: string;
    type: string;
    required: boolean;
    custom: boolean;
  }>`select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as required,
      (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '' or
       a.attcollation <> t.typcollation) as custom
    from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid = a.atttypid
    where a.attrelid = 'public.asset'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attname`.execute(db);
  const expected: Record<string, string> = {
    created_at: 'timestamp with time zone',
    filename: 'character varying',
    id: 'uuid',
    mime_type: 'character varying',
    size: 'integer',
    storage_path: 'character varying',
  };
  if (
    columns.rows.length !== Object.keys(expected).length ||
    columns.rows.some(
      (column) =>
        expected[column.name] !== column.type ||
        !column.required ||
        column.custom,
    )
  ) {
    throw new MigrationSafetyError(
      'Incompatible public.asset columns: require exactly id UUID, filename/mime_type/storage_path unbounded VARCHAR, size INTEGER, created_at TIMESTAMP WITH TIME ZONE; all NOT NULL, without defaults, generated values or custom collations.',
    );
  }

  const constraints = await sql<{ valid: boolean }>`select
      conname = 'asset_pkey' and contype = 'p' and convalidated and
      not condeferrable and not condeferred and
      conkey = array[(select attnum from pg_catalog.pg_attribute
        where attrelid = 'public.asset'::regclass and attname = 'id')]::smallint[] as valid
    from pg_catalog.pg_constraint
    where conrelid = 'public.asset'::regclass and contype <> 'n'`.execute(db);
  const indexes = await sql<{ valid: boolean }>`select
      c.relname = 'asset_pkey' and i.indisprimary and i.indisunique and
      i.indisvalid and i.indisready and i.indnatts = 1 and i.indnkeyatts = 1 and
      i.indpred is null and i.indexprs is null as valid
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.asset'::regclass`.execute(db);
  const custom = await sql<{ present: boolean }>`select
      exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.asset'::regclass and not tgisinternal)
      or exists (select 1 from pg_catalog.pg_rewrite where ev_class = 'public.asset'::regclass)
      as present`.execute(db);
  if (
    constraints.rows.length !== 1 ||
    !constraints.rows[0].valid ||
    indexes.rows.length !== 1 ||
    !indexes.rows[0].valid ||
    custom.rows[0].present
  ) {
    throw new MigrationSafetyError(
      'Incompatible public.asset: require only the non-deferrable asset_pkey primary key on id, with no extra indexes, constraints, triggers or rules. Review custom schema changes manually.',
    );
  }
  return true;
}
