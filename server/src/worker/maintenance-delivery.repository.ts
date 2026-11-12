import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../database/database.types.js';
import type {
  CoordinatorOwner,
  CoordinationResult,
} from './maintenance-reconciliation.repository.js';
import {
  exactPgTimestamp,
  pgTimestamp,
  PG_BIGINT_LIMIT,
  type ExactPgTimestamp,
} from './exact-pg-values.js';
import {
  parseRecoveryHint,
  type RecoveryHint,
} from './recovery-delivery-contract.js';

export interface DeliveryObservation {
  hint: RecoveryHint;
  revision: ExactPgTimestamp;
  eligible: boolean;
}

/** Journal -> retry -> coordinator fencing. Never holds locks across Redis or permit reads. */
export class MaintenanceDeliveryRepository {
  constructor(private readonly db: Kysely<Database>) {}

  inspect(
    owner: CoordinatorOwner,
    hint: RecoveryHint,
  ): Promise<CoordinationResult<DeliveryObservation>> {
    parseRecoveryHint(hint);
    return this.transaction<DeliveryObservation>(
      owner,
      hint,
      async (_tx, current) => ({ status: 'ok', value: current }),
    );
  }

  /** Called only following an exact terminal Redis observation. No attempt or cooldown reset. */
  replaceTerminal(
    owner: CoordinatorOwner,
    expected: DeliveryObservation,
  ): Promise<CoordinationResult<RecoveryHint>> {
    parseRecoveryHint(expected.hint);
    exactPgTimestamp(expected.revision);
    return this.transaction<RecoveryHint>(
      owner,
      expected.hint,
      async (tx, current) => {
        if (!current.eligible || current.revision !== expected.revision)
          return { status: 'stale' };
        if (current.hint.generation === PG_BIGINT_LIMIT)
          return { status: 'overflow' };
        const result = await sql<{
          generation: string;
        }>`update public.maintenance_retry_state
        set generation = generation + 1,
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
        where asset_id = ${expected.hint.asset_id}::uuid
          and generation = ${expected.hint.generation}::bigint
          and updated_at = ${pgTimestamp(expected.revision)}
          and state in ('due', 'cooling') and next_eligible_at <= clock_timestamp()
          and exists(select 1 from public.maintenance_reconciliation where singleton = true
            and leader_token = ${owner.token}::uuid and leader_epoch = ${owner.epoch}::bigint
            and leader_expires_at > clock_timestamp())
        returning generation::text`.execute(tx);
        return result.rows[0]
          ? {
              status: 'ok',
              value: {
                ...expected.hint,
                generation: result.rows[0].generation,
              },
            }
          : { status: 'stale' };
      },
    );
  }

  private async transaction<T>(
    owner: CoordinatorOwner,
    hint: RecoveryHint,
    action: (
      tx: Transaction<Database>,
      current: DeliveryObservation,
    ) => Promise<CoordinationResult<T>>,
  ): Promise<CoordinationResult<T>> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          await sql`set local synchronous_commit to on`.execute(tx);
          await sql`set local lock_timeout to '1s'`.execute(tx);
          await sql`set local statement_timeout to '5s'`.execute(tx);
          await sql`select asset_id from public.asset_deletion where asset_id = ${hint.asset_id}::uuid for update`.execute(
            tx,
          );
          await sql`select asset_id from public.maintenance_retry_state where asset_id = ${hint.asset_id}::uuid for update`.execute(
            tx,
          );
          await sql`select singleton from public.maintenance_reconciliation where singleton = true for share`.execute(
            tx,
          );
          // Evaluate wall time, eligibility and fencing after every lock wait.
          const row = (
            await sql<{
              generation: string;
              revision: string;
              eligible: boolean;
              owns: boolean;
            }>`select
          r.generation::text, to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision,
          d.completed_at is null and not exists(select 1 from public.asset a where a.id = d.asset_id)
            and exists(select 1 from public.storage_binding b where b.singleton = true
              and d.storage_id = b.storage_id and d.originals_binding_id = b.originals_binding_id
              and d.thumbnails_binding_id = b.thumbnails_binding_id
              and d.storage_layout_version = b.storage_layout_version)
            and r.state in ('due', 'cooling') and r.next_eligible_at <= clock_timestamp()
            and (d.execution_token is null or d.execution_expires_at <= clock_timestamp()) as eligible,
          c.leader_token = ${owner.token}::uuid and c.leader_epoch = ${owner.epoch}::bigint
            and c.leader_expires_at > clock_timestamp() as owns
          from public.asset_deletion d join public.maintenance_retry_state r using (asset_id)
          cross join public.maintenance_reconciliation c
          where d.asset_id = ${hint.asset_id}::uuid and c.singleton = true`.execute(
              tx,
            )
          ).rows[0];
          if (!row || !row.owns || row.generation !== hint.generation)
            return { status: 'stale' };
          return action(tx, {
            hint,
            revision: exactPgTimestamp(row.revision),
            eligible: row.eligible === true,
          });
        });
    } catch {
      // No dependent enqueue after an unknown replacement COMMIT.
      return { status: 'uncertain' };
    }
  }
}
