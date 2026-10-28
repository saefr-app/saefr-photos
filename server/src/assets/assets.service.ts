import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  AssetsRepository,
  type AssetRecord,
  type AssetFileRecord,
  type LifecycleResult,
  type PendingDeletionRecord,
} from './assets.repository.js';
import type { AssetResponseDto } from './dto/asset-response.dto.js';
import {
  encodeCursor,
  type AssetCollection,
  type PageRequest,
} from './asset-lifecycle-contract.js';

import {
  LocalStorageService,
  type StoredFile,
} from '../storage/local-storage.service.js';
import { safeErrorCode } from '../errors/safe-error-code.js';
import type { AuthenticatedActor } from '../auth/auth-session.service.js';

export interface AssetContent extends StoredFile {
  contentType: string;
}

export interface ImageUpload {
  filename: string;
  mimeType: string;
  stream: Readable;
  verifyComplete?: () => Promise<void>;
}

export interface AssetPage {
  items: Array<
    AssetResponseDto & { lifecycle_version: string; trashed_at?: string }
  >;
  next_cursor: string | null;
}

export interface DeletionPage {
  items: Array<{
    asset_id: string;
    status: 'pending';
    requested_at: string;
    completed_at: null;
    last_error_code: string | null;
  }>;
  next_cursor: string | null;
}

