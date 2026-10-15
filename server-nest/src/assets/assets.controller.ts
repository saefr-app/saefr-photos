import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  StreamableFile,
} from '@nestjs/common';

import {
  AssetsService,
  type AssetContent,
} from './assets.service.js';
import type { AssetResponseDto } from './dto/asset-response.dto.js';

@Controller('api/v1/assets')
export class AssetsController {
  constructor(
    private readonly assetsService: AssetsService,
  ) {}

  @Get()
  findAll(): Promise<AssetResponseDto[]> {
    return this.assetsService.findAll();
  }

  @Get(':assetId')
  findById(
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<AssetResponseDto> {
    return this.assetsService.findById(assetId);
  }

  @Get(':assetId/original')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async getOriginal(
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<StreamableFile> {
    const file = await this.assetsService.getOriginal(assetId);

    return this.toStreamableFile(file);
  }

  @Get(':assetId/thumbnail')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async getThumbnail(
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<StreamableFile> {
    const file = await this.assetsService.getThumbnail(assetId);

    return this.toStreamableFile(file);
  }

  private toStreamableFile(
    file: AssetContent,
  ): StreamableFile {
    return new StreamableFile(file.stream, {
      type: file.contentType,
      length: file.size,
      disposition: 'inline',
    });
  }
}
