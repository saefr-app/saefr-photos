import { type Kysely, sql } from 'kysely';

import { MigrationSafetyError } from './legacy-asset-schema.js';

const incompatible = () =>
  new MigrationSafetyError(
    'Incompatible M13 maintenance schema; no repair attempted.',
  );

const columns: Record<string, Record<string, [string, boolean]>> = {
  maintenance_retry_state: {
    asset_id: ['uuid', true],
    generation: ['bigint', true],
    state: ['character varying(20)', true],
    lifetime_attempts: ['bigint', true],
    immediate_attempts: ['smallint', true],
    next_eligible_at: ['timestamp with time zone', false],
    attempt_id: ['uuid', false],
    attempt_kind: ['character varying(9)', false],
    reservation_expires_at: ['timestamp with time zone', false],
    worker_incarnation_id: ['uuid', false],
    permit_generation: ['bigint', false],
    journal_execution_token: ['uuid', false],
    blocked_reason: ['character varying(32)', false],
    last_error_code: ['character varying(32)', false],
    last_clearance_id: ['uuid', false],
    created_at: ['timestamp with time zone', true],
    updated_at: ['timestamp with time zone', true],
  },
  maintenance_takeover_clearance: {
    clearance_id: ['uuid', true],
    asset_id: ['uuid', true],
    blocked_generation: ['bigint', true],
    blocked_attempt_id: ['uuid', true],
    blocked_worker_incarnation_id: ['uuid', true],
    blocked_permit_generation: ['bigint', true],
    blocked_journal_execution_token: ['uuid', false],
    disarmed_permit_generation: ['bigint', true],
    operator_reference: ['character varying(128)', true],
    evidence_reference: ['character varying(128)', true],
    recorded_at: ['timestamp with time zone', true],
  },
  maintenance_reconciliation: {
    singleton: ['boolean', true],
    leader_epoch: ['bigint', true],
    leader_token: ['uuid', false],
    leader_expires_at: ['timestamp with time zone', false],
    pass_status: ['character varying(10)', true],
    pass_id: ['uuid', false],
    pass_owner_epoch: ['bigint', false],
    upper_requested_at: ['timestamp with time zone', false],
    upper_asset_id: ['uuid', false],
    cursor_requested_at: ['timestamp with time zone', false],
    cursor_asset_id: ['uuid', false],
    updated_at: ['timestamp with time zone', true],
  },
};

const constraints: Record<string, [string, string]> = {
  maintenance_retry_state_pkey: ['maintenance_retry_state', 'p'],
  maintenance_retry_state_asset_id_fkey: ['maintenance_retry_state', 'f'],
  maintenance_retry_state_last_clearance_fkey: ['maintenance_retry_state', 'f'],
  maintenance_retry_state_counters_check: ['maintenance_retry_state', 'c'],
  maintenance_retry_state_time_check: ['maintenance_retry_state', 'c'],
  maintenance_retry_state_error_check: ['maintenance_retry_state', 'c'],
  maintenance_retry_state_shape_check: ['maintenance_retry_state', 'c'],
  maintenance_retry_state_state_check: ['maintenance_retry_state', 'c'],
  maintenance_retry_state_kind_check: ['maintenance_retry_state', 'c'],
  maintenance_takeover_clearance_pkey: ['maintenance_takeover_clearance', 'p'],
  maintenance_takeover_clearance_asset_id_fkey: [
    'maintenance_takeover_clearance',
    'f',
  ],
  maintenance_takeover_clearance_attempt_key: [
    'maintenance_takeover_clearance',
    'u',
  ],
  maintenance_takeover_clearance_asset_clearance_key: [
    'maintenance_takeover_clearance',
    'u',
  ],
  maintenance_takeover_clearance_values_check: [
    'maintenance_takeover_clearance',
    'c',
  ],
  maintenance_takeover_clearance_references_check: [
    'maintenance_takeover_clearance',
    'c',
  ],
  maintenance_reconciliation_pkey: ['maintenance_reconciliation', 'p'],
  maintenance_reconciliation_singleton_check: [
    'maintenance_reconciliation',
    'c',
  ],
  maintenance_reconciliation_leader_check: ['maintenance_reconciliation', 'c'],
  maintenance_reconciliation_pass_check: ['maintenance_reconciliation', 'c'],
};

