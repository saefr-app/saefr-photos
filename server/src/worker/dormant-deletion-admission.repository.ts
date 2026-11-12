import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../database/database.types.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import { MAINTENANCE_RECOVERY_MIGRATION } from '../database/migrations/migration-provider.js';
import {
  exactPgTimestamp,
  pgTimestamp,
  positivePgBigint,
  type ExactPgTimestamp,
} from './exact-pg-values.js';

/** Not a capability. Synthetic caller attestations for a dormant DB contract only. */
export interface AdmissionPreflight {
  permitGeneration: string;
  storageVerified: true;
  capacityAvailable: boolean;
}
export interface JournalIdentity {
  asset_id: string;
  owner_id: string;
  accepted_lifecycle_version: string;
  requested_at_exact: ExactPgTimestamp;
  storage_id: string;
  originals_binding_id: string;
  thumbnails_binding_id: string;
  storage_layout_version: number;
  original_extension: string;
}
export interface AttemptIdentity {
  journal: JournalIdentity;
  generation: string;
  attemptId: string;
  incarnationId: string;
  permitGeneration: string;
}
export interface Reservation extends AttemptIdentity {
  deadline: ExactPgTimestamp;
}
export interface BoundReservation extends Reservation {
  token: string;
}
export type AdmissionResult<T> =
  { status: 'applied'; value: T } | { status: 'refused' | 'uncertain' };

class GuardRefusal extends Error {}

/**
 * DORMANT: no Nest provider, production import, executor or clearance operation.
 * open() validates actual migration history; it never selects a runtime profile.
 * All external preflight and synthetic drainage proofs are caller obligations.
 */
export class DormantDeletionAdmissionRepository {
  private constructor(private readonly db: Kysely<Database>) {}

  static async open(db: Kysely<Database>) {
    const status = await getMigrationStatus(db);
    if (
      !status.migrations.every((m) => m.applied) ||
      status.migrations.at(-1)?.name !== MAINTENANCE_RECOVERY_MIGRATION
    )
      throw new Error('Dormant admission requires the exact M13 schema');
    return new DormantDeletionAdmissionRepository(db);
  }

  async identity(assetId: string): Promise<JournalIdentity | undefined> {
    const rows = await sql<JournalIdentity>`select asset_id, owner_id,
      accepted_lifecycle_version::text, storage_id, originals_binding_id,
      thumbnails_binding_id, storage_layout_version, original_extension,
      to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as requested_at_exact
      from public.asset_deletion where asset_id = ${assetId}::uuid`.execute(
      this.db,
    );
    return rows.rows[0];
  }

  private journalGuard(j: JournalIdentity) {
    exactPgTimestamp(j.requested_at_exact);
    positivePgBigint(j.accepted_lifecycle_version);
    return sql`d.asset_id = ${j.asset_id}::uuid and d.owner_id = ${j.owner_id}::uuid
      and d.accepted_lifecycle_version = ${j.accepted_lifecycle_version}::bigint
      and d.requested_at = ${pgTimestamp(j.requested_at_exact)}
      and d.storage_id = ${j.storage_id}::uuid
      and d.originals_binding_id = ${j.originals_binding_id}::uuid
      and d.thumbnails_binding_id = ${j.thumbnails_binding_id}::uuid
      and d.storage_layout_version = ${j.storage_layout_version}
      and d.original_extension = ${j.original_extension}
      and exists(select 1 from public.storage_binding b where b.singleton = true and b.storage_id = d.storage_id and b.originals_binding_id = d.originals_binding_id and b.thumbnails_binding_id = d.thumbnails_binding_id and b.storage_layout_version = d.storage_layout_version) and d.completed_at is null
      and not exists(select 1 from public.asset a where a.id = d.asset_id)`;
  }

  private attemptGuard(a: AttemptIdentity) {
    positivePgBigint(a.generation);
    positivePgBigint(a.permitGeneration);
    return sql`r.asset_id = ${a.journal.asset_id}::uuid and r.generation = ${a.generation}::bigint
      and r.attempt_id = ${a.attemptId}::uuid
      and r.worker_incarnation_id = ${a.incarnationId}::uuid
      and r.permit_generation = ${a.permitGeneration}::bigint`;
  }

  private reservationGuard(a: Reservation) {
    exactPgTimestamp(a.deadline);
    return sql`${this.attemptGuard(a)} and r.state = 'reserved'
      and r.reservation_expires_at = ${pgTimestamp(a.deadline)}
      and r.reservation_expires_at > clock_timestamp()`;
  }

