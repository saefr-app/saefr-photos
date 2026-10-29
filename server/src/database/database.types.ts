import type { ColumnType, Generated } from 'kysely';

export interface AssetTable {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: Date;
  owner_id: ColumnType<string | null, string, string | null>;
  trashed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  lifecycle_version: Generated<string>;
}

// pg returns int8 as decimal text. Never coerce lifecycle versions to Number.
export interface AssetDeletionTable {
  asset_id: string;
  owner_id: string;
  accepted_lifecycle_version: string;
  storage_id: string;
  originals_binding_id: string;
  thumbnails_binding_id: string;
  storage_layout_version: number;
  original_extension: string;
  requested_at: Date;
  completed_at: Date | null;
  last_error_code: string | null;
  execution_token: string | null;
  execution_expires_at: Date | null;
}

export interface StorageBindingTable {
  singleton: boolean;
  storage_id: string;
  originals_binding_id: string;
  thumbnails_binding_id: string;
  storage_layout_version: number;
}

export interface AppUserTable {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  password_change_required: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AuthSessionTable {
  id: string;
  user_id: string;
  token_hash: Buffer;
  csrf_token: Buffer;
  created_at: Date;
  expires_at: Date;
}

export type MaintenanceRetryState =
  | 'due'
  | 'reserved'
  | 'cooling'
  | 'blocked_admission'
  | 'blocked_execution'
  | 'closed';

export interface MaintenanceRetryStateTable {
  asset_id: string;
  generation: string;
  state: MaintenanceRetryState;
  lifetime_attempts: string;
  immediate_attempts: number;
  next_eligible_at: Date | null;
  attempt_id: string | null;
  attempt_kind: 'immediate' | 'cooling' | null;
  reservation_expires_at: Date | null;
  worker_incarnation_id: string | null;
  permit_generation: string | null;
  journal_execution_token: string | null;
  blocked_reason: string | null;
  last_error_code: string | null;
  last_clearance_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MaintenanceTakeoverClearanceTable {
  clearance_id: string;
  asset_id: string;
  blocked_generation: string;
  blocked_attempt_id: string;
  blocked_worker_incarnation_id: string;
  blocked_permit_generation: string;
  blocked_journal_execution_token: string | null;
  disarmed_permit_generation: string;
  operator_reference: string;
  evidence_reference: string;
  recorded_at: Date;
}

export interface MaintenanceReconciliationTable {
  singleton: boolean;
  leader_epoch: string;
  leader_token: string | null;
  leader_expires_at: Date | null;
  pass_status: 'incomplete' | 'complete';
  pass_id: string | null;
  pass_owner_epoch: string | null;
  // B.2 must read these cursor keys as exact SQL text and compare in PostgreSQL.
  // The pg Date parser loses the final three of six fractional second digits.
  upper_requested_at: Date | null;
  upper_asset_id: string | null;
  cursor_requested_at: Date | null;
  cursor_asset_id: string | null;
  updated_at: Date;
}

export interface Database {
  asset: AssetTable;
  asset_deletion: AssetDeletionTable;
  storage_binding: StorageBindingTable;
  app_user: AppUserTable;
  auth_session: AuthSessionTable;
  maintenance_retry_state: MaintenanceRetryStateTable;
  maintenance_takeover_clearance: MaintenanceTakeoverClearanceTable;
  maintenance_reconciliation: MaintenanceReconciliationTable;
}
