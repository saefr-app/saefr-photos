import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../database/database.types.js';
import {
  exactPgTimestamp,
  pgTimestamp,
  positivePgBigint,
  PG_BIGINT_LIMIT,
  type ExactPgTimestamp,
} from './exact-pg-values.js';

export interface CoordinatorOwner {
  token: string;
  epoch: string;
}

export interface JournalKey {
  requestedAt: ExactPgTimestamp;
  assetId: string;
}

export interface ReconciliationSnapshot {
  leader_token: string | null;
  leader_epoch: string;
  lease_live: boolean;
  leader_expires_at_exact: string | null;
  pass_status: 'incomplete' | 'complete';
  pass_id: string | null;
  pass_owner_epoch: string | null;
  upper: JournalKey | null;
  cursor: JournalKey | null;
}

export type CoordinationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'stale' | 'busy' | 'overflow' | 'deferred_lock' | 'uncertain' };

interface SnapshotRow {
  leader_token: string | null;
  leader_epoch: string;
  lease_live: boolean;
  leader_expires_at_exact: string | null;
  pass_status: 'incomplete' | 'complete';
  pass_id: string | null;
  pass_owner_epoch: string | null;
  upper_at: string | null;
  upper_id: string | null;
  cursor_at: string | null;
  cursor_id: string | null;
}

export function reconciliationPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new Error(
      'Reconciliation page limit must be an integer from 1 to 100',
    );
  return value;
}

function sameKey(left: JournalKey | null, right: JournalKey | null): boolean {
  return (
    left?.requestedAt === right?.requestedAt && left?.assetId === right?.assetId
  );
}

