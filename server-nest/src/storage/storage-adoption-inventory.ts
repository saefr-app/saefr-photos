import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';

import { roleLocation } from './storage-marker.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EXTENSION = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
} as const;

export interface HistoricalAssetRow {
  readonly id: string;
  readonly mime_type: string;
  readonly size: number;
  readonly storage_path: string;
}

export interface HistoricalAdoptionManifest {
  readonly version: 1;
  /** Explicitly reviewed historical directories, never opened by this check. */
  readonly recordedOriginalRoots: readonly string[];
  readonly assets: readonly {
    readonly id: string;
    readonly originalSha256: string;
    readonly thumbnailSha256: string;
  }[];
}

function unavailable(): Error {
  return new Error('Historical storage pairing unavailable');
}

async function pin(location: string): Promise<FileHandle> {
  let cursor = '/';
  for (const part of location.split('/').filter(Boolean)) {
    cursor = posix.join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
  }
  return open(
    location,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

async function hashFile(
  directory: FileHandle,
  name: string,
): Promise<{
  digest: string;
  size: number;
}> {
  const handle = await open(
    `/proc/self/fd/${directory.fd}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1) throw unavailable();
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    return { digest: hash.digest('hex'), size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Read-only, fail-closed synthetic/operator preflight. A matching manifest is
 * necessary, never sufficient: human-reviewed database/media provenance,
 * stopped writers, backups and physical observation remain separate gates.
 * This function does not write markers, adopt storage or mutate SQL.
 */
export async function assertHistoricalInventory(
  root: string,
  rows: readonly HistoricalAssetRow[],
  manifest: HistoricalAdoptionManifest,
): Promise<void> {
  let originals: FileHandle | undefined;
  let thumbnails: FileHandle | undefined;
  try {
    if (
      process.platform !== 'linux' ||
      manifest.version !== 1 ||
      manifest.recordedOriginalRoots.length === 0 ||
      manifest.recordedOriginalRoots.some(
        (value) =>
          !posix.isAbsolute(value) ||
          posix.normalize(value) !== value ||
          value.endsWith('/'),
      ) ||
      rows.length === 0 ||
      rows.length !== manifest.assets.length
    )
      throw unavailable();

    const expectedOriginals: string[] = [];
    const expectedThumbnails: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const entry = manifest.assets[index];
      const extension = EXTENSION[row.mime_type as keyof typeof EXTENSION];
      if (
        !UUID.test(row.id) ||
        seen.has(row.id) ||
        entry.id !== row.id ||
        !DIGEST.test(entry.originalSha256) ||
        !DIGEST.test(entry.thumbnailSha256) ||
        !extension ||
        !Number.isInteger(row.size) ||
        row.size < 1 ||
        posix.basename(row.storage_path) !== `${row.id}${extension}` ||
        !manifest.recordedOriginalRoots.includes(
          posix.dirname(row.storage_path),
        )
      )
        throw unavailable();
      seen.add(row.id);
      expectedOriginals.push(`${row.id}${extension}`);
      expectedThumbnails.push(`${row.id}.jpg`);
    }

    const originalLocation = roleLocation(root, process.cwd(), 'originals');
    const thumbnailLocation = roleLocation(root, process.cwd(), 'thumbnails');
    originals = await pin(originalLocation);
    thumbnails = await pin(thumbnailLocation);
    const [actualOriginals, actualThumbnails] = await Promise.all([
      readdir(`/proc/self/fd/${originals.fd}`),
      readdir(`/proc/self/fd/${thumbnails.fd}`),
    ]);
    if (
      JSON.stringify(actualOriginals.sort()) !==
        JSON.stringify([...expectedOriginals].sort()) ||
      JSON.stringify(actualThumbnails.sort()) !==
        JSON.stringify([...expectedThumbnails].sort())
    )
      throw unavailable();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const entry = manifest.assets[index];
      const original = await hashFile(originals, expectedOriginals[index]);
      const thumbnail = await hashFile(thumbnails, expectedThumbnails[index]);
      if (
        original.size !== row.size ||
        original.digest !== entry.originalSha256 ||
        thumbnail.digest !== entry.thumbnailSha256
      )
        throw unavailable();
    }
    for (const [location, handle] of [
      [originalLocation, originals],
      [thumbnailLocation, thumbnails],
    ] as const) {
      const current = await lstat(location);
      const opened = await handle.stat();
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      )
        throw unavailable();
    }
  } catch {
    throw unavailable();
  } finally {
    await Promise.all([originals?.close(), thumbnails?.close()]);
  }
}
