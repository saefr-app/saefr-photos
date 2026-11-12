import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { MaintenanceRetryRepository } from '../src/worker/maintenance-retry.repository.js';
import {
  MaintenanceReconciliationRepository,
  type CoordinationResult,
  type CoordinatorOwner,
  type JournalKey,
  type ReconciliationSnapshot,
} from '../src/worker/maintenance-reconciliation.repository.js';
import { MaintenanceReconciliationService } from '../src/worker/maintenance-reconciliation.service.js';
import { exactPgTimestamp } from '../src/worker/exact-pg-values.js';
import { testConfig } from './helpers/integration-database.js';

const execute = promisify(execFile);
const synthetic = { purpose: 'synthetic-metadata-only' } as const;

function value<T>(result: CoordinationResult<T>): T {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok')
    throw new Error('Expected a confirmed coordinator result');
  return result.value;
}

/** Real transaction + COMMIT; only the acknowledgement is lost in this test wrapper. */
function lostAcknowledgement(db: Kysely<Database>): Kysely<Database> {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'transaction') return Reflect.get(target, key);
      return () => {
        const builder = target
          .transaction()
          .setIsolationLevel('read committed');
        const wrapper = {
          setIsolationLevel: () => wrapper,
          execute: async (callback: Parameters<typeof builder.execute>[0]) => {
            await builder.execute(callback);
            throw new Error('Synthetic lost COMMIT acknowledgement');
          },
        };
        return wrapper;
      };
    },
  });
}

