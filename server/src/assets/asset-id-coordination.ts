import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/database.types.js';
import { ASSET_LIFECYCLE_MIGRATION } from '../database/migrations/migration-provider.js';

/**
 * Shared M12 transaction lock for upload finalization and future deletion
 * acceptance. Both paths must acquire it after account/session locks and
 * before deciding whether the UUID may be inserted or retired.
 * Hash collisions only serialize unrelated UUIDs; they grant no authority.
 */
export async function lockAssetId(
  transaction: Transaction<Database>,
  assetId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    hashtextextended(${assetId}::text, 708202610260001::bigint)
  )`.execute(transaction);
}

/** Call only while holding lockAssetId in this same transaction. */
export async function assertAssetIdNotRetired(
  transaction: Transaction<Database>,
  assetId: string,
): Promise<void> {
  const retired = await transaction
    .selectFrom('asset_deletion')
    .select('asset_id')
    .where('asset_id', '=', assetId)
    .executeTakeFirst();
  if (retired) throw new Error('Asset identifier is retired');
}

/**
 * M11 schema has no deletion journal or deletion-acceptance path. Its retained
 * HTTP fixtures still exercise upload. M12 readiness validates the entire
 * schema before any M12 HTTP operation, so a missing M12 journal is not a
 * permitted runtime compatibility shortcut.
 */
export async function assertAssetIdNotRetiredIfPresent(
  transaction: Transaction<Database>,
  assetId: string,
): Promise<void> {
  const relation = await sql<{ present: boolean; migrated: boolean }>`select
    to_regclass('public.asset_deletion') is not null as present,
    exists(select 1 from public.kysely_migration
      where name = ${ASSET_LIFECYCLE_MIGRATION}) as migrated`.execute(
    transaction,
  );
  if (relation.rows[0]?.migrated && !relation.rows[0].present) {
    throw new Error('Asset lifecycle schema unavailable');
  }
  if (relation.rows[0]?.present) {
    await assertAssetIdNotRetired(transaction, assetId);
  }
}
