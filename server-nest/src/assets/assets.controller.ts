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
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AssetsService, type AssetContent } from './assets.service.js';
import { AssetResponseDto } from './dto/asset-response.dto.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

@ApiTags('assets')
@Controller('api/v1/assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all assets',
  })
  @ApiOkResponse({
    type: AssetResponseDto,
    isArray: true,
  })
  findAll(): Promise<AssetResponseDto[]> {
    return this.assetsService.findAll();
  }

  @Post('upload')
  @ApiOperation({
    summary: 'Upload an image',
    description:
      'Upload a JPEG, PNG or WebP image (maximum 20 MiB). ' +
      'The original is preserved and a JPEG thumbnail is generated.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG, PNG or WebP image',
        },
      },
    },
  })
  @ApiCreatedResponse({
    type: AssetResponseDto,
    description: 'Image uploaded successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid multipart request or filename.',
  })
  @ApiResponse({
    status: 413,
    description: 'Upload exceeds the size limit.',
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported or invalid image.',
  })
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
  @ApiOperation({
    summary: 'Get asset metadata',
  })
  @ApiParam({
    name: 'assetId',
    format: 'uuid',
    description: 'Asset UUID',
  })
  @ApiOkResponse({
    type: AssetResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid UUID.',
  })
  @ApiResponse({
    status: 404,
    description: 'Asset not found.',
  })
  findById(
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<AssetResponseDto> {
    return this.assetsService.findById(assetId);
  }

  @Get(':assetId/original')
  @ApiOperation({
    summary: 'Download the original image',
  })
  @ApiParam({
    name: 'assetId',
    format: 'uuid',
  })
  @ApiProduces('image/jpeg', 'image/png', 'image/webp')
  @ApiOkResponse({
    description: 'Original image bytes.',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Asset or original file not found.',
  })
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
  @ApiOperation({
    summary: 'Download the JPEG thumbnail',
  })
  @ApiParam({
    name: 'assetId',
    format: 'uuid',
  })
  @ApiProduces('image/jpeg')
  @ApiOkResponse({
    description: 'Generated JPEG thumbnail.',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Asset or thumbnail not found.',
  })
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