// pg_get_constraintdef output from the PostgreSQL 18 disposable migration.
// Constraint names and kinds alone would accept a weakened replacement CHECK.
const checks: Record<string, string> = {
  maintenance_reconciliation_leader_check:
    'CHECK (((leader_epoch >= 0) AND ((leader_token IS NULL) = (leader_expires_at IS NULL)) AND ((leader_expires_at IS NULL) OR isfinite(leader_expires_at)) AND isfinite(updated_at)))',
  maintenance_reconciliation_pass_check:
    "CHECK ((((pass_status)::text = ANY ((ARRAY['incomplete'::character varying, 'complete'::character varying])::text[])) AND (((pass_id IS NULL) AND (pass_owner_epoch IS NULL) AND (upper_requested_at IS NULL) AND (upper_asset_id IS NULL) AND (cursor_requested_at IS NULL) AND (cursor_asset_id IS NULL) AND ((pass_status)::text = 'complete'::text)) OR ((pass_id IS NOT NULL) AND (pass_owner_epoch IS NOT NULL) AND (pass_owner_epoch > 0) AND (pass_owner_epoch <= leader_epoch) AND (upper_requested_at IS NOT NULL) AND isfinite(upper_requested_at) AND (upper_asset_id IS NOT NULL) AND (((cursor_requested_at IS NULL) AND (cursor_asset_id IS NULL)) OR ((cursor_requested_at IS NOT NULL) AND isfinite(cursor_requested_at) AND (cursor_asset_id IS NOT NULL) AND (ROW(cursor_requested_at, cursor_asset_id) <= ROW(upper_requested_at, upper_asset_id))))))))",
  maintenance_reconciliation_singleton_check: 'CHECK ((singleton = true))',
  maintenance_retry_state_counters_check:
    'CHECK (((generation > 0) AND (lifetime_attempts >= 0) AND ((immediate_attempts >= 0) AND (immediate_attempts <= 3)) AND (lifetime_attempts >= immediate_attempts)))',
  maintenance_retry_state_error_check:
    "CHECK (((last_error_code IS NULL) OR ((last_error_code)::text = ANY ((ARRAY['storage_unavailable'::character varying, 'storage_identity_mismatch'::character varying, 'unsupported_storage'::character varying, 'unexpected_file'::character varying, 'permission_denied'::character varying, 'filesystem_error'::character varying, 'durability_unavailable'::character varying, 'inconsistent_state'::character varying, 'unknown_outcome'::character varying])::text[]))))",
  maintenance_retry_state_kind_check:
    "CHECK (((attempt_kind IS NULL) OR (((attempt_kind)::text = 'immediate'::text) AND ((immediate_attempts >= 1) AND (immediate_attempts <= 3))) OR (((attempt_kind)::text = 'cooling'::text) AND (immediate_attempts = 3))))",
  maintenance_retry_state_shape_check:
    "CHECK (((((state)::text = ANY ((ARRAY['due'::character varying, 'cooling'::character varying, 'blocked_admission'::character varying])::text[])) AND (next_eligible_at IS NOT NULL) AND (attempt_id IS NULL) AND (attempt_kind IS NULL) AND (reservation_expires_at IS NULL) AND (worker_incarnation_id IS NULL) AND (permit_generation IS NULL) AND (journal_execution_token IS NULL)) OR (((state)::text = ANY ((ARRAY['reserved'::character varying, 'blocked_execution'::character varying])::text[])) AND (next_eligible_at IS NULL) AND (attempt_id IS NOT NULL) AND (attempt_kind IS NOT NULL) AND (reservation_expires_at IS NOT NULL) AND (worker_incarnation_id IS NOT NULL) AND (permit_generation IS NOT NULL)) OR (((state)::text = 'closed'::text) AND (next_eligible_at IS NULL) AND (attempt_id IS NULL) AND (attempt_kind IS NULL) AND (reservation_expires_at IS NULL) AND (worker_incarnation_id IS NULL) AND (permit_generation IS NULL) AND (journal_execution_token IS NULL))))",
  maintenance_retry_state_state_check:
    "CHECK (((((state)::text = 'due'::text) AND (immediate_attempts < 3) AND (blocked_reason IS NULL)) OR (((state)::text = 'cooling'::text) AND (immediate_attempts = 3) AND (blocked_reason IS NULL)) OR (((state)::text = 'blocked_admission'::text) AND (blocked_reason IS NOT NULL) AND ((blocked_reason)::text = ANY ((ARRAY['journal_inconsistent'::character varying, 'invalid_target'::character varying, 'storage_identity_mismatch'::character varying, 'unsupported_storage'::character varying])::text[]))) OR (((state)::text = 'reserved'::text) AND (blocked_reason IS NULL)) OR (((state)::text = 'blocked_execution'::text) AND (blocked_reason IS NOT NULL) AND ((blocked_reason)::text = ANY ((ARRAY['quiescence_unknown'::character varying, 'claim_unknown'::character varying, 'provider_unknown'::character varying, 'permit_changed'::character varying, 'storage_identity_mismatch'::character varying])::text[]))) OR (((state)::text = 'closed'::text) AND (blocked_reason IS NULL))))",
  maintenance_retry_state_time_check:
    'CHECK ((isfinite(created_at) AND isfinite(updated_at) AND (updated_at >= created_at) AND ((next_eligible_at IS NULL) OR isfinite(next_eligible_at)) AND ((reservation_expires_at IS NULL) OR isfinite(reservation_expires_at)) AND ((permit_generation IS NULL) OR (permit_generation > 0))))',
  maintenance_takeover_clearance_references_check:
    "CHECK ((((operator_reference)::text ~ '^[A-Za-z0-9._-]{1,128}$'::text) AND ((evidence_reference)::text ~ '^[A-Za-z0-9._-]{1,128}$'::text)))",
  maintenance_takeover_clearance_values_check:
    'CHECK (((blocked_generation > 0) AND (blocked_permit_generation > 0) AND (disarmed_permit_generation > blocked_permit_generation) AND isfinite(recorded_at)))',
};

