import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileStreamInterceptor,
  type MultipartFileStream,
} from '@nestjs/platform-fastify/multipart';

import { AssetsService, type AssetContent } from './assets.service.js';
import type { AssetResponseDto } from './dto/asset-response.dto.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

@Controller('api/v1/assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  findAll(): Promise<AssetResponseDto[]> {
    return this.assetsService.findAll();
  }

  @Post('upload')
  @UseInterceptors(
    FileStreamInterceptor('file', {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
      },
    }),
  )
  upload(
    @UploadedFile() file: MultipartFileStream | undefined,
  ): Promise<AssetResponseDto> {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }

    return this.assetsService.upload({
      filename: file.originalname,
      mimeType: file.mimetype,
      stream: file.stream,
    });
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

  private toStreamableFile(file: AssetContent): StreamableFile {
    return new StreamableFile(file.stream, {
      type: file.contentType,
      length: file.size,
      disposition: 'inline',
    });
  }
}
