import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { LocalStorageService } from './local-storage.service.js';
import { MAX_UPLOAD_BYTES } from './image-limits.js';

const assetId = '550e8400-e29b-41d4-a716-446655440000';

describe('LocalStorageService image uploads', () => {
  let root: string;
  let storage: LocalStorageService;
  let image: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-upload-test-'));

    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));

    storage = new LocalStorageService(
      new ConfigService({ STORAGE_ROOT: root }),
    );

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
    expect((await stat(stored.storagePath)).mode & 0o777).toBe(0o600);

    const thumbnail = await sharp(
      join(root, 'thumbnails', `${assetId}.jpg`),
    ).metadata();

    expect(thumbnail.format).toBe('jpeg');
    expect(thumbnail.width).toBeLessThanOrEqual(300);
    expect(thumbnail.height).toBeLessThanOrEqual(300);
    expect(
      (await stat(join(root, 'thumbnails', `${assetId}.jpg`))).mode & 0o777,
    ).toBe(0o600);

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

  it('removes partial temporary files when the upload stream fails', async () => {
    async function* brokenUpload() {
      yield image.subarray(0, 100);
      throw new Error('Upload stream interrupted');
    }

    await expect(
      storage.saveImage(assetId, 'image/jpeg', Readable.from(brokenUpload())),
    ).rejects.toThrow('Upload stream interrupted');

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('does not publish until the complete multipart request is verified', async () => {
    await expect(
      storage.saveImage(
        assetId,
        'image/jpeg',
        Readable.from([image]),
        async () => {
          throw new Error('Multipart body ended early');
        },
      ),
    ).rejects.toThrow('Multipart body ended early');

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('enforces the byte limit even without the HTTP interceptor', async () => {
    await expect(
      storage.saveImage(
        assetId,
        'image/jpeg',
        Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES + 1)]),
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('preserves an existing original when an asset ID collides', async () => {
    const existing = join(root, 'originals', `${assetId}.jpg`);
    const sentinel = Buffer.from('pre-existing original');
    await writeFile(existing, sentinel);

    await expect(
      storage.saveImage(assetId, 'image/jpeg', Readable.from([image])),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(existing)).toEqual(sentinel);
    expect(await readdir(join(root, 'originals'))).toEqual([`${assetId}.jpg`]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('preserves an existing thumbnail and rolls back its new original', async () => {
    const existing = join(root, 'thumbnails', `${assetId}.jpg`);
    const sentinel = Buffer.from('pre-existing thumbnail');
    await writeFile(existing, sentinel);

    await expect(
      storage.saveImage(assetId, 'image/jpeg', Readable.from([image])),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(existing)).toEqual(sentinel);
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([`${assetId}.jpg`]);
  });

  it('fails on corrupt PNG pixel data after metadata inspection and cleans up', async () => {
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: '#336699',
      },
    })
      .png()
      .toBuffer();
    const corrupted = Buffer.from(png);
    const idat = corrupted.indexOf(Buffer.from('IDAT'));
    expect(idat).toBeGreaterThan(0);
    corrupted[idat + 4] ^= 0xff;

    expect((await sharp(corrupted).metadata()).format).toBe('png');

    await expect(
      storage.saveImage(assetId, 'image/png', Readable.from([corrupted])),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('does not write through a substituted storage directory', async () => {
    const alternate = join(root, 'alternate');
    await mkdir(alternate);
    await rm(join(root, 'originals'), { recursive: true });
    await symlink(alternate, join(root, 'originals'));

    await expect(
      storage.saveImage(assetId, 'image/jpeg', Readable.from([image])),
    ).rejects.toThrow('Invalid storage directory');

    expect(await readdir(alternate)).toEqual([]);
  });

  it('fails safely when the configured storage root is a regular file', async () => {
    const blocked = join(root, 'blocked');
    const sentinel = Buffer.from('not a directory');
    await writeFile(blocked, sentinel);
    const blockedStorage = new LocalStorageService(
      new ConfigService({ STORAGE_ROOT: blocked }),
    );

    await expect(
      blockedStorage.saveImage(assetId, 'image/jpeg', Readable.from([image])),
    ).rejects.toThrow();

    expect(await readFile(blocked)).toEqual(sentinel);
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