const keys: Record<string, [string[], string, string[]] | [string[]]> = {
  maintenance_retry_state_pkey: [['asset_id']],
  maintenance_retry_state_asset_id_fkey: [
    ['asset_id'],
    'asset_deletion',
    ['asset_id'],
  ],
  maintenance_retry_state_last_clearance_fkey: [
    ['asset_id', 'last_clearance_id'],
    'maintenance_takeover_clearance',
    ['asset_id', 'clearance_id'],
  ],
  maintenance_takeover_clearance_pkey: [['clearance_id']],
  maintenance_takeover_clearance_asset_id_fkey: [
    ['asset_id'],
    'maintenance_retry_state',
    ['asset_id'],
  ],
  maintenance_takeover_clearance_attempt_key: [
    ['asset_id', 'blocked_generation', 'blocked_attempt_id'],
  ],
  maintenance_takeover_clearance_asset_clearance_key: [
    ['asset_id', 'clearance_id'],
  ],
  maintenance_reconciliation_pkey: [['singleton']],
};

const indexes: Record<string, [string, boolean, boolean]> = {
  maintenance_retry_state_pkey: [
    'CREATE UNIQUE INDEX maintenance_retry_state_pkey ON public.maintenance_retry_state USING btree (asset_id)',
    true,
    true,
  ],
  maintenance_retry_due_idx: [
    "CREATE INDEX maintenance_retry_due_idx ON public.maintenance_retry_state USING btree (next_eligible_at, asset_id) WHERE ((state)::text = ANY ((ARRAY['due'::character varying, 'cooling'::character varying])::text[]))",
    false,
    false,
  ],
  maintenance_retry_attempt_id_idx: [
    'CREATE UNIQUE INDEX maintenance_retry_attempt_id_idx ON public.maintenance_retry_state USING btree (attempt_id) WHERE (attempt_id IS NOT NULL)',
    false,
    true,
  ],
  maintenance_takeover_clearance_pkey: [
    'CREATE UNIQUE INDEX maintenance_takeover_clearance_pkey ON public.maintenance_takeover_clearance USING btree (clearance_id)',
    true,
    true,
  ],
  maintenance_takeover_clearance_attempt_key: [
    'CREATE UNIQUE INDEX maintenance_takeover_clearance_attempt_key ON public.maintenance_takeover_clearance USING btree (asset_id, blocked_generation, blocked_attempt_id)',
    false,
    true,
  ],
  maintenance_takeover_clearance_asset_clearance_key: [
    'CREATE UNIQUE INDEX maintenance_takeover_clearance_asset_clearance_key ON public.maintenance_takeover_clearance USING btree (asset_id, clearance_id)',
    false,
    true,
  ],
  maintenance_reconciliation_pkey: [
    'CREATE UNIQUE INDEX maintenance_reconciliation_pkey ON public.maintenance_reconciliation USING btree (singleton)',
    true,
    true,
  ],
};

