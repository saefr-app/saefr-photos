export interface AssetTable {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: Date;
}

export interface Database {
  asset: AssetTable;
}
