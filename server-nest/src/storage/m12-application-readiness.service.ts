import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import { ASSET_LIFECYCLE_MIGRATION } from '../database/migrations/migration-provider.js';
import { StorageBindingVerifier } from './storage-binding.service.js';

/**
 * Proposed M12 startup assessment, kept separate from main.ts's existing
 * refusal until independent review approves the HTTP cutover. An unadopted or
 * unavailable storage set permits authorized metadata only; media stays gated
 * by a fresh binding check at each operation.
 */
@Injectable()
export class M12ApplicationReadinessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly verifier: StorageBindingVerifier,
  ) {}

  async assess(): Promise<'media-ready' | 'metadata-only'> {
    try {
      const status = await getMigrationStatus(this.database.db);
      if (
        !status.migrations.some(
          (migration) =>
            migration.name === ASSET_LIFECYCLE_MIGRATION && migration.applied,
        )
      )
        throw new Error('Schema unavailable');
    } catch {
      throw new Error('Application schema is not ready');
    }
    try {
      await this.verifier.assertVerified();
      return 'media-ready';
    } catch {
      return 'metadata-only';
    }
  }
}
