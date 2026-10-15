import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { LocalStorageService } from './local-storage.service.js';

const assetId = '550e8400-e29b-41d4-a716-446655440000';

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

describe('LocalStorageService', () => {
  let root: string;
  let service: LocalStorageService;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), 'saefr-storage-test-'),
    );

    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));

    const config = {
      get: (key: string) => {
        return key === 'STORAGE_ROOT' ? root : undefined;
      },
    } as unknown as ConfigService;

    service = new LocalStorageService(config);
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it('reads an existing original file', async () => {
    const content = Buffer.from('original image data');

    const path = join(
      root,
      'originals',
      `${assetId}.jpg`,
    );

    await writeFile(path, content);

    const file = await service.openOriginal(
      assetId,
      'image/jpeg',
      path,
    );

    expect(file.size).toBe(content.length);
    expect(await readStream(file.stream)).toEqual(content);
  });

  it('reads an existing thumbnail', async () => {
    const content = Buffer.from('thumbnail data');

    await writeFile(
      join(root, 'thumbnails', `${assetId}.jpg`),
      content,
    );

    const file = await service.openThumbnail(assetId);

    expect(file.size).toBe(content.length);
    expect(await readStream(file.stream)).toEqual(content);
  });

  it('returns 404 for a missing file', async () => {
    await expect(
      service.openThumbnail(assetId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects inconsistent legacy paths', async () => {
    await expect(
      service.openOriginal(
        assetId,
        'image/jpeg',
        '/another/location/unrelated.jpg',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects unsupported MIME types', async () => {
    await expect(
      service.openOriginal(
        assetId,
        'image/svg+xml',
        `/storage/originals/${assetId}.svg`,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not follow symbolic links to files', async () => {
    const otherFile = join(root, 'private.txt');

    await writeFile(otherFile, 'private data');

    const linkedFile = join(
      root,
      'originals',
      `${assetId}.jpg`,
    );

    await symlink(otherFile, linkedFile);

    await expect(
      service.openOriginal(
        assetId,
        'image/jpeg',
        linkedFile,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
