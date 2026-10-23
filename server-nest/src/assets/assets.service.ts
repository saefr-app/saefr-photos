import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  AssetsRepository,
  type AssetRecord,
  type AssetFileRecord,
} from './assets.repository.js';
import type { AssetResponseDto } from './dto/asset-response.dto.js';

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

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly assetsRepository: AssetsRepository,
    private readonly storage: LocalStorageService,
  ) {}

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

    return this.toResponse(result.asset);
  }

  async findAll(actor: AuthenticatedActor): Promise<AssetResponseDto[]> {
    const assets = await this.assetsRepository.findAll(actor.userId);

    return assets.map((asset) => this.toResponse(asset));
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
