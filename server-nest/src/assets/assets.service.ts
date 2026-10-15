import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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

export interface AssetContent extends StoredFile {
  contentType: string;
}

export interface ImageUpload {
  filename: string;
  mimeType: string;
  stream: Readable;
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly assetsRepository: AssetsRepository,
    private readonly storage: LocalStorageService,
  ) {}

  async upload(upload: ImageUpload): Promise<AssetResponseDto> {
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
    );

    let asset: AssetRecord;

    try {
      asset = await this.assetsRepository.create({
        id: assetId,
        filename,
        mime_type: stored.mimeType,
        size: stored.size,
        storage_path: stored.storagePath,
        created_at: new Date(),
      });
    } catch (error: unknown) {
      try {
        await this.storage.deleteImage(assetId, stored.mimeType);
      } catch (cleanupError: unknown) {
        this.logger.error(
          'Unable to clean up failed asset upload',
          cleanupError instanceof Error
            ? cleanupError.stack
            : String(cleanupError),
        );
      }

      throw error;
    }

    return this.toResponse(asset);
  }

  async findAll(): Promise<AssetResponseDto[]> {
    const assets = await this.assetsRepository.findAll();

    return assets.map((asset) => this.toResponse(asset));
  }

  async findById(assetId: string): Promise<AssetResponseDto> {
    const asset = await this.assetsRepository.findById(assetId);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.toResponse(asset);
  }

  async getOriginal(assetId: string): Promise<AssetContent> {
    const asset = await this.getFileRecord(assetId);

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

  async getThumbnail(assetId: string): Promise<AssetContent> {
    const asset = await this.getFileRecord(assetId);

    const file = await this.storage.openThumbnail(asset.id);

    return {
      ...file,
      contentType: 'image/jpeg',
    };
  }

  private async getFileRecord(assetId: string): Promise<AssetFileRecord> {
    const asset = await this.assetsRepository.findFileById(assetId);

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
