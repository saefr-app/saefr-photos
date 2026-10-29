import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  open,
  readFile,
  link,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';

import {
  encodePermit,
  MAX_PERMIT_BYTES,
  nextGeneration,
  parsePermit,
  RecoveryPermitError,
  type RecoveryPermit,
} from './recovery-permit.js';

export interface PermitLocation {
  path: string;
  operatorUid: number;
  readerGid: number;
  /** Explicit deployment restore roots, including the entire media root. */
  restoreRoots: readonly string[];
}

type AccessRole = 'operator' | 'runtime';
function unavailable(): never {
  throw new RecoveryPermitError('permit_untrusted');
}
function isAbsent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function lexical(path: string): boolean {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (
      code < 32 ||
      code === 127 ||
      code === 92 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return false;
  }
  return path.startsWith('/') && posix.normalize(path) === path;
}

/** Only trailing directory separators are equivalent; never collapse dot segments. */
export function normalizeRestoreRoot(root: string): string {
  const canonical = root.replace(/\/+$/, '') || '/';
  if (!root.startsWith('/') || !lexical(canonical)) unavailable();
  return canonical;
}

/** Linux descriptor-relative file operations in an operator-controlled namespace. */
export class RecoveryPermitStore {
  constructor(readonly location: PermitLocation) {}

  private async actor(role: AccessRole): Promise<void> {
    if (
      process.platform !== 'linux' ||
      !Number.isSafeInteger(this.location.operatorUid) ||
      this.location.operatorUid < 0 ||
      !Number.isSafeInteger(this.location.readerGid) ||
      this.location.readerGid < 0
    )
      unavailable();
    const uid = process.geteuid?.();
    if (role === 'operator') {
      if (uid !== this.location.operatorUid) unavailable();
    } else {
      if (uid === undefined || uid === 0 || uid === this.location.operatorUid)
        unavailable();
      // Effective capabilities can bypass DAC even for a non-root identity.
      const status = await readFile('/proc/self/status', 'utf8');
      if (!/^CapEff:\s+0+$/m.test(status)) unavailable();
    }
  }

  private validatePath(path: string): void {
    if (
      !lexical(path) ||
      posix.basename(path) === '' ||
      path.endsWith('/') ||
      this.location.restoreRoots.length === 0 ||
      this.location.restoreRoots.some((root) => {
        const relative = posix.relative(normalizeRestoreRoot(root), path);
        return (
          relative === '' ||
          (relative !== '..' &&
            !relative.startsWith('../') &&
            !posix.isAbsolute(relative))
        );
      })
    )
      unavailable();
  }

  private async notWritable(path: string): Promise<void> {
    try {
      await access(path, constants.W_OK);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EACCES')
        return;
      unavailable();
    }
    unavailable();
  }

