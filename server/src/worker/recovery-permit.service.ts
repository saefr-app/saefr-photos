import { sql, type Kysely } from 'kysely';

import type { Database } from '../database/database.types.js';
import { MAINTENANCE_RECOVERY_MIGRATION } from '../database/migrations/migration-provider.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import type { StorageBindingVerifier } from '../storage/storage-binding.service.js';
import { RecoveryPermitStore } from './recovery-permit-store.js';
import {
  pairingFingerprint,
  parseApproval,
  RecoveryPermitError,
  type PermitFailure,
  type RecoveryPermit,
  validGeneration,
} from './recovery-permit.js';

export interface PermitPairing {
  fingerprint: string;
  /** A restored database is not an independent generation high-water mark. */
  recordedGeneration: string;
}

export interface PairingProbe {
  verify(): Promise<PermitPairing>;
}

/** Read-only database/catalog inspection and existing two-role verification. */
export class DatabasePermitPairing implements PairingProbe {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly storage: Pick<StorageBindingVerifier, 'assertVerified'>,
  ) {}

  async verify(): Promise<PermitPairing> {
    try {
      const status = await getMigrationStatus(this.db);
      if (
        !status.migrations.every((item) => item.applied) ||
        status.migrations.at(-1)?.name !== MAINTENANCE_RECOVERY_MIGRATION
      )
        throw new Error();
      const binding = await this.storage.assertVerified();
      const row = (
        await sql<{ generation: string }>`select greatest(
        coalesce((select max(permit_generation) from public.maintenance_retry_state), 0),
        coalesce((select max(blocked_permit_generation) from public.maintenance_takeover_clearance), 0),
        coalesce((select max(disarmed_permit_generation) from public.maintenance_takeover_clearance), 0)
      )::text as generation`.execute(this.db)
      ).rows[0];
      const after = await this.storage.assertVerified();
      if (
        pairingFingerprint(binding) !== pairingFingerprint(after) ||
        !row ||
        (row.generation !== '0' && !validGeneration(row.generation))
      )
        throw new Error();
      return {
        fingerprint: pairingFingerprint(binding),
        recordedGeneration: row.generation,
      };
    } catch {
      throw new RecoveryPermitError('pairing_unavailable');
    }
  }
}

export type PermitDecision =
  | { allowed: true; generation: string }
  | { allowed: false; reason: PermitFailure };

/** Observation only. No executor, queue, reservation or authorization token. */
export class RecoveryPermitService {
  constructor(
    private readonly store: Pick<RecoveryPermitStore, 'readRuntime'>,
    private readonly pairing: PairingProbe,
  ) {}

  async check(expectedGeneration?: string): Promise<PermitDecision> {
    try {
      if (
        expectedGeneration !== undefined &&
        !validGeneration(expectedGeneration)
      )
        throw new RecoveryPermitError('permit_invalid');
      const before = await this.store.readRuntime();
      if (!before.armed) throw new RecoveryPermitError('permit_disarmed');
      if (
        expectedGeneration !== undefined &&
        before.generation !== expectedGeneration
      )
        throw new RecoveryPermitError('permit_changed');
      const pairing = await this.pairing.verify();
      if (pairing.fingerprint !== before.pairing_sha256)
        throw new RecoveryPermitError('pairing_mismatch');
      if (BigInt(before.generation) < BigInt(pairing.recordedGeneration))
        throw new RecoveryPermitError('permit_changed');
      const after = await this.store.readRuntime();
      if (
        !after.armed ||
        after.generation !== before.generation ||
        after.pairing_sha256 !== before.pairing_sha256
      )
        throw new RecoveryPermitError('permit_changed');
      return { allowed: true, generation: after.generation };
    } catch (error) {
      return {
        allowed: false,
        reason:
          error instanceof RecoveryPermitError
            ? error.code
            : 'permit_unavailable',
      };
    }
  }
}

/** Local OS operator authority. Never registered in the worker or HTTP app. */
export class RecoveryPermitOperator {
  constructor(
    private readonly store: RecoveryPermitStore,
    private readonly pairing: PairingProbe,
  ) {}

  status(): Promise<RecoveryPermit> {
    return this.store.readOperator();
  }

  disarm(expectedGeneration: string): Promise<RecoveryPermit> {
    // Deliberately independent of PostgreSQL, media, and approval inventory.
    return this.store.update('disarm', expectedGeneration);
  }

  approvedUpdate(
    action: 'initialize' | 'arm',
    expectedGeneration: string,
    evidencePath: string,
    evidenceSha256: string,
  ): Promise<RecoveryPermit> {
    return this.store.update(action, expectedGeneration, async () => {
      const bytes = await this.store.readApproval(evidencePath);
      const approval = parseApproval(bytes, evidenceSha256);
      if (
        approval.action !== action ||
        approval.expected_generation !== expectedGeneration
      )
        throw new RecoveryPermitError('approval_invalid');
      const pairing = await this.pairing.verify();
      if (pairing.fingerprint !== approval.pairing_sha256)
        throw new RecoveryPermitError('pairing_mismatch');
      // Do not initialize over recorded permit history, or authorize a rolled-back file.
      if (
        action === 'initialize'
          ? pairing.recordedGeneration !== '0'
          : BigInt(expectedGeneration) < BigInt(pairing.recordedGeneration)
      )
        throw new RecoveryPermitError('permit_changed');
      if (!(await this.store.readApproval(evidencePath)).equals(bytes))
        throw new RecoveryPermitError('approval_invalid');
      return pairing.fingerprint;
    });
  }
}
