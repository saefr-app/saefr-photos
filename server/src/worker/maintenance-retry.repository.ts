import { sql, type Kysely, type Transaction } from 'kysely';

import type {
  Database,
  MaintenanceRetryState,
} from '../database/database.types.js';
import type { DeletionErrorCode } from '../assets/asset-deletion.repository.js';
import type { StorageBinding } from '../storage/storage-binding.service.js';
import {
  exactPgTimestamp,
  pgTimestamp,
  positivePgBigint,
  type ExactPgTimestamp,
  PG_BIGINT_LIMIT,
} from './exact-pg-values.js';

export type RetryTransition =
  'applied' | 'stale' | 'missing' | 'ineligible' | 'overflow' | 'uncertain';

export type AdmissionReason =
  | 'journal_inconsistent'
  | 'invalid_target'
  | 'storage_identity_mismatch'
  | 'unsupported_storage';

export type ExecutionReason =
  | 'quiescence_unknown'
  | 'claim_unknown'
  | 'provider_unknown'
  | 'permit_changed'
  | 'storage_identity_mismatch';

export interface RetrySnapshot {
  asset_id: string;
  generation: string;
  state: MaintenanceRetryState;
  lifetime_attempts: string;
  immediate_attempts: number;
  next_eligible_at_exact: string | null;
  attempt_id: string | null;
  attempt_kind: 'immediate' | 'cooling' | null;
  reservation_expires_at_exact: string | null;
  worker_incarnation_id: string | null;
  permit_generation: string | null;
  journal_execution_token: string | null;
  blocked_reason: string | null;
  last_error_code: string | null;
  last_clearance_id: string | null;
  updated_at_exact: string;
}

interface JournalState {
  asset_id: string;
  pending: boolean;
  live_asset: boolean;
  execution_token: string | null;
  claim_live: boolean;
  storage_id: string;
  originals_binding_id: string;
  thumbnails_binding_id: string;
  storage_layout_version: number;
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  'storage_unavailable',
  'storage_identity_mismatch',
  'unsupported_storage',
  'unexpected_file',
  'permission_denied',
  'filesystem_error',
  'durability_unavailable',
  'inconsistent_state',
  'unknown_outcome',
]);

/**
 * Database-only B.3 primitives. No worker provider registers this class yet.
 * A committed journal is always locked before its retry row. No Redis, permit
 * file, or filesystem call is made while the transaction holds database locks.
 */
