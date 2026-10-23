import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
  StreamableFile,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
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
import type { MultipartFile } from '@fastify/multipart';

import { AssetsService, type AssetContent } from './assets.service.js';
import { AssetResponseDto } from './dto/asset-response.dto.js';
import { MAX_UPLOAD_BYTES } from '../storage/image-limits.js';
import type { ActorRequest } from '../auth/request-auth.js';
import type { AuthenticatedActor } from '../auth/auth-session.service.js';

function requireAssetActor(request: ActorRequest): AuthenticatedActor {
  const actor = request.authActor;
  if (!actor) throw new UnauthorizedException('Unauthorized');
  if (actor.passwordChangeRequired) throw new ForbiddenException('Forbidden');
  return actor;
}

function uploadError(error: unknown): unknown {
  if (error instanceof HttpException) return error;

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;

  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException('File too large');
  }

  if (
    code === 'FST_PARTS_LIMIT' ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_MP_PREMATURE_CLOSE' ||
    code === 'FST_PROTO_VIOLATION' ||
    code === 'FST_INVALID_JSON_FIELD_ERROR' ||
    code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ABORT_ERR' ||
    code === 'ECONNRESET'
  ) {
    return new BadRequestException('Invalid multipart request');
  }

  if (
    error instanceof Error &&
    (error.message === 'Multipart: Boundary not found' ||
      error.message === 'Unexpected end of multipart data' ||
      error.message.includes('terminated early due to unexpected end'))
  ) {
    return new BadRequestException('Incomplete multipart request');
  }

  return error;
}

@ApiTags('assets')
@Controller('api/v1/assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  @ApiOperation({
    summary: 'List owned assets',
  })
  @ApiOkResponse({
    type: AssetResponseDto,
    isArray: true,
  })
  findAll(@Req() request: ActorRequest): Promise<AssetResponseDto[]> {
    return this.assetsService.findAll(requireAssetActor(request));
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
  async upload(@Req() request: ActorRequest): Promise<AssetResponseDto> {
    const actor = requireAssetActor(request);
    if (!request.isMultipart()) {
      throw new BadRequestException('Image file is required');
    }

    const parts = request.parts({
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });

    try {
      const first = await parts.next();

      if (
        first.done ||
        first.value.type !== 'file' ||
        first.value.fieldname !== 'file' ||
        !first.value.filename
      ) {
        if (!first.done && first.value.type === 'file') {
          first.value.file.destroy();
        }
        throw new BadRequestException('Image file is required');
      }

      const file: MultipartFile = first.value;
      const uploadStream = new PassThrough();
      const forwarding = pipeline(file.file, uploadStream);
      void forwarding.catch(() => undefined);

      try {
        return await this.assetsService.upload(actor, {
          filename: file.filename,
          mimeType: file.mimetype,
          stream: uploadStream,
          verifyComplete: async () => {
            if (file.file.truncated) {
              throw new PayloadTooLargeException('File too large');
            }

            const last = await parts.next();

            if (!last.done) {
              throw new BadRequestException('Unexpected multipart field');
            }
          },
        });
      } finally {
        if (!uploadStream.readableEnded) {
          file.file.destroy();
          uploadStream.destroy();
        }

        await forwarding.catch(() => undefined);
      }
    } catch (error: unknown) {
      throw uploadError(error);
    }
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
    @Req() request: ActorRequest,
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<AssetResponseDto> {
    return this.assetsService.findById(requireAssetActor(request), assetId);
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
    @Req() request: ActorRequest,
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<StreamableFile> {
    const file = await this.assetsService.getOriginal(
      requireAssetActor(request),
      assetId,
    );

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
    @Req() request: ActorRequest,
    @Param('assetId', new ParseUUIDPipe())
    assetId: string,
  ): Promise<StreamableFile> {
    const file = await this.assetsService.getThumbnail(
      requireAssetActor(request),
      assetId,
    );

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
