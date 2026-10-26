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

export interface Database {
  asset: AssetTable;
  asset_deletion: AssetDeletionTable;
  storage_binding: StorageBindingTable;
  app_user: AppUserTable;
  auth_session: AuthSessionTable;
}
