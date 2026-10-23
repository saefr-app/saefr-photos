import type { ColumnType } from 'kysely';

export interface AssetTable {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: Date;
  owner_id: ColumnType<string | null, string, string | null>;
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
  app_user: AppUserTable;
  auth_session: AuthSessionTable;
}
