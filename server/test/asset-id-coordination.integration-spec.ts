import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  assertAssetIdNotRetired,
  lockAssetId,
} from '../src/assets/asset-id-coordination.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AssetsRepository } from '../src/assets/assets.repository.js';
import type { AuthenticatedActor } from '../src/auth/auth-session.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { testConfig } from './helpers/integration-database.js';

const owner = '00000000-0000-4000-8000-000000000a01';
const storage = '00000000-0000-4000-8000-000000000a02';
const originals = '00000000-0000-4000-8000-000000000a03';
const thumbnails = '00000000-0000-4000-8000-000000000a04';
const sessionId = '00000000-0000-4000-8000-000000000a05';
const actor: AuthenticatedActor = {
  userId: owner,
  username: 'm12cid',
  role: 'user',
  sessionId,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  passwordChangeRequired: false,
  csrfToken: Buffer.alloc(32),
};

describe('M12 asset-ID transaction coordination on disposable PostgreSQL', () => {
  let db: DatabaseService;
  beforeAll(async () => {
    db = new DatabaseService(testConfig());
    await db.ping();
    await migrateToLatest(db.db);
    await sql`insert into public.app_user values
      (${owner}::uuid, 'm12cid', 'test-hash', 'user', 'active', false,
       clock_timestamp(), clock_timestamp())`.execute(db.db);
    await sql`insert into public.auth_session values
      (${sessionId}::uuid, ${owner}::uuid, decode(repeat('ab', 32), 'hex'),
       decode(repeat('cd', 32), 'hex'), clock_timestamp(),
       clock_timestamp() + interval '1 hour')`.execute(db.db);
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
  });

  it('locks a generated ID within its transaction and releases on commit', async () => {
    const id = randomUUID();
    await db.db.transaction().execute(async (transaction) => {
      await lockAssetId(transaction, id);
      await assertAssetIdNotRetired(transaction, id);
      const contender = await sql<{ available: boolean }>`select
        pg_try_advisory_xact_lock(hashtextextended(${id}::text,
          708202610260001::bigint)) as available`.execute(db.db);
      expect(contender.rows[0].available).toBe(false);
    });
    const after = await sql<{ available: boolean }>`select
      pg_try_advisory_xact_lock(hashtextextended(${id}::text,
        708202610260001::bigint)) as available`.execute(db.db);
    expect(after.rows[0].available).toBe(true);
  });

  it('refuses a UUID retained in the deletion journal under the same lock', async () => {
    const id = randomUUID();
    await sql`insert into public.asset_deletion (
      asset_id, owner_id, accepted_lifecycle_version, storage_id,
      originals_binding_id, thumbnails_binding_id, storage_layout_version,
      original_extension, requested_at)
      values (${id}::uuid, ${owner}::uuid, 0, ${storage}::uuid,
        ${originals}::uuid, ${thumbnails}::uuid, 1, '.jpg',
        clock_timestamp())`.execute(db.db);
    try {
      await expect(
        db.db.transaction().execute(async (transaction) => {
          await lockAssetId(transaction, id);
          await assertAssetIdNotRetired(transaction, id);
        }),
      ).rejects.toThrow('Asset identifier is retired');
    } finally {
      await sql`delete from public.asset_deletion where asset_id = ${id}::uuid`.execute(
        db.db,
      );
    }
  });

  it('upload finalization waits for a competing retirement and refuses that UUID', async () => {
    const id = randomUUID();
    const other = new DatabaseService(testConfig());
    let pending: ReturnType<AssetsRepository['createForActor']> | undefined;
    try {
      await db.db.transaction().execute(async (transaction) => {
        await lockAssetId(transaction, id);
        pending = new AssetsRepository(other).createForActor(actor, {
          id,
          filename: 'probe.jpg',
          mime_type: 'image/jpeg',
          size: 1,
          storage_path: `/synthetic/originals/${id}.jpg`,
          created_at: new Date(),
        });
        await vi.waitFor(async () => {
          const waiting = await sql<{
            count: number;
          }>`select count(*)::integer as count
            from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%pg_advisory_xact_lock%'`.execute(db.db);
          expect(waiting.rows[0].count).toBeGreaterThanOrEqual(1);
        });
        await sql`insert into public.asset_deletion (
          asset_id, owner_id, accepted_lifecycle_version, storage_id,
          originals_binding_id, thumbnails_binding_id, storage_layout_version,
          original_extension, requested_at)
          values (${id}::uuid, ${owner}::uuid, 0, ${storage}::uuid,
            ${originals}::uuid, ${thumbnails}::uuid, 1, '.jpg',
            clock_timestamp())`.execute(transaction);
      });
      expect((await pending)?.status).toBe('rolled_back');
      expect(
        await db.db
          .selectFrom('asset')
          .select('id')
          .where('id', '=', id)
          .execute(),
      ).toEqual([]);
    } finally {
      await pending?.catch(() => undefined);
      await sql`delete from public.asset_deletion where asset_id = ${id}::uuid`.execute(
        db.db,
      );
      await other.onModuleDestroy();
    }
  });

  it('refuses insertion when the session expires during the asset-ID lock wait', async () => {
    const id = randomUUID();
    const other = new DatabaseService(testConfig());
    let pending: ReturnType<AssetsRepository['createForActor']> | undefined;
    try {
      await sql`update public.auth_session
        set expires_at = clock_timestamp() + interval '3 seconds'
        where id = ${sessionId}::uuid`.execute(db.db);
      await db.db.transaction().execute(async (transaction) => {
        await lockAssetId(transaction, id);
        pending = new AssetsRepository(other).createForActor(actor, {
          id,
          filename: 'expired.jpg',
          mime_type: 'image/jpeg',
          size: 1,
          storage_path: `/synthetic/originals/${id}.jpg`,
          created_at: new Date(),
        });
        await vi.waitFor(async () => {
          const waiting = await sql<{
            count: number;
          }>`select count(*)::integer as count
            from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%pg_advisory_xact_lock%'`.execute(db.db);
          expect(waiting.rows[0].count).toBeGreaterThanOrEqual(1);
        });
        // Query the database clock, rather than relying on a fixed sleep.
        await vi.waitFor(
          async () => {
            const elapsed = await sql<{ expired: boolean }>`select
            clock_timestamp() >= expires_at as expired
            from public.auth_session where id = ${sessionId}::uuid`.execute(
              db.db,
            );
            expect(elapsed.rows[0]?.expired).toBe(true);
          },
          { timeout: 10_000 },
        );
      });
      expect(await pending).toMatchObject({
        status: 'rolled_back',
        error: { status: 401 },
      });
      expect(
        await db.db
          .selectFrom('asset')
          .select('id')
          .where('id', '=', id)
          .execute(),
      ).toEqual([]);
    } finally {
      await pending?.catch(() => undefined);
      await sql`update public.auth_session
        set expires_at = clock_timestamp() + interval '1 hour'
        where id = ${sessionId}::uuid`.execute(db.db);
      await other.onModuleDestroy();
    }
  }, 15_000);

  it('still inserts an asset with a valid session after coordination', async () => {
    const id = randomUUID();
    try {
      const result = await new AssetsRepository(db).createForActor(actor, {
        id,
        filename: 'valid.jpg',
        mime_type: 'image/jpeg',
        size: 1,
        storage_path: `/synthetic/originals/${id}.jpg`,
        created_at: new Date(),
      });
      expect(result.status).toBe('committed');
      expect(
        await db.db
          .selectFrom('asset')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst(),
      ).toEqual({ id });
    } finally {
      await db.db.deleteFrom('asset').where('id', '=', id).execute();
    }
  });
});