  private async write<T>(
    assetId: string,
    action: (tx: Transaction<Database>) => Promise<T>,
  ): Promise<AdmissionResult<T>> {
    try {
      const value = await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          await sql`set local synchronous_commit to on`.execute(tx);
          await sql`set local lock_timeout to '2s'`.execute(tx);
          await sql`set local statement_timeout to '5s'`.execute(tx);
          const journal = await sql`select asset_id from public.asset_deletion
          where asset_id = ${assetId}::uuid for update`.execute(tx);
          if (journal.rows.length !== 1) throw new GuardRefusal();
          await sql`select asset_id from public.maintenance_retry_state
          where asset_id = ${assetId}::uuid for update`.execute(tx);
          await sql`select singleton from public.storage_binding where singleton = true for share`.execute(
            tx,
          );
          return action(tx);
        });
      return { status: 'applied', value };
    } catch (error) {
      // Only a local guard followed by confirmed rollback is a known refusal.
      // Transport/COMMIT failures never imply rollback or execution authority.
      return {
        status: error instanceof GuardRefusal ? 'refused' : 'uncertain',
      };
    }
  }

  private one(rows: unknown[]) {
    if (rows.length !== 1) throw new GuardRefusal();
  }

  async claimManual(
    journal: JournalIdentity,
    token: string,
  ): Promise<AdmissionResult<string>> {
    const guard = this.journalGuard(journal);
    return this.write(journal.asset_id, async (tx) => {
      const result = await sql`update public.asset_deletion d
        set execution_token = ${token}::uuid,
          execution_expires_at = clock_timestamp() + interval '60 seconds'
        where ${guard} and d.execution_token is null
          and not exists(select 1 from public.maintenance_retry_state r
            where r.asset_id = d.asset_id and r.state in ('reserved', 'blocked_execution', 'closed'))
        returning d.asset_id`.execute(tx);
      this.one(result.rows);
      return token;
    });
  }

  async reserve(
    a: AttemptIdentity,
    expectedDue: ExactPgTimestamp,
    lifetimeCeiling: string,
    preflight: AdmissionPreflight,
  ): Promise<AdmissionResult<Reservation>> {
    positivePgBigint(lifetimeCeiling);
    const guard = this.journalGuard(a.journal);
    this.attemptGuard(a);
    exactPgTimestamp(expectedDue);
    if (
      preflight.permitGeneration !== a.permitGeneration ||
      !preflight.storageVerified ||
      !preflight.capacityAvailable
    )
      return { status: 'refused' };
    return this.write(a.journal.asset_id, async (tx) => {
      const result = await sql<{
        deadline: string;
      }>`update public.maintenance_retry_state r
        set state = 'reserved', next_eligible_at = null,
          lifetime_attempts = lifetime_attempts + 1,
          immediate_attempts = immediate_attempts + case when state = 'due' then 1 else 0 end,
          attempt_id = ${a.attemptId}::uuid, worker_incarnation_id = ${a.incarnationId}::uuid,
          permit_generation = ${a.permitGeneration}::bigint,
          attempt_kind = case when state = 'due' then 'immediate' else 'cooling' end,
          reservation_expires_at = clock_timestamp() + interval '60 seconds',
          journal_execution_token = null, last_error_code = null,
          updated_at = greatest(clock_timestamp(), r.updated_at + interval '1 microsecond')
        where r.asset_id = ${a.journal.asset_id}::uuid and r.generation = ${a.generation}::bigint
          and r.state in ('due', 'cooling')
          and r.next_eligible_at = ${pgTimestamp(expectedDue)} and r.next_eligible_at <= clock_timestamp()
          and r.lifetime_attempts < ${lifetimeCeiling}::bigint
          and r.immediate_attempts < case when r.state = 'due' then 3 else 4 end
          and exists(select 1 from public.asset_deletion d where ${guard} and d.execution_token is null)
        returning to_char(reservation_expires_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as deadline`.execute(tx);
      this.one(result.rows);
      return { ...a, deadline: exactPgTimestamp(result.rows[0].deadline) };
    });
  }

  /** Fresh independent read. No match, expiry or query failure grants authority. */
  async confirm(
    a: AttemptIdentity,
    bound?: { deadline: ExactPgTimestamp; token: string },
  ): Promise<AdmissionResult<Reservation | BoundReservation>> {
    try {
      const result = await sql<{ deadline: string }>`select
        to_char(r.reservation_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as deadline
        from public.asset_deletion d join public.maintenance_retry_state r on r.asset_id = d.asset_id
        where ${this.journalGuard(a.journal)} and ${this.attemptGuard(a)}
          and r.state = 'reserved' and r.reservation_expires_at > clock_timestamp()
          and ${
            bound
              ? sql`r.reservation_expires_at = ${pgTimestamp(bound.deadline)}
            and r.journal_execution_token = ${bound.token}::uuid and d.execution_token = ${bound.token}::uuid
            and d.execution_expires_at > clock_timestamp()`
              : sql`r.journal_execution_token is null and d.execution_token is null`
          }`.execute(this.db);
      if (result.rows.length !== 1) return { status: 'refused' };
      return {
        status: 'applied',
        value: {
          ...a,
          deadline: exactPgTimestamp(result.rows[0].deadline),
          ...(bound ? { token: bound.token } : {}),
        },
      };
    } catch {
      return { status: 'uncertain' };
    }
  }

  /** Caller creates ONE token and retains it across uncertain acknowledgements. */
  async bind(
    a: Reservation,
    token: string,
  ): Promise<AdmissionResult<BoundReservation>> {
    return this.write(a.journal.asset_id, async (tx) => {
      const journal = await sql`update public.asset_deletion d
        set execution_token = ${token}::uuid, execution_expires_at = clock_timestamp() + interval '60 seconds'
        where ${this.journalGuard(a.journal)} and d.execution_token is null
          and exists(select 1 from public.maintenance_retry_state r where ${this.reservationGuard(a)}
            and r.journal_execution_token is null) returning d.asset_id`.execute(
        tx,
      );
      this.one(journal.rows);
      const retry = await sql`update public.maintenance_retry_state r
        set journal_execution_token = ${token}::uuid,
          updated_at = greatest(clock_timestamp(), r.updated_at + interval '1 microsecond')
        where ${this.reservationGuard(a)} and r.journal_execution_token is null
          and exists(select 1 from public.asset_deletion d where ${this.journalGuard(a.journal)}
            and d.execution_token = ${token}::uuid and d.execution_expires_at > clock_timestamp())
        returning r.asset_id`.execute(tx);
      this.one(retry.rows);
      return { ...a, token };
    });
  }

  async settle(
    a: BoundReservation,
    proof: { ioDrained: true; outcome: 'removed' | 'known_failure' },
  ): Promise<AdmissionResult<'settled'>> {
    if (
      proof.ioDrained !== true ||
      !['removed', 'known_failure'].includes(proof.outcome)
    )
      return { status: 'refused' };
    return this.write(a.journal.asset_id, async (tx) => {
      const journal = await sql`update public.asset_deletion d
        set completed_at = ${proof.outcome === 'removed' ? sql`greatest(clock_timestamp(), d.requested_at)` : sql`null`},
          execution_token = null, execution_expires_at = null,
          last_error_code = ${proof.outcome === 'removed' ? null : 'filesystem_error'}
        where ${this.journalGuard(a.journal)} and d.execution_token = ${a.token}::uuid
          and d.execution_expires_at > clock_timestamp()
          and exists(select 1 from public.maintenance_retry_state r where ${this.reservationGuard(a)}
            and r.journal_execution_token = ${a.token}::uuid) returning d.asset_id`.execute(
        tx,
      );
      this.one(journal.rows);
      const retry = await sql`update public.maintenance_retry_state r
        set state = ${proof.outcome === 'removed' ? sql`'closed'` : sql`case when immediate_attempts = 3 then 'cooling' else 'due' end`},
          next_eligible_at = ${proof.outcome === 'removed' ? sql`null` : sql`clock_timestamp() + case when immediate_attempts = 1 then interval '5 minutes' when immediate_attempts = 2 then interval '30 minutes' else interval '6 hours' end`},
          attempt_id = null, attempt_kind = null, reservation_expires_at = null,
          worker_incarnation_id = null, permit_generation = null, journal_execution_token = null,
          last_error_code = ${proof.outcome === 'removed' ? null : 'filesystem_error'},
          updated_at = greatest(clock_timestamp(), r.updated_at + interval '1 microsecond')
        where ${this.reservationGuard(a)} and r.journal_execution_token = ${a.token}::uuid
        returning r.asset_id`.execute(tx);
      this.one(retry.rows);
      return 'settled' as const;
    });
  }

  /** Does not copy a changed journal token or erase identity after journal completion. */
  async block(
    a: Reservation,
    reason:
      | 'quiescence_unknown'
      | 'claim_unknown'
      | 'provider_unknown'
      | 'permit_changed'
      | 'storage_identity_mismatch',
  ): Promise<AdmissionResult<'blocked'>> {
    if (
      ![
        'quiescence_unknown',
        'claim_unknown',
        'provider_unknown',
        'permit_changed',
        'storage_identity_mismatch',
      ].includes(reason)
    )
      return { status: 'refused' };
    return this.write(a.journal.asset_id, async (tx) => {
      const result = await sql`update public.maintenance_retry_state r
        set state = 'blocked_execution', blocked_reason = ${reason},
          updated_at = greatest(clock_timestamp(), r.updated_at + interval '1 microsecond')
        where ${this.attemptGuard(a)} and r.state in ('reserved', 'blocked_execution')
          and r.reservation_expires_at = ${pgTimestamp(a.deadline)} returning r.asset_id`.execute(
        tx,
      );
      this.one(result.rows);
      return 'blocked' as const;
    });
  }
}
