import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import type { AssetTable } from '../database/database.types.js';

export type AssetRecord = Pick<
  Selectable<AssetTable>,
  'id' | 'filename' | 'mime_type' | 'size' | 'created_at'
>;

export type AssetFileRecord = Pick<
  Selectable<AssetTable>,
  'id' | 'mime_type' | 'storage_path'
>;

@Injectable()
export class AssetsRepository {
  constructor(
    private readonly database: DatabaseService,
  ) {}

  async findAll(): Promise<AssetRecord[]> {
    return this.database.db
      .selectFrom('asset')
      .select([
        'id',
        'filename',
        'mime_type',
        'size',
        'created_at',
      ])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  async findById(
    assetId: string,
  ): Promise<AssetRecord | undefined> {
    return this.database.db
      .selectFrom('asset')
      .select([
        'id',
        'filename',
        'mime_type',
        'size',
        'created_at',
      ])
      .where('id', '=', assetId)
      .executeTakeFirst();
  }

  async findFileById(
    assetId: string,
  ): Promise<AssetFileRecord | undefined> {
    return this.database.db
      .selectFrom('asset')
      .select([
        'id',
        'mime_type',
        'storage_path',
      ])
      .where('id', '=', assetId)
      .executeTakeFirst();
  }
}