/** Unregistered database-only coordination. No queue, permit file or provider I/O. */
export class MaintenanceReconciliationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async read(): Promise<ReconciliationSnapshot> {
    return this.snapshot(this.db);
  }

  /** Use a fresh token for each acquisition attempt; unknown COMMIT needs read(). */
  async acquire(token: string): Promise<CoordinationResult<CoordinatorOwner>> {
    return this.transaction<CoordinatorOwner>(async (tx) => {
      const current = await this.snapshot(tx, 'update');
      if (current.lease_live) return { status: 'busy' };
      if (current.leader_epoch === PG_BIGINT_LIMIT)
        return { status: 'overflow' };
      // Never reuse an expired ownership identity.
      if (current.leader_token === token) return { status: 'stale' };
      const result = await sql<{
        epoch: string;
      }>`update public.maintenance_reconciliation
        set leader_epoch = leader_epoch + 1, leader_token = ${token}::uuid,
          leader_expires_at = clock_timestamp() + interval '60 seconds',
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where singleton = true and leader_epoch < ${PG_BIGINT_LIMIT}::bigint
        returning leader_epoch::text as epoch`.execute(tx);
      return { status: 'ok', value: { token, epoch: result.rows[0].epoch } };
    });
  }

  async renew(
    owner: CoordinatorOwner,
  ): Promise<CoordinationResult<ReconciliationSnapshot>> {
    return this.transaction<ReconciliationSnapshot>(async (tx) => {
      if (!this.owns(await this.snapshot(tx, 'update'), owner))
        return { status: 'stale' };
      const result = await sql`update public.maintenance_reconciliation
        set leader_expires_at = clock_timestamp() + interval '60 seconds',
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where singleton = true and leader_token = ${owner.token}::uuid
          and leader_epoch = ${owner.epoch}::bigint
          and leader_expires_at > clock_timestamp()`.execute(tx);
      if (Number(result.numAffectedRows) !== 1) return { status: 'stale' };
      return { status: 'ok', value: await this.snapshot(tx) };
    });
  }

  async beginOrResume(
    owner: CoordinatorOwner,
  ): Promise<CoordinationResult<ReconciliationSnapshot>> {
    return this.transaction<ReconciliationSnapshot>(async (tx) => {
      const current = await this.snapshot(tx, 'update');
      if (!this.owns(current, owner)) return { status: 'stale' };
      if (current.pass_status === 'incomplete') {
        await sql`update public.maintenance_reconciliation
          set pass_owner_epoch = ${owner.epoch}::bigint,
            updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
          where singleton = true`.execute(tx);
      } else {
        // MVCC read only: never take journal/retry locks after the singleton.
        const upper = (
          await sql<{ at: string; id: string }>`select
          to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
          asset_id as id from public.asset_deletion where completed_at is null
          order by requested_at desc, asset_id desc limit 1`.execute(tx)
        ).rows[0];
        if (upper) {
          await sql`update public.maintenance_reconciliation
            set pass_status = 'incomplete', pass_id = ${randomUUID()}::uuid,
              pass_owner_epoch = ${owner.epoch}::bigint,
              upper_requested_at = ${pgTimestamp(exactPgTimestamp(upper.at))},
              upper_asset_id = ${upper.id}::uuid,
              cursor_requested_at = null, cursor_asset_id = null,
              updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
            where singleton = true`.execute(tx);
        }
      }
      const after = await this.snapshot(tx);
      if (!this.owns(after, owner))
        throw new Error('Coordinator lease expired');
      return { status: 'ok', value: after };
    });
  }

  async page(
    owner: CoordinatorOwner,
    expected: ReconciliationSnapshot,
    limit = 100,
  ): Promise<CoordinationResult<JournalKey[]>> {
    reconciliationPageLimit(limit);
    return this.transaction<JournalKey[]>(async (tx) => {
      const current = await this.snapshot(tx, 'share');
      if (!this.matchesPass(current, owner, expected))
        return { status: 'stale' };
      const rows = await this.pending(tx, current, limit);
      if (!this.owns(await this.snapshot(tx), owner))
        return { status: 'stale' };
      return { status: 'ok', value: rows };
    });
  }

  /** Caller must positively establish an outcome, or explicitly defer a rolled-back lock wait. */
  async advance(
    owner: CoordinatorOwner,
    expected: ReconciliationSnapshot,
    key: JournalKey,
  ): Promise<CoordinationResult<ReconciliationSnapshot>> {
    exactPgTimestamp(key.requestedAt);
    return this.transaction<ReconciliationSnapshot>(async (tx) => {
      const current = await this.snapshot(tx, 'update');
      if (!this.matchesPass(current, owner, expected))
        return { status: 'stale' };
      // Do not skip an earlier still-pending receipt. Completed candidates may disappear.
      const first = (await this.pending(tx, current, 1))[0];
      const result = await sql`update public.maintenance_reconciliation
        set cursor_requested_at = ${pgTimestamp(key.requestedAt)}, cursor_asset_id = ${key.assetId}::uuid,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where singleton = true and leader_expires_at > clock_timestamp()
          and (${pgTimestamp(key.requestedAt)}, ${key.assetId}::uuid) <= (upper_requested_at, upper_asset_id)
          and (cursor_requested_at is null or
            (${pgTimestamp(key.requestedAt)}, ${key.assetId}::uuid) > (cursor_requested_at, cursor_asset_id))
          and (${first ? pgTimestamp(first.requestedAt) : pgTimestamp(key.requestedAt)},
            ${first?.assetId ?? key.assetId}::uuid) >= (${pgTimestamp(key.requestedAt)}, ${key.assetId}::uuid)`.execute(
        tx,
      );
      if (Number(result.numAffectedRows) !== 1) return { status: 'stale' };
      return { status: 'ok', value: await this.snapshot(tx) };
    });
  }

  async complete(
    owner: CoordinatorOwner,
    expected: ReconciliationSnapshot,
  ): Promise<CoordinationResult<ReconciliationSnapshot>> {
    return this.transaction<ReconciliationSnapshot>(async (tx) => {
      const current = await this.snapshot(tx, 'update');
      if (!this.matchesPass(current, owner, expected))
        return { status: 'stale' };
      if ((await this.pending(tx, current, 1)).length !== 0)
        return { status: 'busy' };
      const changed = await sql`update public.maintenance_reconciliation
        set pass_status = 'complete',
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where singleton = true and leader_expires_at > clock_timestamp()`.execute(
        tx,
      );
      if (Number(changed.numAffectedRows) !== 1) return { status: 'stale' };
      return { status: 'ok', value: await this.snapshot(tx) };
    });
  }

  /** Receipt locks precede the singleton SHARE fence; control-only paths never reverse this. */
  async inspectReceipt(
    owner: CoordinatorOwner,
    assetId: string,
  ): Promise<
    CoordinationResult<
      'established' | 'discover' | 'inconsistent' | 'completed'
    >
  > {
    return this.transaction<
      'established' | 'discover' | 'inconsistent' | 'completed'
    >(async (tx) => {
      const journal = await this.lockJournal(tx, assetId);
      const retry = await tx
        .selectFrom('maintenance_retry_state')
        .select(['asset_id', 'state'])
        .where('asset_id', '=', assetId)
        .forUpdate()
        .executeTakeFirst();
      if (!this.owns(await this.snapshot(tx, 'share'), owner))
        return { status: 'stale' };
      if (!journal) return { status: 'uncertain' };
      if (journal.completed) return { status: 'ok', value: 'completed' };
      if (journal.live_asset || retry?.state === 'closed')
        return { status: 'ok', value: 'inconsistent' };
      return { status: 'ok', value: retry ? 'established' : 'discover' };
    });
  }

  /** Production discovery also fences the INSERT while the singleton SHARE lock is held. */
  async discoverFenced(
    owner: CoordinatorOwner,
    assetId: string,
  ): Promise<CoordinationResult<void>> {
    return this.transaction<void>(async (tx) => {
      const journal = await this.lockJournal(tx, assetId);
      const retry = await tx
        .selectFrom('maintenance_retry_state')
        .select('asset_id')
        .where('asset_id', '=', assetId)
        .forUpdate()
        .executeTakeFirst();
      if (!this.owns(await this.snapshot(tx, 'share'), owner))
        return { status: 'stale' };
      if (!journal || journal.completed || journal.live_asset)
        return { status: 'stale' };
      if (!retry) {
        const inserted = await sql`insert into public.maintenance_retry_state
          (asset_id, generation, state, lifetime_attempts, immediate_attempts, next_eligible_at, created_at, updated_at)
          select ${assetId}::uuid, 1, 'due', 0, 0, clock_timestamp() + interval '1 minute', clock_timestamp(), clock_timestamp()
          where exists(select 1 from public.maintenance_reconciliation where singleton = true
            and leader_token = ${owner.token}::uuid and leader_epoch = ${owner.epoch}::bigint
            and leader_expires_at > clock_timestamp())
          on conflict (asset_id) do nothing`.execute(tx);
        if (Number(inserted.numAffectedRows) !== 1) return { status: 'stale' };
      }
      return { status: 'ok', value: undefined };
    });
  }

  /** Separate, replayable primary-key sweep; its cursor is never the pending-pass cursor. */
  async sweepPage(
    owner: CoordinatorOwner,
    afterId: string | null,
    limit = 100,
  ): Promise<CoordinationResult<string[]>> {
    reconciliationPageLimit(limit);
    return this.transaction<string[]>(async (tx) => {
      if (!this.owns(await this.snapshot(tx, 'share'), owner))
        return { status: 'stale' };
      const rows = await tx
        .selectFrom('maintenance_retry_state')
        .select('asset_id')
        .$if(afterId !== null, (query) =>
          query.where('asset_id', '>', afterId!),
        )
        .orderBy('asset_id')
        .limit(limit)
        .execute();
      return { status: 'ok', value: rows.map((row) => row.asset_id) };
    });
  }

  async closePassiveCompleted(
    owner: CoordinatorOwner,
    assetId: string,
  ): Promise<
    CoordinationResult<'closed' | 'unchanged' | 'evidence_preserved'>
  > {
    return this.transaction<'closed' | 'unchanged' | 'evidence_preserved'>(
      async (tx) => {
        const journal = await this.lockJournal(tx, assetId);
        const retry = await tx
          .selectFrom('maintenance_retry_state')
          .selectAll()
          .where('asset_id', '=', assetId)
          .forUpdate()
          .executeTakeFirst();
        if (!this.owns(await this.snapshot(tx, 'share'), owner))
          return { status: 'stale' };
        if (!journal?.completed || journal.live_asset || !retry)
          return { status: 'ok', value: 'unchanged' };
        // closed requires NULL active fields. Never erase blocked/uncertain execution evidence.
        if (retry.state !== 'due' && retry.state !== 'cooling')
          return {
            status: 'ok',
            value:
              retry.state === 'closed' ? 'unchanged' : 'evidence_preserved',
          };
        const result = await sql`update public.maintenance_retry_state
        set state = 'closed', next_eligible_at = null,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${assetId}::uuid and exists (
          select 1 from public.maintenance_reconciliation where singleton = true
            and leader_token = ${owner.token}::uuid and leader_epoch = ${owner.epoch}::bigint
            and leader_expires_at > clock_timestamp())`.execute(tx);
        if (Number(result.numAffectedRows) !== 1) return { status: 'stale' };
        return { status: 'ok', value: 'closed' };
      },
    );
  }

  private owns(row: ReconciliationSnapshot, owner: CoordinatorOwner): boolean {
    positivePgBigint(owner.epoch);
    return (
      row.lease_live &&
      row.leader_token === owner.token &&
      row.leader_epoch === owner.epoch
    );
  }

  private matchesPass(
    row: ReconciliationSnapshot,
    owner: CoordinatorOwner,
    expected: ReconciliationSnapshot,
  ): boolean {
    return (
      this.owns(row, owner) &&
      row.pass_owner_epoch === owner.epoch &&
      row.pass_status === 'incomplete' &&
      row.pass_id === expected.pass_id &&
      sameKey(row.upper, expected.upper) &&
      sameKey(row.cursor, expected.cursor)
    );
  }

  private async lockJournal(tx: Transaction<Database>, assetId: string) {
    await sql`select asset_id from public.asset_deletion where asset_id = ${assetId}::uuid for update`.execute(
      tx,
    );
    return (
      await sql<{
        completed: boolean;
        live_asset: boolean;
      }>`select completed_at is not null as completed,
      exists(select 1 from public.asset where id = ${assetId}::uuid) as live_asset
      from public.asset_deletion where asset_id = ${assetId}::uuid`.execute(tx)
    ).rows[0];
  }

  private async pending(
    tx: Transaction<Database>,
    row: ReconciliationSnapshot,
    limit: number,
  ): Promise<JournalKey[]> {
    if (!row.upper) return [];
    const rows = await sql<{ at: string; id: string }>`select
      to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, asset_id as id
      from public.asset_deletion where completed_at is null
        and (requested_at, asset_id) <= (${pgTimestamp(row.upper.requestedAt)}, ${row.upper.assetId}::uuid)
        ${row.cursor ? sql`and (requested_at, asset_id) > (${pgTimestamp(row.cursor.requestedAt)}, ${row.cursor.assetId}::uuid)` : sql``}
      order by requested_at asc, asset_id asc limit ${limit}`.execute(tx);
    return rows.rows.map((key) => ({
      requestedAt: exactPgTimestamp(key.at),
      assetId: key.id,
    }));
  }

  private async snapshot(
    db: Kysely<Database> | Transaction<Database>,
    lock?: 'update' | 'share',
  ): Promise<ReconciliationSnapshot> {
    // A separate statement evaluates clock time after any row-lock wait.
    if (lock)
      await sql`select singleton from public.maintenance_reconciliation where singleton = true
      ${lock === 'update' ? sql`for update` : sql`for share`}`.execute(db);
    const row = (
      await sql<SnapshotRow>`select leader_token, leader_epoch::text,
      leader_expires_at > clock_timestamp() as lease_live,
      to_char(leader_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as leader_expires_at_exact,
      pass_status, pass_id, pass_owner_epoch::text,
      to_char(upper_requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as upper_at,
      upper_asset_id as upper_id,
      to_char(cursor_requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
      cursor_asset_id as cursor_id
      from public.maintenance_reconciliation where singleton = true`.execute(db)
    ).rows[0];
    if (!row) throw new Error('Reconciliation singleton unavailable');
    return {
      leader_token: row.leader_token,
      leader_epoch: row.leader_epoch,
      lease_live: row.lease_live === true,
      leader_expires_at_exact: row.leader_expires_at_exact,
      pass_status: row.pass_status,
      pass_id: row.pass_id,
      pass_owner_epoch: row.pass_owner_epoch,
      upper:
        row.upper_at && row.upper_id
          ? {
              requestedAt: exactPgTimestamp(row.upper_at),
              assetId: row.upper_id,
            }
          : null,
      cursor:
        row.cursor_at && row.cursor_id
          ? {
              requestedAt: exactPgTimestamp(row.cursor_at),
              assetId: row.cursor_id,
            }
          : null,
    };
  }

  private async transaction<T>(
    action: (tx: Transaction<Database>) => Promise<CoordinationResult<T>>,
  ): Promise<CoordinationResult<T>> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          await sql`set local synchronous_commit to on`.execute(tx);
          await sql`set local lock_timeout to '1s'`.execute(tx);
          await sql`set local statement_timeout to '5s'`.execute(tx);
          return action(tx);
        });
    } catch (error: unknown) {
      // A PostgreSQL lock-timeout error aborts this transaction before COMMIT.
      // All other failures, including a lost COMMIT acknowledgement, stay unknown.
      return {
        status:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '55P03'
            ? 'deferred_lock'
            : 'uncertain',
      };
    }
  }
}
