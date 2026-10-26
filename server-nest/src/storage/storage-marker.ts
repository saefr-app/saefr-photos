import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import { TextDecoder } from 'node:util';

export type StorageRole = 'originals' | 'thumbnails';

export interface Ext4PhysicalIdentity {
  format: 'linux-ext4-handle-v1';
  profile: 'linux-ext4-v1';
  filesystem_uuid: string;
  directory_handle_type: number;
  directory_handle_hex: string;
  location_sha256: string;
}

export interface StorageMarkerV2 {
  version: 2;
  storage_id: string;
  binding_id: string;
  role: StorageRole;
  physical_identity: Ext4PhysicalIdentity;
}

const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]+$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class InvalidStorageMarker extends Error {
  constructor() {
    super('Storage marker is invalid');
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new InvalidStorageMarker();
  }
  return value as Record<string, unknown>;
}

/** Minimal JSON reader: rejects duplicate keys before JSON.parse can discard them. */
function rejectDuplicateKeys(input: string): void {
  let at = 0;
  const space = () => {
    while (/\s/.test(input[at] ?? '') && at < input.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      const char = input[at++];
      if (char === '"') return JSON.parse(input.slice(start, at)) as string;
      if (char === '\\') at++;
    }
    throw new InvalidStorageMarker();
  };
  const value = (): void => {
    space();
    if (input[at] === '{') {
      at++;
      const seen = new Set<string>();
      space();
      while (input[at] !== '}') {
        if (input[at] !== '"') throw new InvalidStorageMarker();
        const key = string();
        if (seen.has(key)) throw new InvalidStorageMarker();
        seen.add(key);
        space();
        if (input[at++] !== ':') throw new InvalidStorageMarker();
        value();
        space();
        if (input[at] === '}') break;
        if (input[at++] !== ',') throw new InvalidStorageMarker();
        space();
      }
      at++;
    } else if (input[at] === '[') {
      at++;
      space();
      while (input[at] !== ']') {
        value();
        space();
        if (input[at] === ']') break;
        if (input[at++] !== ',') throw new InvalidStorageMarker();
      }
      at++;
    } else if (input[at] === '"') {
      string();
    } else {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          input.slice(at),
        );
      if (!match) throw new InvalidStorageMarker();
      at += match[0].length;
    }
    if (at > input.length) throw new InvalidStorageMarker();
  };
  value();
  space();
  if (at !== input.length) throw new InvalidStorageMarker();
}

export function parseStorageMarker(bytes: Uint8Array): StorageMarkerV2 {
  if (bytes.byteLength < 1 || bytes.byteLength > 1024) {
    throw new InvalidStorageMarker();
  }
  try {
    const text = utf8.decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) throw new InvalidStorageMarker();
    rejectDuplicateKeys(text);
    const record = object(JSON.parse(text) as unknown, [
      'version',
      'storage_id',
      'binding_id',
      'role',
      'physical_identity',
    ]);
    const identity = object(record.physical_identity, [
      'format',
      'profile',
      'filesystem_uuid',
      'directory_handle_type',
      'directory_handle_hex',
      'location_sha256',
    ]);
    const role = record.role;
    const handle = identity.directory_handle_hex;
    const fingerprint = identity.location_sha256;
    if (
      record.version !== 2 ||
      typeof record.storage_id !== 'string' ||
      !UUID.test(record.storage_id) ||
      typeof record.binding_id !== 'string' ||
      !UUID.test(record.binding_id) ||
      (role !== 'originals' && role !== 'thumbnails') ||
      identity.format !== 'linux-ext4-handle-v1' ||
      identity.profile !== 'linux-ext4-v1' ||
      typeof identity.filesystem_uuid !== 'string' ||
      !UUID.test(identity.filesystem_uuid) ||
      !Number.isInteger(identity.directory_handle_type) ||
      (identity.directory_handle_type as number) < -2147483648 ||
      (identity.directory_handle_type as number) > 2147483647 ||
      typeof handle !== 'string' ||
      handle.length < 2 ||
      handle.length > 256 ||
      handle.length % 2 !== 0 ||
      !HEX.test(handle) ||
      typeof fingerprint !== 'string' ||
      fingerprint.length !== 64 ||
      !HEX.test(fingerprint)
    )
      throw new InvalidStorageMarker();
    return record as unknown as StorageMarkerV2;
  } catch {
    throw new InvalidStorageMarker();
  }
}

/** The candidate Linux profile uses lexical POSIX paths, never realpath rewriting. */
export function roleLocation(
  root: string,
  cwd: string,
  role: StorageRole,
): string {
  if (
    !isAbsolute(cwd) ||
    [root, cwd].some((path) =>
      Array.from(path).some((char) => {
        const code = char.codePointAt(0)!;
        return code <= 31 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
      }),
    )
  )
    throw new InvalidStorageMarker();
  return posix.resolve(cwd, root, role);
}

export function locationFingerprint(
  location: string,
  role: StorageRole,
): string {
  if (!location.startsWith('/') || posix.normalize(location) !== location) {
    throw new InvalidStorageMarker();
  }
  return createHash('sha256')
    .update('saefr-role-location-v1\0', 'utf8')
    .update(role, 'ascii')
    .update('\0')
    .update(location, 'utf8')
    .digest('hex');
}

export function serializeStorageMarker(marker: StorageMarkerV2): Buffer {
  const text = `${JSON.stringify(marker)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  parseStorageMarker(bytes);
  return bytes;
}
