import { type Kysely, sql } from 'kysely';

import {
  assertOwnershipAbsent,
  inspectOwnershipAsset,
} from '../asset-ownership-schema.js';
import { inspectAuthSchema } from '../auth-schema.js';
import {
  inspectLegacyAsset,
  MigrationSafetyError,
} from '../legacy-asset-schema.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await inspectLegacyAsset(db))) {
    throw new MigrationSafetyError(
      'M11 ownership migration requires the verified M8 asset schema.',
    );
  }
  await inspectAuthSchema(db);
  await assertOwnershipAbsent(db);

  await db.schema
    .withSchema('public')
    .alterTable('asset')
    .addColumn('owner_id', 'uuid')
    .execute();
  await db.schema
    .withSchema('public')
    .alterTable('asset')
    .addForeignKeyConstraint(
      'asset_owner_id_fkey',
      ['owner_id'],
      'public.app_user',
      ['id'],
      (constraint) => constraint.onDelete('restrict').onUpdate('no action'),
    )
    .execute();
  await sql`alter table public.asset add constraint asset_owner_required_check
    check (owner_id is not null) not valid`.execute(db);
  await db.schema
    .withSchema('public')
    .createIndex('asset_owner_created_id_idx')
    .on('asset')
    .column('owner_id')
    .column('created_at desc')
    .column('id desc')
    .execute();
  if (!(await inspectOwnershipAsset(db)))
    throw new MigrationSafetyError(
      'M11 ownership migration did not create the expected schema.',
    );
}

export async function down(): Promise<never> {
  throw new MigrationSafetyError(
    'Ownership migration cannot be rolled back automatically: asset ownership requires a separately reviewed recovery plan.',
  );
}
