import { type Kysely, sql } from 'kysely';

import { inspectLifecycleSchema } from '../asset-lifecycle-schema.js';
import { MigrationSafetyError } from '../legacy-asset-schema.js';
import {
  assertMaintenanceAbsent,
  inspectMaintenanceSchema,
} from '../maintenance-schema.js';

/** Installs coordination metadata only; no deletion processor is registered. */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await inspectLifecycleSchema(db)))
    throw new MigrationSafetyError('M13 requires the verified M12 schema.');
  await assertMaintenanceAbsent(db);

  await sql`create table public.maintenance_retry_state (
    asset_id uuid not null,
    generation bigint not null,
    state varchar(20) not null,
    lifetime_attempts bigint not null,
    immediate_attempts smallint not null,
    next_eligible_at timestamptz,
    attempt_id uuid,
    attempt_kind varchar(9),
    reservation_expires_at timestamptz,
    worker_incarnation_id uuid,
    permit_generation bigint,
    journal_execution_token uuid,
    blocked_reason varchar(32),
    last_error_code varchar(32),
    last_clearance_id uuid,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint maintenance_retry_state_pkey primary key (asset_id),
    constraint maintenance_retry_state_asset_id_fkey foreign key (asset_id)
      references public.asset_deletion (asset_id) match simple
      on delete restrict on update no action,
    constraint maintenance_retry_state_counters_check check (
      generation > 0 and lifetime_attempts >= 0 and
      immediate_attempts between 0 and 3 and lifetime_attempts >= immediate_attempts),
    constraint maintenance_retry_state_time_check check (
      isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at and
      (next_eligible_at is null or isfinite(next_eligible_at)) and
      (reservation_expires_at is null or isfinite(reservation_expires_at)) and
      (permit_generation is null or permit_generation > 0)),
    constraint maintenance_retry_state_error_check check (
      last_error_code is null or last_error_code in (
        'storage_unavailable', 'storage_identity_mismatch', 'unsupported_storage',
        'unexpected_file', 'permission_denied', 'filesystem_error',
        'durability_unavailable', 'inconsistent_state', 'unknown_outcome')),
    constraint maintenance_retry_state_shape_check check (
      (state in ('due', 'cooling', 'blocked_admission') and
        next_eligible_at is not null and attempt_id is null and
        attempt_kind is null and reservation_expires_at is null and
        worker_incarnation_id is null and permit_generation is null and
        journal_execution_token is null)
      or
      (state in ('reserved', 'blocked_execution') and
        next_eligible_at is null and attempt_id is not null and
        attempt_kind is not null and reservation_expires_at is not null and
        worker_incarnation_id is not null and permit_generation is not null)
      or
      (state = 'closed' and next_eligible_at is null and
        attempt_id is null and attempt_kind is null and
        reservation_expires_at is null and worker_incarnation_id is null and
        permit_generation is null and journal_execution_token is null)),
    constraint maintenance_retry_state_state_check check (
      (state = 'due' and immediate_attempts < 3 and blocked_reason is null)
      or (state = 'cooling' and immediate_attempts = 3 and blocked_reason is null)
      or (state = 'blocked_admission' and blocked_reason is not null and
        blocked_reason in ('journal_inconsistent', 'invalid_target',
          'storage_identity_mismatch', 'unsupported_storage'))
      or (state = 'reserved' and blocked_reason is null)
      or (state = 'blocked_execution' and blocked_reason is not null and
        blocked_reason in ('quiescence_unknown', 'claim_unknown',
          'provider_unknown', 'permit_changed', 'storage_identity_mismatch'))
      or (state = 'closed' and blocked_reason is null)),
    constraint maintenance_retry_state_kind_check check (
      attempt_kind is null or
      (attempt_kind = 'immediate' and immediate_attempts between 1 and 3) or
      (attempt_kind = 'cooling' and immediate_attempts = 3))
  )`.execute(db);

  await sql`create table public.maintenance_takeover_clearance (
    clearance_id uuid not null,
    asset_id uuid not null,
    blocked_generation bigint not null,
    blocked_attempt_id uuid not null,
    blocked_worker_incarnation_id uuid not null,
    blocked_permit_generation bigint not null,
    blocked_journal_execution_token uuid,
    disarmed_permit_generation bigint not null,
    operator_reference varchar(128) not null,
    evidence_reference varchar(128) not null,
    recorded_at timestamptz not null,
    constraint maintenance_takeover_clearance_pkey primary key (clearance_id),
    constraint maintenance_takeover_clearance_asset_id_fkey foreign key (asset_id)
      references public.maintenance_retry_state (asset_id) match simple
      on delete restrict on update no action,
    constraint maintenance_takeover_clearance_attempt_key unique
      (asset_id, blocked_generation, blocked_attempt_id),
    constraint maintenance_takeover_clearance_asset_clearance_key unique
      (asset_id, clearance_id),
    constraint maintenance_takeover_clearance_values_check check (
      blocked_generation > 0 and blocked_permit_generation > 0 and
      disarmed_permit_generation > blocked_permit_generation and
      isfinite(recorded_at)),
    constraint maintenance_takeover_clearance_references_check check (
      operator_reference ~ '^[A-Za-z0-9._-]{1,128}$' and
      evidence_reference ~ '^[A-Za-z0-9._-]{1,128}$')
  )`.execute(db);

  await sql`alter table public.maintenance_retry_state
    add constraint maintenance_retry_state_last_clearance_fkey
    foreign key (asset_id, last_clearance_id)
    references public.maintenance_takeover_clearance (asset_id, clearance_id)
    match simple on delete restrict on update no action`.execute(db);

  await sql`create table public.maintenance_reconciliation (
    singleton boolean not null,
    leader_epoch bigint not null,
    leader_token uuid,
    leader_expires_at timestamptz,
    pass_status varchar(10) not null,
    pass_id uuid,
    pass_owner_epoch bigint,
    upper_requested_at timestamptz,
    upper_asset_id uuid,
    cursor_requested_at timestamptz,
    cursor_asset_id uuid,
    updated_at timestamptz not null,
    constraint maintenance_reconciliation_pkey primary key (singleton),
    constraint maintenance_reconciliation_singleton_check check (singleton = true),
    constraint maintenance_reconciliation_leader_check check (
      leader_epoch >= 0 and
      (leader_token is null) = (leader_expires_at is null) and
      (leader_expires_at is null or isfinite(leader_expires_at)) and
      isfinite(updated_at)),
    constraint maintenance_reconciliation_pass_check check (
      pass_status in ('incomplete', 'complete') and
      ((pass_id is null and pass_owner_epoch is null and
        upper_requested_at is null and upper_asset_id is null and
        cursor_requested_at is null and cursor_asset_id is null and
        pass_status = 'complete')
       or
       (pass_id is not null and pass_owner_epoch is not null and
        pass_owner_epoch > 0 and pass_owner_epoch <= leader_epoch and
        upper_requested_at is not null and isfinite(upper_requested_at) and
        upper_asset_id is not null and
        ((cursor_requested_at is null and cursor_asset_id is null) or
         (cursor_requested_at is not null and isfinite(cursor_requested_at) and
          cursor_asset_id is not null and
          (cursor_requested_at, cursor_asset_id) <=
            (upper_requested_at, upper_asset_id)))))
  ))`.execute(db);

  await sql`insert into public.maintenance_reconciliation
    (singleton, leader_epoch, pass_status, updated_at)
    values (true, 0, 'complete', clock_timestamp())`.execute(db);

  await sql`create index asset_deletion_pending_global_requested_id_idx
    on public.asset_deletion (requested_at asc, asset_id asc)
    where completed_at is null`.execute(db);
  await sql`create index maintenance_retry_due_idx
    on public.maintenance_retry_state (next_eligible_at asc, asset_id asc)
    where state in ('due', 'cooling')`.execute(db);
  await sql`create unique index maintenance_retry_attempt_id_idx
    on public.maintenance_retry_state (attempt_id)
    where attempt_id is not null`.execute(db);

  await inspectMaintenanceSchema(db);
}

export async function down(): Promise<never> {
  throw new MigrationSafetyError(
    'M13 maintenance coordination cannot be rolled back automatically; retained retry and clearance state requires a reviewed recovery plan.',
  );
}
