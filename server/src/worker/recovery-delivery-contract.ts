import { validGeneration } from './recovery-permit.js';

export const RECOVERY_QUEUE = 'maintenance-recovery';
export const RECOVERY_JOB = 'deletion.execute.v1';

export interface RecoveryHint {
  version: 1;
  asset_id: string;
  generation: string;
}

/** Canonical bounded identifiers; no paths, owners, permit or execution tokens. */
export function parseRecoveryHint(value: unknown): RecoveryHint {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery hint');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.version !== 1 ||
    typeof record.asset_id !== 'string' ||
    !/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      record.asset_id,
    ) ||
    !validGeneration(record.generation)
  )
    throw new Error('Invalid recovery hint');
  return {
    version: 1,
    asset_id: record.asset_id,
    generation: record.generation,
  };
}

export function recoveryJobId(value: RecoveryHint): string {
  const hint = parseRecoveryHint(value);
  return `deletion-${hint.asset_id}-${hint.generation}`;
}
