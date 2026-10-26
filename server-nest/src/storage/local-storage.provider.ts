import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ConfigService } from '@nestjs/config';

import { MAX_UPLOAD_BYTES } from './image-limits.js';
import { StorageBindingVerifier } from './storage-binding.service.js';
import { roleLocation, type StorageRole } from './storage-marker.js';
import type {
  LogicalStorageTarget,
  OpenOutcome,
  PersistenceOutcome,
  PublicationOutcome,
  PublishedObject,
  RemovalOutcome,
  StorageProvider,
} from './storage-provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface OwnedStage {
  readonly receipt: PublishedObject;
  readonly stageName: string;
  readonly targetName: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

class StorageInputTooLarge extends Error {}

/**
 * Local layout-1 mechanics. The binding verifier is mandatory and must use a
 * certified physical observer before this class can be mounted in production.
 * Synthetic observers are for isolated conformance tests only. This provider
 * assumes exclusive application ownership of the verified directory namespace.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly capabilities = {
    // Mechanics are implemented, but the injected observer has no certified
    // native implementation. Do not advertise a usable storage profile.
    bindingObservation: false,
    exclusiveStaging: true,
    noReplacePublication: true,
    regularFileOpen: true,
    exactRemoval: true,
    authoritativeAbsence: true,
    deletionDurability: false,
  } as const;

  private readonly owned = new Map<string, OwnedStage>();

  constructor(
    private readonly verifier: StorageBindingVerifier,
    private readonly config: ConfigService,
  ) {}

  verifyBinding() {
    return this.verifier.assertVerified();
  }

  private name(target: LogicalStorageTarget): string {
    if (
      !UUID.test(target.assetId) ||
      !['.jpg', '.png', '.webp'].includes(target.extension) ||
      (target.role !== 'originals' && target.role !== 'thumbnails') ||
      (target.role === 'thumbnails' && target.extension !== '.jpg')
    ) {
      throw new Error('Invalid logical storage target');
    }
    return `${target.assetId}${target.extension}`;
  }

  private directory(role: StorageRole): string {
    return roleLocation(
      this.config.getOrThrow<string>('STORAGE_ROOT'),
      process.cwd(),
      role,
    );
  }

  private async pin(role: StorageRole): Promise<FileHandle> {
    // All I/O below uses /proc/self/fd for this pinned directory. A renamed
    // ancestor cannot redirect a later file operation into a different root.
    const directory = this.directory(role);
    let cursor = '/';
    for (const part of directory.split('/').filter(Boolean)) {
      cursor = posix.join(cursor, part);
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Storage path unavailable');
    }
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await this.verifier.assertVerified({ role, directory: handle });
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private pinnedPath(directory: FileHandle, name: string): string {
    return `/proc/self/fd/${directory.fd}/${name}`;
  }

  private async recheck(
    role: StorageRole,
    directory: FileHandle,
  ): Promise<void> {
    await this.verifier.assertVerified({ role, directory });
  }

  protected async syncFile(handle: FileHandle): Promise<void> {
    await handle.sync();
  }

  protected async syncDirectory(
    role: StorageRole,
    directory?: FileHandle,
  ): Promise<void> {
    if (directory) return directory.sync();
    const pinned = await this.pin(role);
    try {
      await pinned.sync();
    } finally {
      await pinned.close();
    }
  }

  protected async linkStage(stage: string, target: string): Promise<void> {
    await link(stage, target);
  }

  protected async unlinkPath(path: string): Promise<void> {
    await unlink(path);
  }

  async publish(
    target: LogicalStorageTarget,
    attemptId: string,
    source: Readable,
    beforePublish?: (bytes: Buffer) => Promise<void>,
  ): Promise<PublicationOutcome> {
    if (!UUID.test(attemptId)) return { status: 'unavailable', durable: false };
    let stage: string | undefined;
    let directory: FileHandle | undefined;
    let linkAttempted = false;
    let object: PublishedObject | undefined;
    let inputError: unknown;
    let emptyInput = false;
    try {
      const destinationName = this.name(target);
      directory = await this.pin(target.role);
      const destination = this.pinnedPath(directory, destinationName);
      const stageName = `.${target.assetId}.${attemptId}.${randomUUID()}.uploading`;
      stage = this.pinnedPath(directory, stageName);
      const handle = await open(
        stage,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
              callback(new StorageInputTooLarge());
              return;
            }
            if (beforePublish) chunks.push(Buffer.from(chunk));
            callback(null, chunk);
          },
        });
        const destinationStream = handle.createWriteStream({ autoClose: true });
        let firstFault: 'source' | 'destination' | undefined;
        let sourcePremature = false;
        source.once('error', () => {
          firstFault ??= 'source';
        });
        source.once('close', () => {
          if (!source.readableEnded) sourcePremature = true;
        });
        destinationStream.once('error', () => {
          firstFault ??= 'destination';
        });
        try {
          await pipeline(source, limit, destinationStream);
        } catch (error) {
          // A source/parser failure is distinct from a filesystem write
          // failure. Retain the former only for internal HTTP classification.
          if (
            (firstFault === 'source' ||
              (sourcePremature && firstFault !== 'destination')) &&
            !(error instanceof StorageInputTooLarge)
          ) {
            inputError = error;
          }
          throw error;
        }
        if (size === 0) {
          emptyInput = true;
          throw new Error('Empty storage input');
        }
        if (beforePublish) {
          try {
            await beforePublish(Buffer.concat(chunks));
          } catch (error) {
            inputError = error;
            throw error;
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      const syncHandle = await open(
        stage,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await this.syncFile(syncHandle);
      } finally {
        await syncHandle.close();
      }
      await this.recheck(target.role, directory);
      object = {
        target,
        attemptId,
        byteLength: size,
        receiptId: randomUUID(),
      };
      this.owned.set(object.receiptId, {
        receipt: object,
        stageName,
        targetName: destinationName,
      });
      linkAttempted = true;
      await this.linkStage(stage, destination);
      await this.syncDirectory(target.role, directory);
      await this.recheck(target.role, directory);
      return { status: 'published', object, durable: true };
    } catch (error: unknown) {
      source.destroy();
      if (
        linkAttempted &&
        (error as NodeJS.ErrnoException)?.code !== 'EEXIST'
      ) {
        return { status: 'uncertain', object, durable: false };
      }
      if (object) this.owned.delete(object.receiptId);
      if (stage) {
        try {
          await this.unlinkPath(stage);
        } catch (cleanupError) {
          if (!missing(cleanupError))
            return { status: 'uncertain', durable: false };
        }
      }
      if (emptyInput) return { status: 'empty_input', durable: false };
      if (inputError !== undefined)
        return { status: 'input_error', error: inputError, durable: false };
      return {
        status:
          error instanceof StorageInputTooLarge
            ? 'too_large'
            : (error as NodeJS.ErrnoException)?.code === 'EEXIST'
              ? 'collision'
              : 'unavailable',
        durable: false,
      };
    } finally {
      await directory?.close();
    }
  }

  async open(target: LogicalStorageTarget): Promise<OpenOutcome> {
    let handle: FileHandle | undefined;
    let directory: FileHandle | undefined;
    try {
      const name = this.name(target);
      directory = await this.pin(target.role);
      const path = this.pinnedPath(directory, name);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile())
        throw new Error('Storage target is not a regular file');
      await this.recheck(target.role, directory);
      return {
        status: 'opened',
        stream: handle.createReadStream({ autoClose: true }),
        size: info.size,
      };
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (missing(error)) {
        try {
          if (!directory) throw error;
          await this.recheck(target.role, directory);
          return { status: 'absent' };
        } catch {
          return { status: 'unavailable' };
        }
      }
      return { status: 'unavailable' };
    } finally {
      await directory?.close();
    }
  }

  async removeExact(target: LogicalStorageTarget): Promise<RemovalOutcome> {
    let removalAttempted = false;
    let directory: FileHandle | undefined;
    try {
      const name = this.name(target);
      directory = await this.pin(target.role);
      const path = this.pinnedPath(directory, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) {
          return { status: 'unavailable', durable: false };
        }
      } catch (error) {
        if (!missing(error)) throw error;
        // A prior attempt may have unlinked the target but lost its directory
        // sync acknowledgment. Repeat-safe absence still requires fsync.
        await this.syncDirectory(target.role, directory);
        await this.recheck(target.role, directory);
        return { status: 'absent', durable: true };
      }
      try {
        removalAttempted = true;
        await this.unlinkPath(path);
      } catch (error) {
        if (!missing(error)) return { status: 'uncertain', durable: false };
      }
      await this.syncDirectory(target.role, directory);
      await this.recheck(target.role, directory);
      return { status: 'removed', durable: true };
    } catch {
      return {
        status: removalAttempted ? 'uncertain' : 'unavailable',
        durable: false,
      };
    } finally {
      await directory?.close();
    }
  }

  async confirmDirectoryPersistence(
    role: StorageRole,
  ): Promise<PersistenceOutcome> {
    try {
      const directory = await this.pin(role);
      try {
        await this.syncDirectory(role, directory);
        await this.recheck(role, directory);
      } finally {
        await directory.close();
      }
      return { status: 'durable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private ownedStage(receipt: PublishedObject): OwnedStage | undefined {
    const entry = this.owned.get(receipt.receiptId);
    return entry?.receipt === receipt ? entry : undefined;
  }

  private async sameFile(
    entry: OwnedStage,
    directory: FileHandle,
  ): Promise<boolean> {
    const [stage, target] = await Promise.all([
      lstat(this.pinnedPath(directory, entry.stageName)),
      lstat(this.pinnedPath(directory, entry.targetName)),
    ]);
    return (
      stage.isFile() &&
      target.isFile() &&
      stage.dev === target.dev &&
      stage.ino === target.ino &&
      stage.nlink >= 2
    );
  }

  async compensateOwned(receipt: PublishedObject): Promise<RemovalOutcome> {
    const entry = this.ownedStage(receipt);
    if (!entry) return { status: 'unavailable', durable: false };
    let directory: FileHandle | undefined;
    try {
      directory = await this.pin(receipt.target.role);
      if (!(await this.sameFile(entry, directory)))
        return { status: 'unavailable', durable: false };
      await this.unlinkPath(this.pinnedPath(directory, entry.targetName));
      await this.syncDirectory(receipt.target.role, directory);
      await this.recheck(receipt.target.role, directory);
      await this.unlinkPath(this.pinnedPath(directory, entry.stageName));
      await this.syncDirectory(receipt.target.role, directory);
      this.owned.delete(receipt.receiptId);
      return { status: 'removed', durable: true };
    } catch {
      return { status: 'uncertain', durable: false };
    } finally {
      await directory?.close();
    }
  }

  async releaseOwned(receipt: PublishedObject): Promise<PersistenceOutcome> {
    const entry = this.ownedStage(receipt);
    if (!entry) return { status: 'unavailable' };
    let directory: FileHandle | undefined;
    try {
      directory = await this.pin(receipt.target.role);
      if (!(await this.sameFile(entry, directory)))
        return { status: 'unavailable' };
      await this.unlinkPath(this.pinnedPath(directory, entry.stageName));
      await this.syncDirectory(receipt.target.role, directory);
      await this.recheck(receipt.target.role, directory);
      this.owned.delete(receipt.receiptId);
      return { status: 'durable' };
    } catch {
      return { status: 'uncertain' };
    } finally {
      await directory?.close();
    }
  }
}
