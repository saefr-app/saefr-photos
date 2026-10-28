import type { MigrationProvider } from 'kysely/migration';

import * as initialAsset from './versions/202610170001_initial_asset.js';
import * as authenticationFoundation from './versions/202610210001_authentication_foundation.js';
import * as assetOwnership from './versions/202610220001_asset_ownership.js';
import * as assetLifecycle from './versions/202610260001_asset_lifecycle.js';

export const INITIAL_ASSET_MIGRATION = '202610170001_initial_asset';
export const AUTHENTICATION_MIGRATION =
  '202610210001_authentication_foundation';
export const ASSET_OWNERSHIP_MIGRATION = '202610220001_asset_ownership';
export const ASSET_LIFECYCLE_MIGRATION = '202610260001_asset_lifecycle';

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
        [AUTHENTICATION_MIGRATION]: authenticationFoundation,
        [ASSET_OWNERSHIP_MIGRATION]: assetOwnership,
        [ASSET_LIFECYCLE_MIGRATION]: assetLifecycle,
      };
    },
  };
}
