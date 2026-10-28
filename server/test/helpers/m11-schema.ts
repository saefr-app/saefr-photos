import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import {
  ASSET_OWNERSHIP_MIGRATION,
  createMigrationProvider,
} from '../../src/database/migrations/migration-provider.js';

/** Historical HTTP fixtures stay on M11 while M12B deliberately refuses HTTP startup. */
export async function migrateToM11<DB>(db: Kysely<DB>): Promise<void> {
  const result = await new Migrator({
    db,
    migrationTableSchema: 'public',
    provider: createMigrationProvider(),
  }).migrateTo(ASSET_OWNERSHIP_MIGRATION);
  if (result.error) throw result.error;
}
