import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { LocalStorageService } from './local-storage.service.js';

const assetId = '550e8400-e29b-41d4-a716-446655440000';

describe('LocalStorageService image uploads', () => {
  let root: string;
  let storage: LocalStorageService;
  let image: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-upload-test-'));

    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));

    const config = {
      get: (key: string) => (key === 'STORAGE_ROOT' ? root : undefined),
    } as unknown as ConfigService;

    storage = new LocalStorageService(config);

    image = await sharp({
      create: {
        width: 640,
        height: 400,
        channels: 3,
        background: '#336699',
      },
    })
      .jpeg()
      .toBuffer();
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it('preserves originals and generates thumbnails', async () => {
    const stored = await storage.saveImage(
      assetId,
      'image/jpeg',
      Readable.from([image]),
    );

    expect(stored.size).toBe(image.length);
    expect(stored.mimeType).toBe('image/jpeg');

    const original = await readFile(stored.storagePath);

    expect(original).toEqual(image);

    const thumbnail = await sharp(
      join(root, 'thumbnails', `${assetId}.jpg`),
    ).metadata();

    expect(thumbnail.format).toBe('jpeg');
    expect(thumbnail.width).toBeLessThanOrEqual(300);
    expect(thumbnail.height).toBeLessThanOrEqual(300);

    expect((await readdir(join(root, 'originals'))).length).toBe(1);

    expect((await readdir(join(root, 'thumbnails'))).length).toBe(1);
  });

  it('rejects MIME type mismatches and cleans up', async () => {
    await expect(
      storage.saveImage(assetId, 'image/png', Readable.from([image])),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('rejects invalid image bytes and cleans up', async () => {
    await expect(
      storage.saveImage(
        assetId,
        'image/jpeg',
        Readable.from([Buffer.from('not an image')]),
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('deletes newly stored files when requested', async () => {
    const stored = await storage.saveImage(
      assetId,
      'image/jpeg',
      Readable.from([image]),
    );

    expect(stored.size).toBeGreaterThan(0);

    await storage.deleteImage(assetId, 'image/jpeg');

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });
});
