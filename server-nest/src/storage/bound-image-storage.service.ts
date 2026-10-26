import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { Readable } from 'node:stream';

import {
  BadRequestException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

import type { AssetImageStorage } from '../assets/assets.service.js';
import { MAX_IMAGE_PIXELS } from './image-limits.js';
import { roleLocation } from './storage-marker.js';
import type {
  LogicalStorageTarget,
  PublishedObject,
  StorageProvider,
} from './storage-provider.js';

const FORMATS = {
  'image/jpeg': { extension: '.jpg', format: 'jpeg' },
  'image/png': { extension: '.png', format: 'png' },
  'image/webp': { extension: '.webp', format: 'webp' },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Provider-backed version of the M11 image surface. Deliberately not mounted:
 * no native observer/profile is certified and M12 startup remains refused.
 */
export class BoundImageStorageService implements AssetImageStorage {
  private readonly attempts = new Map<string, readonly PublishedObject[]>();

  constructor(
    private readonly provider: StorageProvider,
    private readonly config: ConfigService,
  ) {}

  async saveImage(
    assetId: string,
    mimeType: string,
    input: Readable,
    verifyComplete?: () => Promise<void>,
  ): Promise<{ storagePath: string; mimeType: string; size: number }> {
    if (!UUID.test(assetId))
      throw new BadRequestException('Invalid asset identifier');
    const format = FORMATS[mimeType as keyof typeof FORMATS];
    if (!format)
      throw new UnsupportedMediaTypeException('Unsupported image type');

    const original: LogicalStorageTarget = {
      role: 'originals',
      assetId,
      extension: format.extension,
    };
    const thumbnail: LogicalStorageTarget = {
      role: 'thumbnails',
      assetId,
      extension: '.jpg',
    };
    let validationError: unknown;
    let thumbnailBytes: Buffer | undefined;

    const attemptId = randomUUID();
    const first = await this.provider.publish(
      original,
      attemptId,
      input,
      async (bytes) => {
        try {
          await verifyComplete?.();
          const metadata = await sharp(bytes, {
            limitInputPixels: MAX_IMAGE_PIXELS,
          }).metadata();
          if (
            metadata.format !== format.format ||
            !metadata.width ||
            !metadata.height ||
            (metadata.pages ?? 1) > 1 ||
            metadata.width * metadata.height > MAX_IMAGE_PIXELS
          ) {
            throw new UnsupportedMediaTypeException(
              'Invalid or unsupported image',
            );
          }
          thumbnailBytes = await sharp(bytes, {
            limitInputPixels: MAX_IMAGE_PIXELS,
          })
            .rotate()
            .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch (error: unknown) {
          validationError =
            error instanceof HttpException
              ? error
              : new UnsupportedMediaTypeException('Invalid image data');
          throw validationError;
        }
      },
    );
    if (validationError) throw validationError;
    if (first.status === 'too_large') {
      throw new PayloadTooLargeException('File too large');
    }
    if (first.status !== 'published' || !thumbnailBytes) {
      throw new ServiceUnavailableException('Storage unavailable');
    }

    const second = await this.provider.publish(
      thumbnail,
      attemptId,
      Readable.from([thumbnailBytes]),
    );
    if (second.status !== 'published') {
      if (second.status === 'unavailable' || second.status === 'collision') {
        // Only a known non-publication may compensate the original. Unknown
        // thumbnail publication retains both possible targets for recovery.
        await this.provider.compensateOwned(first.object);
      }
      throw new ServiceUnavailableException('Storage unavailable');
    }
    this.attempts.set(assetId, [first.object, second.object]);
    const location = roleLocation(
      this.config.getOrThrow<string>('STORAGE_ROOT'),
      process.cwd(),
      'originals',
    );
    return {
      storagePath: posix.join(location, `${assetId}${format.extension}`),
      mimeType,
      size: first.object.byteLength,
    };
  }

  async deleteImage(assetId: string): Promise<void> {
    const receipts = this.attempts.get(assetId);
    if (!receipts) throw new ServiceUnavailableException('Storage unavailable');
    for (const receipt of [...receipts].reverse()) {
      const outcome = await this.provider.compensateOwned(receipt);
      if (outcome.status !== 'removed' || !outcome.durable) {
        throw new ServiceUnavailableException('Storage unavailable');
      }
    }
    this.attempts.delete(assetId);
  }

  async finalizeImage(assetId: string): Promise<void> {
    const receipts = this.attempts.get(assetId);
    if (!receipts) return;
    for (const receipt of receipts) {
      const outcome = await this.provider.releaseOwned(receipt);
      if (outcome.status !== 'durable') {
        throw new ServiceUnavailableException('Storage unavailable');
      }
    }
    this.attempts.delete(assetId);
  }

  async openOriginal(
    assetId: string,
    mimeType: string,
    legacyStoragePath: string,
  ) {
    const format = FORMATS[mimeType as keyof typeof FORMATS];
    if (!format || !UUID.test(assetId))
      throw new NotFoundException('Asset file not found');
    if (basename(legacyStoragePath) !== `${assetId}${format.extension}`) {
      throw new NotFoundException('Asset file not found');
    }
    return this.open({
      role: 'originals',
      assetId,
      extension: format.extension,
    });
  }

  async openThumbnail(assetId: string) {
    if (!UUID.test(assetId))
      throw new NotFoundException('Asset file not found');
    return this.open({ role: 'thumbnails', assetId, extension: '.jpg' });
  }

  private async open(target: LogicalStorageTarget) {
    const result = await this.provider.open(target);
    if (result.status === 'opened')
      return { stream: result.stream, size: result.size };
    if (result.status === 'absent')
      throw new NotFoundException('Asset file not found');
    throw new ServiceUnavailableException('Storage unavailable');
  }
}