describe('M13B.3 finite reconciliation on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let first: Kysely<Database>;
  let second: Kysely<Database>;
  let databaseName: string;
  let a: MaintenanceReconciliationRepository;
  let b: MaintenanceReconciliationRepository;
  let retry: MaintenanceRetryRepository;
  let service: MaintenanceReconciliationService;
  const ownerId = randomUUID();
  const binding = {
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
  };

  beforeAll(async () => {
    const config = testConfig(); // Own container, tmpfs, loopback and credentials verified before SQL.
    admin = new DatabaseService(config);
    databaseName = `saefr_reconciliation_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const connect = (applicationName: string) =>
      new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({
            host: '127.0.0.1',
            port: config.getOrThrow<number>('POSTGRES_PORT'),
            database: databaseName,
            user: config.getOrThrow<string>('POSTGRES_USER'),
            password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
            max: 1,
            connectionTimeoutMillis: 5000,
            statement_timeout: 7000,
            application_name: applicationName,
          }),
        }),
      });
    first = connect('saefr_coordinator_first');
    second = connect('saefr_coordinator_second');
    await migrateToLatest(first);
    await sql`insert into public.app_user
      (id, username, password_hash, role, status, password_change_required, created_at, updated_at)
      values (${ownerId}::uuid, 'coordinator-fixture', 'synthetic-hash', 'user', 'active', false, clock_timestamp(), clock_timestamp())`.execute(
      first,
    );
    a = new MaintenanceReconciliationRepository(first);
    b = new MaintenanceReconciliationRepository(second);
    retry = new MaintenanceRetryRepository(first);
    service = new MaintenanceReconciliationService(a, retry, 1);
  });

  beforeEach(async () => {
    await sql`truncate public.asset, public.asset_deletion, public.maintenance_retry_state,
      public.maintenance_takeover_clearance`.execute(first);
    await sql`update public.maintenance_reconciliation set leader_epoch = 0, leader_token = null,
      leader_expires_at = null, pass_status = 'complete', pass_id = null, pass_owner_epoch = null,
      upper_requested_at = null, upper_asset_id = null, cursor_requested_at = null, cursor_asset_id = null,
      updated_at = clock_timestamp()`.execute(first);
  });

  afterAll(async () => {
    await second?.destroy();
    await first?.destroy();
    if (admin && databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  async function receipt(
    at = '2026-10-29T10:11:12.123456Z',
    id = randomUUID(),
    db: Kysely<Database> | Transaction<Database> = first,
  ): Promise<JournalKey> {
    await sql`insert into public.asset_deletion
      (asset_id, owner_id, accepted_lifecycle_version, storage_id, originals_binding_id, thumbnails_binding_id,
       storage_layout_version, original_extension, requested_at)
      values (${id}::uuid, ${ownerId}::uuid, 1, ${binding.storage_id}::uuid, ${binding.originals_binding_id}::uuid,
        ${binding.thumbnails_binding_id}::uuid, 1, '.jpg', ${at}::timestamptz)`.execute(
      db,
    );
    return { requestedAt: exactPgTimestamp(at), assetId: id };
  }

  async function expire(db = first) {
    await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
      db,
    );
  }

  async function leader(): Promise<CoordinatorOwner> {
    return value(await a.acquire(randomUUID()));
  }

  async function pass(
    owner: CoordinatorOwner,
  ): Promise<ReconciliationSnapshot> {
    return value(await a.beginOrResume(owner));
  }

  async function hold(
    lockSql: ReturnType<typeof sql>,
    action: (release: () => void) => Promise<void>,
  ) {
    let unlock!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = first.transaction().execute(async (tx) => {
      await lockSql.execute(tx);
      acquired();
      await released;
    });
    try {
      await ready;
      await action(unlock);
    } finally {
      unlock();
      await holder;
    }
  }

  it('allows only one of two independent pools to acquire leadership', async () => {
    const outcomes = await Promise.all([
      a.acquire(randomUUID()),
      b.acquire(randomUUID()),
    ]);
    expect(outcomes.map((row) => row.status).sort()).toEqual(['busy', 'ok']);
    const winner = outcomes.find((row) => row.status === 'ok')!;
    const row = await b.read();
    expect(row).toMatchObject({ leader_epoch: '1', lease_live: true });
    expect(winner.status === 'ok' && winner.value.token).toBe(row.leader_token);
  });

  it('fences two independent Node processes without a process-local mutex', async () => {
    const script = `
      import { randomUUID } from 'node:crypto';
      import { Kysely, PostgresDialect } from 'kysely';
      import { Pool } from 'pg';
      import { MaintenanceReconciliationRepository } from './dist/worker/maintenance-reconciliation.repository.js';
      const db = new Kysely({dialect: new PostgresDialect({pool: new Pool({
        host:'127.0.0.1', port:Number(process.env.SAEFR_M7_TEST_PORT), database:process.env.SAEFR_COORDINATOR_FIXTURE_DB,
        user:process.env.SAEFR_M7_TEST_USER, password:process.env.SAEFR_M7_TEST_PASSWORD,
        max:1, connectionTimeoutMillis:5000, statement_timeout:7000})})});
      try { console.log(JSON.stringify(await new MaintenanceReconciliationRepository(db).acquire(randomUUID()))); }
      finally { await db.destroy(); }
    `;
    const results = await Promise.all(
      [1, 2].map(() =>
        execute(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, SAEFR_COORDINATOR_FIXTURE_DB: databaseName },
          timeout: 15000,
        }),
      ),
    );
    expect(
      results
        .map((row) => (JSON.parse(row.stdout) as { status: string }).status)
        .sort(),
    ).toEqual(['busy', 'ok']);
    expect((await a.read()).leader_epoch).toBe('1');
  });

  it('resumes a persisted partial pass after the owning process shuts down', async () => {
    const one = await receipt();
    await receipt('2026-10-29T10:11:13.123456Z');
    const script = `
      import { randomUUID } from 'node:crypto';
      import { Kysely, PostgresDialect } from 'kysely';
      import { Pool } from 'pg';
      import { MaintenanceReconciliationRepository } from './dist/worker/maintenance-reconciliation.repository.js';
      const db = new Kysely({dialect:new PostgresDialect({pool:new Pool({
        host:'127.0.0.1',port:Number(process.env.SAEFR_M7_TEST_PORT),database:process.env.SAEFR_COORDINATOR_FIXTURE_DB,
        user:process.env.SAEFR_M7_TEST_USER,password:process.env.SAEFR_M7_TEST_PASSWORD,
        max:1,connectionTimeoutMillis:5000,statement_timeout:7000})})});
      try {
        const repo = new MaintenanceReconciliationRepository(db);
        const owner = await repo.acquire(randomUUID());
        if(owner.status !== 'ok') throw Error('Synthetic lease unavailable');
        const pass = await repo.beginOrResume(owner.value);
        if(pass.status !== 'ok') throw Error('Synthetic pass unavailable');
        const moved = await repo.advance(owner.value,pass.value,JSON.parse(process.env.SAEFR_COORDINATOR_KEY));
        if(moved.status !== 'ok') throw Error('Synthetic checkpoint unavailable');
      } finally { await db.destroy(); }
    `;
    await execute(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        SAEFR_COORDINATOR_FIXTURE_DB: databaseName,
        SAEFR_COORDINATOR_KEY: JSON.stringify(one),
      },
      timeout: 15000,
    });
    const stopped = await a.read();
    expect(stopped).toMatchObject({
      pass_status: 'incomplete',
      cursor: one,
      leader_epoch: '1',
    });
    await expire();
    const replacement = value(await b.acquire(randomUUID()));
    const resumed = value(await b.beginOrResume(replacement));
    expect(resumed).toMatchObject({
      pass_id: stopped.pass_id,
      upper: stopped.upper,
      cursor: one,
      pass_owner_epoch: '2',
    });
  });

  it('forces synchronous COMMIT inside coordinator writes without changing the inherited connection setting', async () => {
    await sql`create temporary table coordinator_commit_probe (setting text)`.execute(
      first,
    );
    await sql`create function pg_temp.capture_coordinator_commit() returns trigger language plpgsql as $$
      begin insert into pg_temp.coordinator_commit_probe values (current_setting('synchronous_commit')); return new; end $$`.execute(
      first,
    );
    await sql`create trigger coordinator_commit_probe before update on public.maintenance_reconciliation
      for each row execute function pg_temp.capture_coordinator_commit()`.execute(
      first,
    );
    try {
      await sql`set synchronous_commit to off`.execute(first);
      await leader();
      expect(
        (
          await sql<{
            setting: string;
          }>`select setting from pg_temp.coordinator_commit_probe`.execute(
            first,
          )
        ).rows,
      ).toEqual([{ setting: 'on' }]);
      expect(
        (
          await sql<{
            setting: string;
          }>`select current_setting('synchronous_commit') as setting`.execute(
            first,
          )
        ).rows[0].setting,
      ).toBe('off');
    } finally {
      await sql`set synchronous_commit to on`.execute(first);
      await sql`drop trigger coordinator_commit_probe on public.maintenance_reconciliation`.execute(
        first,
      );
      await sql`drop function pg_temp.capture_coordinator_commit()`.execute(
        first,
      );
      await sql`drop table pg_temp.coordinator_commit_probe`.execute(first);
    }
  });

  it('renews only a live identity and resumes the same pass after ownership replacement', async () => {
    const one = await receipt();
    const next = await receipt('2026-10-29T10:11:13.123456Z');
    const old = await leader();
    const started = await pass(old);
    const progressed = value(await a.advance(old, started, one));
    expect((await b.renew({ ...old, token: randomUUID() })).status).toBe(
      'stale',
    );
    expect((await a.renew(old)).status).toBe('ok');
    await expire();
    expect((await a.renew(old)).status).toBe('stale');
    const replacement = value(await b.acquire(randomUUID()));
    expect(replacement.epoch).toBe('2');
    // next is strictly after the durable cursor and within the unchanged upper
    // bound. Without ownership fencing this request would otherwise advance.
    expect((await a.advance(old, progressed, next)).status).toBe('stale');
    expect((await b.read()).cursor).toEqual(one);
    const resumed = value(await b.beginOrResume(replacement));
    expect(resumed).toMatchObject({
      pass_id: started.pass_id,
      cursor: one,
      upper: started.upper,
      pass_owner_epoch: '2',
    });
    expect(value(await b.advance(replacement, resumed, next)).cursor).toEqual(
      next,
    );
  });

  it('reevaluates expiry after waiting for the singleton lock', async () => {
    const old = await leader();
    await hold(
      sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`,
      async (release) => {
        // The holder remains locked until a second backend is observed waiting.
        const renewal = b.renew(old);
        let waiting = false;
        for (let i = 0; i < 80; i++) {
          const row = await sql<{
            waiting: boolean;
          }>`select exists(select 1 from pg_stat_activity
          where datname = ${databaseName} and application_name = 'saefr_coordinator_second' and wait_event_type = 'Lock') as waiting`.execute(
            admin.db,
          );
          if (row.rows[0].waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(waiting).toBe(true);
        release();
        // The query resumes before its timeout and must recheck expiry after the wait.
        expect((await renewal).status).toBe('stale');
      },
    );
    expect((await b.renew(old)).status).toBe('stale');
  });

  it('uses the greatest actual tuple and preserves microseconds through another connection', async () => {
    const low = await receipt(
      '2026-10-29T10:11:12.123455Z',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    const firstEqual = await receipt(
      '2026-10-29T10:11:12.123456Z',
      '00000000-0000-4000-8000-000000000001',
    );
    const upper = await receipt(
      '2026-10-29T10:11:12.123456Z',
      '00000000-0000-4000-8000-000000000002',
    );
    const owner = await leader();
    const started = await pass(owner);
    expect(started.upper).toEqual(upper); // Independent MAX(asset_id) would pick low's UUID.
    await sql`set time zone 'Pacific/Auckland'`.execute(second);
    await sql`set datestyle = 'ISO, DMY'`.execute(second);
    const reconnected = JSON.parse(
      JSON.stringify(await b.read()),
    ) as ReconciliationSnapshot;
    expect(value(await b.page(owner, reconnected, 3))).toEqual([
      low,
      firstEqual,
      upper,
    ]);
    const cursor = value(await b.advance(owner, reconnected, low));
    expect((await a.read()).cursor).toEqual(low);
    expect(value(await a.page(owner, cursor, 2))).toEqual([firstEqual, upper]);
  });

  it('rejects stale cursor CAS and refuses skipping an earlier pending receipt', async () => {
    const firstKey = await receipt();
    const later = await receipt('2026-10-29T10:11:13.123456Z');
    const owner = await leader();
    const started = await pass(owner);
    expect((await a.advance(owner, started, later)).status).toBe('stale');
    const next = value(await a.advance(owner, started, firstKey));
    expect((await b.advance(owner, started, later)).status).toBe('stale');
    expect(value(await b.page(owner, next, 1))).toEqual([later]);
    expect((await b.complete(owner, next)).status).toBe('busy');
  });

  it('finishes fixed finite passes despite continuous insertion and revisits all rows next pass', async () => {
    const initial = await receipt();
    const owner = await leader();
    const started = await pass(owner);
    for (let i = 0; i < 3; i++) {
      await receipt(`2026-10-29T10:11:1${i + 3}.123456Z`);
      expect((await a.read()).upper).toEqual(initial);
    }
    expect(await service.reconcilePage(owner, synthetic)).toMatchObject({
      status: 'page',
      checkpointed: 1,
    });
    expect(await service.reconcilePage(owner, synthetic)).toMatchObject({
      status: 'complete',
    });
    const next = await pass(owner);
    expect(next.pass_id).not.toBe(started.pass_id);
    expect(next.cursor).toBeNull();
    expect(value(await a.page(owner, next, 100))).toHaveLength(4);
  });

  it('revisits a late COMMIT behind the cursor in the next finite pass', async () => {
    const visible = await receipt('2026-10-29T10:11:13.123456Z');
    let release!: () => void;
    let inserted!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    let late!: JournalKey;
    const transaction = second.transaction().execute(async (tx) => {
      late = await receipt('2026-10-29T10:11:12.123456Z', randomUUID(), tx);
      inserted();
      await committed;
    });
    try {
      await ready;
      const owner = await leader();
      expect((await pass(owner)).upper).toEqual(visible);
      expect((await service.reconcilePage(owner, synthetic)).checkpointed).toBe(
        1,
      );
      release();
      await transaction;
      expect((await service.reconcilePage(owner, synthetic)).status).toBe(
        'complete',
      );
      const next = await pass(owner);
      expect(value(await a.page(owner, next, 1))).toEqual([late]);
    } finally {
      release();
      await transaction;
    }
  });

  it('replays a partial page after a crash without consuming attempt counters', async () => {
    const one = await receipt();
    const two = await receipt('2026-10-29T10:11:13.123456Z');
    const owner = await leader();
    const started = await pass(owner);
    expect(await retry.discover(one.assetId)).toBe('applied'); // Crash before cursor COMMIT.
    const restarted = new MaintenanceReconciliationService(
      b,
      new MaintenanceRetryRepository(second),
      1,
    );
    expect(await restarted.reconcilePage(owner, synthetic)).toMatchObject({
      checkpointed: 1,
    });
    expect((await b.read()).pass_id).toBe(started.pass_id);
    expect(await restarted.reconcilePage(owner, synthetic)).toMatchObject({
      checkpointed: 1,
    });
    for (const key of [one, two])
      expect(await retry.read(key.assetId)).toMatchObject({
        lifetime_attempts: '0',
        immediate_attempts: 0,
      });
  });

  it('returns unknown after a committed checkpoint loses its acknowledgement and confirms it independently', async () => {
    const key = await receipt();
    const owner = await leader();
    const started = await pass(owner);
    const uncertain = new MaintenanceReconciliationRepository(
      lostAcknowledgement(first),
    );
    expect((await uncertain.advance(owner, started, key)).status).toBe(
      'uncertain',
    );
    const confirmed = await b.read();
    expect(confirmed).toMatchObject({
      leader_token: owner.token,
      leader_epoch: owner.epoch,
      pass_id: started.pass_id,
      cursor: key,
    });
    expect((await a.advance(owner, started, key)).status).toBe('stale');
    expect(value(await a.page(owner, confirmed, 1))).toEqual([]);
  });

  it('requires independent positive confirmation of unknown lease and pass commits', async () => {
    const key = await receipt();
    const uncertain = new MaintenanceReconciliationRepository(
      lostAcknowledgement(first),
    );
    const token = randomUUID();
    expect((await uncertain.acquire(token)).status).toBe('uncertain');
    const confirmed = await b.read();
    const owner = { token, epoch: confirmed.leader_epoch };
    expect(confirmed).toMatchObject({ leader_token: token, lease_live: true });
    expect((await uncertain.beginOrResume(owner)).status).toBe('uncertain');
    const established = await b.read();
    expect(established).toMatchObject({
      pass_status: 'incomplete',
      upper: key,
      cursor: null,
    });
    expect(value(await b.beginOrResume(owner)).pass_id).toBe(
      established.pass_id,
    );
  });

  it('stops progress after an uncertain receipt mutation and safely replays its committed row', async () => {
    const key = await receipt();
    const owner = await leader();
    const unknown = new MaintenanceReconciliationService(
      a,
      new MaintenanceRetryRepository(lostAcknowledgement(first)),
      1,
    );
    expect(await unknown.reconcilePage(owner, synthetic)).toMatchObject({
      status: 'uncertain',
      checkpointed: 0,
    });
    expect((await b.read()).cursor).toBeNull();
    expect(await retry.read(key.assetId)).toMatchObject({
      lifetime_attempts: '0',
    });
    expect(await service.reconcilePage(owner, synthetic)).toMatchObject({
      checkpointed: 1,
    });
  });

  it('defers a positively aborted journal lock timeout so the oldest row cannot starve later rows', async () => {
    const one = await receipt();
    const two = await receipt('2026-10-29T10:11:13.123456Z');
    const owner = await leader();
    const other = new MaintenanceReconciliationService(
      b,
      new MaintenanceRetryRepository(second),
      1,
    );
    await hold(
      sql`select asset_id from public.asset_deletion where asset_id = ${one.assetId}::uuid for update`,
      async () => {
        expect(await other.reconcilePage(owner, synthetic)).toMatchObject({
          status: 'page',
          checkpointed: 1,
          deferred: 1,
        });
      },
    );
    expect(await retry.read(one.assetId)).toBeUndefined();
    expect((await service.reconcilePage(owner, synthetic)).checkpointed).toBe(
      1,
    );
    expect(await retry.read(two.assetId)).toMatchObject({
      lifetime_attempts: '0',
    });
    expect((await service.reconcilePage(owner, synthetic)).status).toBe(
      'complete',
    );
    expect((await service.reconcilePage(owner, synthetic)).checkpointed).toBe(
      1,
    );
    expect(await retry.read(one.assetId)).toMatchObject({
      lifetime_attempts: '0',
    });
  });

  it('does not discover closed journals and completes empty passes without inventing keys', async () => {
    const key = await receipt();
    await sql`update public.asset_deletion set completed_at = clock_timestamp() where asset_id = ${key.assetId}::uuid`.execute(
      first,
    );
    const owner = await leader();
    expect(await service.reconcilePage(owner, synthetic)).toMatchObject({
      status: 'complete',
      checkpointed: 0,
    });
    expect(await retry.read(key.assetId)).toBeUndefined();
    expect((await a.read()).upper).toBeNull();
  });

  it('keeps invalid live-asset journal evidence unchanged and safely defers it', async () => {
    const key = await receipt();
    await sql`insert into public.asset (id, owner_id, filename, mime_type, size, storage_path, created_at)
      values (${key.assetId}::uuid, ${ownerId}::uuid, 'synthetic.jpg', 'image/jpeg', 1, 'synthetic-no-file', clock_timestamp())`.execute(
      first,
    );
    const before = await sql`select * from public.asset_deletion`.execute(
      first,
    );
    expect(
      await service.reconcilePage(await leader(), synthetic),
    ).toMatchObject({ checkpointed: 1, deferred: 1 });
    expect(await retry.read(key.assetId)).toBeUndefined();
    expect(
      (await sql`select * from public.asset_deletion`.execute(first)).rows,
    ).toEqual(before.rows);
  });

  it('defers inconsistent closed retry metadata without reopening an episode', async () => {
    const key = await receipt();
    await retry.discover(key.assetId);
    await sql`update public.maintenance_retry_state set state = 'closed', next_eligible_at = null
      where asset_id = ${key.assetId}::uuid`.execute(first);
    expect(
      await service.reconcilePage(await leader(), synthetic),
    ).toMatchObject({ checkpointed: 1, deferred: 1 });
    expect(await retry.read(key.assetId)).toMatchObject({
      state: 'closed',
      lifetime_attempts: '0',
    });
  });

  it('retains an unknown closure outcome for independent confirmation and replay', async () => {
    const key = await receipt();
    await retry.discover(key.assetId);
    await sql`update public.asset_deletion set completed_at = clock_timestamp() where asset_id = ${key.assetId}::uuid`.execute(
      first,
    );
    const owner = await leader();
    const uncertain = new MaintenanceReconciliationRepository(
      lostAcknowledgement(first),
    );
    expect(
      (await uncertain.closePassiveCompleted(owner, key.assetId)).status,
    ).toBe('uncertain');
    expect(
      await new MaintenanceRetryRepository(second).read(key.assetId),
    ).toMatchObject({ state: 'closed', lifetime_attempts: '0' });
    expect(value(await b.closePassiveCompleted(owner, key.assetId))).toBe(
      'unchanged',
    );
  });

  it('closes passive completed metadata while preserving counters, errors and the pending cursor', async () => {
    const key = await receipt();
    await retry.discover(key.assetId);
    const clearanceId = randomUUID();
    await sql`insert into public.maintenance_takeover_clearance
      (clearance_id, asset_id, blocked_generation, blocked_attempt_id, blocked_worker_incarnation_id,
       blocked_permit_generation, blocked_journal_execution_token, disarmed_permit_generation,
       operator_reference, evidence_reference, recorded_at)
      values (${clearanceId}::uuid, ${key.assetId}::uuid, 1, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        1, null, 2, 'synthetic-operator', 'synthetic-evidence', clock_timestamp())`.execute(
      first,
    );
    await sql`update public.maintenance_retry_state set lifetime_attempts = 3, immediate_attempts = 3,
      state = 'cooling', last_error_code = 'filesystem_error', last_clearance_id = ${clearanceId}::uuid
      where asset_id = ${key.assetId}::uuid`.execute(first);
    await sql`update public.asset_deletion set completed_at = clock_timestamp() where asset_id = ${key.assetId}::uuid`.execute(
      first,
    );
    const owner = await leader();
    const before = await a.read();
    expect(await service.sweepCompleted(owner, null, synthetic)).toMatchObject({
      status: 'page',
      closed: 1,
      cursor: key.assetId,
    });
    expect(await retry.read(key.assetId)).toMatchObject({
      state: 'closed',
      lifetime_attempts: '3',
      immediate_attempts: 3,
      last_error_code: 'filesystem_error',
      last_clearance_id: clearanceId,
    });
    expect(await a.read()).toEqual(before);
    expect((await service.sweepCompleted(owner, null, synthetic)).closed).toBe(
      0,
    );
    expect(
      await service.sweepCompleted(owner, key.assetId, synthetic),
    ).toMatchObject({ status: 'complete', cursor: null });
  });

  it('retains all reserved, admission-blocked and uncertain execution evidence on completed journals', async () => {
    for (const state of [
      'reserved',
      'blocked_admission',
      'blocked_execution',
    ] as const) {
      const key = await receipt();
      await retry.discover(key.assetId);
      if (state === 'blocked_admission')
        await retry.blockAdmission(key.assetId, '1', 'invalid_target');
      else {
        await sql`update public.maintenance_retry_state set next_eligible_at = clock_timestamp() - interval '1 second'
          where asset_id = ${key.assetId}::uuid`.execute(first);
        const snapshot = (await retry.read(key.assetId))!;
        const attempt = {
          assetId: key.assetId,
          generation: '1',
          expectedDue: exactPgTimestamp(snapshot.next_eligible_at_exact!),
          attemptId: randomUUID(),
          incarnationId: randomUUID(),
          permitGeneration: '3',
        };
        expect(await retry.reserve(attempt)).toBe('applied');
        if (state === 'blocked_execution') {
          await sql`update public.asset_deletion set execution_token = ${randomUUID()}::uuid,
            execution_expires_at = clock_timestamp() + interval '60 seconds' where asset_id = ${key.assetId}::uuid`.execute(
            first,
          );
          expect(
            await retry.blockExecution({
              ...attempt,
              reason: 'quiescence_unknown',
            }),
          ).toBe('applied');
        }
      }
      await sql`update public.asset_deletion set completed_at = clock_timestamp(), execution_token = null,
        execution_expires_at = null where asset_id = ${key.assetId}::uuid`.execute(
        first,
      );
    }
    const before = (
      await sql`select * from public.maintenance_retry_state order by asset_id`.execute(
        first,
      )
    ).rows;
    const owner = await leader();
    const sweep = new MaintenanceReconciliationService(a, retry, 100);
    expect(await sweep.sweepCompleted(owner, null, synthetic)).toMatchObject({
      closed: 0,
      retained: 3,
    });
    expect(
      (
        await sql`select * from public.maintenance_retry_state order by asset_id`.execute(
          first,
        )
      ).rows,
    ).toEqual(before);
  });

  it('fences stale completion sweeps and leaves pending journals and production work untouched', async () => {
    const key = await receipt();
    const owner = await leader();
    expect((await service.reconcilePage(owner)).status).toBe('denied');
    expect(await retry.read(key.assetId)).toBeUndefined();
    await retry.discover(key.assetId);
    expect(value(await a.closePassiveCompleted(owner, key.assetId))).toBe(
      'unchanged',
    );
    await expire();
    expect((await a.closePassiveCompleted(owner, key.assetId)).status).toBe(
      'stale',
    );
    expect(await retry.read(key.assetId)).toMatchObject({
      state: 'due',
      lifetime_attempts: '0',
    });
    expect(
      (
        await sql`select execution_token, completed_at from public.asset_deletion`.execute(
          first,
        )
      ).rows[0],
    ).toEqual({ execution_token: null, completed_at: null });
  });

  it('rejects epoch overflow without changing ownership', async () => {
    await sql`update public.maintenance_reconciliation set leader_epoch = 9223372036854775807`.execute(
      first,
    );
    expect((await a.acquire(randomUUID())).status).toBe('overflow');
    expect((await a.read()).leader_token).toBeNull();
  });
});