/** The active M11 implementation and the gated M12 provider share this surface. */
export interface AssetImageStorage {
  assertReady?(): Promise<void>;
  saveImage(
    assetId: string,
    mimeType: string,
    input: Readable,
    verifyComplete?: () => Promise<void>,
  ): Promise<{ storagePath: string; mimeType: string; size: number }>;
  deleteImage(assetId: string, mimeType: string): Promise<void>;
  openOriginal(
    assetId: string,
    mimeType: string,
    legacyStoragePath: string,
  ): Promise<StoredFile>;
  openThumbnail(assetId: string): Promise<StoredFile>;
  finalizeImage?(assetId: string): Promise<void>;
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly assetsRepository: AssetsRepository,
    @Inject(LocalStorageService) private readonly storage: AssetImageStorage,
  ) {}

  async assertUploadReady(): Promise<void> {
    await this.storage.assertReady?.();
  }

  async upload(
    actor: AuthenticatedActor,
    upload: ImageUpload,
  ): Promise<AssetResponseDto> {
    const filename = basename(upload.filename.replaceAll('\\', '/')).trim();

    if (
      !filename ||
      filename === '.' ||
      filename === '..' ||
      Buffer.byteLength(filename, 'utf8') > 255 ||
      Array.from(filename).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    ) {
      throw new BadRequestException('Invalid filename');
    }

    const assetId = randomUUID();

    try {
      await this.assetsRepository.assertIdAvailableForPublication(assetId);
    } catch (error: unknown) {
      throw new ServiceUnavailableException('Service unavailable', {
        cause: error,
      });
    }

    const stored = await this.storage.saveImage(
      assetId,
      upload.mimeType,
      upload.stream,
      upload.verifyComplete,
    );

    const result = await this.assetsRepository.createForActor(actor, {
      id: assetId,
      filename,
      mime_type: stored.mimeType,
      size: stored.size,
      storage_path: stored.storagePath,
      created_at: new Date(),
    });

    if (result.status === 'not_started' || result.status === 'rolled_back') {
      try {
        await this.storage.deleteImage(assetId, stored.mimeType);
      } catch (cleanupError: unknown) {
        this.logger.error(
          `Unable to clean up failed asset upload; ${safeErrorCode(cleanupError)}`,
        );
      }

      if (result.status === 'not_started') {
        this.logger.error(
          `Asset upload transaction did not start for ${assetId}; ${safeErrorCode(result.error)}`,
        );
        throw new ServiceUnavailableException('Upload unavailable', {
          cause: result.error,
        });
      }

      throw result.error;
    }

    if (result.status === 'uncertain') {
      this.logger.error(
        `Asset upload commit outcome unknown for ${assetId}; ${safeErrorCode(result.error)}`,
      );
      throw new ServiceUnavailableException('Upload unavailable');
    }

    try {
      await this.storage.finalizeImage?.(assetId);
    } catch (error: unknown) {
      // Metadata committed. A failed stage-link release is left for explicit
      // reconciliation; never undo or report this upload as rolled back.
      this.logger.error(
        `Unable to release upload staging after commit; ${safeErrorCode(error)}`,
      );
    }

    return this.toResponse(result.asset);
  }

  async findPage(
    actor: AuthenticatedActor,
    collection: 'active' | 'trash',
    page: PageRequest,
  ): Promise<AssetPage> {
    const rows = await this.assetsRepository.findPage(
      actor.userId,
      collection,
      page.limit,
      page.cursor,
    );
    const visible = rows.slice(0, page.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((asset) => ({
        id: asset.id,
        filename: asset.filename,
        mime_type: asset.mime_type,
        size: asset.size,
        created_at: asset.created_at.toISOString(),
        lifecycle_version: asset.lifecycle_version,
        ...(collection === 'trash'
          ? { trashed_at: asset.trashed_timestamp! }
          : {}),
      })),
      next_cursor:
        rows.length > page.limit && last
          ? this.cursor(
              actor.userId,
              collection,
              collection === 'trash'
                ? last.trashed_timestamp!
                : last.cursor_timestamp,
              last.id,
            )
          : null,
    };
  }

  /** Bounded compatibility helper for historical component tests. */
  async findAll(actor: AuthenticatedActor): Promise<AssetResponseDto[]> {
    const assets = await this.assetsRepository.findAll(actor.userId);
    return assets.map((asset) => this.toResponse(asset));
  }

  async findPendingDeletions(
    actor: AuthenticatedActor,
    page: PageRequest,
  ): Promise<DeletionPage> {
    const rows = await this.assetsRepository.findPendingDeletions(
      actor.userId,
      page.limit,
      page.cursor,
    );
    const visible = rows.slice(0, page.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.pendingResponse(row)),
      next_cursor:
        rows.length > page.limit && last
          ? this.cursor(
              actor.userId,
              'pending-deletions',
              last.requested_timestamp,
              last.asset_id,
            )
          : null,
    };
  }

  private pendingResponse(
    row: PendingDeletionRecord,
  ): DeletionPage['items'][number] {
    return {
      asset_id: row.asset_id,
      status: 'pending',
      requested_at: row.requested_timestamp,
      completed_at: null,
      last_error_code: row.last_error_code,
    };
  }

  private cursor(
    owner: string,
    collection: AssetCollection,
    timestamp: string,
    id: string,
  ): string {
    return encodeCursor({ v: 1, owner, collection, timestamp, id });
  }

  async findById(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<AssetResponseDto> {
    const asset = await this.assetsRepository.findById(assetId, actor.userId);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.toResponse(asset);
  }

  async findByIdWithVersion(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<{ body: AssetResponseDto; version: string }> {
    const asset = await this.assetsRepository.findById(assetId, actor.userId);
    if (!asset) throw new NotFoundException('Asset not found');
    return { body: this.toResponse(asset), version: asset.lifecycle_version };
  }

  async transition(
    actor: AuthenticatedActor,
    assetId: string,
    target: 'active' | 'trashed',
    ifMatch: string | string[] | undefined,
  ): Promise<{
    id: string;
    state: 'active' | 'trashed';
    trashed_at: string | null;
    lifecycle_version: string;
  }> {
    const result: LifecycleResult = await this.assetsRepository.transition(
      actor,
      assetId,
      target,
      ifMatch,
    );
    return {
      id: result.id,
      state: result.trashed_timestamp === null ? 'active' : 'trashed',
      trashed_at: result.trashed_timestamp,
      lifecycle_version: result.lifecycle_version,
    };
  }

  async getTrashThumbnail(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<AssetContent> {
    const asset = await this.assetsRepository.findTrashFileById(
      assetId,
      actor.userId,
    );
    if (!asset) throw new NotFoundException('Asset not found');
    const file = await this.storage.openThumbnail(asset.id);
    return { ...file, contentType: 'image/jpeg' };
  }

  async getOriginal(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<AssetContent> {
    const asset = await this.getFileRecord(actor, assetId);

    const file = await this.storage.openOriginal(
      asset.id,
      asset.mime_type,
      asset.storage_path,
    );

    return {
      ...file,
      contentType: asset.mime_type,
    };
  }

  async getThumbnail(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<AssetContent> {
    const asset = await this.getFileRecord(actor, assetId);

    const file = await this.storage.openThumbnail(asset.id);

    return {
      ...file,
      contentType: 'image/jpeg',
    };
  }

  private async getFileRecord(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<AssetFileRecord> {
    const asset = await this.assetsRepository.findFileById(
      assetId,
      actor.userId,
    );

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  private toResponse(asset: AssetRecord): AssetResponseDto {
    return {
      id: asset.id,
      filename: asset.filename,
      mime_type: asset.mime_type,
      size: asset.size,
      created_at: asset.created_at.toISOString(),
    };
  }
}
