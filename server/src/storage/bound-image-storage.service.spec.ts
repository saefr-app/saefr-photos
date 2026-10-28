import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetsService } from '../assets/assets.service.js';
import type { AssetsRepository } from '../assets/assets.repository.js';
import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import type { StorageBindingVerifier } from './storage-binding.service.js';
import { BoundImageStorageService } from './bound-image-storage.service.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { MAX_UPLOAD_BYTES } from './image-limits.js';

describe('provider-backed M11 image surface on synthetic storage', () => {
  let root: string;
  let service: BoundImageStorageService;
  let original: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-bound-storage-'));
    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));
    const config = new ConfigService({ STORAGE_ROOT: root });
    const provider = new LocalStorageProvider(
      { assertVerified: async () => ({}) } as StorageBindingVerifier,
      config,
    );
    service = new BoundImageStorageService(provider, config);
    original = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#527aac' },
    })
      .jpeg()
      .toBuffer();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes the exact original bytes and a bounded thumbnail, then releases staging', async () => {
    const id = randomUUID();
    const stored = await service.saveImage(
      id,
      'image/jpeg',
      Readable.from([original]),
    );
    expect(stored.size).toBe(original.length);
    expect(await readFile(stored.storagePath)).toEqual(original);
    const thumb = await readFile(join(root, 'thumbnails', `${id}.jpg`));
    expect((await sharp(thumb).metadata()).format).toBe('jpeg');
    const opened = await service.openOriginal(
      id,
      'image/jpeg',
      stored.storagePath,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(original);
    await service.finalizeImage(id);
    expect(await readdir(join(root, 'originals'))).toEqual([`${id}.jpg`]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([`${id}.jpg`]);
  });

  it('compensates only receipts from the current attempt after a known rollback', async () => {
    const id = randomUUID();
    await service.saveImage(id, 'image/jpeg', Readable.from([original]));
    await service.deleteImage(id);
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('rejects invalid data and truncated multipart verification before publication', async () => {
    const id = randomUUID();
    await expect(
      service.saveImage(
        id,
        'image/jpeg',
        Readable.from([Buffer.from('invalid')]),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.saveImage(
        id,
        'image/jpeg',
        Readable.from([original]),
        async () => {
          throw new BadRequestException('Incomplete multipart request');
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('preserves empty-image and unexpected verification errors without publishing', async () => {
    await expect(
      service.saveImage(randomUUID(), 'image/jpeg', Readable.from([])),
    ).rejects.toMatchObject({ status: 415 });
    const internal = new Error('private parser detail');
    await expect(
      service.saveImage(
        randomUUID(),
        'image/jpeg',
        Readable.from([original]),
        async () => {
          throw internal;
        },
      ),
    ).rejects.toBe(internal);
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('rejects an oversized stream before publishing either rendition', async () => {
    await expect(
      service.saveImage(
        randomUUID(),
        'image/jpeg',
        Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES + 1)]),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('retains potentially committed media after an unknown PostgreSQL outcome', async () => {
    const actor: AuthenticatedActor = {
      userId: randomUUID(),
      username: 'synthetic',
      role: 'user',
      sessionId: randomUUID(),
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      passwordChangeRequired: false,
      csrfToken: Buffer.alloc(32),
    };
    const repository = {
      assertIdAvailableForPublication: async () => undefined,
      createForActor: async () => ({
        status: 'uncertain',
        error: new Error('private PostgreSQL detail'),
      }),
    } as unknown as AssetsRepository;
    await expect(
      new AssetsService(repository, service).upload(actor, {
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([original]),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await readdir(join(root, 'originals'))).toHaveLength(2);
    expect(await readdir(join(root, 'thumbnails'))).toHaveLength(2);
  });
});
