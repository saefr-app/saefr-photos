import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  HttpException,
  HttpCode,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyReply } from 'fastify';

import { AssetsService, type AssetContent } from './assets.service.js';
import {
  AssetPageDto,
  AssetResponseDto,
  DeletionReceiptDto,
  LifecycleTransitionDto,
  PendingDeletionPageDto,
  TrashPageDto,
} from './dto/asset-response.dto.js';
import {
  isCanonicalUuid,
  lifecycleEtag,
  parsePageQuery,
} from './asset-lifecycle-contract.js';
import { AssetDeletionService } from './asset-deletion.service.js';
import { hasDeletionBody } from './deletion-empty-body.js';
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
  constructor(
    private readonly assetsService: AssetsService,
    private readonly deletionService: AssetDeletionService,
  ) {}

  private deletionId(value: string): string {
    if (!isCanonicalUuid(value))
      throw new BadRequestException('Invalid request');
    return value;
  }

  private emptyBody(request: ActorRequest): void {
    if (hasDeletionBody(request))
      throw new BadRequestException('Invalid request');
  }

  private async deletionAttempt(
    request: ActorRequest,
    reply: FastifyReply,
    work: (
      signal: AbortSignal,
    ) => Promise<{ code: 200 | 202; receipt: DeletionReceiptDto }>,
  ): Promise<DeletionReceiptDto> {
    const controller = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('aborted', disconnect);
    reply.raw.once('close', disconnect);
    try {
      // Authentication can await after the peer has already closed. Event
      // listeners alone cannot observe a close that happened before entry.
      if (
        request.raw.aborted ||
        (!reply.raw.writableEnded && reply.raw.destroyed) ||
        request.raw.socket.destroyed
      )
        disconnect();
      const result = await work(controller.signal);
      reply.code(result.code);
      reply.header(
        'Location',
        `/api/v1/assets/deletions/${result.receipt.asset_id}`,
      );
      return result.receipt;
    } finally {
      request.raw.off('aborted', disconnect);
      reply.raw.off('close', disconnect);
    }
  }

  @Get()
  @ApiOperation({
    summary: 'List owned assets',
  })
  @ApiOkResponse({
    type: AssetPageDto,
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  findAll(@Req() request: ActorRequest) {
    const actor = requireAssetActor(request);
    return this.assetsService.findPage(
      actor,
      'active',
      parsePageQuery(request.raw.url ?? '', actor.userId, 'active'),
    );
  }

  @Get('trash')
  @ApiOperation({ summary: 'List owned trashed assets' })
  @ApiOkResponse({ type: TrashPageDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  findTrash(@Req() request: ActorRequest) {
    const actor = requireAssetActor(request);
    return this.assetsService.findPage(
      actor,
      'trash',
      parsePageQuery(request.raw.url ?? '', actor.userId, 'trash'),
    );
  }

  @Get('deletions')
  @ApiOperation({ summary: 'List owned pending deletion receipts' })
  @ApiOkResponse({ type: PendingDeletionPageDto })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  findPendingDeletions(@Req() request: ActorRequest) {
    const actor = requireAssetActor(request);
    return this.assetsService.findPendingDeletions(
      actor,
      parsePageQuery(request.raw.url ?? '', actor.userId, 'pending-deletions'),
    );
  }

  @Get('deletions/:assetId')
  @ApiOperation({ summary: 'Read an owned permanent-deletion receipt' })
  @ApiParam({ name: 'assetId', format: 'uuid' })
  @ApiOkResponse({ type: DeletionReceiptDto })
  @ApiResponse({ status: 404, description: 'Deletion receipt not found.' })
  async deletionStatus(
    @Req() request: ActorRequest,
    @Param('assetId') assetId: string,
  ): Promise<DeletionReceiptDto> {
    return this.deletionService.status(
      requireAssetActor(request),
      this.deletionId(assetId),
    );
  }

  @Post('deletions/:assetId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Explicitly retry an accepted permanent deletion' })
  @ApiParam({ name: 'assetId', format: 'uuid' })
  @ApiOkResponse({ type: DeletionReceiptDto })
  @ApiResponse({ status: 202, type: DeletionReceiptDto })
  @ApiResponse({ status: 404, description: 'Deletion receipt not found.' })
  @ApiResponse({ status: 503, description: 'Execution unavailable.' })
  async retryDeletion(
    @Req() request: ActorRequest,
    @Param('assetId') assetId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DeletionReceiptDto> {
    const actor = requireAssetActor(request);
    this.emptyBody(request);
    return this.deletionAttempt(request, reply, (signal) =>
      this.deletionService.retry(actor, this.deletionId(assetId), signal),
    );
  }

  @Get('trash/:assetId/thumbnail')
  @ApiOperation({ summary: 'View an owned Trash thumbnail' })
  @ApiProduces('image/jpeg')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async getTrashThumbnail(
    @Req() request: ActorRequest,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
  ): Promise<StreamableFile> {
    const file = await this.assetsService.getTrashThumbnail(
      requireAssetActor(request),
      assetId,
    );
    return this.toStreamableFile(file);
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
  async upload(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetResponseDto> {
    const actor = requireAssetActor(request);
    await this.assetsService.assertUploadReady();
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
      // Busboy can hand back a file stream already destroyed by malformed
      // multipart data. Piping it afterward can wait forever for an event that
      // has already fired.
      if (file.file.destroyed) {
        if (file.file.truncated) {
          throw new PayloadTooLargeException('File too large');
        }
        throw new BadRequestException('Incomplete multipart request');
      }
      const uploadStream = new PassThrough();
      const forwarding = pipeline(file.file, uploadStream);
      void forwarding.catch(() => undefined);

      try {
        const created = await this.assetsService.upload(actor, {
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
        reply.header('ETag', lifecycleEtag(created.id, '0'));
        return created;
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
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AssetResponseDto> {
    return this.assetsService
      .findByIdWithVersion(requireAssetActor(request), assetId)
      .then(({ body, version }) => {
        reply.header('ETag', lifecycleEtag(assetId, version));
        return body;
      });
  }

  @Post(':assetId/trash')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move an owned asset to Trash' })
  @ApiOkResponse({ type: LifecycleTransitionDto })
  async trash(
    @Req() request: ActorRequest,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = requireAssetActor(request);
    if (request.body !== undefined)
      throw new BadRequestException('Invalid request');
    const result = await this.assetsService.transition(
      actor,
      assetId,
      'trashed',
      request.headers['if-match'],
    );
    reply.header('ETag', lifecycleEtag(assetId, result.lifecycle_version));
    return result;
  }

  @Post(':assetId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore an owned asset from Trash' })
  @ApiOkResponse({ type: LifecycleTransitionDto })
  async restore(
    @Req() request: ActorRequest,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = requireAssetActor(request);
    if (request.body !== undefined)
      throw new BadRequestException('Invalid request');
    const result = await this.assetsService.transition(
      actor,
      assetId,
      'active',
      request.headers['if-match'],
    );
    reply.header('ETag', lifecycleEtag(assetId, result.lifecycle_version));
    return result;
  }

  @Delete(':assetId')
  @ApiOperation({ summary: 'Permanently delete an owned trashed asset' })
  @ApiParam({ name: 'assetId', format: 'uuid' })
  @ApiOkResponse({ type: DeletionReceiptDto })
  @ApiResponse({ status: 202, type: DeletionReceiptDto })
  @ApiResponse({ status: 409, description: 'Asset must be in Trash.' })
  @ApiResponse({ status: 412, description: 'Lifecycle version conflict.' })
  @ApiResponse({ status: 428, description: 'Lifecycle version required.' })
  @ApiResponse({ status: 503, description: 'Storage or database unavailable.' })
  async deleteAsset(
    @Req() request: ActorRequest,
    @Param('assetId') assetId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DeletionReceiptDto> {
    const actor = requireAssetActor(request);
    this.emptyBody(request);
    return this.deletionAttempt(request, reply, (signal) =>
      this.deletionService.accept(
        actor,
        this.deletionId(assetId),
        request.headers['if-match'],
        signal,
      ),
    );
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
