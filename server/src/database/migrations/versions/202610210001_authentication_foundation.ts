import { type Kysely, sql } from 'kysely';

import { assertAuthAbsent, inspectAuthSchema } from '../auth-schema.js';
import {
  inspectLegacyAsset,
  MigrationSafetyError,
} from '../legacy-asset-schema.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await inspectLegacyAsset(db))) {
    throw new MigrationSafetyError(
      'M10 authentication migration requires the verified M8 asset schema.',
    );
  }
  await assertAuthAbsent(db);

  await db.schema
    .withSchema('public')
    .createTable('app_user')
    .addColumn('id', 'uuid', (column) => column.notNull())
    .addColumn('username', 'varchar(64)', (column) => column.notNull())
    .addColumn('password_hash', 'text', (column) => column.notNull())
    .addColumn('role', 'varchar(16)', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('password_change_required', 'boolean', (column) =>
      column.notNull(),
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('app_user_pkey', ['id'])
    .addUniqueConstraint('app_user_username_key', ['username'])
    .addCheckConstraint(
      'app_user_username_format_check',
      sql`username collate "C" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'`,
    )
    .addCheckConstraint('app_user_role_check', sql`role in ('admin', 'user')`)
    .addCheckConstraint(
      'app_user_status_check',
      sql`status in ('active', 'disabled')`,
    )
    .execute();

  await db.schema
    .withSchema('public')
    .createTable('auth_session')
    .addColumn('id', 'uuid', (column) => column.notNull())
    .addColumn('user_id', 'uuid', (column) => column.notNull())
    .addColumn('token_hash', 'bytea', (column) => column.notNull())
    .addColumn('csrf_token', 'bytea', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('auth_session_pkey', ['id'])
    .addUniqueConstraint('auth_session_token_hash_key', ['token_hash'])
    .addForeignKeyConstraint(
      'auth_session_user_id_fkey',
      ['user_id'],
      'public.app_user',
      ['id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .addCheckConstraint(
      'auth_session_token_hash_length_check',
      sql`octet_length(token_hash) = 32`,
    )
    .addCheckConstraint(
      'auth_session_csrf_token_length_check',
      sql`octet_length(csrf_token) = 32`,
    )
    .addCheckConstraint(
      'auth_session_expires_after_created_check',
      sql`expires_at > created_at`,
    )
    .execute();

  await db.schema
    .withSchema('public')
    .createIndex('auth_session_user_id_idx')
    .on('auth_session')
    .column('user_id')
    .execute();
  await db.schema
    .withSchema('public')
    .createIndex('auth_session_expires_at_idx')
    .on('auth_session')
    .column('expires_at')
    .execute();

  await inspectAuthSchema(db);
}

export async function down(): Promise<never> {
  throw new MigrationSafetyError(
    'Authentication migration cannot be rolled back automatically: dropping accounts or sessions requires a separately reviewed recovery plan.',
  );
}
