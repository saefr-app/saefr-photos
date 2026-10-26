import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AssetDeletionRepository,
  type ClaimResult,
} from '../src/assets/asset-deletion.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  createMigrationDatabase,
  migrationConfig,
} from '../src/database/migrations/migration-config.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { testConfig } from './helpers/integration-database.js';

describe('M12B deletion journal claims on disposable PostgreSQL 18', () => {
  let admin: DatabaseService;
  let db: Kysely<unknown>;
  let repository: AssetDeletionRepository;
  let contenderA: Kysely<unknown>;
  let contenderB: Kysely<unknown>;
  let repositoryA: AssetDeletionRepository;
  let repositoryB: AssetDeletionRepository;
  let databaseName: string;
  const contenderAName = 'saefr_m12b_claim_a';
  const contenderBName = 'saefr_m12b_claim_b';
  const ownerId = '00000000-0000-4000-8000-000000000901';
  const foreignId = '00000000-0000-4000-8000-000000000902';
  const storageId = '00000000-0000-4000-8000-000000000903';
  const originalsId = '00000000-0000-4000-8000-000000000904';
  const thumbnailsId = '00000000-0000-4000-8000-000000000905';

  async function journal(assetId = randomUUID()) {
    await sql`insert into public.asset_deletion (
      asset_id, owner_id, accepted_lifecycle_version, storage_id,
      originals_binding_id, thumbnails_binding_id, storage_layout_version,
      original_extension, requested_at, completed_at, last_error_code,
      execution_token, execution_expires_at)
      values (${assetId}::uuid, ${ownerId}::uuid, 0, ${storageId}::uuid,
        ${originalsId}::uuid, ${thumbnailsId}::uuid, 1, '.jpg',
        clock_timestamp(), null, null, null, null)`.execute(db);
    return assetId;
  }

  async function waitForRowLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const active = await sql<{
        waiting: number;
      }>`select count(*)::integer as waiting
        from pg_catalog.pg_stat_activity
        where datname = ${databaseName} and application_name = ${applicationName}
          and wait_event_type = 'Lock' and query like '%asset_deletion%'`.execute(
        admin.db,
      );
      if (active.rows[0].waiting === 1) return;
      await delay(10);
    }
    throw new Error(
      'Expected a separate PostgreSQL backend to wait for the journal lock',
    );
  }

  async function holdJournalLock(assetId: string) {
    let unlock!: () => void;
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => (unlock = resolve));
    const acquired = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    let holder!: Kysely<unknown>;
    const transaction = db
      .transaction()
      .execute(async (connection) => {
        await sql`select asset_id from public.asset_deletion
          where asset_id = ${assetId}::uuid for update`.execute(connection);
        holder = connection;
        ready();
        await gate;
      })
      .catch((error: unknown) => {
        failed(error);
        throw error;
      });
    await acquired;
    return {
      async waitPastExpiry() {
        // The contender is already observed waiting on this row. Advance by
        // the database's remaining lease time, then prove expiry before unlock.
        await sql`select pg_sleep(least(3.0,
          greatest(0.0, extract(epoch from (execution_expires_at - clock_timestamp()))) + 0.02))
          from public.asset_deletion where asset_id = ${assetId}::uuid`.execute(
          holder,
        );
        const state = await sql<{ expired: boolean }>`select
          execution_expires_at <= clock_timestamp() as expired
          from public.asset_deletion where asset_id = ${assetId}::uuid`.execute(
          holder,
        );
        expect(state.rows[0].expired).toBe(true);
      },
      async release() {
        unlock();
        await transaction;
      },
    };
  }

  beforeAll(async () => {
    const config = testConfig();
    admin = new DatabaseService(config);
    databaseName = `saefr_m12_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const isolatedConfig = migrationConfig({
      MIGRATION_POSTGRES_HOST: '127.0.0.1',
      MIGRATION_POSTGRES_PORT: String(
        config.getOrThrow<number>('POSTGRES_PORT'),
      ),
      MIGRATION_POSTGRES_DB: databaseName,
      MIGRATION_POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
      MIGRATION_POSTGRES_PASSWORD:
        config.getOrThrow<string>('POSTGRES_PASSWORD'),
    });
    db = createMigrationDatabase(isolatedConfig);
    // Separate pools with separate PostgreSQL backend sessions. The migration
    // pool's max: 1 is retained; production pooling is not changed.
    contenderA = createMigrationDatabase({
      ...isolatedConfig,
      application_name: contenderAName,
      idleTimeoutMillis: 30_000,
    });
    contenderB = createMigrationDatabase({
      ...isolatedConfig,
      application_name: contenderBName,
      idleTimeoutMillis: 30_000,
    });
    await migrateToLatest(db);
    for (const [id, username] of [
      [ownerId, 'owner'],
      [foreignId, 'foreign'],
    ]) {
      await sql`insert into public.app_user values
        (${id}::uuid, ${username}, 'synthetic-hash', 'user', 'active', false,
         clock_timestamp(), clock_timestamp())`.execute(db);
    }
    repository = new AssetDeletionRepository({ db } as DatabaseService);
    repositoryA = new AssetDeletionRepository({
      db: contenderA,
    } as DatabaseService);
    repositoryB = new AssetDeletionRepository({
      db: contenderB,
    } as DatabaseService);
  });

  beforeEach(async () => {
    await sql`delete from public.asset`.execute(db);
    await sql`delete from public.asset_deletion`.execute(db);
  });

  afterAll(async () => {
    await contenderA?.destroy();
    await contenderB?.destroy();
    await db?.destroy();
    if (admin && databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  it('scopes retained receipts to their owner and preserves immutable targets', async () => {
    const id = await journal();
    expect(await repository.findForOwner(id, foreignId)).toBeUndefined();
    const before = await repository.findForOwner(id, ownerId);
    expect(before?.accepted_lifecycle_version).toBe('0');
    const result = await repository.claim(id, ownerId);
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') throw new Error('Expected claim');
    expect(
      await repository.recordFailure(
        id,
        ownerId,
        result.token,
        'filesystem_error',
      ),
    ).toBe(true);
    const after = await repository.findForOwner(id, ownerId);
    expect(after).toMatchObject({
      asset_id: before?.asset_id,
      owner_id: before?.owner_id,
      accepted_lifecycle_version: before?.accepted_lifecycle_version,
      storage_id: before?.storage_id,
      originals_binding_id: before?.originals_binding_id,
      thumbnails_binding_id: before?.thumbnails_binding_id,
      storage_layout_version: before?.storage_layout_version,
      original_extension: before?.original_extension,
      requested_at: before?.requested_at,
      last_error_code: 'filesystem_error',
    });
  });

  it('enforces journal values, paired claims and completed-state constraints', async () => {
    const id = await journal();
    await expect(
      sql`update public.asset_deletion set original_extension = '.gif'
      where asset_id = ${id}::uuid`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.asset_deletion set accepted_lifecycle_version = -1
      where asset_id = ${id}::uuid`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.asset_deletion set execution_token = ${randomUUID()}::uuid
      where asset_id = ${id}::uuid`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.asset_deletion set completed_at = clock_timestamp(),
      last_error_code = 'filesystem_error' where asset_id = ${id}::uuid`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`update public.asset_deletion set last_error_code = 'private-path'
      where asset_id = ${id}::uuid`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('atomically grants one concurrent claim and confirms only its token', async () => {
    const id = await journal();
    const held = await holdJournalLock(id);
    const first = repositoryA.claim(id, ownerId);
    const second = repositoryB.claim(id, ownerId);
    let results: ClaimResult[];
    try {
      await Promise.all([
        waitForRowLock(contenderAName),
        waitForRowLock(contenderBName),
      ]);
    } finally {
      await held.release();
      results = await Promise.all([first, second]);
    }
    expect(results.map((result) => result.status).sort()).toEqual([
      'claimed',
      'pending',
    ]);
    const winner = results.find((result) => result.status === 'claimed');
    if (!winner || winner.status !== 'claimed')
      throw new Error('Expected claim');
    expect(await repository.confirmClaim(id, ownerId, winner.token)).toBe(true);
    expect(await repository.confirmClaim(id, foreignId, winner.token)).toBe(
      false,
    );
    expect(await repository.renew(id, ownerId, winner.token)).toBe(true);
  }, 10000);

  it.each(['renew', 'complete', 'failure'] as const)(
    'rejects %s after an initially valid claim expires during a row-lock wait',
    async (operationName) => {
      const id = await journal();
      const claim = await repository.claim(id, ownerId);
      if (claim.status !== 'claimed') throw new Error('Expected first claim');
      await sql`update public.asset_deletion
        set execution_expires_at = clock_timestamp() + interval '2 seconds'
        where asset_id = ${id}::uuid`.execute(db);
      const before = await sql<{ valid: boolean }>`select
        execution_expires_at > clock_timestamp() as valid
        from public.asset_deletion where asset_id = ${id}::uuid`.execute(db);
      expect(before.rows[0].valid).toBe(true);
      const held = await holdJournalLock(id);
      let operation: Promise<boolean> | undefined;
      try {
        operation =
          operationName === 'renew'
            ? repositoryA.renew(id, ownerId, claim.token)
            : operationName === 'complete'
              ? repositoryA.completeAfterVerifiedRemoval(
                  id,
                  ownerId,
                  claim.token,
                )
              : repositoryA.recordFailure(
                  id,
                  ownerId,
                  claim.token,
                  'filesystem_error',
                );
        await waitForRowLock(contenderAName);
        await held.waitPastExpiry();
      } finally {
        await held.release();
        // Drain even on a failed lock-order assertion before pool teardown.
        await operation?.catch(() => undefined);
      }
      if (!operation) throw new Error('Expected a waiting operation');
      expect(await operation).toBe(false);
      const receipt = await repository.findForOwner(id, ownerId);
      expect(receipt).toMatchObject({
        execution_token: claim.token,
        completed_at: null,
        last_error_code: null,
      });
    },
    10000,
  );

  it('lets an expired claim be replaced while stale tokens cannot write', async () => {
    const id = await journal();
    const first = await repository.claim(id, ownerId);
    if (first.status !== 'claimed') throw new Error('Expected first claim');
    await sql`update public.asset_deletion set execution_expires_at =
      clock_timestamp() - interval '1 second' where asset_id = ${id}::uuid`.execute(
      db,
    );
    expect(await repository.confirmClaim(id, ownerId, first.token)).toBe(false);
    const second = await repository.claim(id, ownerId);
    if (second.status !== 'claimed')
      throw new Error('Expected replacement claim');
    expect(await repository.renew(id, ownerId, first.token)).toBe(false);
    expect(
      await repository.recordFailure(
        id,
        ownerId,
        first.token,
        'unknown_outcome',
      ),
    ).toBe(false);
    expect(
      await repository.completeAfterVerifiedRemoval(id, ownerId, first.token),
    ).toBe(false);
    expect(await repository.confirmClaim(id, ownerId, second.token)).toBe(true);
    expect(
      await repository.completeAfterVerifiedRemoval(id, ownerId, second.token),
    ).toBe(true);
    expect(await repository.claim(id, ownerId)).toEqual({
      status: 'completed',
    });
    expect(await repository.renew(id, ownerId, second.token)).toBe(false);
    expect(await repository.findForOwner(id, ownerId)).toMatchObject({
      execution_token: null,
      execution_expires_at: null,
      last_error_code: null,
      completed_at: expect.any(Date),
    });
  });

  it('refuses a claim when the same asset row is still live', async () => {
    const id = await journal();
    await sql`insert into public.asset
      (id, owner_id, filename, mime_type, size, storage_path, created_at)
      values (${id}::uuid, ${ownerId}::uuid, 'synthetic.jpg', 'image/jpeg', 1,
        '/isolated-test/synthetic.jpg', clock_timestamp())`.execute(db);
    expect(await repository.claim(id, ownerId)).toEqual({
      status: 'inconsistent',
    });
  });
});
