import { type Kysely, sql } from 'kysely';

import { MigrationSafetyError } from './legacy-asset-schema.js';

const incompatible = () =>
  new MigrationSafetyError(
    'Incompatible M11 public.asset ownership schema; no repair attempted.',
  );

/** Names added by M11 must be free before its transactional DDL runs. */
export async function assertOwnershipAbsent<DB>(db: Kysely<DB>): Promise<void> {
  const collision = await sql<{ present: boolean }>`select
    exists (select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'asset_owner_created_id_idx')
    or exists (select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_namespace n on n.oid = k.connamespace
      where n.nspname = 'public' and k.conname in
        ('asset_owner_id_fkey', 'asset_owner_required_check')) as present`.execute(
    db,
  );
  if (collision.rows[0].present) {
    throw new MigrationSafetyError(
      'A reserved M11 ownership object name is already in use; no repair attempted.',
    );
  }
}

/** Exact post-M11 catalog contract; the frozen M8 inspector remains historical. */
export async function inspectOwnershipAsset<DB>(
  db: Kysely<DB>,
): Promise<boolean> {
  const relation = await sql<{
    valid: boolean;
  }>`select c.relkind = 'r' and c.relpersistence = 'p'
    and not c.relrowsecurity and not c.relforcerowsecurity
    and not c.relispartition
    and not exists (select 1 from pg_catalog.pg_inherits i
      where i.inhrelid = c.oid or i.inhparent = c.oid)
    and not exists (select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and not t.tgisinternal)
    and not exists (select 1 from pg_catalog.pg_rewrite r
      where r.ev_class = c.oid) as valid
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'asset'`.execute(db);
  if (!relation.rows.length) return false;
  if (!relation.rows[0].valid) throw incompatible();

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
    owner_id: 'uuid',
    size: 'integer',
    storage_path: 'character varying',
  };
  if (
    columns.rows.length !== 7 ||
    columns.rows.some(
      (column) =>
        expected[column.name] !== column.type ||
        column.required !== (column.name !== 'owner_id') ||
        column.custom,
    )
  ) {
    throw incompatible();
  }

  const constraints = await sql<{
    name: string;
    valid: boolean;
  }>`select conname as name,
    case conname
      when 'asset_pkey' then contype = 'p' and convalidated and conenforced
        and not condeferrable and not condeferred
        and conkey = array[(select attnum from pg_catalog.pg_attribute
          where attrelid = 'public.asset'::regclass and attname = 'id')]::smallint[]
      when 'asset_owner_id_fkey' then contype = 'f' and convalidated and conenforced
        and not condeferrable and not condeferred and confmatchtype = 's'
        and confdeltype = 'r' and confupdtype = 'a'
        and confrelid = 'public.app_user'::regclass
        and conkey = array[(select attnum from pg_catalog.pg_attribute
          where attrelid = 'public.asset'::regclass and attname = 'owner_id')]::smallint[]
        and confkey = array[(select attnum from pg_catalog.pg_attribute
          where attrelid = 'public.app_user'::regclass and attname = 'id')]::smallint[]
      when 'asset_owner_required_check' then contype = 'c' and not convalidated
        and conenforced and not condeferrable and not condeferred and not connoinherit
        and conkey = array[(select attnum from pg_catalog.pg_attribute
          where attrelid = 'public.asset'::regclass and attname = 'owner_id')]::smallint[]
        and regexp_replace(pg_catalog.pg_get_expr(conbin, conrelid), '[()]', '', 'g') = 'owner_id IS NOT NULL'
      else false
    end as valid
    from pg_catalog.pg_constraint where conrelid = 'public.asset'::regclass
      and contype <> 'n'`.execute(db);
  if (
    constraints.rows.length !== 3 ||
    new Set(constraints.rows.map((constraint) => constraint.name)).size !== 3 ||
    constraints.rows.some((constraint) => !constraint.valid)
  )
    throw incompatible();

  // PostgreSQL enforces FKs with internal triggers. A privileged operator can
  // disable one without changing the still-valid pg_constraint definition.
  const ownershipTriggers = await sql<{
    relation: string;
    function_name: string;
    event_type: number;
    valid: boolean;
  }>`select c.relname as relation, p.proname as function_name,
      t.tgtype::integer as event_type,
      t.tgisinternal and t.tgenabled = 'O' and not t.tgdeferrable
        and not t.tginitdeferred and t.tgparentid = 0
        and t.tgqual is null and p.prokind = 'f'
        and pn.nspname = 'pg_catalog' and cn.nspname = 'public' as valid
    from pg_catalog.pg_constraint k
      join pg_catalog.pg_trigger t on t.tgconstraint = k.oid
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
      join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
    where k.conrelid = 'public.asset'::regclass
      and k.conname = 'asset_owner_id_fkey' and k.contype = 'f'`.execute(db);
  const expectedTriggers = [
    ['app_user', 'RI_FKey_noaction_upd', 17], // AFTER ROW UPDATE
    ['app_user', 'RI_FKey_restrict_del', 9], // AFTER ROW DELETE
    ['asset', 'RI_FKey_check_ins', 5], // AFTER ROW INSERT
    ['asset', 'RI_FKey_check_upd', 17], // AFTER ROW UPDATE
  ];
  if (
    ownershipTriggers.rows.length !== expectedTriggers.length ||
    ownershipTriggers.rows.some(
      (trigger) =>
        !trigger.valid ||
        !expectedTriggers.some(
          ([relation, functionName, eventType]) =>
            trigger.relation === relation &&
            trigger.function_name === functionName &&
            trigger.event_type === eventType,
        ),
    ) ||
    new Set(
      ownershipTriggers.rows.map(
        (trigger) =>
          `${trigger.relation}:${trigger.function_name}:${trigger.event_type}`,
      ),
    ).size !== expectedTriggers.length
  )
    throw incompatible();

  const indexes = await sql<{
    name: string;
    valid: boolean;
  }>`select c.relname as name,
    case c.relname
      when 'asset_pkey' then i.indisprimary and i.indisunique
        and i.indnatts = 1 and i.indnkeyatts = 1
        and pg_catalog.pg_get_indexdef(c.oid) =
          'CREATE UNIQUE INDEX asset_pkey ON public.asset USING btree (id)'
      when 'asset_owner_created_id_idx' then not i.indisprimary and not i.indisunique
        and i.indnatts = 3 and i.indnkeyatts = 3
        and pg_catalog.pg_get_indexdef(c.oid) =
          'CREATE INDEX asset_owner_created_id_idx ON public.asset USING btree (owner_id, created_at DESC, id DESC)'
      else false
    end and i.indisvalid and i.indisready and i.indpred is null and i.indexprs is null
      and c.relpersistence = 'p' as valid
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.asset'::regclass`.execute(db);
  if (
    indexes.rows.length !== 2 ||
    new Set(indexes.rows.map((index) => index.name)).size !== 2 ||
    indexes.rows.some((index) => !index.valid)
  )
    throw incompatible();
  return true;
}
