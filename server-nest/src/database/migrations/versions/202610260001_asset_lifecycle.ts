import { type Kysely, sql } from 'kysely';

import { inspectAuthSchema } from '../auth-schema.js';
import { inspectOwnershipAsset } from '../asset-ownership-schema.js';
import {
  assertLifecycleAbsent,
  inspectLifecycleSchema,
} from '../asset-lifecycle-schema.js';
import { MigrationSafetyError } from '../legacy-asset-schema.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await inspectAuthSchema(db);
  if (!(await inspectOwnershipAsset(db))) {
    throw new MigrationSafetyError(
      'M12 requires the verified M11 asset schema.',
    );
  }
  await assertLifecycleAbsent(db);

  await db.schema
    .withSchema('public')
    .alterTable('asset')
    .addColumn('trashed_at', 'timestamptz')
    .execute();
  await db.schema
    .withSchema('public')
    .alterTable('asset')
    .addColumn('lifecycle_version', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .execute();
  await sql`alter table public.asset add constraint asset_lifecycle_version_check
    check (lifecycle_version >= 0)`.execute(db);
  await sql`alter table public.asset add constraint asset_trashed_at_finite_check
    check (trashed_at is null or isfinite(trashed_at))`.execute(db);
  await sql`create index asset_active_owner_created_id_idx on public.asset
    (owner_id, created_at desc, id desc) where trashed_at is null`.execute(db);
  await sql`create index asset_trash_owner_trashed_id_idx on public.asset
    (owner_id, trashed_at desc, id desc) where trashed_at is not null`.execute(
    db,
  );

  await db.schema
    .withSchema('public')
    .createTable('asset_deletion')
    .addColumn('asset_id', 'uuid', (column) => column.notNull())
    .addColumn('owner_id', 'uuid', (column) => column.notNull())
    .addColumn('accepted_lifecycle_version', 'bigint', (column) =>
      column.notNull(),
    )
    .addColumn('storage_id', 'uuid', (column) => column.notNull())
    .addColumn('originals_binding_id', 'uuid', (column) => column.notNull())
    .addColumn('thumbnails_binding_id', 'uuid', (column) => column.notNull())
    .addColumn('storage_layout_version', 'smallint', (column) =>
      column.notNull(),
    )
    .addColumn('original_extension', 'varchar', (column) => column.notNull())
    .addColumn('requested_at', 'timestamptz', (column) => column.notNull())
    .addColumn('completed_at', 'timestamptz')
    .addColumn('last_error_code', 'varchar')
    .addColumn('execution_token', 'uuid')
    .addColumn('execution_expires_at', 'timestamptz')
    .addPrimaryKeyConstraint('asset_deletion_pkey', ['asset_id'])
    .addForeignKeyConstraint(
      'asset_deletion_owner_id_fkey',
      ['owner_id'],
      'public.app_user',
      ['id'],
      (constraint) => constraint.onDelete('restrict').onUpdate('no action'),
    )
    .addCheckConstraint(
      'asset_deletion_version_check',
      sql`accepted_lifecycle_version >= 0`,
    )
    .addCheckConstraint(
      'asset_deletion_layout_check',
      sql`storage_layout_version = 1`,
    )
    .addCheckConstraint(
      'asset_deletion_extension_check',
      sql`original_extension in ('.jpg', '.png', '.webp')`,
    )
    .addCheckConstraint(
      'asset_deletion_requested_at_check',
      sql`isfinite(requested_at)`,
    )
    .addCheckConstraint(
      'asset_deletion_completed_at_check',
      sql`completed_at is null or (isfinite(completed_at) and completed_at >= requested_at)`,
    )
    .addCheckConstraint(
      'asset_deletion_claim_pair_check',
      sql`(execution_token is null) = (execution_expires_at is null)`,
    )
    .addCheckConstraint(
      'asset_deletion_expiry_check',
      sql`execution_expires_at is null or isfinite(execution_expires_at)`,
    )
    .addCheckConstraint(
      'asset_deletion_completed_state_check',
      sql`completed_at is null or (execution_token is null and execution_expires_at is null and last_error_code is null)`,
    )
    .addCheckConstraint(
      'asset_deletion_error_code_check',
      sql`last_error_code is null or last_error_code in (
      'storage_unavailable', 'storage_identity_mismatch', 'unsupported_storage',
      'unexpected_file', 'permission_denied', 'filesystem_error',
      'durability_unavailable', 'inconsistent_state', 'unknown_outcome')`,
    )
    .execute();
  await sql`create index asset_deletion_pending_owner_requested_id_idx
    on public.asset_deletion (owner_id, requested_at desc, asset_id desc)
    where completed_at is null`.execute(db);

  await db.schema
    .withSchema('public')
    .createTable('storage_binding')
    .addColumn('singleton', 'boolean', (column) => column.notNull())
    .addColumn('storage_id', 'uuid', (column) => column.notNull())
    .addColumn('originals_binding_id', 'uuid', (column) => column.notNull())
    .addColumn('thumbnails_binding_id', 'uuid', (column) => column.notNull())
    .addColumn('storage_layout_version', 'smallint', (column) =>
      column.notNull(),
    )
    .addPrimaryKeyConstraint('storage_binding_pkey', ['singleton'])
    .addCheckConstraint(
      'storage_binding_singleton_check',
      sql`singleton = true`,
    )
    .addCheckConstraint(
      'storage_binding_roles_check',
      sql`originals_binding_id <> thumbnails_binding_id`,
    )
    .addCheckConstraint(
      'storage_binding_layout_check',
      sql`storage_layout_version = 1`,
    )
    .execute();

  await inspectLifecycleSchema(db);
}

export async function down(): Promise<never> {
  throw new MigrationSafetyError(
    'Asset lifecycle migration cannot be rolled back automatically; Trash and deletion journals require a reviewed recovery plan.',
  );
}
