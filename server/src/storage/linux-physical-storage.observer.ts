import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

import type { PhysicalStorageObserver } from './storage-binding.service.js';
import type { ProvisioningIdentityObserver } from './storage-binding-provisioner.js';
import type { Ext4PhysicalIdentity, StorageRole } from './storage-marker.js';

const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^(?:[0-9a-f]{2}){1,128}$/;
const MARKER_HEX = /^(?:[0-9a-f]{2}){1,1024}$/;

type Identity = Omit<Ext4PhysicalIdentity, 'location_sha256'>;

function unavailable(): Error {
  return new Error('Physical identity observation unavailable');
}

function decoded(
  value: unknown,
  withMarker: boolean,
): {
  identity: Identity;
  markerBytes?: Buffer;
} {
  if (typeof value !== 'object' || !value || Array.isArray(value))
    throw unavailable();
  const record = value as Record<string, unknown>;
  const keys = withMarker
    ? [
        'filesystem_uuid',
        'directory_handle_type',
        'directory_handle_hex',
        'marker_hex',
      ]
    : ['filesystem_uuid', 'directory_handle_type', 'directory_handle_hex'];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    typeof record.filesystem_uuid !== 'string' ||
    !UUID.test(record.filesystem_uuid) ||
    !Number.isInteger(record.directory_handle_type) ||
    (record.directory_handle_type as number) < -2147483648 ||
    (record.directory_handle_type as number) > 2147483647 ||
    typeof record.directory_handle_hex !== 'string' ||
    !HEX.test(record.directory_handle_hex) ||
    (withMarker &&
      (typeof record.marker_hex !== 'string' ||
        !MARKER_HEX.test(record.marker_hex)))
  )
    throw unavailable();
  return {
    identity: {
      format: 'linux-ext4-handle-v1',
      profile: 'linux-ext4-v1',
      filesystem_uuid: record.filesystem_uuid,
      directory_handle_type: record.directory_handle_type as number,
      directory_handle_hex: record.directory_handle_hex,
    },
    ...(withMarker && {
      markerBytes: Buffer.from(record.marker_hex as string, 'hex'),
    }),
  };
}

/** Linux-only, descriptor-based observation. No path is passed to the helper. */
export class LinuxPhysicalStorageObserver
  implements PhysicalStorageObserver, ProvisioningIdentityObserver
{
  constructor(
    private readonly executable = resolve(
      process.cwd(),
      'dist/native/storage-identity-observer',
    ),
  ) {}

  private async inspect(
    location: string,
    withMarker: boolean,
    pinned?: FileHandle,
  ): Promise<{ identity: Identity; markerBytes?: Buffer }> {
    if (
      process.platform !== 'linux' ||
      !location.startsWith(sep) ||
      posix.normalize(location) !== location ||
      Array.from(location).some((char) => {
        const code = char.codePointAt(0)!;
        return code <= 31 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
      })
    )
      throw unavailable();
    let handle = pinned;
    try {
      // Directory ancestors are controlled by the operator in this profile.
      // Check every component, then pin the final directory as an open fd.
      let current: string = sep;
      for (const part of location.split(sep).filter(Boolean)) {
        current = resolve(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      }
      handle ??= await open(
        location,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const before = await handle.stat();
      const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(
          this.executable,
          [withMarker ? '--observe' : '--identity'],
          {
            stdio: ['ignore', 'pipe', 'ignore', handle!.fd],
            timeout: 3000,
            killSignal: 'SIGKILL',
            env: {},
          },
        );
        let data = '';
        if (!child.stdout) {
          reject(unavailable());
          return;
        }
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          data += chunk;
          if (Buffer.byteLength(data) > 4096) child.kill('SIGKILL');
        });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code !== 0 || Buffer.byteLength(data) > 4096)
            reject(unavailable());
          else resolveOutput(data);
        });
      });
      // Reject a role path replaced while the descriptor was observed.
      let recheck: string = sep;
      for (const part of location.split(sep).filter(Boolean)) {
        recheck = resolve(recheck, part);
        const ancestor = await lstat(recheck);
        if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
          throw unavailable();
      }
      const after = await lstat(location);
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      )
        throw unavailable();
      return decoded(JSON.parse(output) as unknown, withMarker);
    } catch {
      throw unavailable();
    } finally {
      if (!pinned)
        await handle?.close().catch(() => {
          throw unavailable();
        });
    }
  }

  async observe(_role: StorageRole, location: string) {
    const result = await this.inspect(location, true);
    if (!result.markerBytes) throw unavailable();
    return { identity: result.identity, markerBytes: result.markerBytes };
  }

  async observePinned(
    _role: StorageRole,
    location: string,
    directory: FileHandle,
  ) {
    const result = await this.inspect(location, true, directory);
    if (!result.markerBytes) throw unavailable();
    return { identity: result.identity, markerBytes: result.markerBytes };
  }

  async observeIdentity(_role: StorageRole, location: string) {
    return (await this.inspect(location, false)).identity;
  }
}
