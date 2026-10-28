import { type Kysely, sql } from 'kysely';

import {
  inspectLegacyAsset,
  MigrationSafetyError,
} from '../legacy-asset-schema.js';

export async function up(
  db: Kysely<unknown>,
  baselineLegacy = false,
): Promise<void> {
  if (await inspectLegacyAsset(db)) {
    if (!baselineLegacy) {
      throw new MigrationSafetyError(
        'Untracked public.asset requires explicit --baseline-legacy after schema review and backup.',
      );
    }
    // Hold off concurrent DDL until Kysely commits the baseline record.
    // This lock permits ordinary reads/writes and does not alter the table.
    await sql`lock table public.asset in share update exclusive mode`.execute(
      db,
    );
    await inspectLegacyAsset(db);
    return;
  }
  await db.schema
    .withSchema('public')
    .createTable('asset')
    .addColumn('filename', 'varchar', (column) => column.notNull())
    .addColumn('mime_type', 'varchar', (column) => column.notNull())
    .addColumn('size', 'integer', (column) => column.notNull())
    .addColumn('id', 'uuid', (column) => column.notNull())
    .addColumn('storage_path', 'varchar', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('asset_pkey', ['id'])
    .execute();
}

export async function down(): Promise<never> {
  throw new MigrationSafetyError(
    'The initial asset migration cannot be rolled back: dropping it could destroy legacy data. Use a separately reviewed recovery plan.',
  );
}