/** Verifies M13 objects in addition to the adapted post-M13 M12 catalog contract. */
export async function inspectNewMaintenanceTables<DB>(
  db: Kysely<DB>,
): Promise<void> {
  const names = Object.keys(columns);
  const relations = await sql<{
    name: string;
    valid: boolean;
  }>`select c.relname as name,
    c.relkind = 'r' and c.relpersistence = 'p' and not c.relrowsecurity and
    not c.relforcerowsecurity and not c.relispartition and
    not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid) and
    not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) and
    not exists (select 1 from pg_catalog.pg_rewrite r where r.ev_class = c.oid) as valid
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in
      ('maintenance_retry_state', 'maintenance_takeover_clearance', 'maintenance_reconciliation')`.execute(
    db,
  );
  if (
    relations.rows.length !== names.length ||
    relations.rows.some((row) => !names.includes(row.name) || !row.valid)
  )
    throw incompatible();

  const attrs = await sql<{
    relation: string;
    name: string;
    number: number;
    type: string;
    required: boolean;
    custom: boolean;
  }>`select c.relname as relation, a.attname as name, a.attnum::integer as number,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as required,
    (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '' or
      a.attcollation <> t.typcollation) as custom
    from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_type t on t.oid = a.atttypid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in
      ('maintenance_retry_state', 'maintenance_takeover_clearance', 'maintenance_reconciliation')
      and a.attnum > 0 and not a.attisdropped`.execute(db);
  if (
    attrs.rows.length !==
      Object.values(columns).reduce(
        (sum, table) => sum + Object.keys(table).length,
        0,
      ) ||
    attrs.rows.some((row) => {
      const expected = columns[row.relation]?.[row.name];
      return (
        !expected ||
        row.type !== expected[0] ||
        row.required !== expected[1] ||
        row.custom
      );
    })
  )
    throw incompatible();
  const journalKey = await sql<{
    number: number;
  }>`select attnum::integer as number
    from pg_catalog.pg_attribute where attrelid = 'public.asset_deletion'::regclass
      and attname = 'asset_id'`.execute(db);
  const attnums = (table: string, fields: string[]) =>
    fields.map((field) =>
      table === 'asset_deletion' && field === 'asset_id'
        ? journalKey.rows[0]?.number
        : attrs.rows.find((row) => row.relation === table && row.name === field)
            ?.number,
    );

  const catalog = await sql<{
    relation: string;
    name: string;
    kind: string;
    definition: string;
    valid: boolean;
    enforced: boolean;
    deferrable: boolean;
    deferred: boolean;
    inherited: boolean;
    referenced: string | null;
    match_type: string;
    delete_type: string;
    update_type: string;
    key_columns: number[];
    foreign_columns: number[];
    index_oid: string | number;
  }>`select c.relname as relation, k.conname as name, k.contype as kind,
    pg_catalog.pg_get_constraintdef(k.oid) as definition, k.convalidated as valid,
    k.conenforced as enforced, k.condeferrable as deferrable, k.condeferred as deferred,
    k.connoinherit as inherited, fk.relname as referenced, k.confmatchtype as match_type,
    k.confdeltype as delete_type, k.confupdtype as update_type,
    k.conkey as key_columns, k.confkey as foreign_columns, k.conindid as index_oid
    from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_class fk on fk.oid = k.confrelid
    where n.nspname = 'public' and c.relname in
      ('maintenance_retry_state', 'maintenance_takeover_clearance', 'maintenance_reconciliation')
      and k.contype <> 'n'`.execute(db);
  if (
    catalog.rows.length !== Object.keys(constraints).length ||
    new Set(catalog.rows.map((row) => row.name)).size !== catalog.rows.length
  )
    throw incompatible();
  for (const row of catalog.rows) {
    const expected = constraints[row.name];
    if (
      !expected ||
      row.relation !== expected[0] ||
      row.kind !== expected[1] ||
      !row.valid ||
      !row.enforced ||
      row.deferrable ||
      row.deferred ||
      row.inherited !== (row.kind !== 'c') ||
      (row.kind === 'c' && row.definition !== checks[row.name])
    )
      throw incompatible();
    const key = keys[row.name];
    if (
      key &&
      (JSON.stringify(row.key_columns) !==
        JSON.stringify(attnums(row.relation, key[0])) ||
        (key.length === 3 &&
          (row.referenced !== key[1] ||
            JSON.stringify(row.foreign_columns) !==
              JSON.stringify(attnums(key[1], key[2])) ||
            row.match_type !== 's' ||
            row.delete_type !== 'r' ||
            row.update_type !== 'a')))
    )
      throw incompatible();
  }

  const actualIndexes = await sql<{
    relation: string;
    name: string;
    definition: string;
    primary: boolean;
    unique: boolean;
    valid: boolean;
    oid: string | number;
  }>`select c.relname as relation, i.relname as name,
    pg_catalog.pg_get_indexdef(i.oid) as definition,
    x.indisprimary as primary, x.indisunique as unique,
    x.indisvalid and x.indisready and x.indexprs is null and i.relpersistence = 'p' as valid,
    i.oid as oid
    from pg_catalog.pg_index x join pg_catalog.pg_class c on c.oid = x.indrelid
    join pg_catalog.pg_class i on i.oid = x.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in
      ('maintenance_retry_state', 'maintenance_takeover_clearance', 'maintenance_reconciliation')`.execute(
    db,
  );
  if (
    actualIndexes.rows.length !== Object.keys(indexes).length ||
    actualIndexes.rows.some((row) => {
      const expected = indexes[row.name];
      return (
        !expected ||
        !row.valid ||
        row.definition !== expected[0] ||
        row.primary !== expected[1] ||
        row.unique !== expected[2] ||
        ((row.name.endsWith('_pkey') || row.name.endsWith('_key')) &&
          String(row.oid) !==
            String(
              catalog.rows.find((key) => key.name === row.name)?.index_oid,
            ))
      );
    })
  )
    throw incompatible();

  const fkTriggers = await sql<{
    name: string;
    relation: string;
    function_name: string;
    event_type: number;
    valid: boolean;
  }>`select k.conname as name, c.relname as relation,
    p.proname as function_name, t.tgtype::integer as event_type,
    t.tgisinternal and t.tgenabled = 'O' and not t.tgdeferrable and
      not t.tginitdeferred and t.tgparentid = 0 and t.tgqual is null and
      p.prokind = 'f' and pn.nspname = 'pg_catalog' and cn.nspname = 'public'
      as valid
    from pg_catalog.pg_constraint k join pg_catalog.pg_trigger t on t.tgconstraint = k.oid
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
    where k.conrelid in ('public.maintenance_retry_state'::regclass,
      'public.maintenance_takeover_clearance'::regclass) and k.contype = 'f'
    order by k.conname, c.relname, p.proname, t.tgtype`.execute(db);
  const expectedTriggerRows = [
    [
      'maintenance_retry_state_asset_id_fkey',
      'asset_deletion',
      'RI_FKey_noaction_upd',
      17,
    ],
    [
      'maintenance_retry_state_asset_id_fkey',
      'asset_deletion',
      'RI_FKey_restrict_del',
      9,
    ],
    [
      'maintenance_retry_state_asset_id_fkey',
      'maintenance_retry_state',
      'RI_FKey_check_ins',
      5,
    ],
    [
      'maintenance_retry_state_asset_id_fkey',
      'maintenance_retry_state',
      'RI_FKey_check_upd',
      17,
    ],
    [
      'maintenance_retry_state_last_clearance_fkey',
      'maintenance_retry_state',
      'RI_FKey_check_ins',
      5,
    ],
    [
      'maintenance_retry_state_last_clearance_fkey',
      'maintenance_retry_state',
      'RI_FKey_check_upd',
      17,
    ],
    [
      'maintenance_retry_state_last_clearance_fkey',
      'maintenance_takeover_clearance',
      'RI_FKey_noaction_upd',
      17,
    ],
    [
      'maintenance_retry_state_last_clearance_fkey',
      'maintenance_takeover_clearance',
      'RI_FKey_restrict_del',
      9,
    ],
    [
      'maintenance_takeover_clearance_asset_id_fkey',
      'maintenance_retry_state',
      'RI_FKey_noaction_upd',
      17,
    ],
    [
      'maintenance_takeover_clearance_asset_id_fkey',
      'maintenance_retry_state',
      'RI_FKey_restrict_del',
      9,
    ],
    [
      'maintenance_takeover_clearance_asset_id_fkey',
      'maintenance_takeover_clearance',
      'RI_FKey_check_ins',
      5,
    ],
    [
      'maintenance_takeover_clearance_asset_id_fkey',
      'maintenance_takeover_clearance',
      'RI_FKey_check_upd',
      17,
    ],
  ];
  if (
    fkTriggers.rows.length !== expectedTriggerRows.length ||
    fkTriggers.rows.some(
      (row, index) =>
        !row.valid ||
        JSON.stringify([
          row.name,
          row.relation,
          row.function_name,
          row.event_type,
        ]) !== JSON.stringify(expectedTriggerRows[index]),
    )
  )
    throw incompatible();

  const singleton = await sql<{ singleton: boolean }>`select singleton
    from public.maintenance_reconciliation`.execute(db);
  if (singleton.rows.length !== 1 || singleton.rows[0].singleton !== true)
    throw incompatible();
}
