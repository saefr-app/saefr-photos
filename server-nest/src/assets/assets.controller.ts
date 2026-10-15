import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';

import { AssetsService } from './assets.service.js';
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
}