  private async directory(path: string, role: AccessRole): Promise<FileHandle> {
    await this.actor(role);
    this.validatePath(path);
    let directory = await open(
      '/',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const parts = posix.dirname(path).split('/').filter(Boolean);
      for (let i = 0; i <= parts.length; i++) {
        const stat = await directory.stat();
        const final = i === parts.length;
        // Root-owned sticky directories (e.g. /tmp in tests) protect entries
        // owned by another UID; they are never allowed as the permit parent.
        const stickyRoot =
          !final && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        if (
          !stat.isDirectory() ||
          ![0, this.location.operatorUid].includes(stat.uid) ||
          ((stat.mode & 0o022) !== 0 && !stickyRoot) ||
          (final &&
            (stat.uid !== this.location.operatorUid ||
              stat.gid !== this.location.readerGid ||
              (stat.mode & 0o7777) !== 0o750))
        )
          unavailable();
        if (role === 'runtime' && !stickyRoot)
          await this.notWritable(`/proc/self/fd/${directory.fd}`);
        if (final) return directory;
        const next = await open(
          `/proc/self/fd/${directory.fd}/${parts[i]}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await directory.close();
        directory = next;
      }
      unavailable();
    } catch (error) {
      await directory.close();
      throw error;
    }
  }

  private async stillPinned(
    directory: FileHandle,
    path: string,
    role: AccessRole,
  ): Promise<void> {
    const current = await this.directory(path, role);
    try {
      const a = await directory.stat();
      const b = await current.stat();
      if (a.dev !== b.dev || a.ino !== b.ino) unavailable();
    } finally {
      await current.close();
    }
  }

  private filePath(directory: FileHandle, name: string): string {
    return `/proc/self/fd/${directory.fd}/${name}`;
  }

  private async noLock(directory: FileHandle): Promise<void> {
    try {
      await lstat(this.filePath(directory, '.recovery-permit.lock'));
    } catch (error) {
      if (isAbsent(error)) return;
      throw error;
    }
    throw new RecoveryPermitError('permit_busy');
  }

  private async bytes(
    directory: FileHandle,
    path: string,
    role: AccessRole,
    mode: number,
    limit: number,
  ): Promise<Buffer> {
    const target = this.filePath(directory, posix.basename(path));
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(this.location.operatorUid) ||
        before.gid !== BigInt(this.location.readerGid) ||
        (before.mode & 0o7777n) !== BigInt(mode) ||
        before.size < 1n ||
        before.size > BigInt(limit)
      )
        unavailable();
      if (role === 'runtime')
        await this.notWritable(`/proc/self/fd/${file.fd}`);
      // Never read an unbounded concurrently enlarged operator file.
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat({ bigint: true });
      const named = await lstat(target, { bigint: true });
      if (
        bytesRead !== Number(before.size) ||
        bytesRead > limit ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.dev !== named.dev ||
        before.ino !== named.ino ||
        named.nlink !== 1n
      )
        unavailable();
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  private async read(role: AccessRole): Promise<RecoveryPermit> {
    let directory: FileHandle | undefined;
    try {
      directory = await this.directory(this.location.path, role);
      await this.noLock(directory);
      const permit = parsePermit(
        await this.bytes(
          directory,
          this.location.path,
          role,
          0o640,
          MAX_PERMIT_BYTES,
        ),
      );
      await this.stillPinned(directory, this.location.path, role);
      await this.noLock(directory);
      return permit;
    } catch (error) {
      if (error instanceof RecoveryPermitError) throw error;
      throw new RecoveryPermitError('permit_unavailable');
    } finally {
      await directory?.close();
    }
  }

  readRuntime(): Promise<RecoveryPermit> {
    return this.read('runtime');
  }
  readOperator(): Promise<RecoveryPermit> {
    return this.read('operator');
  }

  async readApproval(path: string): Promise<Buffer> {
    let directory: FileHandle | undefined;
    try {
      directory = await this.directory(path, 'operator');
      const bytes = await this.bytes(directory, path, 'operator', 0o600, 4096);
      await this.stillPinned(directory, path, 'operator');
      return bytes;
    } catch {
      throw new RecoveryPermitError('approval_invalid');
    } finally {
      await directory?.close();
    }
  }

  /** Only called by the local operator service. No runtime updater is composed. */
  async update(
    action: 'initialize' | 'arm' | 'disarm',
    expectedGeneration: string,
    verifyPairingAndApproval?: () => Promise<string>,
  ): Promise<RecoveryPermit> {
    let directory: FileHandle | undefined;
    let lock: FileHandle | undefined;
    let temporary: string | undefined;
    let publishing = false;
    let published = false;
    try {
      directory = await this.directory(this.location.path, 'operator');
      const lockPath = this.filePath(directory, '.recovery-permit.lock');
      try {
        lock = await open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        throw new RecoveryPermitError('permit_busy');
      }
      // A crash after publication must leave a durable blocker for readers.
      await lock.sync();
      await directory.sync();
      let old: RecoveryPermit | undefined;
      try {
        old = parsePermit(
          await this.bytes(
            directory,
            this.location.path,
            'operator',
            0o640,
            MAX_PERMIT_BYTES,
          ),
        );
      } catch (error) {
        if (action !== 'initialize' || !isAbsent(error)) throw error;
      }
      if (
        action === 'initialize'
          ? old !== undefined || expectedGeneration !== '0'
          : !old || old.generation !== expectedGeneration
      )
        throw new RecoveryPermitError('permit_changed');
      if (action === 'arm' && old?.armed)
        throw new RecoveryPermitError('permit_changed');
      const fingerprint =
        action === 'disarm'
          ? old!.pairing_sha256
          : await verifyPairingAndApproval?.();
      if (!fingerprint) throw new RecoveryPermitError('approval_invalid');
      if (old && fingerprint !== old.pairing_sha256)
        throw new RecoveryPermitError('pairing_mismatch');
      const next: RecoveryPermit = {
        version: 1,
        armed: action === 'arm',
        generation: old ? nextGeneration(old.generation) : '1',
        pairing_sha256: fingerprint,
      };
      const bytes = encodePermit(next);
      temporary = this.filePath(
        directory,
        `.recovery-permit-${randomUUID()}.tmp`,
      );
      const file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.chown(this.location.operatorUid, this.location.readerGid);
        await file.chmod(0o640);
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.stillPinned(directory, this.location.path, 'operator');
      publishing = true;
      const target = this.filePath(
        directory,
        posix.basename(this.location.path),
      );
      if (action === 'initialize') {
        await link(temporary, target); // exclusive publication; cannot replace an existing record
        await unlink(temporary);
      } else await rename(temporary, target);
      temporary = undefined;
      await directory.sync();
      if (
        !(
          await this.bytes(
            directory,
            this.location.path,
            'operator',
            0o640,
            MAX_PERMIT_BYTES,
          )
        ).equals(bytes)
      )
        throw new Error();
      await this.stillPinned(directory, this.location.path, 'operator');
      published = true;
      await this.releaseLock(directory, lock);
      lock = undefined;
      return next;
    } catch (error) {
      if (publishing || published)
        throw new RecoveryPermitError('publication_unknown');
      if (error instanceof RecoveryPermitError) throw error;
      throw new RecoveryPermitError('permit_unavailable');
    } finally {
      // After publication starts, never remove uncertainty evidence automatically.
      if (!publishing && directory && lock) {
        try {
          if (temporary) await unlink(temporary);
          await this.releaseLock(directory, lock);
          lock = undefined;
        } catch {
          /* Retain the lock; a later reader refuses automatically. */
        }
      }
      await lock?.close();
      await directory?.close();
    }
  }

  private async releaseLock(
    directory: FileHandle,
    lock: FileHandle,
  ): Promise<void> {
    const path = this.filePath(directory, '.recovery-permit.lock');
    const current = await lstat(path);
    const held = await lock.stat();
    if (
      current.dev !== held.dev ||
      current.ino !== held.ino ||
      current.nlink !== 1
    )
      unavailable();
    try {
      await unlink(path);
      await directory.sync();
      await lock.close();
    } catch (error) {
      // Publication is durable before release. Restore an uncertainty blocker
      // if release acknowledgement is lost. External process fencing must
      // remain in place on every failure, including an unhealthy filesystem
      // that also prevents creation of this blocker.
      let blocker: FileHandle | undefined;
      try {
        blocker = await open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await blocker.sync();
        await directory.sync();
      } finally {
        await blocker?.close();
      }
      throw error;
    }
  }
}
