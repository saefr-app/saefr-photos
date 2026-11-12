import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AssetDeletionRepository } from '../src/assets/asset-deletion.repository.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import {
  exactPgTimestamp,
  pgTimestamp,
  positivePgBigint,
} from '../src/worker/exact-pg-values.js';
import { MaintenanceRetryRepository } from '../src/worker/maintenance-retry.repository.js';
import { testConfig } from './helpers/integration-database.js';

describe('M13B.3 database-only retry primitives on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let first: Kysely<Database>;
  let second: Kysely<Database>;
  let manualDb: DatabaseService;
  let databaseName: string;
  let a: MaintenanceRetryRepository;
  let b: MaintenanceRetryRepository;
  const binding = {
    singleton: true,
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
    storage_layout_version: 1,
  };

  beforeAll(async () => {
    const config = testConfig(); // Verifies container identity, tmpfs, isolated credentials and loopback.
    admin = new DatabaseService(config);
    databaseName = `saefr_retry_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const pool = (applicationName: string) =>
      new Pool({
        host: '127.0.0.1',
        port: config.getOrThrow<number>('POSTGRES_PORT'),
        database: databaseName,
        user: config.getOrThrow<string>('POSTGRES_USER'),
        password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 7000,
        application_name: applicationName,
      });
    first = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: pool('saefr_retry_first') }),
    });
    second = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: pool('saefr_retry_second') }),
    });
    manualDb = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: config.getOrThrow<number>('POSTGRES_PORT'),
        POSTGRES_DB: databaseName,
        POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
    await migrateToLatest(first);
    await first.insertInto('storage_binding').values(binding).execute();
    // Synthetic identity verifier for repository-only tests. No host storage is read.
    a = new MaintenanceRetryRepository(first, async () => binding);
    b = new MaintenanceRetryRepository(second);
  });

  afterAll(async () => {
    await manualDb?.onModuleDestroy();
    await second?.destroy();
    await first?.destroy();
    if (admin && databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  async function receipt(requestedAt?: string): Promise<string> {
    const owner = randomUUID();
    const asset = randomUUID();
    await sql`insert into public.app_user
      (id, username, password_hash, role, status, password_change_required,
       created_at, updated_at)
      values (${owner}::uuid, ${`retry_${owner.slice(0, 12)}`},
        'synthetic-hash', 'user', 'active', false, clock_timestamp(), clock_timestamp())`.execute(
      first,
    );
    await sql`insert into public.asset_deletion
      (asset_id, owner_id, accepted_lifecycle_version, storage_id,
       originals_binding_id, thumbnails_binding_id, storage_layout_version,
       original_extension, requested_at)
      values (${asset}::uuid, ${owner}::uuid, 1, ${binding.storage_id}::uuid,
        ${binding.originals_binding_id}::uuid, ${binding.thumbnails_binding_id}::uuid, 1, '.jpg',
        coalesce(${requestedAt}::timestamptz, clock_timestamp()))`.execute(
      first,
    );
    return asset;
  }

  async function due(asset: string) {
    await sql`update public.maintenance_retry_state
      set next_eligible_at = clock_timestamp() - interval '1 second'
      where asset_id = ${asset}::uuid`.execute(first);
    const snapshot = await a.read(asset);
    expect(snapshot?.next_eligible_at_exact).not.toBeNull();
    return exactPgTimestamp(snapshot!.next_eligible_at_exact!);
  }

  function attempt(asset: string, dueAt: ReturnType<typeof exactPgTimestamp>) {
    return {
      assetId: asset,
      generation: '1',
      expectedDue: dueAt,
      attemptId: randomUUID(),
      incarnationId: randomUUID(),
      permitGeneration: '3',
    };
  }

  it('round-trips six-digit UTC keys across connections, timezones and UUID tie ordering', async () => {
    const low = await receipt('2026-10-29T10:11:12.123455Z');
    const high = await receipt('2026-10-29T10:11:12.123456Z');
    const equal = await receipt('2026-10-29T10:11:12.123456Z');
    expect(await a.requestedKey(low)).toBe('2026-10-29T10:11:12.123455Z');
    const key = (await a.requestedKey(high))!;
    expect(key).toBe('2026-10-29T10:11:12.123456Z');
    await sql`set time zone 'America/New_York'`.execute(second);
    expect(await b.requestedKey(high)).toBe(key);
    const compare = await sql<{ greater: boolean; equal: boolean }>`select
      ${pgTimestamp(key)} > ${pgTimestamp((await a.requestedKey(low))!)} as greater,
      ${pgTimestamp(key)} = requested_at as equal
      from public.asset_deletion where asset_id = ${high}::uuid`.execute(
      second,
    );
    expect(compare.rows[0]).toEqual({ greater: true, equal: true });
    const ordered = await sql<{ asset_id: string }>`select asset_id
      from public.asset_deletion where asset_id in
        (${high}::uuid, ${equal}::uuid)
      order by requested_at, asset_id`.execute(second);
    expect(ordered.rows.map((row) => row.asset_id)).toEqual(
      [high, equal].sort(),
    );
  });

  it('discovers a committed pending journal once with a full minute before eligibility', async () => {
    const asset = await receipt();
    expect(await a.discover(asset)).toBe('applied');
    expect(await b.discover(asset)).toBe('stale');
    const row = await a.read(asset);
    expect(row).toMatchObject({
      state: 'due',
      generation: '1',
      lifetime_attempts: '0',
      immediate_attempts: 0,
    });
    const age = await sql<{ seconds: number }>`select
      extract(epoch from next_eligible_at - created_at)::float8 as seconds
      from public.maintenance_retry_state where asset_id = ${asset}::uuid`.execute(
      first,
    );
    expect(age.rows[0].seconds).toBeGreaterThanOrEqual(59);
    expect(age.rows[0].seconds).toBeLessThanOrEqual(61);
    expect(
      await a.reserve(
        attempt(asset, exactPgTimestamp(row!.next_eligible_at_exact!)),
      ),
    ).toBe('ineligible');
  });

  it('serializes two independent pools and increments the counter exactly once', async () => {
    const asset = await receipt();
    expect(await a.discover(asset)).toBe('applied');
    const key = await due(asset);
    const firstAttempt = attempt(asset, key);
    const secondAttempt = attempt(asset, key);
    const outcomes = await Promise.all([
      a.reserve(firstAttempt),
      b.reserve(secondAttempt),
    ]);
    expect([...outcomes].sort()).toEqual(['applied', 'stale']);
    const winner = outcomes[0] === 'applied' ? firstAttempt : secondAttempt;
    const loser = outcomes[0] === 'applied' ? secondAttempt : firstAttempt;
    expect(await b.confirmReservation(winner)).toBe(true);
    expect(await a.confirmReservation(loser)).toBe(false);
    expect(await a.read(asset)).toMatchObject({
      state: 'reserved',
      lifetime_attempts: '1',
      immediate_attempts: 1,
      attempt_id: winner.attemptId,
    });
  });

  it('rejects stale generation, wrong incarnation and replayed results without resetting counters', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const active = attempt(asset, await due(asset));
    expect(await a.reserve({ ...active, generation: '2' })).toBe('stale');
    expect(await a.reserve(active)).toBe('applied');
    expect(
      await b.settleFailure({
        ...active,
        incarnationId: randomUUID(),
        errorCode: 'filesystem_error',
        ioDrained: true,
      }),
    ).toBe('stale');
    expect(
      await a.settleFailure({
        ...active,
        errorCode: 'filesystem_error',
        ioDrained: true,
      }),
    ).toBe('applied');
    expect(
      await b.settleFailure({
        ...active,
        errorCode: 'filesystem_error',
        ioDrained: true,
      }),
    ).toBe('stale');
    expect(await a.read(asset)).toMatchObject({
      state: 'due',
      lifetime_attempts: '1',
      immediate_attempts: 1,
      attempt_id: null,
      last_error_code: 'filesystem_error',
    });
  });

  it('preserves the immediate and cooling attempt ceilings', async () => {
    const asset = await receipt();
    await a.discover(asset);
    for (let number = 1; number <= 4; number++) {
      const active = attempt(asset, await due(asset));
      expect(await a.reserve(active)).toBe('applied');
      const current = await a.read(asset);
      expect(current?.attempt_kind).toBe(
        number === 4 ? 'cooling' : 'immediate',
      );
      expect(
        await a.settleFailure({
          ...active,
          errorCode: 'unknown_outcome',
          ioDrained: true,
        }),
      ).toBe('applied');
      const next = await a.read(asset);
      expect(next?.immediate_attempts).toBe(Math.min(number, 3));
      expect(next?.lifetime_attempts).toBe(String(number));
      expect(next?.state).toBe(number >= 3 ? 'cooling' : 'due');
    }
  });

  it('keeps admission blocks and due time, and requires revalidation to release', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const before = await a.read(asset);
    expect(
      await a.blockAdmission(asset, '1', 'storage_identity_mismatch'),
    ).toBe('applied');
    expect(await a.read(asset)).toMatchObject({
      state: 'blocked_admission',
      blocked_reason: 'storage_identity_mismatch',
      next_eligible_at_exact: before!.next_eligible_at_exact,
    });
    expect(
      await b.releaseAdmissionAfterVerification(
        asset,
        '1',
        'storage_identity_mismatch',
      ),
    ).toBe('ineligible');
    const wrongBinding = new MaintenanceRetryRepository(first, async () => ({
      ...binding,
      originals_binding_id: randomUUID(),
    }));
    expect(
      await wrongBinding.releaseAdmissionAfterVerification(
        asset,
        '1',
        'storage_identity_mismatch',
      ),
    ).toBe('ineligible');
    expect((await a.read(asset))?.state).toBe('blocked_admission');
    expect(
      await a.releaseAdmissionAfterVerification(
        asset,
        '1',
        'storage_identity_mismatch',
      ),
    ).toBe('applied');
    expect((await a.read(asset))?.next_eligible_at_exact).toBe(
      before!.next_eligible_at_exact,
    );
  });

  it('retains attempt evidence in an execution block and refuses unverified clearance', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const active = attempt(asset, await due(asset));
    await a.reserve(active);
    expect(
      await a.blockExecution({ ...active, reason: 'quiescence_unknown' }),
    ).toBe('applied');
    const row = await a.read(asset);
    expect(row).toMatchObject({
      state: 'blocked_execution',
      attempt_id: active.attemptId,
      worker_incarnation_id: active.incarnationId,
      permit_generation: '3',
      lifetime_attempts: '1',
    });
    expect(
      await a.hasMatchingClearance({ ...active, clearanceId: randomUUID() }),
    ).toBe(false);
    const clearanceId = randomUUID();
    await sql`insert into public.maintenance_takeover_clearance
      (clearance_id, asset_id, blocked_generation, blocked_attempt_id,
       blocked_worker_incarnation_id, blocked_permit_generation,
       blocked_journal_execution_token, disarmed_permit_generation,
       operator_reference, evidence_reference, recorded_at)
      values (${clearanceId}::uuid, ${asset}::uuid, 1, ${active.attemptId}::uuid,
        ${active.incarnationId}::uuid, 3, null, 4,
        'synthetic-operator', 'synthetic-quiescence', clock_timestamp())`.execute(
      first,
    );
    expect(await a.hasMatchingClearance({ ...active, clearanceId })).toBe(true);
    expect(
      await a.hasMatchingClearance({
        ...active,
        clearanceId,
        incarnationId: randomUUID(),
      }),
    ).toBe(false);
    expect(
      await a.hasMatchingClearance({
        ...active,
        clearanceId,
        permitGeneration: '4',
      }),
    ).toBe(false);
    expect(
      await a.settleFailure({
        ...active,
        errorCode: 'unknown_outcome',
        ioDrained: true,
      }),
    ).toBe('stale');
  });

  it('fences generation replacement with exact revision and preserves cooldown', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const before = (await a.read(asset))!;
    expect(
      await a.advanceGenerationAfterTerminalDelivery({
        assetId: asset,
        generation: '1',
        expectedRevision: exactPgTimestamp(before.updated_at_exact),
        terminalDeliveryVerified: true,
      }),
    ).toBe('applied');
    expect(
      await b.advanceGenerationAfterTerminalDelivery({
        assetId: asset,
        generation: '1',
        expectedRevision: exactPgTimestamp(before.updated_at_exact),
        terminalDeliveryVerified: true,
      }),
    ).toBe('stale');
    expect(await a.read(asset)).toMatchObject({
      generation: '2',
      lifetime_attempts: '0',
      immediate_attempts: 0,
      next_eligible_at_exact: before.next_eligible_at_exact,
    });
    expect(
      await a.reserve(
        attempt(asset, exactPgTimestamp(before.next_eligible_at_exact!)),
      ),
    ).toBe('stale');
  });

  it('rejects journal/asset inconsistency and closes only after journal completion', async () => {
    const asset = await receipt();
    await a.discover(asset);
    expect(await a.closeCompleted(asset, '1')).toBe('ineligible');
    await sql`update public.asset_deletion
      set completed_at = clock_timestamp() where asset_id = ${asset}::uuid`.execute(
      first,
    );
    expect(await a.closeCompleted(asset, '1')).toBe('applied');
    expect(await b.closeCompleted(asset, '1')).toBe('applied');
    expect(await a.read(asset)).toMatchObject({
      state: 'closed',
      attempt_id: null,
      next_eligible_at_exact: null,
    });
  });

  async function completeManually(asset: string) {
    const { owner_id: owner } = await first
      .selectFrom('asset_deletion')
      .select('owner_id')
      .where('asset_id', '=', asset)
      .executeTakeFirstOrThrow();
    const manual = new AssetDeletionRepository(manualDb);
    const claim = await manual.claim(asset, owner);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed')
      throw new Error('Synthetic claim unavailable');
    expect(
      await manual.completeAfterVerifiedRemoval(asset, owner, claim.token),
    ).toBe(true);
  }

  it.each(['reserved', 'blocked_execution'] as const)(
    'preserves all %s evidence after manual journal completion',
    async (state) => {
      const asset = await receipt();
      await a.discover(asset);
      const active = attempt(asset, await due(asset));
      expect(await a.reserve(active)).toBe('applied');
      if (state === 'blocked_execution') {
        // A retained token identifies the unresolved predecessor, independently
        // of the later manual claim that completes the journal.
        await sql`update public.asset_deletion set execution_token = ${randomUUID()}::uuid,
          execution_expires_at = clock_timestamp() - interval '1 second'
          where asset_id = ${asset}::uuid`.execute(first);
        expect(
          await a.blockExecution({ ...active, reason: 'quiescence_unknown' }),
        ).toBe('applied');
      }
      const before = await a.read(asset);
      if (state === 'blocked_execution')
        expect(before?.journal_execution_token).not.toBeNull();
      const clearances = await first
        .selectFrom('maintenance_takeover_clearance')
        .selectAll()
        .where('asset_id', '=', asset)
        .execute();
      await completeManually(asset);
      expect(await b.closeCompleted(asset, '1')).toBe('ineligible');
      expect(await b.closeCompleted(asset, '1')).toBe('ineligible');
      expect(await a.read(asset)).toEqual(before);
      expect(
        await first
          .selectFrom('maintenance_takeover_clearance')
          .selectAll()
          .where('asset_id', '=', asset)
          .execute(),
      ).toEqual(clearances);
    },
  );

  it.each(['due', 'cooling'] as const)(
    'closes only passive %s and preserves historical fields idempotently',
    async (state) => {
      const asset = await receipt();
      await a.discover(asset);
      for (let i = 0; i < (state === 'cooling' ? 3 : 1); i++) {
        const active = attempt(asset, await due(asset));
        expect(await a.reserve(active)).toBe('applied');
        expect(
          await a.settleFailure({
            ...active,
            errorCode: 'filesystem_error',
            ioDrained: true,
          }),
        ).toBe('applied');
      }
      const before = (await a.read(asset))!;
      expect(before.state).toBe(state);
      await completeManually(asset);
      expect(await b.closeCompleted(asset, '2')).toBe('stale');
      expect(await a.read(asset)).toEqual(before);
      expect(await a.closeCompleted(asset, '1')).toBe('applied');
      const closed = (await a.read(asset))!;
      expect(closed).toMatchObject({
        ...before,
        state: 'closed',
        next_eligible_at_exact: null,
        updated_at_exact: expect.any(String),
      });
      expect(await b.closeCompleted(asset, '1')).toBe('applied');
      expect(await b.closeCompleted(asset, '2')).toBe('stale');
      expect(await a.read(asset)).toEqual(closed);
    },
  );

  it('refuses generic closure of a blocked admission without changing evidence', async () => {
    const asset = await receipt();
    await a.discover(asset);
    await a.blockAdmission(asset, '1', 'storage_identity_mismatch');
    const before = await a.read(asset);
    await completeManually(asset);
    expect(await a.closeCompleted(asset, '1')).toBe('ineligible');
    expect(await a.read(asset)).toEqual(before);
  });

  it.each(['reservation', 'closure'] as const)(
    'revalidates completion and eligibility after a contended %s transaction',
    async (winner) => {
      const asset = await receipt();
      await a.discover(asset);
      const active = attempt(asset, await due(asset));
      if (winner === 'closure') await completeManually(asset);
      let unlock!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const paused = new Proxy(first, {
        get(target, property) {
          if (property === 'transaction')
            return () => ({
              execute: async (
                callback: Parameters<
                  ReturnType<typeof target.transaction>['execute']
                >[0],
              ) =>
                target.transaction().execute(async (tx) => {
                  const result = await callback(tx);
                  if (winner === 'reservation') {
                    // Controlled manual-completion fixture in the same held transaction.
                    await sql`update public.asset_deletion set completed_at = clock_timestamp()
                    where asset_id = ${asset}::uuid`.execute(tx);
                  }
                  acquired();
                  await held;
                  return result;
                }),
            });
          return Reflect.get(target, property);
        },
      });
      const repo = new MaintenanceRetryRepository(paused);
      const leading =
        winner === 'reservation'
          ? repo.reserve(active)
          : repo.closeCompleted(asset, '1');
      let trailing: Promise<unknown> | undefined;
      try {
        await locked;
        trailing =
          winner === 'reservation'
            ? b.closeCompleted(asset, '1')
            : b.reserve(active);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const activity = await sql<{
            waiting: boolean;
          }>`select exists(select 1
            from pg_catalog.pg_stat_activity where datname = ${databaseName}
            and application_name = 'saefr_retry_second' and wait_event_type = 'Lock') as waiting`.execute(
            admin.db,
          );
          if (activity.rows[0].waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        unlock();
        expect(await leading).toBe('applied');
        expect(await trailing).toBe('ineligible');
        expect(await a.read(asset)).toMatchObject(
          winner === 'reservation'
            ? {
                state: 'reserved',
                attempt_id: active.attemptId,
                generation: '1',
                lifetime_attempts: '1',
              }
            : {
                state: 'closed',
                attempt_id: null,
                generation: '1',
                lifetime_attempts: '0',
              },
        );
      } finally {
        unlock();
        await leading;
        await trailing;
      }
    },
  );

  it('rejects missing receipts and integer overflow without mutation', async () => {
    expect(await a.discover(randomUUID())).toBe('missing');
    const asset = await receipt();
    await a.discover(asset);
    await sql`update public.maintenance_retry_state
      set generation = 9223372036854775807 where asset_id = ${asset}::uuid`.execute(
      first,
    );
    const row = (await a.read(asset))!;
    expect(
      await a.advanceGenerationAfterTerminalDelivery({
        assetId: asset,
        generation: row.generation,
        expectedRevision: exactPgTimestamp(row.updated_at_exact),
        terminalDeliveryVerified: true,
      }),
    ).toBe('overflow');
    await sql`update public.maintenance_retry_state
      set lifetime_attempts = 9223372036854775807
      where asset_id = ${asset}::uuid`.execute(first);
    const key = await due(asset);
    expect(
      await a.reserve({ ...attempt(asset, key), generation: row.generation }),
    ).toBe('overflow');
    expect(() => positivePgBigint('9223372036854775808')).toThrow();
  });

  it('refuses automatic reservation during a live M12 manual journal claim', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const key = await due(asset);
    const owner = (
      await sql<{ owner_id: string }>`select owner_id
      from public.asset_deletion where asset_id = ${asset}::uuid`.execute(first)
    ).rows[0].owner_id;
    const manual = new AssetDeletionRepository(manualDb);
    const claim = await manual.claim(asset, owner);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed')
      throw new Error('Synthetic claim unavailable');
    expect(await a.reserve(attempt(asset, key))).toBe('ineligible');
    expect(
      await manual.recordFailure(asset, owner, claim.token, 'filesystem_error'),
    ).toBe(true);
    expect(await a.reserve(attempt(asset, key))).toBe('applied');
  });

  it('reports the precise existing CHECK constraint for invalid retry shape', async () => {
    const asset = await receipt();
    await a.discover(asset);
    await expect(
      sql`update public.maintenance_retry_state
      set next_eligible_at = null where asset_id = ${asset}::uuid`.execute(
        first,
      ),
    ).rejects.toMatchObject({
      constraint: 'maintenance_retry_state_shape_check',
    });
    await expect(
      sql`update public.maintenance_retry_state
      set lifetime_attempts = -1 where asset_id = ${asset}::uuid`.execute(
        first,
      ),
    ).rejects.toMatchObject({
      constraint: 'maintenance_retry_state_counters_check',
    });
  });

  it('returns uncertain on lock timeout and allows an independent positive read', async () => {
    const asset = await receipt();
    await a.discover(asset);
    let unlock!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = first.transaction().execute(async (tx) => {
      await sql`select asset_id from public.asset_deletion
        where asset_id = ${asset}::uuid for update`.execute(tx);
      acquired();
      await held;
    });
    try {
      await locked;
      expect(await b.blockAdmission(asset, '1', 'journal_inconsistent')).toBe(
        'uncertain',
      );
      expect((await b.read(asset))?.state).toBe('due');
    } finally {
      unlock();
      await holder;
    }
  });

  it('requires an independent positive read after a simulated lost COMMIT acknowledgement', async () => {
    const asset = await receipt();
    // The real Kysely transaction commits in PostgreSQL, then the test wrapper
    // loses only its acknowledgement to the repository. No database is mocked.
    const lostAcknowledgement = new Proxy(first, {
      get(target, property) {
        if (property === 'transaction') {
          return () => ({
            execute: async (
              callback: Parameters<
                ReturnType<typeof target.transaction>['execute']
              >[0],
            ) => {
              await target.transaction().execute(callback);
              throw new Error('Synthetic lost commit acknowledgement');
            },
          });
        }
        return Reflect.get(target, property);
      },
    }) as Kysely<Database>;
    const uncertain = new MaintenanceRetryRepository(lostAcknowledgement);
    expect(await uncertain.discover(asset)).toBe('uncertain');
    expect(await b.read(asset)).toMatchObject({
      generation: '1',
      state: 'due',
      lifetime_attempts: '0',
    });
    expect(await a.discover(asset)).toBe('stale');
  });

  it('confirms the exact reservation tuple after a lost COMMIT acknowledgement without reserving again', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const active = attempt(asset, await due(asset));
    const lost = new Proxy(first, {
      get(target, property) {
        if (property === 'transaction')
          return () => ({
            execute: async (
              callback: Parameters<
                ReturnType<typeof target.transaction>['execute']
              >[0],
            ) => {
              await target.transaction().execute(callback);
              throw new Error('Synthetic lost reservation acknowledgement');
            },
          });
        return Reflect.get(target, property);
      },
    });
    expect(await new MaintenanceRetryRepository(lost).reserve(active)).toBe(
      'uncertain',
    );
    expect(await b.confirmReservation(active)).toBe(true);
    for (const wrong of [
      { ...active, generation: '2' },
      { ...active, attemptId: randomUUID() },
      { ...active, incarnationId: randomUUID() },
      { ...active, permitGeneration: '4' },
    ])
      expect(await b.confirmReservation(wrong)).toBe(false);
    const unavailable = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: '127.0.0.1',
          port: 1,
          connectionTimeoutMillis: 200,
        }),
      }),
    });
    try {
      await expect(
        new MaintenanceRetryRepository(unavailable).confirmReservation(active),
      ).rejects.toThrow();
    } finally {
      await unavailable.destroy();
    }
    expect(await b.reserve(active)).toBe('stale');
    expect(await a.read(asset)).toMatchObject({
      state: 'reserved',
      generation: '1',
      attempt_id: active.attemptId,
      worker_incarnation_id: active.incarnationId,
      permit_generation: active.permitGeneration,
      lifetime_attempts: '1',
      immediate_attempts: 1,
    });
  });

  it('rejects an attempt whose reservation expires while waiting on the journal', async () => {
    const asset = await receipt();
    await a.discover(asset);
    const active = attempt(asset, await due(asset));
    await a.reserve(active);
    let unlock!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = first.transaction().execute(async (tx) => {
      await sql`select asset_id from public.asset_deletion
        where asset_id = ${asset}::uuid for update`.execute(tx);
      await sql`update public.maintenance_retry_state
        set reservation_expires_at = clock_timestamp() - interval '1 second'
        where asset_id = ${asset}::uuid`.execute(tx);
      acquired();
      await held;
    });
    try {
      await locked;
      const pending = b.settleFailure({
        ...active,
        errorCode: 'filesystem_error',
        ioDrained: true,
      });
      // The independent backend must actually wait for the journal lock.
      let waiting = false;
      for (let count = 0; count < 100; count++) {
        const activity = await sql<{ waiting: boolean }>`select exists(
          select 1 from pg_catalog.pg_stat_activity
          where datname = ${databaseName}
            and application_name = 'saefr_retry_second'
            and wait_event_type = 'Lock') as waiting`.execute(admin.db);
        if (activity.rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      unlock();
      await holder;
      expect(await pending).toBe('stale');
      expect((await a.read(asset))?.state).toBe('reserved');
    } finally {
      unlock();
      await holder;
    }
  });
});
