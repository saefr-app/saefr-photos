import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { MAINTENANCE_RECOVERY_MIGRATION } from '../database/migrations/migration-provider.js';
import type { StorageBinding } from '../storage/storage-binding.service.js';

export const MAX_PERMIT_BYTES = 1024;
export const MAX_GENERATION = 9223372036854775807n;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PermitFailure =
  | 'permit_unavailable'
  | 'permit_untrusted'
  | 'permit_invalid'
  | 'permit_busy'
  | 'permit_disarmed'
  | 'permit_changed'
  | 'pairing_unavailable'
  | 'pairing_mismatch'
  | 'approval_invalid'
  | 'publication_unknown';

export class RecoveryPermitError extends Error {
  constructor(readonly code: PermitFailure) {
    super(`Recovery permit blocked: ${code}`);
  }
}

export interface RecoveryPermit {
  readonly version: 1;
  readonly armed: boolean;
  readonly generation: string;
  readonly pairing_sha256: string;
}

export function validGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= MAX_GENERATION
  );
}

export function nextGeneration(value: string): string {
  if (!validGeneration(value) || BigInt(value) === MAX_GENERATION)
    throw new RecoveryPermitError('permit_invalid');
  return String(BigInt(value) + 1n);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RecoveryPermitError('permit_invalid');
  return value as Record<string, unknown>;
}

export function encodePermit(value: RecoveryPermit): Buffer {
  if (
    value.version !== 1 ||
    typeof value.armed !== 'boolean' ||
    !validGeneration(value.generation) ||
    typeof value.pairing_sha256 !== 'string' ||
    !SHA256.test(value.pairing_sha256)
  )
    throw new RecoveryPermitError('permit_invalid');
  return Buffer.from(
    JSON.stringify({
      version: 1,
      armed: value.armed,
      generation: value.generation,
      pairing_sha256: value.pairing_sha256,
    }) + '\n',
  );
}

/** Canonical encoding rejects duplicate/unknown keys, BOMs and ambiguous JSON. */
export function parsePermit(bytes: Uint8Array): RecoveryPermit {
  try {
    if (bytes.length === 0 || bytes.length > MAX_PERMIT_BYTES)
      throw new Error();
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const v = object(JSON.parse(text) as unknown);
    const result = {
      version: v.version,
      armed: v.armed,
      generation: v.generation,
      pairing_sha256: v.pairing_sha256,
    } as RecoveryPermit;
    if (!encodePermit(result).equals(Buffer.from(bytes))) throw new Error();
    return result;
  } catch {
    throw new RecoveryPermitError('permit_invalid');
  }
}

export function pairingFingerprint(binding: StorageBinding): string {
  if (
    binding.singleton !== true ||
    binding.storage_layout_version !== 1 ||
    ![
      binding.storage_id,
      binding.originals_binding_id,
      binding.thumbnails_binding_id,
    ].every((id) => typeof id === 'string' && UUID.test(id)) ||
    binding.originals_binding_id === binding.thumbnails_binding_id
  )
    throw new RecoveryPermitError('pairing_unavailable');
  return createHash('sha256')
    .update('saefr-automatic-recovery-pairing-v1\0')
    .update(
      JSON.stringify([
        MAINTENANCE_RECOVERY_MIGRATION,
        binding.storage_id,
        binding.originals_binding_id,
        binding.thumbnails_binding_id,
        binding.storage_layout_version,
      ]),
    )
    .digest('hex');
}

export interface PermitApproval {
  version: 1;
  action: 'initialize' | 'arm';
  expected_generation: string;
  pairing_sha256: string;
  operator_reference: string;
  fencing_record_sha256: string;
  reconciliation_record_sha256: string;
  backup_record_sha256: string;
  first_provisioning: boolean;
}

/** A protected human-reviewed attestation; this is not automated quiescence proof. */
export function parseApproval(
  bytes: Uint8Array,
  digest: string,
): PermitApproval {
  try {
    if (
      !SHA256.test(digest) ||
      bytes.length > 4096 ||
      bytes.length === 0 ||
      createHash('sha256').update(bytes).digest('hex') !== digest
    )
      throw new Error();
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const v = object(JSON.parse(text) as unknown);
    const keys = [
      'version',
      'action',
      'expected_generation',
      'pairing_sha256',
      'operator_reference',
      'fencing_record_sha256',
      'reconciliation_record_sha256',
      'backup_record_sha256',
      'first_provisioning',
    ];
    if (
      Object.keys(v).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(v, key)) ||
      v.version !== 1 ||
      (v.action !== 'initialize' && v.action !== 'arm') ||
      !(v.action === 'initialize'
        ? v.expected_generation === '0' && v.first_provisioning === true
        : validGeneration(v.expected_generation) &&
          v.first_provisioning === false) ||
      typeof v.operator_reference !== 'string' ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(v.operator_reference) ||
      [
        'pairing_sha256',
        'fencing_record_sha256',
        'reconciliation_record_sha256',
        'backup_record_sha256',
      ].some((key) => typeof v[key] !== 'string' || !SHA256.test(v[key]))
    )
      throw new Error();
    const canonical = Object.fromEntries(keys.map((key) => [key, v[key]]));
    if (JSON.stringify(canonical) + '\n' !== text) throw new Error();
    return v as unknown as PermitApproval;
  } catch {
    throw new RecoveryPermitError('approval_invalid');
  }
}
