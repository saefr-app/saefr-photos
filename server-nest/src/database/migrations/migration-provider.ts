import type { MigrationProvider } from 'kysely/migration';

import * as initialAsset from './versions/202610170001_initial_asset.js';

export const INITIAL_ASSET_MIGRATION = '202610170001_initial_asset';

// Explicit imports work identically in compiled ESM and Vitest. Append new
// immutable version files here; never rename or edit an applied migration.
export function createMigrationProvider(
  baselineLegacy = false,
): MigrationProvider {
  return {
    async getMigrations() {
      return {
        [INITIAL_ASSET_MIGRATION]: {
          up: (db) => initialAsset.up(db, baselineLegacy),
          down: initialAsset.down,
        },
      };
    },
  };
}
