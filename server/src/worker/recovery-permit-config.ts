import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { posix } from 'node:path';

import type { Database } from '../database/database.types.js';
import { LinuxPhysicalStorageObserver } from '../storage/linux-physical-storage.observer.js';
import { StorageBindingVerifier } from '../storage/storage-binding.service.js';
import type { DatabaseService } from '../database/database.service.js';
import {
  normalizeRestoreRoot,
  type PermitLocation,
} from './recovery-permit-store.js';
import { DatabasePermitPairing } from './recovery-permit.service.js';
import { RecoveryPermitError, validGeneration } from './recovery-permit.js';

function invalid(): never {
  throw new RecoveryPermitError('permit_invalid');
}
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[`RECOVERY_PERMIT_${key}`];
  if (!value || value.trim() !== value) invalid();
  return value;
}
function numeric(env: NodeJS.ProcessEnv, key: string, max: number): number {
  const raw = required(env, key);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) invalid();
  return value;
}

export function permitLocation(env: NodeJS.ProcessEnv): PermitLocation {
  try {
    const roots: unknown = JSON.parse(required(env, 'RESTORE_ROOTS'));
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.length > 32 ||
      roots.some((root) => typeof root !== 'string')
    )
      invalid();
    const path = required(env, 'PATH');
    if (
      !posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.endsWith('/')
    )
      invalid();
    return {
      path,
      operatorUid: numeric(env, 'OPERATOR_UID', 4294967294),
      readerGid: numeric(env, 'READER_GID', 4294967294),
      restoreRoots: (roots as string[]).map(normalizeRestoreRoot),
    };
  } catch {
    invalid();
  }
}

export type PermitCommand =
  | { action: 'status' }
  | { action: 'disarm'; expected: string }
  | {
      action: 'initialize' | 'arm';
      expected: string;
      evidence: string;
      digest: string;
    };

export function parsePermitCommand(
  args: string[],
  location: PermitLocation,
): PermitCommand {
  const [action, ...rest] = args;
  const flags = new Map<string, string>();
  for (const item of rest) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(item);
    if (!match || flags.has(match[1])) invalid();
    flags.set(match[1], match[2]);
  }
  if (flags.get('confirm-permit') !== location.path) invalid();
  if (action === 'status' && flags.size === 1) return { action };
  const expected = flags.get('expected-generation');
  if (action === 'disarm' && flags.size === 2 && validGeneration(expected))
    return { action, expected };
  if (
    (action === 'initialize' || action === 'arm') &&
    flags.size === 4 &&
    (action === 'initialize' ? expected === '0' : validGeneration(expected)) &&
    flags.has('approval') &&
    /^[0-9a-f]{64}$/.test(flags.get('approval-sha256') ?? '')
  ) {
    return {
      action,
      expected: expected!,
      evidence: flags.get('approval')!,
      digest: flags.get('approval-sha256')!,
    };
  }
  invalid();
}

/** Dedicated configuration: never loads .env or falls back to application credentials. */
export function createPermitPairing(
  env: NodeJS.ProcessEnv,
  location: PermitLocation,
): {
  pairing: DatabasePermitPairing;
  close: () => Promise<void>;
} {
  const root = normalizeRestoreRoot(required(env, 'STORAGE_ROOT'));
  if (
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    !location.restoreRoots.map(normalizeRestoreRoot).includes(root)
  )
    invalid();
  const port = numeric(env, 'POSTGRES_PORT', 65535);
  if (port === 0) invalid();
  const config = new ConfigService({
    STORAGE_ROOT: root,
    STORAGE_ID: required(env, 'STORAGE_ID'),
    STORAGE_ORIGINALS_BINDING_ID: required(env, 'ORIGINALS_BINDING_ID'),
    STORAGE_THUMBNAILS_BINDING_ID: required(env, 'THUMBNAILS_BINDING_ID'),
    STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
    STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
  });
  const pool = new Pool({
    host: required(env, 'POSTGRES_HOST'),
    port,
    database: required(env, 'POSTGRES_DB'),
    user: required(env, 'POSTGRES_USER'),
    password: required(env, 'POSTGRES_PASSWORD'),
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    statement_timeout: 5000,
    options:
      '-c search_path=pg_catalog,public -c lock_timeout=2000 -c default_transaction_read_only=on',
    application_name: 'saefr-recovery-permit',
  });
  pool.on('error', () =>
    console.error('Recovery permit database unavailable.'),
  );
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  // Existing verifier consumes only .db; no API DatabaseService/pool is bootstrapped.
  const verifier = new StorageBindingVerifier(
    { db } as DatabaseService,
    config,
    new LinuxPhysicalStorageObserver(),
  );
  return {
    pairing: new DatabasePermitPairing(db, verifier),
    close: () => db.destroy(),
  };
}
