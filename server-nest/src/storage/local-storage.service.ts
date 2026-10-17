import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, link, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp, { type Metadata } from 'sharp';

import { MAX_IMAGE_PIXELS, MAX_UPLOAD_BYTES } from './image-limits.js';
import { safeErrorCode } from '../errors/safe-error-code.js';

export interface StoredFile {
  stream: Readable;
  size: number;
}

export interface StoredImage {
  storagePath: string;
  mimeType: string;
  size: number;
}

type StorageDirectory = 'originals' | 'thumbnails';

const IMAGE_FORMATS: Readonly<
  Record<string, { extension: string; format: string }>
> = {
  'image/jpeg': { extension: '.jpg', format: 'jpeg' },
  'image/png': { extension: '.png', format: 'png' },
  'image/webp': { extension: '.webp', format: 'webp' },
};

const ASSET_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertAssetId(assetId: string): void {
  if (!ASSET_ID.test(assetId)) {
    throw new Error('Invalid asset identifier for storage');
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;

  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

@Injectable()
export class LocalStorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly storageRoot: string;

  constructor(config: ConfigService) {
    this.storageRoot = resolve(config.getOrThrow<string>('STORAGE_ROOT'));
  }

  async saveImage(
    assetId: string,
    mimeType: string,
    input: Readable,
    verifyComplete?: () => Promise<void>,
  ): Promise<StoredImage> {
    assertAssetId(assetId);

    const format = IMAGE_FORMATS[mimeType];

    if (!format) {
      throw new UnsupportedMediaTypeException('Unsupported image type');
    }

    const originals = await this.ensureDirectory('originals');
    const thumbnails = await this.ensureDirectory('thumbnails');

    const originalPath = join(originals, `${assetId}${format.extension}`);

    const thumbnailPath = join(thumbnails, `${assetId}.jpg`);

    const temporaryOriginal = join(
      originals,
      `${assetId}.${randomUUID()}.uploading`,
    );

    const temporaryThumbnail = join(
      thumbnails,
      `${assetId}.${randomUUID()}.uploading`,
    );

    let originalPublished = false;
    let thumbnailPublished = false;
    let streamedBytes = 0;

    try {
      const sizeLimit = new Transform({
        transform(chunk: Buffer | string, _encoding, callback) {
          streamedBytes += Buffer.byteLength(chunk);

          if (streamedBytes > MAX_UPLOAD_BYTES) {
            callback(new PayloadTooLargeException('File too large'));
          } else {
            callback(null, chunk);
          }
        },
      });

      await pipeline(
        input,
        sizeLimit,
        createWriteStream(temporaryOriginal, {
          flags: 'wx',
          mode: 0o600,
        }),
      );

      await verifyComplete?.();

      const fileStats = await stat(temporaryOriginal);

      if (fileStats.size === 0) {
        throw new UnsupportedMediaTypeException('Empty image file');
      }

      let metadata: Metadata;

      try {
        metadata = await sharp(temporaryOriginal, {
          limitInputPixels: MAX_IMAGE_PIXELS,
        }).metadata();
      } catch {
        throw new UnsupportedMediaTypeException('Invalid image data');
      }

      if (
        metadata.format !== format.format ||
        !metadata.width ||
        !metadata.height ||
        (metadata.pages ?? 1) > 1 ||
        metadata.width * metadata.height > MAX_IMAGE_PIXELS
      ) {
        throw new UnsupportedMediaTypeException('Invalid or unsupported image');
      }

      try {
        await sharp(temporaryOriginal, {
          limitInputPixels: MAX_IMAGE_PIXELS,
        })
          .rotate()
          .resize(300, 300, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .flatten({
            background: '#ffffff',
          })
          .jpeg({
            quality: 85,
          })
          .toFile(temporaryThumbnail);
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
        ) {
          throw error;
        }

        throw new UnsupportedMediaTypeException('Unable to decode image');
      }

      await chmod(temporaryThumbnail, 0o600);

      await link(temporaryOriginal, originalPath);
      originalPublished = true;

      await link(temporaryThumbnail, thumbnailPath);
      thumbnailPublished = true;

      return {
        storagePath: originalPath,
        mimeType,
        size: fileStats.size,
      };
    } catch (error: unknown) {
      const publishedCleanup = await Promise.allSettled([
        ...(thumbnailPublished ? [rm(thumbnailPath, { force: true })] : []),
        ...(originalPublished ? [rm(originalPath, { force: true })] : []),
      ]);

      const failedPublished = publishedCleanup.find(
        (result) => result.status === 'rejected',
      );

      if (failedPublished?.status === 'rejected') {
        this.logger.error(
          `Unable to remove files after failed upload; ${safeErrorCode(failedPublished.reason)}`,
        );
      }

      throw error;
    } finally {
      const temporaryCleanup = await Promise.allSettled([
        rm(temporaryOriginal, { force: true }),
        rm(temporaryThumbnail, { force: true }),
      ]);

      const failedTemporary = temporaryCleanup.find(
        (result) => result.status === 'rejected',
      );

      if (failedTemporary?.status === 'rejected') {
        this.logger.error(
          `Unable to remove temporary upload files; ${safeErrorCode(failedTemporary.reason)}`,
        );
      }
    }
  }

  async deleteImage(assetId: string, mimeType: string): Promise<void> {
    assertAssetId(assetId);

    const format = IMAGE_FORMATS[mimeType];

    if (!format) {
      return;
    }

    const originals = await this.ensureDirectory('originals');
    const thumbnails = await this.ensureDirectory('thumbnails');

    await Promise.all([
      rm(join(originals, `${assetId}${format.extension}`), {
        force: true,
      }),
      rm(join(thumbnails, `${assetId}.jpg`), {
        force: true,
      }),
    ]);
  }

  async openOriginal(
    assetId: string,
    mimeType: string,
    legacyStoragePath: string,
  ): Promise<StoredFile> {
    assertAssetId(assetId);

    const extension = IMAGE_FORMATS[mimeType]?.extension;

    if (!extension) {
      throw new NotFoundException('Asset file not found');
    }

    const filename = `${assetId}${extension}`;

    if (basename(legacyStoragePath) !== filename) {
      throw new NotFoundException('Asset file not found');
    }

    return this.openFile('originals', filename);
  }

  async openThumbnail(assetId: string): Promise<StoredFile> {
    assertAssetId(assetId);

    return this.openFile('thumbnails', `${assetId}.jpg`);
  }

  private async ensureDirectory(
    directoryName: StorageDirectory,
  ): Promise<string> {
    await mkdir(this.storageRoot, {
      recursive: true,
    });

    const root = await realpath(this.storageRoot);
    const expected = join(root, directoryName);

    await mkdir(expected, {
      recursive: true,
    });

    const directory = await realpath(expected);

    if (directory !== expected) {
      throw new Error('Invalid storage directory');
    }

    return directory;
  }

  private async openFile(
    directoryName: StorageDirectory,
    filename: string,
  ): Promise<StoredFile> {
    let handle: FileHandle | undefined;

    try {
      const root = await realpath(this.storageRoot);

      const directory = await realpath(join(root, directoryName));

      if (directory !== join(root, directoryName)) {
        throw new NotFoundException('Asset file not found');
      }

      const filePath = join(directory, filename);

      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);

      const stats = await handle.stat();

      if (!stats.isFile()) {
        throw new NotFoundException('Asset file not found');
      }

      return {
        stream: handle.createReadStream({
          autoClose: true,
        }),
        size: stats.size,
      };
    } catch (error: unknown) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }

      if (error instanceof NotFoundException || isMissingFileError(error)) {
        throw new NotFoundException('Asset file not found');
      }

      throw error;
    }
  }
}
