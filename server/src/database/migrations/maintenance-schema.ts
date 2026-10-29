import { type Kysely, sql } from 'kysely';

import { MigrationSafetyError } from './legacy-asset-schema.js';
import { inspectNewMaintenanceTables } from './maintenance-tables-schema.js';

const incompatible = () =>
  new MigrationSafetyError(
    'Incompatible M13 maintenance schema; no repair attempted.',
  );

/** Reject reserved M13 objects before the M13 ledger entry is applied. */
export async function assertMaintenanceAbsent<DB>(
  db: Kysely<DB>,
): Promise<void> {
  const result = await sql<{ present: boolean }>`select
    exists (select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and (
        c.relname like 'maintenance\\_%' escape '\\' or
        c.relname = 'asset_deletion_pending_global_requested_id_idx'))
    or exists (select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_namespace n on n.oid = k.connamespace
      where n.nspname = 'public' and k.conname like 'maintenance\\_%' escape '\\')
    as present`.execute(db);
  if (result.rows[0].present)
    throw new MigrationSafetyError(
      'A reserved M13 maintenance object exists before M13 history; no repair attempted.',
    );
}

/** Exact post-M13 contract; the historical M12 inspector remains unchanged. */
export async function inspectMaintenanceSchema<DB>(
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
    default_expression: string | null;
  }>`select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as required,
      (a.attidentity <> '' or a.attgenerated <> '' or
       a.attcollation <> t.typcollation) as custom,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression
    from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid = a.atttypid
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.asset'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attname`.execute(db);
  const expected: Record<string, string> = {
    created_at: 'timestamp with time zone',
    filename: 'character varying',
    id: 'uuid',
    mime_type: 'character varying',
    owner_id: 'uuid',
    trashed_at: 'timestamp with time zone',
    lifecycle_version: 'bigint',
    size: 'integer',
    storage_path: 'character varying',
  };
  if (
    columns.rows.length !== 9 ||
    columns.rows.some(
      (column) =>
        expected[column.name] !== column.type ||
        column.required !== !['owner_id', 'trashed_at'].includes(column.name) ||
        column.custom ||
        column.default_expression !==
          (column.name === 'lifecycle_version' ? '0' : null),
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
      when 'asset_lifecycle_version_check' then contype = 'c' and convalidated
        and conenforced and not condeferrable and not condeferred and not connoinherit
        and pg_catalog.pg_get_expr(conbin, conrelid) = '(lifecycle_version >= 0)'
      when 'asset_trashed_at_finite_check' then contype = 'c' and convalidated
        and conenforced and not condeferrable and not condeferred and not connoinherit
        and pg_catalog.pg_get_expr(conbin, conrelid) = '((trashed_at IS NULL) OR isfinite(trashed_at))'
      else false
    end as valid
    from pg_catalog.pg_constraint where conrelid = 'public.asset'::regclass
      and contype <> 'n'`.execute(db);
  if (
    constraints.rows.length !== 5 ||
    new Set(constraints.rows.map((constraint) => constraint.name)).size !== 5 ||
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
      when 'asset_active_owner_created_id_idx' then not i.indisprimary and not i.indisunique
        and i.indnatts = 3 and i.indnkeyatts = 3
        and pg_catalog.pg_get_indexdef(c.oid) =
          'CREATE INDEX asset_active_owner_created_id_idx ON public.asset USING btree (owner_id, created_at DESC, id DESC) WHERE (trashed_at IS NULL)'
      when 'asset_trash_owner_trashed_id_idx' then not i.indisprimary and not i.indisunique
        and i.indnatts = 3 and i.indnkeyatts = 3
        and pg_catalog.pg_get_indexdef(c.oid) =
          'CREATE INDEX asset_trash_owner_trashed_id_idx ON public.asset USING btree (owner_id, trashed_at DESC, id DESC) WHERE (trashed_at IS NOT NULL)'
      else false
    end and i.indisvalid and i.indisready and i.indexprs is null
      and c.relpersistence = 'p' as valid
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.asset'::regclass`.execute(db);
  if (
    indexes.rows.length !== 4 ||
    new Set(indexes.rows.map((index) => index.name)).size !== 4 ||
    indexes.rows.some((index) => !index.valid)
  )
    throw incompatible();
  await inspectLifecycleTables(db);
  await inspectNewMaintenanceTables(db);
  return true;
}

async function inspectLifecycleTables<DB>(db: Kysely<DB>): Promise<void> {
  const relations = await sql<{
    name: string;
    valid: boolean;
  }>`select c.relname as name,
    c.relkind = 'r' and c.relpersistence = 'p' and not c.relrowsecurity
    and not c.relforcerowsecurity and not c.relispartition
    and not exists (select 1 from pg_catalog.pg_inherits i
      where i.inhrelid = c.oid or i.inhparent = c.oid)
    and not exists (select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and not t.tgisinternal)
    and not exists (select 1 from pg_catalog.pg_rewrite r where r.ev_class = c.oid)
    as valid
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('asset_deletion', 'storage_binding')`.execute(
    db,
  );
  if (relations.rows.length !== 2 || relations.rows.some((row) => !row.valid))
    throw incompatible();

  const expectedColumns: Record<string, Record<string, [string, boolean]>> = {
    asset_deletion: {
      asset_id: ['uuid', true],
      owner_id: ['uuid', true],
      accepted_lifecycle_version: ['bigint', true],
      storage_id: ['uuid', true],
      originals_binding_id: ['uuid', true],
      thumbnails_binding_id: ['uuid', true],
      storage_layout_version: ['smallint', true],
      original_extension: ['character varying', true],
      requested_at: ['timestamp with time zone', true],
      completed_at: ['timestamp with time zone', false],
      last_error_code: ['character varying', false],
      execution_token: ['uuid', false],
      execution_expires_at: ['timestamp with time zone', false],
    },
    storage_binding: {
      singleton: ['boolean', true],
      storage_id: ['uuid', true],
      originals_binding_id: ['uuid', true],
      thumbnails_binding_id: ['uuid', true],
      storage_layout_version: ['smallint', true],
    },
  };
  const columns = await sql<{
    table_name: string;
    name: string;
    type: string;
    required: boolean;
    custom: boolean;
  }>`select c.relname as table_name, a.attname as name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as required,
    (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '' or
     a.attcollation <> t.typcollation) as custom
    from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_type t on t.oid = a.atttypid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('asset_deletion', 'storage_binding')
      and a.attnum > 0 and not a.attisdropped`.execute(db);
  if (
    columns.rows.length !== 18 ||
    columns.rows.some((column) => {
      const expected = expectedColumns[column.table_name]?.[column.name];
      return (
        !expected ||
        column.type !== expected[0] ||
        column.required !== expected[1] ||
        column.custom
      );
    })
  )
    throw incompatible();

  const constraints = await sql<{
    table_name: string;
    name: string;
    kind: string;
    definition: string;
    valid: boolean;
    enforced: boolean;
    deferrable: boolean;
    deferred: boolean;
    no_inherit: boolean;
    referenced: string | null;
    match_type: string;
    delete_type: string;
    update_type: string;
    keys: number[];
    foreign_keys: number[];
    index_oid: string | number;
  }>`select c.relname as table_name,
    k.conname as name, k.contype as kind, pg_catalog.pg_get_constraintdef(k.oid) as definition,
    k.convalidated as valid, k.conenforced as enforced, k.condeferrable as deferrable,
    k.condeferred as deferred, k.connoinherit as no_inherit,
    fk.relname as referenced, k.confmatchtype as match_type,
    k.confdeltype as delete_type, k.confupdtype as update_type,
    k.conkey as keys, k.confkey as foreign_keys, k.conindid as index_oid
    from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_class fk on fk.oid = k.confrelid
    where n.nspname = 'public' and c.relname in ('asset_deletion', 'storage_binding')
      and k.contype <> 'n'`.execute(db);
  const expectedNames = new Set([
    'asset_deletion_pkey',
    'asset_deletion_owner_id_fkey',
    'asset_deletion_version_check',
    'asset_deletion_layout_check',
    'asset_deletion_extension_check',
    'asset_deletion_requested_at_check',
    'asset_deletion_completed_at_check',
    'asset_deletion_claim_pair_check',
    'asset_deletion_expiry_check',
    'asset_deletion_completed_state_check',
    'asset_deletion_error_code_check',
    'storage_binding_pkey',
    'storage_binding_singleton_check',
    'storage_binding_roles_check',
    'storage_binding_layout_check',
  ]);
  if (
    constraints.rows.length !== expectedNames.size ||
    constraints.rows.some(
      (row) =>
        !expectedNames.has(row.name) ||
        row.kind !==
          (row.name.endsWith('_pkey')
            ? 'p'
            : row.name.endsWith('_fkey')
              ? 'f'
              : 'c') ||
        !row.valid ||
        !row.enforced ||
        row.deferrable ||
        row.deferred ||
        row.no_inherit !== (row.kind !== 'c') ||
        row.table_name !==
          (row.name.startsWith('storage_binding')
            ? 'storage_binding'
            : 'asset_deletion'),
    ) ||
    new Set(constraints.rows.map((row) => row.name)).size !== expectedNames.size
  )
    throw incompatible();
  const key = (table: string, column: string) =>
    sql<{
      number: number;
    }>`select attnum::integer as number from pg_catalog.pg_attribute
      where attrelid = ${`public.${table}`}::regclass and attname = ${column}`.execute(
      db,
    );
  const assetIdKey = (await key('asset_deletion', 'asset_id')).rows[0]?.number;
  const ownerIdKey = (await key('asset_deletion', 'owner_id')).rows[0]?.number;
  const singletonKey = (await key('storage_binding', 'singleton')).rows[0]
    ?.number;
  const userIdKey = (await key('app_user', 'id')).rows[0]?.number;
  for (const row of constraints.rows) {
    if (row.kind === 'p') {
      if (
        row.name !== `${row.table_name}_pkey` ||
        row.keys.length !== 1 ||
        row.keys[0] !==
          (row.table_name === 'asset_deletion' ? assetIdKey : singletonKey)
      )
        throw incompatible();
    } else if (row.kind === 'f') {
      if (
        row.name !== 'asset_deletion_owner_id_fkey' ||
        row.referenced !== 'app_user' ||
        row.match_type !== 's' ||
        row.delete_type !== 'r' ||
        row.update_type !== 'a' ||
        row.keys.length !== 1 ||
        row.keys[0] !== ownerIdKey ||
        row.foreign_keys.length !== 1 ||
        row.foreign_keys[0] !== userIdKey
      )
        throw incompatible();
    } else if (row.kind !== 'c') throw incompatible();
  }
  const checks = Object.fromEntries(
    constraints.rows
      .filter((row) => row.kind === 'c')
      .map((row) => [row.name, row.definition]),
  );
  for (const [name, definition] of Object.entries(EXPECTED_CHECKS)) {
    if (checks[name] !== definition) throw incompatible();
  }

  const triggers = await sql<{
    relation: string;
    function_name: string;
    event_type: number;
    valid: boolean;
  }>`select c.relname as relation, p.proname as function_name,
    t.tgtype::integer as event_type,
    t.tgisinternal and t.tgenabled = 'O' and not t.tgdeferrable
      and not t.tginitdeferred and t.tgparentid = 0 and t.tgqual is null
      and p.prokind = 'f' and pn.nspname = 'pg_catalog' and cn.nspname = 'public' as valid
    from pg_catalog.pg_constraint k join pg_catalog.pg_trigger t on t.tgconstraint = k.oid
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
    where k.conrelid = 'public.asset_deletion'::regclass
      and k.conname = 'asset_deletion_owner_id_fkey' and k.contype = 'f'`.execute(
    db,
  );
  const expectedTriggers = [
    ['app_user', 'RI_FKey_noaction_upd', 17],
    ['app_user', 'RI_FKey_restrict_del', 9],
    ['asset_deletion', 'RI_FKey_check_ins', 5],
    ['asset_deletion', 'RI_FKey_check_upd', 17],
  ];
  if (
    triggers.rows.length !== 4 ||
    triggers.rows.some(
      (row) =>
        !row.valid ||
        !expectedTriggers.some(
          ([table, fn, event]) =>
            row.relation === table &&
            row.function_name === fn &&
            row.event_type === event,
        ),
    ) ||
    new Set(
      triggers.rows.map(
        (row) => `${row.relation}:${row.function_name}:${row.event_type}`,
      ),
    ).size !== 4
  )
    throw incompatible();

  const indexes = await sql<{
    table_name: string;
    name: string;
    definition: string;
    valid: boolean;
    primary: boolean;
    unique: boolean;
    oid: string | number;
  }>`select c.relname as table_name, i.relname as name,
    pg_catalog.pg_get_indexdef(i.oid) as definition,
    x.indisvalid and x.indisready and x.indexprs is null and
      i.relpersistence = 'p' as valid,
    x.indisprimary as primary, x.indisunique as unique, i.oid as oid
    from pg_catalog.pg_index x join pg_catalog.pg_class c on c.oid = x.indrelid
    join pg_catalog.pg_class i on i.oid = x.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('asset_deletion', 'storage_binding')`.execute(
    db,
  );
  const expectedIndexes: Record<string, string> = {
    asset_deletion_pkey:
      'CREATE UNIQUE INDEX asset_deletion_pkey ON public.asset_deletion USING btree (asset_id)',
    asset_deletion_pending_owner_requested_id_idx:
      'CREATE INDEX asset_deletion_pending_owner_requested_id_idx ON public.asset_deletion USING btree (owner_id, requested_at DESC, asset_id DESC) WHERE (completed_at IS NULL)',
    asset_deletion_pending_global_requested_id_idx:
      'CREATE INDEX asset_deletion_pending_global_requested_id_idx ON public.asset_deletion USING btree (requested_at, asset_id) WHERE (completed_at IS NULL)',
    storage_binding_pkey:
      'CREATE UNIQUE INDEX storage_binding_pkey ON public.storage_binding USING btree (singleton)',
  };
  if (
    indexes.rows.length !== 4 ||
    indexes.rows.some(
      (row) =>
        !row.valid ||
        row.definition !== expectedIndexes[row.name] ||
        row.primary !== row.name.endsWith('_pkey') ||
        row.unique !== row.name.endsWith('_pkey') ||
        (row.primary &&
          String(row.oid) !==
            String(
              constraints.rows.find(
                (constraint) => constraint.name === row.name,
              )?.index_oid,
            )) ||
        row.table_name !==
          (row.name.startsWith('storage_binding')
            ? 'storage_binding'
            : 'asset_deletion'),
    )
  )
    throw incompatible();
}

// PostgreSQL 18 canonical CHECK renderings; update only through a reviewed new
// migration if the supported database contract changes.
const EXPECTED_CHECKS: Readonly<Record<string, string>> = {
  asset_deletion_version_check: 'CHECK ((accepted_lifecycle_version >= 0))',
  asset_deletion_layout_check: 'CHECK ((storage_layout_version = 1))',
  asset_deletion_extension_check:
    "CHECK (((original_extension)::text = ANY ((ARRAY['.jpg'::character varying, '.png'::character varying, '.webp'::character varying])::text[])))",
  asset_deletion_requested_at_check: 'CHECK (isfinite(requested_at))',
  asset_deletion_completed_at_check:
    'CHECK (((completed_at IS NULL) OR (isfinite(completed_at) AND (completed_at >= requested_at))))',
  asset_deletion_claim_pair_check:
    'CHECK (((execution_token IS NULL) = (execution_expires_at IS NULL)))',
  asset_deletion_expiry_check:
    'CHECK (((execution_expires_at IS NULL) OR isfinite(execution_expires_at)))',
  asset_deletion_completed_state_check:
    'CHECK (((completed_at IS NULL) OR ((execution_token IS NULL) AND (execution_expires_at IS NULL) AND (last_error_code IS NULL))))',
  asset_deletion_error_code_check:
    "CHECK (((last_error_code IS NULL) OR ((last_error_code)::text = ANY ((ARRAY['storage_unavailable'::character varying, 'storage_identity_mismatch'::character varying, 'unsupported_storage'::character varying, 'unexpected_file'::character varying, 'permission_denied'::character varying, 'filesystem_error'::character varying, 'durability_unavailable'::character varying, 'inconsistent_state'::character varying, 'unknown_outcome'::character varying])::text[]))))",
  storage_binding_singleton_check: 'CHECK ((singleton = true))',
  storage_binding_roles_check:
    'CHECK ((originals_binding_id <> thumbnails_binding_id))',
  storage_binding_layout_check: 'CHECK ((storage_layout_version = 1))',
};
