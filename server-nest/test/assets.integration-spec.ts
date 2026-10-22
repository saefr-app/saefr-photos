import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AssetsRepository } from '../src/assets/assets.repository.js';
import { AssetsService } from '../src/assets/assets.service.js';
import type { AssetTable } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { testConfig } from './helpers/integration-database.js';
import { HealthService } from '../src/health/health.service.js';
import type { LocalStorageService } from '../src/storage/local-storage.service.js';

const ids = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
  missing: '00000000-0000-4000-8000-000000000099',
};
const ownerId = '00000000-0000-4000-8000-000000000100';

function asset(
  id: string,
  createdAt = new Date('2026-10-16T12:00:00.000Z'),
): Omit<AssetTable, 'owner_id'> & { owner_id: string } {
  return {
    id,
    filename: `${id}.jpg`,
    mime_type: 'image/jpeg',
    size: 1234,
    storage_path: `/isolated-test/originals/${id}.jpg`,
    created_at: createdAt,
    owner_id: ownerId,
  };
}

describe('AssetsRepository with disposable PostgreSQL 18', () => {
  let database: DatabaseService;
  let repository: AssetsRepository;
  let config: ConfigService;

  beforeAll(async () => {
    config = testConfig();
    database = new DatabaseService(config);
    await database.ping();

    const identity = await sql<{
      database_name: string;
      user_name: string;
      version_number: number;
    }>`select current_database() as database_name,
       current_user as user_name,
       current_setting('server_version_num')::integer as version_number`.execute(
      database.db,
    );
    expect(identity.rows[0]).toEqual({
      database_name: process.env.SAEFR_M7_TEST_DB,
      user_name: 'saefr_m7_test',
      version_number: expect.any(Number),
    });
    expect(identity.rows[0].version_number).toBeGreaterThanOrEqual(180000);
    expect(identity.rows[0].version_number).toBeLessThan(190000);

    await migrateToLatest(database.db);
    await sql`insert into public.app_user values
      (${ownerId}::uuid, 'assetfixture', 'test-hash', 'user', 'active', false,
       '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z')`.execute(database.db);
    repository = new AssetsRepository(database);
  });

  beforeEach(async () => {
    await sql`delete from asset`.execute(database.db);
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it('uses the legacy UUID, integer, path and time-zone column types', async () => {
    const result = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>`select column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = 'public' and table_name = 'asset'
       order by ordinal_position`.execute(database.db);

    expect(result.rows).toEqual([
      {
        column_name: 'filename',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
      {
        column_name: 'mime_type',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
      { column_name: 'size', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      {
        column_name: 'storage_path',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
      {
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      { column_name: 'owner_id', data_type: 'uuid', is_nullable: 'YES' },
    ]);
  });

  it('creates and reads metadata and internal storage path by UUID', async () => {
    const input = asset(ids.first);
    const created = await repository.create(input);
    expect(created).toMatchObject({
      id: input.id,
      filename: input.filename,
      mime_type: input.mime_type,
      size: input.size,
    });
    expect(created.created_at).toBeInstanceOf(Date);
    expect(created).not.toHaveProperty('storage_path');
    expect(await repository.findById(input.id)).toEqual(created);
    expect(await repository.findFileById(input.id)).toEqual({
      id: input.id,
      mime_type: input.mime_type,
      storage_path: input.storage_path,
    });
  });

  it('returns undefined for missing metadata and file records', async () => {
    await expect(repository.findById(ids.missing)).resolves.toBeUndefined();
    await expect(repository.findFileById(ids.missing)).resolves.toBeUndefined();
  });

  it('lists newest first and resolves equal timestamps by descending UUID', async () => {
    const older = asset(ids.first, new Date('2026-10-15T12:00:00.000Z'));
    const sameTime = new Date('2026-10-16T12:00:00.000Z');
    await repository.create(older);
    await repository.create(asset(ids.second, sameTime));
    await repository.create(asset(ids.third, sameTime));

    const records = await repository.findAll();
    expect(records.map((record) => record.id)).toEqual([
      ids.third,
      ids.second,
      ids.first,
    ]);
    expect(records.every((record) => !('storage_path' in record))).toBe(true);
  });

  it('round-trips offset timestamps and serializes public UTC metadata', async () => {
    const input = asset(ids.first);
    await sql`insert into asset (id, filename, mime_type, size, storage_path, created_at, owner_id)
      values (${input.id}::uuid, ${input.filename}, ${input.mime_type},
        ${input.size}, ${input.storage_path}, ${'2026-10-16 17:30:00+05:30'}::timestamptz,
        ${ownerId}::uuid)`.execute(database.db);
    const stored = await repository.findById(input.id);
    expect(stored?.created_at).toBeInstanceOf(Date);
    expect(stored?.created_at.toISOString()).toBe('2026-10-16T12:00:00.000Z');

    const service = new AssetsService(repository, {} as LocalStorageService);
    const response = await service.findById(input.id);
    expect(response).toEqual({
      id: input.id,
      filename: input.filename,
      mime_type: input.mime_type,
      size: input.size,
      created_at: '2026-10-16T12:00:00.000Z',
    });
    expect(response).not.toHaveProperty('storage_path');
  });

  it('enforces the legacy 32-bit integer size limit', async () => {
    const maximum = asset(ids.first);
    maximum.size = 2_147_483_647;
    expect((await repository.create(maximum)).size).toBe(maximum.size);

    const tooLarge = asset(ids.second);
    tooLarge.size = 2_147_483_648;
    await expect(repository.create(tooLarge)).rejects.toThrow(/out of range/i);
    await expect(repository.findById(tooLarge.id)).resolves.toBeUndefined();
  });

  it('reports readiness from a real ping and 503 after its pool closes', async () => {
    const separateDatabase = new DatabaseService(config);
    const health = new HealthService(separateDatabase);
    try {
      await expect(health.getReadiness()).resolves.toEqual({
        status: 'ok',
        database: 'connected',
      });
    } finally {
      await separateDatabase.onModuleDestroy();
    }
    await expect(health.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
