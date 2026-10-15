import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AssetsRepository,
  type AssetRecord,
} from './assets.repository.js';
import type { AssetResponseDto } from './dto/asset-response.dto.js';

@Injectable()
export class AssetsService {
  constructor(
    private readonly assetsRepository: AssetsRepository,
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
