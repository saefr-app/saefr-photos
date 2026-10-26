import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertHistoricalInventory,
  type HistoricalAdoptionManifest,
  type HistoricalAssetRow,
} from './storage-adoption-inventory.js';

const digest = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');

describe('historical adoption inventory gate on synthetic media', () => {
  let root: string;
  let row: HistoricalAssetRow;
  let manifest: HistoricalAdoptionManifest;
  let original: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-adoption-'));
    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));
    const id = randomUUID();
    original = Buffer.from('synthetic original');
    const thumbnail = Buffer.from('synthetic thumbnail');
    await writeFile(join(root, 'originals', `${id}.jpg`), original);
    await writeFile(join(root, 'thumbnails', `${id}.jpg`), thumbnail);
    row = {
      id,
      mime_type: 'image/jpeg',
      size: original.length,
      storage_path: `/reviewed/old/originals/${id}.jpg`,
    };
    manifest = {
      version: 1,
      recordedOriginalRoots: ['/reviewed/old/originals'],
      assets: [
        {
          id,
          originalSha256: digest(original),
          thumbnailSha256: digest(thumbnail),
        },
      ],
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('matches a complete reviewed inventory without accessing historical paths', async () => {
    await expect(
      assertHistoricalInventory(root, [row], manifest),
    ).resolves.toBeUndefined();
  });

  it('rejects an omitted row, unreviewed historical root and wrong metadata', async () => {
    await expect(
      assertHistoricalInventory(root, [], manifest),
    ).rejects.toThrow();
    await expect(
      assertHistoricalInventory(root, [row], {
        ...manifest,
        recordedOriginalRoots: ['/different/originals'],
      }),
    ).rejects.toThrow();
    await expect(
      assertHistoricalInventory(
        root,
        [{ ...row, size: row.size + 1 }],
        manifest,
      ),
    ).rejects.toThrow();
  });

  it('rejects copied names with changed bytes and unexpected files', async () => {
    await writeFile(join(root, 'originals', `${row.id}.jpg`), 'replacement');
    await expect(
      assertHistoricalInventory(root, [row], manifest),
    ).rejects.toThrow();
    await writeFile(join(root, 'originals', `${row.id}.jpg`), original);
    await writeFile(join(root, 'originals', 'unowned.jpg'), 'unreviewed');
    await expect(
      assertHistoricalInventory(root, [row], manifest),
    ).rejects.toThrow();
  });

  it('rejects missing thumbnails and symlinked media', async () => {
    await rm(join(root, 'thumbnails', `${row.id}.jpg`));
    await expect(
      assertHistoricalInventory(root, [row], manifest),
    ).rejects.toThrow();
    await symlink(
      join(root, 'originals', `${row.id}.jpg`),
      join(root, 'thumbnails', `${row.id}.jpg`),
    );
    await expect(
      assertHistoricalInventory(root, [row], manifest),
    ).rejects.toThrow();
  });
});
