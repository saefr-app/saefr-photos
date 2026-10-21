import { type Kysely, sql } from 'kysely';

import { MigrationSafetyError } from './legacy-asset-schema.js';

const COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  app_user: {
    created_at: 'timestamp with time zone',
    id: 'uuid',
    password_change_required: 'boolean',
    password_hash: 'text',
    role: 'character varying(16)',
    status: 'character varying(16)',
    updated_at: 'timestamp with time zone',
    username: 'character varying(64)',
  },
  auth_session: {
    created_at: 'timestamp with time zone',
    csrf_token: 'bytea',
    expires_at: 'timestamp with time zone',
    id: 'uuid',
    token_hash: 'bytea',
    user_id: 'uuid',
  },
};

function incompatible(detail: string): never {
  throw new MigrationSafetyError(
    `Incompatible M10 authentication schema: ${detail}. No repair attempted.`,
  );
}

export async function assertAuthAbsent<DB>(db: Kysely<DB>): Promise<void> {
  const relations = await sql<{ name: string }>`select c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in (
      'app_user', 'app_user_pkey', 'app_user_username_key',
      'auth_session', 'auth_session_pkey', 'auth_session_token_hash_key',
      'auth_session_user_id_idx', 'auth_session_expires_at_idx'
    )`.execute(db);
  if (relations.rows.length)
    incompatible(
      'reserved authentication relation exists before the M10 migration',
    );
}

/** Validate the complete managed M10 contract; this never accepts a partial adoption. */
export async function inspectAuthSchema<DB>(db: Kysely<DB>): Promise<void> {
  const relations = await sql<{
    name: string;
    valid: boolean;
  }>`select c.relname as name,
    (c.relkind = 'r' and c.relpersistence = 'p' and not c.relrowsecurity
     and not c.relforcerowsecurity and not c.relispartition
     and not exists (select 1 from pg_catalog.pg_inherits i
       where i.inhrelid = c.oid or i.inhparent = c.oid)
     and not exists (select 1 from pg_catalog.pg_trigger t
       where t.tgrelid = c.oid and not t.tgisinternal)
     and not exists (select 1 from pg_catalog.pg_rewrite r where r.ev_class = c.oid)) as valid
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('app_user', 'auth_session')`.execute(
    db,
  );
  if (
    relations.rows.length !== 2 ||
    relations.rows.some((row) => !row.valid) ||
    new Set(relations.rows.map((row) => row.name)).size !== 2
  )
    incompatible('expected two ordinary public authentication tables');

  const columns = await sql<{
    table_name: string;
    name: string;
    type: string;
    required: boolean;
    custom: boolean;
  }>`select c.relname as table_name, a.attname as name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as required,
      (a.atthasdef or a.attidentity <> '' or a.attgenerated <> ''
       or a.attcollation <> t.typcollation) as custom
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_type t on t.oid = a.atttypid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('app_user', 'auth_session')
      and a.attnum > 0 and not a.attisdropped`.execute(db);
  const expectedCount = Object.values(COLUMNS).reduce(
    (count, table) => count + Object.keys(table).length,
    0,
  );
  if (
    columns.rows.length !== expectedCount ||
    columns.rows.some(
      (column) =>
        COLUMNS[column.table_name]?.[column.name] !== column.type ||
        !column.required ||
        column.custom,
    )
  )
    incompatible(
      'unexpected authentication columns, types, nullability or defaults',
    );

  const constraints = await sql<{
    name: string;
    table_name: string;
    definition: string;
    valid: boolean;
  }>`select k.conname as name, c.relname as table_name,
      pg_catalog.pg_get_constraintdef(k.oid) as definition,
      (k.convalidated and not k.condeferrable and not k.condeferred) as valid
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('app_user', 'auth_session')
      and k.contype <> 'n'`.execute(db);
  const expectedConstraints: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = {
    app_user: {
      app_user_pkey: 'PRIMARY KEY (id)',
      app_user_username_key: 'UNIQUE (username)',
      app_user_username_format_check:
        'CHECK ((((username)::text COLLATE "C") ~ \'^[a-z0-9][a-z0-9._-]{2,63}$\'::text))',
      app_user_role_check:
        "CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'user'::character varying])::text[])))",
      app_user_status_check:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))",
    },
    auth_session: {
      auth_session_pkey: 'PRIMARY KEY (id)',
      auth_session_token_hash_key: 'UNIQUE (token_hash)',
      auth_session_user_id_fkey:
        'FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE RESTRICT',
      auth_session_token_hash_length_check:
        'CHECK ((octet_length(token_hash) = 32))',
      auth_session_csrf_token_length_check:
        'CHECK ((octet_length(csrf_token) = 32))',
      auth_session_expires_after_created_check:
        'CHECK ((expires_at > created_at))',
    },
  };
  if (
    constraints.rows.length !==
      Object.values(expectedConstraints).reduce(
        (count, table) => count + Object.keys(table).length,
        0,
      ) ||
    constraints.rows.some(
      (constraint) =>
        !constraint.valid ||
        expectedConstraints[constraint.table_name]?.[constraint.name] !==
          constraint.definition,
    )
  )
    incompatible('unexpected authentication constraints');

  const indexes = await sql<{
    table_name: string;
    name: string;
    definition: string;
    valid: boolean;
  }>`select t.relname as table_name, i.relname as name,
      pg_catalog.pg_get_indexdef(i.oid) as definition,
      (x.indisvalid and x.indisready and x.indnatts = 1 and x.indnkeyatts = 1
       and x.indpred is null and x.indexprs is null) as valid
    from pg_catalog.pg_index x
    join pg_catalog.pg_class t on t.oid = x.indrelid
    join pg_catalog.pg_class i on i.oid = x.indexrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname in ('app_user', 'auth_session')`.execute(
    db,
  );
  const expectedIndexes: Readonly<Record<string, string>> = {
    app_user_pkey:
      'CREATE UNIQUE INDEX app_user_pkey ON public.app_user USING btree (id)',
    app_user_username_key:
      'CREATE UNIQUE INDEX app_user_username_key ON public.app_user USING btree (username)',
    auth_session_pkey:
      'CREATE UNIQUE INDEX auth_session_pkey ON public.auth_session USING btree (id)',
    auth_session_token_hash_key:
      'CREATE UNIQUE INDEX auth_session_token_hash_key ON public.auth_session USING btree (token_hash)',
    auth_session_user_id_idx:
      'CREATE INDEX auth_session_user_id_idx ON public.auth_session USING btree (user_id)',
    auth_session_expires_at_idx:
      'CREATE INDEX auth_session_expires_at_idx ON public.auth_session USING btree (expires_at)',
  };
  if (
    indexes.rows.length !== Object.keys(expectedIndexes).length ||
    indexes.rows.some(
      (index) =>
        !index.valid || expectedIndexes[index.name] !== index.definition,
    )
  )
    incompatible('unexpected authentication indexes');
}
