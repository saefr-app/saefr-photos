import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { User } from '../entities/user.entity';
import { AssetsService } from './assets.service';

/** 25 MB — conservative guardrail for this phase, see comment on the interceptor. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Controller('assets')
@UseGuards(JwtAuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('upload')
  @UseInterceptors(
    // Multer's default storage buffers the whole file in memory before we ever
    // touch it, so peak RAM scales with concurrent uploads × file size. The
    // 25MB cap is the guardrail; real streaming-to-disk uploads are deferred to
    // a later hardening pass.
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async upload(@CurrentUser() user: User, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided under field "file"');
    }
    return this.assets.upload(user, file);
  }

  /** Everything the caller can see, newest first. Backs the gallery grid. */
  @Get()
  async list(@CurrentUser() user: User) {
    return this.assets.listForUser(user);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: User,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.assets.findOneForUser(user, id);
  }

  /** The stored bytes, behind the same membership check as the metadata. */
  @Get(':id/file')
  async file(
    @CurrentUser() user: User,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { asset, stream } = await this.assets.openFile(user, id);

    res.set({
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.sizeBytes),
      // RFC 5987 encoding so non-ASCII filenames survive the header.
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(
        asset.originalFilename,
      )}`,
    });

    return new StreamableFile(stream);
  }
}
