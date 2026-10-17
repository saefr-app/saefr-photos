import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { link, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp, { type Metadata } from 'sharp';

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

const MAX_IMAGE_PIXELS = 40_000_000;

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;

  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

@Injectable()
export class LocalStorageService {
  private readonly storageRoot: string;

  constructor(config: ConfigService) {
    this.storageRoot = resolve(config.getOrThrow<string>('STORAGE_ROOT'));
  }

  async saveImage(
    assetId: string,
    mimeType: string,
    input: Readable,
  ): Promise<StoredImage> {
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

    try {
      await pipeline(
        input,
        createWriteStream(temporaryOriginal, {
          flags: 'wx',
        }),
      );

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
      if (thumbnailPublished) {
        await rm(thumbnailPath, { force: true }).catch(() => undefined);
      }

      if (originalPublished) {
        await rm(originalPath, { force: true }).catch(() => undefined);
      }

      throw error;
    } finally {
      await Promise.allSettled([
        rm(temporaryOriginal, { force: true }),
        rm(temporaryThumbnail, { force: true }),
      ]);
    }
  }

  async deleteImage(assetId: string, mimeType: string): Promise<void> {
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

      const directory = await realpath(join(this.storageRoot, directoryName));

      const relativeDirectory = relative(root, directory);

      if (
        relativeDirectory === '..' ||
        relativeDirectory.startsWith(`..${sep}`) ||
        isAbsolute(relativeDirectory)
      ) {
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
