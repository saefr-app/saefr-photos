import {
  Injectable,
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

@Injectable()
export class AssetsService {
  constructor(
    private readonly assetsRepository: AssetsRepository,
    private readonly storage: LocalStorageService,
  ) {}

  async findAll(): Promise<AssetResponseDto[]> {
    const assets = await this.assetsRepository.findAll();

    return assets.map((asset) => this.toResponse(asset));
  }

  async findById(
    assetId: string,
  ): Promise<AssetResponseDto> {
    const asset = await this.assetsRepository.findById(assetId);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.toResponse(asset);
  }

  async getOriginal(
    assetId: string,
  ): Promise<AssetContent> {
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

  async getThumbnail(
    assetId: string,
  ): Promise<AssetContent> {
    const asset = await this.getFileRecord(assetId);

    const file = await this.storage.openThumbnail(
      asset.id,
    );

    return {
      ...file,
      contentType: 'image/jpeg',
    };
  }

  private async getFileRecord(
    assetId: string,
  ): Promise<AssetFileRecord> {
    const asset = await this.assetsRepository.findFileById(
      assetId,
    );

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  private toResponse(
    asset: AssetRecord,
  ): AssetResponseDto {
    return {
      id: asset.id,
      filename: asset.filename,
      mime_type: asset.mime_type,
      size: asset.size,
      created_at: asset.created_at.toISOString(),
    };
  }
}
