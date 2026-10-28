import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBindingVerifier } from './storage-binding.service.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import type { LogicalStorageTarget } from './storage-provider.js';

const target = (): LogicalStorageTarget => ({
  role: 'originals',
  assetId: randomUUID(),
  extension: '.jpg',
});

describe('local provider mechanics on synthetic private media', () => {
  let root: string;
  let verified: boolean;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-provider-'));
    await mkdir(join(root, 'originals'), { mode: 0o700 });
    await mkdir(join(root, 'thumbnails'), { mode: 0o700 });
    verified = true;
    const verifier = {
      assertVerified: vi.fn(async () => {
        if (!verified) throw new Error('Synthetic identity mismatch');
        return { storage_id: randomUUID() };
      }),
    } as unknown as StorageBindingVerifier;
    provider = new LocalStorageProvider(
      verifier,
      new ConfigService({ STORAGE_ROOT: root }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves exact bytes, creates private staging and never replaces a collision', async () => {
    const id = target();
    const bytes = Buffer.from([0, 255, 1, 254, 7]);
    const first = await provider.publish(
      id,
      randomUUID(),
      Readable.from([bytes]),
    );
    expect(first.status).toBe('published');
    if (first.status !== 'published') return;
    const names = await readdir(join(root, 'originals'));
    expect(names).toHaveLength(2);
    const stage = names.find((name) => name.endsWith('.uploading'));
    expect(stage).toBeDefined();
    expect((await stat(join(root, 'originals', stage!))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await readFile(join(root, 'originals', `${id.assetId}.jpg`)),
    ).toEqual(bytes);
    const collision = await provider.publish(
      id,
      randomUUID(),
      Readable.from([Buffer.from('replacement')]),
    );
    expect(collision.status).toBe('collision');
    expect(
      await readFile(join(root, 'originals', `${id.assetId}.jpg`)),
    ).toEqual(bytes);
    expect(await readdir(join(root, 'originals'))).toHaveLength(2);
    expect(await provider.releaseOwned(first.object)).toEqual({
      status: 'durable',
    });
    expect(await readdir(join(root, 'originals'))).toEqual([
      `${id.assetId}.jpg`,
    ]);
  });

  it('rejects truncated streams and failed staged sync without publishing', async () => {
    const id = target();
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('truncated');
      })(),
    );
    const sourceFailure = await provider.publish(id, randomUUID(), broken);
    expect(sourceFailure.status).toBe('input_error');
    expect(await readdir(join(root, 'originals'))).toEqual([]);

    class SyncFailure extends LocalStorageProvider {
      protected override async syncFile(): Promise<void> {
        throw new Error('synthetic fsync failure');
      }
    }
    const failing = new SyncFailure(
      { assertVerified: async () => ({}) } as StorageBindingVerifier,
      new ConfigService({ STORAGE_ROOT: root }),
    );
    expect(
      (
        await failing.publish(
          id,
          randomUUID(),
          Readable.from([Buffer.from('x')]),
        )
      ).status,
    ).toBe('unavailable');
    expect(await readdir(join(root, 'originals'))).toEqual([]);
  });

  it('retains possible publication after a lost sync acknowledgment', async () => {
    class DirectorySyncFailure extends LocalStorageProvider {
      protected override async syncDirectory(): Promise<void> {
        throw new Error('synthetic lost acknowledgment');
      }
    }
    const failing = new DirectorySyncFailure(
      { assertVerified: async () => ({}) } as StorageBindingVerifier,
      new ConfigService({ STORAGE_ROOT: root }),
    );
    const id = target();
    const result = await failing.publish(
      id,
      randomUUID(),
      Readable.from([Buffer.from('keep')]),
    );
    expect(result.status).toBe('uncertain');
    expect(result.object).toBeDefined();
    expect(
      await readFile(join(root, 'originals', `${id.assetId}.jpg`), 'utf8'),
    ).toBe('keep');
    expect(await readdir(join(root, 'originals'))).toHaveLength(2);
  });

  it('compensates only its own hard-linked object', async () => {
    const id = target();
    const result = await provider.publish(
      id,
      randomUUID(),
      Readable.from([Buffer.from('a')]),
    );
    expect(result.status).toBe('published');
    if (result.status !== 'published') return;
    const forged = { ...result.object, receiptId: randomUUID() };
    expect(await provider.compensateOwned(forged)).toMatchObject({
      status: 'unavailable',
    });
    expect(await provider.compensateOwned(result.object)).toEqual({
      status: 'removed',
      durable: true,
    });
    expect(await provider.compensateOwned(result.object)).toMatchObject({
      status: 'unavailable',
    });
    expect(await readdir(join(root, 'originals'))).toEqual([]);
  });

  it('does not remove a replacement target using an old attempt receipt', async () => {
    const id = target();
    const published = await provider.publish(
      id,
      randomUUID(),
      Readable.from([Buffer.from('first')]),
    );
    expect(published.status).toBe('published');
    if (published.status !== 'published') return;
    const path = join(root, 'originals', `${id.assetId}.jpg`);
    await rm(path);
    await writeFile(path, 'other attempt');
    expect((await provider.compensateOwned(published.object)).status).toBe(
      'unavailable',
    );
    expect(await readFile(path, 'utf8')).toBe('other attempt');
  });

  it('opens only verified regular files and distinguishes verified absence', async () => {
    const id = target();
    expect((await provider.open(id)).status).toBe('absent');
    await writeFile(join(root, 'originals', `${id.assetId}.jpg`), 'image');
    const opened = await provider.open(id);
    expect(opened.status).toBe('opened');
    if (opened.status === 'opened') {
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('image');
    }
    await rm(join(root, 'originals', `${id.assetId}.jpg`));
    await writeFile(join(root, 'synthetic-sentinel'), 'do not follow');
    await symlink(
      join(root, 'synthetic-sentinel'),
      join(root, 'originals', `${id.assetId}.jpg`),
    );
    expect((await provider.open(id)).status).toBe('unavailable');
    expect((await provider.removeExact(id)).status).toBe('unavailable');
  });

  it('removes exact targets repeat-safely only while binding is verified', async () => {
    const id = target();
    await writeFile(join(root, 'originals', `${id.assetId}.jpg`), 'image');
    expect(await provider.removeExact(id)).toEqual({
      status: 'removed',
      durable: true,
    });
    expect(await provider.removeExact(id)).toEqual({
      status: 'absent',
      durable: true,
    });
    verified = false;
    expect((await provider.removeExact(id)).status).toBe('unavailable');
    expect((await provider.open(id)).status).toBe('unavailable');
  });

  it('retries directory persistence after an unlink with lost sync acknowledgement', async () => {
    class OnceFailedSync extends LocalStorageProvider {
      private fail = true;

      protected override async syncDirectory(
        role: 'originals' | 'thumbnails',
      ): Promise<void> {
        if (this.fail) {
          this.fail = false;
          throw new Error('synthetic directory fsync failure');
        }
        await super.syncDirectory(role);
      }
    }
    const retrying = new OnceFailedSync(
      { assertVerified: async () => ({}) } as StorageBindingVerifier,
      new ConfigService({ STORAGE_ROOT: root }),
    );
    const id = target();
    await writeFile(join(root, 'originals', `${id.assetId}.jpg`), 'image');
    expect((await retrying.removeExact(id)).status).toBe('uncertain');
    expect(await retrying.removeExact(id)).toEqual({
      status: 'absent',
      durable: true,
    });
  });

  it('refuses missing role directories without recreating them', async () => {
    await rm(join(root, 'originals'), { recursive: true });
    expect(
      (
        await provider.publish(
          target(),
          randomUUID(),
          Readable.from([Buffer.from('x')]),
        )
      ).status,
    ).toBe('unavailable');
    expect(await readdir(root)).toEqual(['thumbnails']);
  });

  it('never follows a substituted parent path after pinning the role directory', async () => {
    const id = target();
    const originalDirectory = join(root, 'originals');
    const detachedDirectory = join(root, 'detached-originals');
    const replacementDirectory = join(root, 'replacement');
    await mkdir(replacementDirectory);
    class SwappedParent extends LocalStorageProvider {
      protected override async linkStage(stage: string, destination: string) {
        await rename(originalDirectory, detachedDirectory);
        await symlink(replacementDirectory, originalDirectory);
        await super.linkStage(stage, destination);
      }
    }
    const swapped = new SwappedParent(
      {
        assertVerified: async (pinned?: {
          directory: { stat(): Promise<{ dev: number; ino: number }> };
        }) => {
          if (pinned) {
            const actual = await lstat(originalDirectory);
            const opened = await pinned.directory.stat();
            if (
              actual.isSymbolicLink() ||
              actual.dev !== opened.dev ||
              actual.ino !== opened.ino
            ) {
              throw new Error('Synthetic binding changed');
            }
          }
          return {};
        },
      } as StorageBindingVerifier,
      new ConfigService({ STORAGE_ROOT: root }),
    );
    const result = await swapped.publish(
      id,
      randomUUID(),
      Readable.from([Buffer.from('original bytes')]),
    );
    expect(result.status).toBe('uncertain');
    expect(await readdir(replacementDirectory)).toEqual([]);
    expect(
      await readFile(join(detachedDirectory, `${id.assetId}.jpg`), 'utf8'),
    ).toBe('original bytes');
  });
});