export class MaintenanceRetryRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly verifyStorage?: () => Promise<StorageBinding>,
  ) {}

  /** Read-only observation for positive confirmation after an uncertain COMMIT. */
  async read(assetId: string): Promise<RetrySnapshot | undefined> {
    return this.readRow(this.db, assetId);
  }

  async requestedKey(assetId: string): Promise<ExactPgTimestamp | undefined> {
    const result = await sql<{ key: string }>`select
      to_char(requested_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as key
      from public.asset_deletion where asset_id = ${assetId}::uuid`.execute(
      this.db,
    );
    return result.rows[0] ? exactPgTimestamp(result.rows[0].key) : undefined;
  }

  /** The first committed discovery starts a full one-minute admission delay. */
  async discover(assetId: string): Promise<RetryTransition> {
    return this.write(assetId, async (tx, journal, current) => {
      if (!journal) return 'missing';
      if (!journal.pending || journal.live_asset) return 'ineligible';
      if (current) return 'stale';
      const changed = await sql`insert into public.maintenance_retry_state
        (asset_id, generation, state, lifetime_attempts, immediate_attempts,
         next_eligible_at, created_at, updated_at)
        values (${assetId}::uuid, 1, 'due', 0, 0,
          clock_timestamp() + interval '1 minute', clock_timestamp(), clock_timestamp())
        on conflict (asset_id) do nothing`.execute(tx);
      return Number(changed.numAffectedRows) === 1 ? 'applied' : 'stale';
    });
  }

  /**
   * The caller supplies a unique attempt ID and an independently checked
   * permit generation. A returned uncertain result NEVER authorizes execution.
   */
  async reserve(input: {
    assetId: string;
    generation: string;
    expectedDue: ExactPgTimestamp;
    attemptId: string;
    incarnationId: string;
    permitGeneration: string;
  }): Promise<RetryTransition> {
    positivePgBigint(input.generation);
    positivePgBigint(input.permitGeneration);
    exactPgTimestamp(input.expectedDue);
    return this.write(input.assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (!journal.pending || journal.live_asset || journal.claim_live)
        return 'ineligible';
      if (
        current.generation !== input.generation ||
        current.next_eligible_at_exact !== input.expectedDue ||
        (current.state !== 'due' && current.state !== 'cooling')
      )
        return 'stale';
      if (current.lifetime_attempts === PG_BIGINT_LIMIT) return 'overflow';
      const kind = current.state === 'due' ? 'immediate' : 'cooling';
      const result = await sql<{
        asset_id: string;
      }>`update public.maintenance_retry_state
        set state = 'reserved', next_eligible_at = null,
          lifetime_attempts = lifetime_attempts + 1,
          immediate_attempts = immediate_attempts + case when state = 'due' then 1 else 0 end,
          attempt_id = ${input.attemptId}::uuid, attempt_kind = ${kind},
          reservation_expires_at = clock_timestamp() + interval '60 seconds',
          worker_incarnation_id = ${input.incarnationId}::uuid,
          permit_generation = ${input.permitGeneration}::bigint,
          journal_execution_token = null, last_error_code = null,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${input.assetId}::uuid
          and generation = ${input.generation}::bigint
          and state = ${current.state}
          and next_eligible_at = ${pgTimestamp(input.expectedDue)}
          and next_eligible_at <= clock_timestamp()
          and lifetime_attempts < ${PG_BIGINT_LIMIT}::bigint
          and immediate_attempts < case when state = 'due' then 3 else 4 end
        returning asset_id`.execute(tx);
      return result.rows.length === 1 ? 'applied' : 'ineligible';
    });
  }

  /** A fresh independent read is mandatory after an unknown reservation result. */
  async confirmReservation(input: {
    assetId: string;
    generation: string;
    attemptId: string;
    incarnationId: string;
    permitGeneration: string;
  }): Promise<boolean> {
    positivePgBigint(input.generation);
    positivePgBigint(input.permitGeneration);
    const result = await sql<{ valid: boolean }>`select
      r.state = 'reserved' and r.generation = ${input.generation}::bigint
      and r.attempt_id = ${input.attemptId}::uuid
      and r.worker_incarnation_id = ${input.incarnationId}::uuid
      and r.permit_generation = ${input.permitGeneration}::bigint
      and r.reservation_expires_at > clock_timestamp()
      and d.completed_at is null
      and not exists (select 1 from public.asset a where a.id = d.asset_id)
      as valid
      from public.asset_deletion d
      join public.maintenance_retry_state r on r.asset_id = d.asset_id
      where d.asset_id = ${input.assetId}::uuid`.execute(this.db);
    return result.rows[0]?.valid === true;
  }

  /** Only a caller that has drained its own I/O may settle an attempt. */
  async settleFailure(input: {
    assetId: string;
    generation: string;
    attemptId: string;
    incarnationId: string;
    permitGeneration: string;
    errorCode: DeletionErrorCode;
    ioDrained: true;
  }): Promise<RetryTransition> {
    this.validateAttempt(input);
    if (!ERROR_CODES.has(input.errorCode) || input.ioDrained !== true)
      throw new Error('Invalid attempt settlement');
    return this.write(input.assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (!journal.pending) return 'ineligible';
      if (!this.matchesAttempt(current, input) || current.state !== 'reserved')
        return 'stale';
      const result = await sql<{
        asset_id: string;
      }>`update public.maintenance_retry_state
        set state = case when immediate_attempts = 3 then 'cooling' else 'due' end,
          next_eligible_at = clock_timestamp() + case
            when immediate_attempts = 1 then interval '5 minutes'
            when immediate_attempts = 2 then interval '30 minutes'
            else interval '6 hours' end,
          attempt_id = null, attempt_kind = null, reservation_expires_at = null,
          worker_incarnation_id = null, permit_generation = null,
          journal_execution_token = null, last_error_code = ${input.errorCode},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${input.assetId}::uuid
          and generation = ${input.generation}::bigint and state = 'reserved'
          and attempt_id = ${input.attemptId}::uuid
          and worker_incarnation_id = ${input.incarnationId}::uuid
          and permit_generation = ${input.permitGeneration}::bigint
          and reservation_expires_at > clock_timestamp()
        returning asset_id`.execute(tx);
      return result.rows.length === 1 ? 'applied' : 'stale';
    });
  }

  async blockAdmission(
    assetId: string,
    generation: string,
    reason: AdmissionReason,
  ): Promise<RetryTransition> {
    positivePgBigint(generation);
    return this.write(assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (!journal.pending) return 'ineligible';
      if (current.generation !== generation) return 'stale';
      if (current.state === 'blocked_admission')
        return current.blocked_reason === reason ? 'applied' : 'stale';
      if (current.state !== 'due' && current.state !== 'cooling')
        return 'stale';
      const result = await sql`update public.maintenance_retry_state
        set state = 'blocked_admission', blocked_reason = ${reason},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${assetId}::uuid and generation = ${generation}::bigint
          and state = ${current.state}`.execute(tx);
      return Number(result.numAffectedRows) === 1 ? 'applied' : 'stale';
    });
  }

  /**
   * Physical verification completes before the transaction acquires locks.
   * B.4 must verify again before any destructive action; this only changes
   * retry metadata and is not an execution authorization.
   */
  async releaseAdmissionAfterVerification(
    assetId: string,
    generation: string,
    reason: AdmissionReason,
  ): Promise<RetryTransition> {
    positivePgBigint(generation);
    if (!this.verifyStorage || reason === 'invalid_target') return 'ineligible';
    let verified: StorageBinding;
    try {
      verified = await this.verifyStorage();
    } catch {
      return 'ineligible';
    }
    return this.write(assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (!journal.pending || journal.live_asset) return 'ineligible';
      const binding = await tx
        .selectFrom('storage_binding')
        .selectAll()
        .where('singleton', '=', true)
        .forShare()
        .executeTakeFirst();
      if (
        !binding ||
        binding.storage_id !== verified.storage_id ||
        binding.originals_binding_id !== verified.originals_binding_id ||
        binding.thumbnails_binding_id !== verified.thumbnails_binding_id ||
        binding.storage_layout_version !== verified.storage_layout_version ||
        journal.storage_id !== binding.storage_id ||
        journal.originals_binding_id !== binding.originals_binding_id ||
        journal.thumbnails_binding_id !== binding.thumbnails_binding_id ||
        journal.storage_layout_version !== binding.storage_layout_version
      )
        return 'ineligible';
      if (
        current.generation !== generation ||
        current.state !== 'blocked_admission' ||
        current.blocked_reason !== reason
      )
        return 'stale';
      const result = await sql`update public.maintenance_retry_state
        set state = case when immediate_attempts = 3 then 'cooling' else 'due' end,
          blocked_reason = null,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${assetId}::uuid and generation = ${generation}::bigint
          and state = 'blocked_admission' and blocked_reason = ${reason}`.execute(
        tx,
      );
      return Number(result.numAffectedRows) === 1 ? 'applied' : 'stale';
    });
  }

  /** Retains the exact possibly live attempt and journal-token evidence. */
  async blockExecution(input: {
    assetId: string;
    generation: string;
    attemptId: string;
    incarnationId: string;
    permitGeneration: string;
    reason: ExecutionReason;
  }): Promise<RetryTransition> {
    this.validateAttempt(input);
    return this.write(input.assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (!journal.pending) return 'ineligible';
      if (!this.matchesAttempt(current, input)) return 'stale';
      if (current.state === 'blocked_execution')
        return current.blocked_reason === input.reason ? 'applied' : 'stale';
      if (current.state !== 'reserved') return 'stale';
      const result = await sql`update public.maintenance_retry_state
        set state = 'blocked_execution', blocked_reason = ${input.reason},
          journal_execution_token = ${journal.execution_token}::uuid,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${input.assetId}::uuid
          and generation = ${input.generation}::bigint and state = 'reserved'
          and attempt_id = ${input.attemptId}::uuid
          and worker_incarnation_id = ${input.incarnationId}::uuid
          and permit_generation = ${input.permitGeneration}::bigint`.execute(
        tx,
      );
      return Number(result.numAffectedRows) === 1 ? 'applied' : 'stale';
    });
  }

  /** Read-only clearance prerequisites; this never releases an execution block. */
  async hasMatchingClearance(input: {
    assetId: string;
    generation: string;
    attemptId: string;
    incarnationId: string;
    permitGeneration: string;
    clearanceId: string;
  }): Promise<boolean> {
    this.validateAttempt(input);
    const result = await sql<{ valid: boolean }>`select
      r.state = 'blocked_execution'
      and r.generation = ${input.generation}::bigint
      and r.attempt_id = ${input.attemptId}::uuid
      and r.worker_incarnation_id = ${input.incarnationId}::uuid
      and r.permit_generation = ${input.permitGeneration}::bigint
      and r.journal_execution_token is not distinct from c.blocked_journal_execution_token
      and c.blocked_generation = r.generation
      and c.blocked_attempt_id = r.attempt_id
      and c.blocked_worker_incarnation_id = r.worker_incarnation_id
      and c.blocked_permit_generation = r.permit_generation
      and c.disarmed_permit_generation > r.permit_generation
      and d.completed_at is null and d.execution_token is null
      and not exists (select 1 from public.asset a where a.id = d.asset_id)
      as valid
      from public.asset_deletion d
      join public.maintenance_retry_state r on r.asset_id = d.asset_id
      join public.maintenance_takeover_clearance c
        on c.asset_id = r.asset_id and c.clearance_id = ${input.clearanceId}::uuid
      where d.asset_id = ${input.assetId}::uuid`.execute(this.db);
    return result.rows[0]?.valid === true;
  }

  /** A retained terminal Redis delivery can be replaced only after external proof. */
  async advanceGenerationAfterTerminalDelivery(input: {
    assetId: string;
    generation: string;
    expectedRevision: ExactPgTimestamp;
    terminalDeliveryVerified: true;
  }): Promise<RetryTransition> {
    positivePgBigint(input.generation);
    exactPgTimestamp(input.expectedRevision);
    if (input.terminalDeliveryVerified !== true)
      throw new Error('Terminal delivery confirmation required');
    return this.write(input.assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (!journal.pending || journal.live_asset || journal.claim_live)
        return 'ineligible';
      if (
        current.generation !== input.generation ||
        current.updated_at_exact !== input.expectedRevision ||
        (current.state !== 'due' && current.state !== 'cooling')
      )
        return 'stale';
      if (current.generation === PG_BIGINT_LIMIT) return 'overflow';
      const result = await sql`update public.maintenance_retry_state
        set generation = generation + 1,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${input.assetId}::uuid
          and generation = ${input.generation}::bigint
          and updated_at = ${pgTimestamp(input.expectedRevision)}
          and state = ${current.state} and generation < ${PG_BIGINT_LIMIT}::bigint`.execute(
        tx,
      );
      return Number(result.numAffectedRows) === 1 ? 'applied' : 'stale';
    });
  }

  /** Journal completion closes passive rows only; it cannot prove execution quiescence. */
  async closeCompleted(
    assetId: string,
    generation: string,
  ): Promise<RetryTransition> {
    positivePgBigint(generation);
    return this.write(assetId, async (tx, journal, current) => {
      if (!journal || !current) return 'missing';
      if (current.generation !== generation) return 'stale';
      if (current.state === 'closed')
        return journal.pending ? 'ineligible' : 'applied';
      if (
        journal.pending ||
        (current.state !== 'due' && current.state !== 'cooling')
      )
        return 'ineligible';
      const result = await sql`update public.maintenance_retry_state
        set state = 'closed', next_eligible_at = null,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${assetId}::uuid and generation = ${generation}::bigint
          and state in ('due', 'cooling')`.execute(tx);
      return Number(result.numAffectedRows) === 1 ? 'applied' : 'stale';
    });
  }

  private validateAttempt(input: {
    generation: string;
    permitGeneration: string;
  }): void {
    positivePgBigint(input.generation);
    positivePgBigint(input.permitGeneration);
  }

  private matchesAttempt(
    row: RetrySnapshot,
    input: {
      generation: string;
      attemptId: string;
      incarnationId: string;
      permitGeneration: string;
    },
  ): boolean {
    return (
      row.generation === input.generation &&
      row.attempt_id === input.attemptId &&
      row.worker_incarnation_id === input.incarnationId &&
      row.permit_generation === input.permitGeneration
    );
  }

  private async write(
    assetId: string,
    action: (
      tx: Transaction<Database>,
      journal: JournalState | undefined,
      retry: RetrySnapshot | undefined,
    ) => Promise<RetryTransition>,
  ): Promise<RetryTransition> {
    try {
      return await this.db.transaction().execute(async (tx) => {
        await sql`set local synchronous_commit to on`.execute(tx);
        await sql`set local lock_timeout to '2s'`.execute(tx);
        await sql`set local statement_timeout to '5s'`.execute(tx);
        const locked = await sql<{ asset_id: string }>`select asset_id
          from public.asset_deletion where asset_id = ${assetId}::uuid
          for update`.execute(tx);
        if (!locked.rows[0]) return action(tx, undefined, undefined);
        // Evaluate wall time and live-asset status after the row-lock wait.
        const journal = (
          await sql<JournalState>`select d.asset_id,
            d.completed_at is null as pending,
            exists(select 1 from public.asset a where a.id = d.asset_id) as live_asset,
            d.execution_token, d.storage_id, d.originals_binding_id,
            d.thumbnails_binding_id, d.storage_layout_version,
            d.execution_token is not null and d.execution_expires_at > clock_timestamp()
              as claim_live
            from public.asset_deletion d where d.asset_id = ${assetId}::uuid`.execute(
            tx,
          )
        ).rows[0];
        const retry = await this.readRow(tx, assetId, true);
        return action(tx, journal, retry);
      });
    } catch {
      // COMMIT acknowledgement may have been lost. No caller may infer rollback.
      return 'uncertain';
    }
  }

  private async readRow(
    db: Kysely<Database> | Transaction<Database>,
    assetId: string,
    forUpdate = false,
  ): Promise<RetrySnapshot | undefined> {
    const result = await sql<RetrySnapshot>`select
      asset_id, generation::text, state, lifetime_attempts::text,
      immediate_attempts,
      to_char(next_eligible_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as next_eligible_at_exact,
      attempt_id, attempt_kind,
      to_char(reservation_expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reservation_expires_at_exact,
      worker_incarnation_id, permit_generation::text,
      journal_execution_token, blocked_reason, last_error_code,
      last_clearance_id,
      to_char(updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_exact
      from public.maintenance_retry_state
      where asset_id = ${assetId}::uuid
      ${forUpdate ? sql`for update` : sql``}`.execute(db);
    return result.rows[0];
  }
}
