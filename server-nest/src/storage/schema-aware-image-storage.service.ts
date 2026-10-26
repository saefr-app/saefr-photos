import type { Readable } from 'node:stream';

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AssetImageStorage } from '../assets/assets.service.js';
import { DatabaseService } from '../database/database.service.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import {
  ASSET_LIFECYCLE_MIGRATION,
  ASSET_OWNERSHIP_MIGRATION,
} from '../database/migrations/migration-provider.js';
import { BoundImageStorageService } from './bound-image-storage.service.js';
import { LocalStorageService } from './local-storage.service.js';

/**
 * Resolve the active schema for each media operation. Never cache an M11
 * decision across a later schema upgrade or fall back after an inspection
 * failure. M12 media remains gated by both role bindings at operation time.
 */
export class SchemaAwareImageStorageService implements AssetImageStorage {
  private readonly legacy: LocalStorageService;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService,
    private readonly bound: BoundImageStorageService,
  ) {
    this.legacy = new LocalStorageService(config);
  }

  private async select(): Promise<AssetImageStorage> {
    try {
      const status = await getMigrationStatus(this.database.db);
      if (
        status.migrations.some(
          (migration) =>
            migration.name === ASSET_LIFECYCLE_MIGRATION && migration.applied,
        )
      )
        return this.bound;
      if (
        status.migrations.some(
          (migration) =>
            migration.name === ASSET_OWNERSHIP_MIGRATION && migration.applied,
        )
      )
        return this.legacy;
    } catch {
      // Exact schema validation failed; no path may select legacy storage.
    }
    throw new ServiceUnavailableException('Storage unavailable');
  }

  async assertReady(): Promise<void> {
    await (await this.select()).assertReady?.();
  }

  async saveImage(
    assetId: string,
    mimeType: string,
    input: Readable,
    verifyComplete?: () => Promise<void>,
  ) {
    return (await this.select()).saveImage(
      assetId,
      mimeType,
      input,
      verifyComplete,
    );
  }

  async deleteImage(assetId: string, mimeType: string): Promise<void> {
    await (await this.select()).deleteImage(assetId, mimeType);
  }

  async finalizeImage(assetId: string): Promise<void> {
    await (await this.select()).finalizeImage?.(assetId);
  }

  async openOriginal(
    assetId: string,
    mimeType: string,
    legacyStoragePath: string,
  ) {
    return (await this.select()).openOriginal(
      assetId,
      mimeType,
      legacyStoragePath,
    );
  }

  async openThumbnail(assetId: string) {
    return (await this.select()).openThumbnail(assetId);
  }
}
