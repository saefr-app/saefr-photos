import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WorkerRuntime } from '../src/worker/worker-runtime.js';
import { MaintenanceRuntime } from '../src/worker/maintenance-runtime.js';
import { maintenanceConfig } from '../src/worker/maintenance-config.js';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AssetDeletionExecutor } from '../src/assets/asset-deletion.executor.js';
import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from '../src/storage/storage-binding.service.js';
import { locationFingerprint } from '../src/storage/storage-marker.js';
import { RecoveryPermitStore } from '../src/worker/recovery-permit-store.js';
import {
  DatabasePermitPairing,
  RecoveryPermitService,
} from '../src/worker/recovery-permit.service.js';
import {
  encodePermit,
  pairingFingerprint,
} from '../src/worker/recovery-permit.js';
import { MaintenanceRecoveryAuthorization } from '../src/worker/maintenance-recovery-authorization.js';
import { MaintenanceDeliveryRepository } from '../src/worker/maintenance-delivery.repository.js';
import { MaintenanceRecoveryService } from '../src/worker/maintenance-recovery.service.js';
import {
  MaintenanceReconciliationRepository,
  type CoordinationResult,
} from '../src/worker/maintenance-reconciliation.repository.js';
import { MaintenanceRetryRepository } from '../src/worker/maintenance-retry.repository.js';
import {
  RedisRecoveryDelivery,
  createRecoveryQueue,
} from '../src/worker/redis-recovery-delivery.js';
import {
  RECOVERY_QUEUE,
  parseRecoveryHint,
  recoveryJobId,
  type RecoveryHint,
} from '../src/worker/recovery-delivery-contract.js';
import { exactPgTimestamp } from '../src/worker/exact-pg-values.js';
import { testConfig } from './helpers/integration-database.js';
import {
  disposableRedis,
  wipeDisposableRedis,
  restartDisposableRedis,
} from './helpers/disposable-redis.js';

function confirmed<T>(result: CoordinationResult<T>): T {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok')
    throw new Error('Synthetic database transition unavailable');
  return result.value;
}

describe('permit-gated delivery with disposable PostgreSQL and Redis', () => {
  let admin: DatabaseService;
  let db: Kysely<Database>;
  let second: Kysely<Database>;
  let blocker: Kysely<Database>;
  let databaseName: string;
  let root: string;
  let store: RecoveryPermitStore;
  let permit: RecoveryPermitService;
  let pairing: DatabasePermitPairing;
  let coordinator: MaintenanceReconciliationRepository;
  let retry: MaintenanceRetryRepository;
  let deliveryDb: MaintenanceDeliveryRepository;
  let redis: RedisRecoveryDelivery;
  let queue: Queue;
  let recovery: MaintenanceRecoveryService;
  let owner: { token: string; epoch: string };
  const runtimes: MaintenanceRuntime[] = [];
  const poolErrors: Error[] = [];
  let terminatingBackend = false;
  let storageProblem: 'mismatch' | 'unavailable' | undefined;
  const user = randomUUID();
  const binding = {
    singleton: true,
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
    storage_layout_version: 1,
  };

  const physical: PhysicalStorageObserver = {
    async observe(role, location) {
      if (storageProblem === 'unavailable')
        throw new Error('Synthetic private mount unavailable');
      const identity = {
        format: 'linux-ext4-handle-v1' as const,
        profile: 'linux-ext4-v1' as const,
        filesystem_uuid: binding.storage_id,
        directory_handle_type: 1,
        directory_handle_hex: '01020304',
      };
      return {
        markerBytes: Buffer.from(
          JSON.stringify({
            version: 2,
            storage_id: binding.storage_id,
            binding_id:
              role === 'originals'
                ? binding.originals_binding_id
                : binding.thumbnails_binding_id,
            role,
            physical_identity: {
              ...identity,
              location_sha256: locationFingerprint(location, role),
            },
          }),
        ),
        identity: {
          ...identity,
          directory_handle_hex:
            storageProblem === 'mismatch'
              ? 'deadbeef'
              : identity.directory_handle_hex,
        },
      };
    },
  };

  beforeAll(async () => {
    const config = testConfig();
    disposableRedis(); // Both targets verified before SQL, migrations or queue operations.
    admin = new DatabaseService(config);
    databaseName = `saefr_delivery_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const connection = (applicationName: string) => {
      const pool = new Pool({
        host: '127.0.0.1',
        port: config.getOrThrow<number>('POSTGRES_PORT'),
        database: databaseName,
        user: config.getOrThrow<string>('POSTGRES_USER'),
        password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
        max: 1,
        application_name: applicationName,
        connectionTimeoutMillis: 5000,
        statement_timeout: 7000,
      });
      // The injected termination can surface after pg returns the connection to the idle pool.
      // Collect it explicitly; afterEach rejects every unexpected idle error.
      pool.on('connect', (client) => {
        client.on('error', (error) => poolErrors.push(error));
      });
      pool.on('error', (error) => poolErrors.push(error));
      return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    };
    db = connection('saefr_delivery_first');
    second = connection('saefr_delivery_second');
    blocker = connection('saefr_delivery_blocker');
    await migrateToLatest(db);
    await db.insertInto('storage_binding').values(binding).execute();
    await sql`insert into public.app_user values (${user}::uuid, 'delivery-fixture', 'synthetic-hash',
      'user', 'active', false, clock_timestamp(), clock_timestamp())`.execute(
      db,
    );
    coordinator = new MaintenanceReconciliationRepository(db);
    retry = new MaintenanceRetryRepository(db);
    deliveryDb = new MaintenanceDeliveryRepository(db);
  });

  beforeEach(async () => {
    await sql`truncate public.asset, public.asset_deletion, public.maintenance_retry_state, public.maintenance_takeover_clearance`.execute(
      db,
    );
    await sql`update public.maintenance_reconciliation set leader_epoch = 0, leader_token = null,
      leader_expires_at = null, pass_status = 'complete', pass_id = null, pass_owner_epoch = null,
      upper_requested_at = null, upper_asset_id = null, cursor_requested_at = null, cursor_asset_id = null,
      updated_at = clock_timestamp()`.execute(db);
    storageProblem = undefined;
    root = await mkdtemp(join(tmpdir(), 'saefr-delivery-permit-'));
    await chmod(root, 0o750);
    store = new RecoveryPermitStore({
      path: join(root, 'permit.json'),
      operatorUid: process.geteuid!(),
      readerGid: process.getegid!(),
      restoreRoots: [join(root, 'media')],
    });
    await seedPermit();
    pairing = new DatabasePermitPairing(
      db,
      new StorageBindingVerifier(
        { db } as DatabaseService,
        new ConfigService({
          STORAGE_ROOT: join(root, 'media'),
          STORAGE_ID: binding.storage_id,
          STORAGE_ORIGINALS_BINDING_ID: binding.originals_binding_id,
          STORAGE_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
          STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
          STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
        }),
        physical,
      ),
    );
    // Explicit synthetic policy composition: operator reader under this test UID.
    // Actual runtime reader denial is tested separately; no production fallback exists.
    permit = new RecoveryPermitService(
      { readRuntime: () => store.readOperator() },
      pairing,
    );
    const config = {
      ...disposableRedis().config,
      prefix: `${process.env.SAEFR_REDIS_PREFIX}:combined_${randomUUID()}`,
    };
    redis = new RedisRecoveryDelivery(config);
    queue = createRecoveryQueue(config);
    await queue.waitUntilReady();
    owner = confirmed(await coordinator.acquire(randomUUID()));
    recovery = compose();
  });
  afterEach(async () => {
    for (const error of poolErrors.splice(0)) {
      expect(terminatingBackend).toBe(true);
      expect(error.message).toBe('Connection terminated unexpectedly');
    }
    terminatingBackend = false;
    for (const runtime of runtimes.splice(0))
      expect(await runtime.stop()).toBe(true);
    expect(await redis?.close()).toBe(true);
    await queue?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await blocker?.destroy();
    await second?.destroy();
    await db?.destroy();
    if (admin && databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  function compose(
    producer: Pick<RedisRecoveryDelivery, 'inspect' | 'enqueue'> = redis,
    gate = new MaintenanceRecoveryAuthorization(permit),
    repository = deliveryDb,
  ) {
    return new MaintenanceRecoveryService(
      coordinator,
      retry,
      repository,
      gate,
      producer,
      1,
    );
  }
  async function seedPermit(armed = true, generation = '7') {
    await writeFile(
      store.location.path,
      encodePermit({
        version: 1,
        armed,
        generation,
        pairing_sha256: pairingFingerprint(binding),
      }),
      { mode: 0o640 },
    );
  }
  async function receipt(prepare = true): Promise<RecoveryHint> {
    const asset_id = randomUUID();
    await sql`insert into public.asset_deletion
      (asset_id, owner_id, accepted_lifecycle_version, storage_id, originals_binding_id,
       thumbnails_binding_id, storage_layout_version, original_extension, requested_at)
      values (${asset_id}::uuid, ${user}::uuid, 1, ${binding.storage_id}::uuid,
        ${binding.originals_binding_id}::uuid, ${binding.thumbnails_binding_id}::uuid, 1, '.jpg', clock_timestamp())`.execute(
      db,
    );
    if (prepare) {
      await retry.discover(asset_id);
      await sql`update public.maintenance_retry_state set next_eligible_at = clock_timestamp() - interval '1 second'
        where asset_id = ${asset_id}::uuid`.execute(db);
    }
    return { version: 1, asset_id, generation: '1' };
  }
  async function terminal(hint: RecoveryHint, fail = false) {
    await redis.enqueue(hint);
    const verified = disposableRedis().config;
    const worker = new Worker(
      RECOVERY_QUEUE,
      async (job) => {
        parseRecoveryHint(job.data);
        if (fail) throw new Error('Synthetic non-destructive failure');
        return { synthetic: true };
      },
      {
        prefix: queue.opts.prefix,
        connection: {
          host: verified.host,
          port: verified.port,
          password: verified.password,
          maxRetriesPerRequest: null,
        },
      },
    );
    worker.on('error', () => undefined);
    try {
      let reached = false;
      for (let i = 0; i < 100; i++) {
        const state = await (await queue.getJob(
          recoveryJobId(hint),
        ))!.getState();
        if (state === (fail ? 'failed' : 'completed')) {
          reached = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(reached).toBe(true);
    } finally {
      await worker.close();
    }
  }

  it('delivers strict hints through fresh actual B.2 checks without spending an attempt or mutating journal authority', async () => {
    const hint = await receipt();
    const journal = (await sql`select * from public.asset_deletion`.execute(db))
      .rows;
    expect(await recovery.deliver(owner, hint, '7')).toBe('queued');
    expect(await recovery.deliver(owner, hint, '7')).toBe('queued');
    expect((await queue.getJob(recoveryJobId(hint)))?.data).toEqual(hint);
    expect(await retry.read(hint.asset_id)).toMatchObject({
      generation: '1',
      lifetime_attempts: '0',
      immediate_attempts: 0,
    });
    expect(
      (await sql`select * from public.asset_deletion`.execute(db)).rows,
    ).toEqual(journal);
    expect(await queue.getActiveCount()).toBe(0);
  });

  it.each([
    'disarmed',
    'missing',
    'malformed',
    'untrusted',
    'generation',
  ] as const)('denies %s permits before delivery', async (problem) => {
    const hint = await receipt();
    if (problem === 'disarmed') await seedPermit(false);
    if (problem === 'missing') await rm(store.location.path);
    if (problem === 'malformed')
      await writeFile(store.location.path, '{invalid private fixture}');
    if (problem === 'untrusted') await chmod(store.location.path, 0o666);
    expect(
      await recovery.deliver(owner, hint, problem === 'generation' ? '6' : '7'),
    ).toBe('denied');
    expect(await queue.getWaitingCount()).toBe(0);
    expect((await retry.read(hint.asset_id))?.lifetime_attempts).toBe('0');
  });

  it.each(['mismatch', 'unavailable'] as const)(
    'fails closed when storage evidence is %s',
    async (problem) => {
      const hint = await receipt();
      storageProblem = problem;
      expect(await recovery.deliver(owner, hint, '7')).toBe('denied');
      expect(await queue.getWaitingCount()).toBe(0);
    },
  );

  it('rejects an incompatible schema without migration or repair', async () => {
    const hint = await receipt();
    await sql`drop index public.asset_deletion_pending_global_requested_id_idx`.execute(
      db,
    );
    try {
      expect(await recovery.deliver(owner, hint, '7')).toBe('denied');
    } finally {
      await sql`create index asset_deletion_pending_global_requested_id_idx on public.asset_deletion (requested_at, asset_id) where completed_at is null`.execute(
        db,
      );
    }
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('does not substitute an operator reader for the real untrusted runtime identity', async () => {
    const hint = await receipt();
    const real = new MaintenanceRecoveryAuthorization(
      new RecoveryPermitService(store, pairing),
    );
    expect(await compose(redis, real).deliver(owner, hint, '7')).toBe('denied');
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('does not deliver an accepted journal paired with a different storage binding', async () => {
    const hint = await receipt();
    await sql`update public.asset_deletion set originals_binding_id = ${randomUUID()}::uuid
      where asset_id = ${hint.asset_id}::uuid`.execute(db);
    expect(await recovery.deliver(owner, hint, '7')).toBe('pending');
    expect(await queue.getWaitingCount()).toBe(0);
    expect((await retry.read(hint.asset_id))?.generation).toBe('1');
  });

  it('does not create retry metadata when the actual permit observation denies reconciliation', async () => {
    const hint = await receipt(false);
    await seedPermit(false);
    expect((await recovery.reconcilePage(owner, '7')).status).toBe('denied');
    expect(await retry.read(hint.asset_id)).toBeUndefined();
    expect((await coordinator.read()).pass_id).toBeNull();
  });

  it('fails closed when the pairing database is unavailable', async () => {
    const hint = await receipt();
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
      const probe = new DatabasePermitPairing(unavailable, {
        assertVerified: async () => binding,
      });
      const authorization = new MaintenanceRecoveryAuthorization(
        new RecoveryPermitService(
          { readRuntime: () => store.readOperator() },
          probe,
        ),
      );
      expect(
        await compose(redis, authorization).deliver(owner, hint, '7'),
      ).toBe('denied');
      expect(await queue.getWaitingCount()).toBe(0);
    } finally {
      await unavailable.destroy();
    }
  });

  it('refuses a stale coordinator after a Redis wait without creating a delivery', async () => {
    const hint = await receipt();
    const producer = {
      inspect: async (value: RecoveryHint) => {
        const result = await redis.inspect(value);
        await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
          db,
        );
        confirmed(await coordinator.acquire(randomUUID()));
        return result;
      },
      enqueue: (value: RecoveryHint) => redis.enqueue(value),
    };
    expect(await compose(producer).deliver(owner, hint, '7')).toBe('denied');
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('recovers an ambiguous enqueue conservatively without replacing its durable generation', async () => {
    const hint = await receipt();
    const producer = {
      inspect: (value: RecoveryHint) => redis.inspect(value),
      enqueue: async (value: RecoveryHint) => {
        await redis.enqueue(value);
        return { status: 'uncertain' as const };
      },
    };
    expect(await compose(producer).deliver(owner, hint, '7')).toBe('uncertain');
    expect(await recovery.deliver(owner, hint, '7')).toBe('queued');
    expect(await queue.getWaitingCount()).toBe(1);
    expect(await retry.read(hint.asset_id)).toMatchObject({
      generation: '1',
      lifetime_attempts: '0',
    });
  });

  it.each([false, true])(
    'stops when the permit changes after Redis inspection (generation change: %s)',
    async (changeGeneration) => {
      const hint = await receipt();
      const producer = {
        inspect: async (value: RecoveryHint) => {
          const result = await redis.inspect(value);
          await seedPermit(
            !changeGeneration ? false : true,
            changeGeneration ? '8' : '7',
          );
          return result;
        },
        enqueue: (value: RecoveryHint) => redis.enqueue(value),
      };
      expect(await compose(producer).deliver(owner, hint, '7')).toBe('denied');
      expect(await queue.getWaitingCount()).toBe(0);
      expect((await retry.read(hint.asset_id))?.generation).toBe('1');
    },
  );

  it('reports uncertainty if disarm follows an already-issued enqueue and denies subsequent work', async () => {
    const hint = await receipt();
    const producer = {
      inspect: (value: RecoveryHint) => redis.inspect(value),
      enqueue: async (value: RecoveryHint) => {
        const result = await redis.enqueue(value);
        await seedPermit(false);
        return result;
      },
    };
    expect(await compose(producer).deliver(owner, hint, '7')).toBe('uncertain');
    expect(await queue.getWaitingCount()).toBe(1); // A hint is not execution authority.
    expect(await recovery.checkHint(owner, hint, '7')).toBe(false);
    expect((await retry.read(hint.asset_id))?.lifetime_attempts).toBe('0');
  });

  it('keeps PostgreSQL metadata progress independent of unavailable Redis', async () => {
    const hints = [await receipt(), await receipt()];
    const unavailable = new RedisRecoveryDelivery({
      ...disposableRedis().config,
      port: 1,
    });
    try {
      const service = compose(unavailable);
      expect(await service.reconcilePage(owner, '7')).toMatchObject({
        status: 'page',
        checkpointed: 1,
      });
      expect(await service.reconcilePage(owner, '7')).toMatchObject({
        status: 'page',
        checkpointed: 1,
      });
      expect((await service.reconcilePage(owner, '7')).status).toBe('complete');
      for (const hint of hints)
        expect(await retry.read(hint.asset_id)).toMatchObject({
          lifetime_attempts: '0',
          immediate_attempts: 0,
        });
    } finally {
      await unavailable.close();
    }
  });

  it.each([false, true])(
    'replaces a retained terminal delivery through durable CAS (failed: %s)',
    async (fail) => {
      const hint = await receipt();
      await sql`update public.maintenance_retry_state set state = 'cooling', lifetime_attempts = 3,
        immediate_attempts = 3, last_error_code = 'filesystem_error' where asset_id = ${hint.asset_id}::uuid`.execute(
        db,
      );
      await terminal(hint, fail);
      const before = (await retry.read(hint.asset_id))!;
      expect(await recovery.deliver(owner, hint, '7')).toBe('queued');
      const after = (await retry.read(hint.asset_id))!;
      expect(after).toMatchObject({
        generation: '2',
        lifetime_attempts: before.lifetime_attempts,
        immediate_attempts: before.immediate_attempts,
        next_eligible_at_exact: before.next_eligible_at_exact,
      });
      expect(
        (await queue.getJob(recoveryJobId({ ...hint, generation: '2' })))?.data,
      ).toEqual({ ...hint, generation: '2' });
      expect(await recovery.checkHint(owner, hint, '7')).toBe(false);
      expect(await recovery.deliver(owner, hint, '7')).toBe('stale');
    },
  );

  it('does not enqueue after an unknown generation COMMIT, and recovers from a positive later read', async () => {
    const hint = await receipt();
    await terminal(hint);
    let calls = 0;
    const lost = new Proxy(db, {
      get(target, key) {
        if (key !== 'transaction') return Reflect.get(target, key);
        return () => {
          const real = target.transaction().setIsolationLevel('read committed');
          const wrapper = {
            setIsolationLevel: () => wrapper,
            execute: async (callback: Parameters<typeof real.execute>[0]) => {
              const result = await real.execute(callback);
              if (++calls === 2)
                throw new Error('Synthetic lost generation acknowledgement');
              return result;
            },
          };
          return wrapper;
        };
      },
    });
    expect(
      await compose(
        redis,
        undefined,
        new MaintenanceDeliveryRepository(lost),
      ).deliver(owner, hint, '7'),
    ).toBe('uncertain');
    expect(
      (await new MaintenanceRetryRepository(second).read(hint.asset_id))
        ?.generation,
    ).toBe('2');
    const next = { ...hint, generation: '2' };
    expect(await queue.getJob(recoveryJobId(next))).toBeUndefined();
    expect(await recovery.deliver(owner, next, '7')).toBe('queued');
  });

  it.each(['replacement', 'reservation'] as const)(
    'forces %s to win the journal lock before the competing operation',
    async (winner) => {
      const hint = await receipt();
      await terminal(hint);
      const observation = confirmed(await deliveryDb.inspect(owner, hint));
      const row = (await retry.read(hint.asset_id))!;
      const attempt = {
        assetId: hint.asset_id,
        generation: '1',
        expectedDue: exactPgTimestamp(row.next_eligible_at_exact!),
        attemptId: randomUUID(),
        incarnationId: randomUUID(),
        permitGeneration: '7',
      };
      let replacement!: ReturnType<
        MaintenanceDeliveryRepository['replaceTerminal']
      >;
      let reservation!: ReturnType<MaintenanceRetryRepository['reserve']>;
      await blocker.transaction().execute(async (tx) => {
        await sql`select asset_id from public.asset_deletion where asset_id = ${hint.asset_id}::uuid for update`.execute(
          tx,
        );
        const waiting = async (name: string) => {
          for (let i = 0; i < 200; i++) {
            await sql`select pg_stat_clear_snapshot()`.execute(tx);
            const row = (
              await sql<{
                waiting: boolean;
              }>`select exists(select 1 from pg_stat_activity
              where application_name = ${name} and wait_event_type = 'Lock') as waiting`.execute(
                tx,
              )
            ).rows[0];
            if (row.waiting) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          throw new Error('Expected independent backend row-lock wait');
        };
        if (winner === 'replacement') {
          replacement = deliveryDb.replaceTerminal(owner, observation);
          await waiting('saefr_delivery_first');
          reservation = new MaintenanceRetryRepository(second).reserve(attempt);
          await waiting('saefr_delivery_second');
        } else {
          reservation = new MaintenanceRetryRepository(second).reserve(attempt);
          await waiting('saefr_delivery_second');
          replacement = deliveryDb.replaceTerminal(owner, observation);
          await waiting('saefr_delivery_first');
        }
      });
      const [replaced, reserved] = await Promise.all([
        replacement,
        reservation,
      ]);
      const current = (await retry.read(hint.asset_id))!;
      if (winner === 'replacement') {
        expect(replaced.status).toBe('ok');
        expect(reserved).toBe('stale');
        expect(current).toMatchObject({
          generation: '2',
          state: 'due',
          lifetime_attempts: '0',
          immediate_attempts: 0,
          next_eligible_at_exact: row.next_eligible_at_exact,
          attempt_id: null,
          worker_incarnation_id: null,
          permit_generation: null,
        });
      } else {
        expect(reserved).toBe('applied');
        expect(replaced.status).toBe('stale');
        expect(current).toMatchObject({
          generation: '1',
          state: 'reserved',
          lifetime_attempts: '1',
          immediate_attempts: 1,
          next_eligible_at_exact: null,
          attempt_id: attempt.attemptId,
          worker_incarnation_id: attempt.incarnationId,
          permit_generation: '7',
        });
      }
      expect(await retry.reserve(attempt)).toBe('stale');
      expect(
        (await deliveryDb.replaceTerminal(owner, observation)).status,
      ).toBe('stale');
      expect(await retry.read(hint.asset_id)).toEqual(current);
    },
  );

  it('never shortens cooling or releases an execution block when the permit advances', async () => {
    const hint = await receipt();
    await sql`update public.maintenance_retry_state set state = 'cooling', lifetime_attempts = 3, immediate_attempts = 3,
      next_eligible_at = clock_timestamp() + interval '6 hours' where asset_id = ${hint.asset_id}::uuid`.execute(
      db,
    );
    const before = (await retry.read(hint.asset_id))!;
    await seedPermit(true, '8');
    expect(await recovery.deliver(owner, hint, '8')).toBe('pending');
    expect(await retry.read(hint.asset_id)).toEqual(before);
    await sql`update public.maintenance_retry_state set next_eligible_at = clock_timestamp() - interval '1 second'
      where asset_id = ${hint.asset_id}::uuid`.execute(db);
    const due = (await retry.read(hint.asset_id))!;
    const active = {
      assetId: hint.asset_id,
      generation: '1',
      expectedDue: exactPgTimestamp(due.next_eligible_at_exact!),
      attemptId: randomUUID(),
      incarnationId: randomUUID(),
      permitGeneration: '8',
    };
    expect(await retry.reserve(active)).toBe('applied');
    expect(
      await retry.blockExecution({ ...active, reason: 'quiescence_unknown' }),
    ).toBe('applied');
    const blocked = await retry.read(hint.asset_id);
    await seedPermit(true, '9');
    expect(await recovery.deliver(owner, hint, '9')).toBe('pending');
    expect(await retry.read(hint.asset_id)).toEqual(blocked);
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('reconstructs a missing delivery from durable state after verified queue loss', async () => {
    const hint = await receipt();
    expect(await recovery.deliver(owner, hint, '7')).toBe('queued');
    wipeDisposableRedis();
    expect(await recovery.deliver(owner, hint, '7')).toBe('queued');
    expect(await retry.read(hint.asset_id)).toMatchObject({
      generation: '1',
      lifetime_attempts: '0',
    });
  });
  async function runtime(service = recovery, repository = coordinator) {
    await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
      db,
    );
    const value = new MaintenanceRuntime(
      maintenanceConfig({
        SAEFR_MAINTENANCE_ENABLED: 'true',
        SAEFR_MAINTENANCE_INTERVAL_MS: '1000',
        SAEFR_MAINTENANCE_RENEW_MS: '1000',
        SAEFR_MAINTENANCE_PAGE_SIZE: '1',
      }),
      repository,
      new MaintenanceRecoveryAuthorization(permit),
      service,
    );
    runtimes.push(value);
    return value;
  }

  it('runs permit-gated passive ticks with Redis down and preserves all journal authority and counters', async () => {
    const reserveSpy = vi.spyOn(
      MaintenanceRetryRepository.prototype,
      'reserve',
    );
    const executorSpy = vi.spyOn(AssetDeletionExecutor.prototype, 'execute');
    const hint = await receipt(false);
    const before = (await sql`select * from public.asset_deletion`.execute(db))
      .rows;
    const unavailable = new RedisRecoveryDelivery({
      ...disposableRedis().config,
      port: 1,
    });
    const value = await runtime(compose(unavailable));
    try {
      await value.tick();
      expect(value.diagnostics()).toMatchObject({ state: 'ready', pages: 1 });
      expect(await retry.read(hint.asset_id)).toMatchObject({
        state: 'due',
        lifetime_attempts: '0',
        immediate_attempts: 0,
      });
      expect(
        (await sql`select * from public.asset_deletion`.execute(db)).rows,
      ).toEqual(before);
      expect(await queue.getWaitingCount()).toBe(0);
      expect(
        (
          await sql`select * from public.maintenance_takeover_clearance`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(0);
      expect(reserveSpy).not.toHaveBeenCalled();
      expect(executorSpy).not.toHaveBeenCalled();
    } finally {
      reserveSpy.mockRestore();
      executorSpy.mockRestore();
      await unavailable.close();
    }
  });

  it('renews actual leadership independently and rejects an expired identity before resuming the persisted pass', async () => {
    await receipt();
    await receipt();
    const value = await runtime();
    await value.tick();
    const before = await coordinator.read();
    await value.renew();
    const renewed = await coordinator.read();
    expect(renewed.leader_token).toBe(before.leader_token);
    expect(renewed.leader_epoch).toBe(before.leader_epoch);
    expect(
      renewed.leader_expires_at_exact! > before.leader_expires_at_exact!,
    ).toBe(true);
    await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
      db,
    );
    const replacement = confirmed(
      await new MaintenanceReconciliationRepository(second).acquire(
        randomUUID(),
      ),
    );
    await value.renew();
    expect(value.diagnostics().ownsCoordinator).toBe(false);
    expect(
      (
        await coordinator.advance(
          { token: before.leader_token!, epoch: before.leader_epoch },
          before,
          before.upper!,
        )
      ).status,
    ).toBe('stale');
    expect((await coordinator.beginOrResume(replacement)).status).toBe('ok');
    expect((await coordinator.read()).cursor).toEqual(before.cursor);
  });

  it.each(['disarmed', 'missing', 'generation', 'storage', 'schema'] as const)(
    'revalidates %s evidence on subsequent ticks without spending budgets',
    async (problem) => {
      const hint = await receipt(false);
      const value = await runtime();
      await value.tick();
      const before = await retry.read(hint.asset_id);
      if (problem === 'disarmed') await seedPermit(false);
      if (problem === 'missing') await rm(store.location.path);
      if (problem === 'generation') await seedPermit(true, '8');
      if (problem === 'storage') storageProblem = 'unavailable';
      if (problem === 'schema')
        await sql`drop index public.asset_deletion_pending_global_requested_id_idx`.execute(
          db,
        );
      try {
        await value.tick();
        expect(value.diagnostics().state).toBe(
          problem === 'generation'
            ? 'idle'
            : ['missing', 'storage', 'schema'].includes(problem)
              ? 'degraded'
              : 'blocked',
        );
        expect(await retry.read(hint.asset_id)).toEqual(before);
        expect(await queue.getWaitingCount()).toBe(0);
      } finally {
        if (problem === 'schema')
          await sql`create index asset_deletion_pending_global_requested_id_idx on public.asset_deletion (requested_at, asset_id) where completed_at is null`.execute(
            db,
          );
      }
    },
  );

  it('retains reserved and blocked execution evidence while closing only passive completed metadata', async () => {
    const passive = await receipt();
    const active = await receipt();
    const row = (await retry.read(active.asset_id))!;
    const attempt = {
      assetId: active.asset_id,
      generation: '1',
      expectedDue: exactPgTimestamp(row.next_eligible_at_exact!),
      attemptId: randomUUID(),
      incarnationId: randomUUID(),
      permitGeneration: '7',
    };
    expect(await retry.reserve(attempt)).toBe('applied');
    expect(
      await retry.blockExecution({ ...attempt, reason: 'quiescence_unknown' }),
    ).toBe('applied');
    const blocked = await retry.read(active.asset_id);
    await sql`update public.asset_deletion set completed_at = clock_timestamp()`.execute(
      db,
    );
    const service = new MaintenanceRecoveryService(
      coordinator,
      retry,
      deliveryDb,
      new MaintenanceRecoveryAuthorization(permit),
      redis,
      100,
    );
    const value = await runtime(service);
    await value.tick();
    expect((await retry.read(passive.asset_id))?.state).toBe('closed');
    expect(await retry.read(active.asset_id)).toEqual(blocked);
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('stops before checkpoint advancement after an unknown terminal replacement COMMIT', async () => {
    const hint = await receipt();
    await terminal(hint);
    const lost = new Proxy(deliveryDb, {
      get(target, key) {
        if (key === 'replaceTerminal')
          return async (...args: Parameters<typeof target.replaceTerminal>) => {
            await target.replaceTerminal(...args);
            return { status: 'uncertain' as const };
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    expect(
      await compose(redis, undefined, lost).reconcilePage(owner, '7'),
    ).toMatchObject({ status: 'uncertain', checkpointed: 0 });
    expect((await coordinator.read()).cursor).toBeNull();
    expect((await retry.read(hint.asset_id))?.generation).toBe('2');
    expect(
      await queue.getJob(recoveryJobId({ ...hint, generation: '2' })),
    ).toBeUndefined();
  });

  it('does not resume metadata writes when shutdown begins during a permit observation', async () => {
    const hint = await receipt(false);
    let release!: () => void;
    let observed!: () => void;
    const entered = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = new MaintenanceRecoveryAuthorization(
      new RecoveryPermitService(
        {
          readRuntime: async () => {
            observed();
            await held;
            return store.readOperator();
          },
        },
        pairing,
      ),
    );
    const value = new MaintenanceRuntime(
      maintenanceConfig({ SAEFR_MAINTENANCE_ENABLED: 'true' }),
      coordinator,
      gate,
      compose(redis, gate),
    );
    runtimes.push(value);
    const tick = value.tick();
    await entered;
    const stopped = value.stop();
    release();
    await tick;
    expect(await stopped).toBe(true);
    expect(await retry.read(hint.asset_id)).toBeUndefined();
  });

  it('recovers a real committed-but-unacknowledged acquisition only after an independent positive read', async () => {
    const hint = await receipt(false);
    let once = true;
    const lost = new Proxy(coordinator, {
      get(target, key) {
        if (key === 'acquire')
          return async (token: string) => {
            const result = await target.acquire(token);
            if (once) {
              once = false;
              return { status: 'uncertain' as const };
            }
            return result;
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const value = await runtime(recovery, lost);
    await value.tick();
    expect(await retry.read(hint.asset_id)).toBeUndefined();
    const saved = await new MaintenanceReconciliationRepository(second).read();
    expect(saved.lease_live).toBe(true);
    await value.tick();
    expect((await retry.read(hint.asset_id))?.lifetime_attempts).toBe('0');
    expect((await coordinator.read()).leader_token).toBe(saved.leader_token);
  });

  it('starts production passive composition before unavailable Redis and exits safely on SIGINT', async () => {
    const config = testConfig();
    const writer = {
      HOST: '127.0.0.1',
      PORT: String(config.getOrThrow('POSTGRES_PORT')),
      DB: databaseName,
      USER: config.getOrThrow<string>('POSTGRES_USER'),
      PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
    };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SAEFR_MAINTENANCE_ENABLED: 'true',
      SAEFR_REDIS_PORT: '1',
      SAEFR_MAINTENANCE_INTERVAL_MS: '1000',
      RECOVERY_PERMIT_PATH: store.location.path,
      RECOVERY_PERMIT_OPERATOR_UID: String(process.geteuid!()),
      RECOVERY_PERMIT_READER_GID: String(process.getegid!()),
      RECOVERY_PERMIT_RESTORE_ROOTS: JSON.stringify([join(root, 'media')]),
      RECOVERY_PERMIT_STORAGE_ROOT: join(root, 'media'),
      RECOVERY_PERMIT_STORAGE_ID: binding.storage_id,
      RECOVERY_PERMIT_ORIGINALS_BINDING_ID: binding.originals_binding_id,
      RECOVERY_PERMIT_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
    };
    for (const [key, value] of Object.entries(writer)) {
      env[`MAINTENANCE_POSTGRES_${key}`] = value;
      env[`RECOVERY_PERMIT_POSTGRES_${key}`] = value;
    }
    const child = spawn(process.execPath, ['dist/worker/main.js'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (b: Buffer) => {
        output += b.toString();
      });
    const ended = new Promise<number>((resolve) =>
      child.once('close', (code) => resolve(code ?? 1)),
    );
    try {
      for (
        let i = 0;
        i < 150 && !output.includes('Maintenance metadata runtime started');
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(output).toContain('Maintenance metadata runtime started');
      expect(child.exitCode).toBeNull();
      child.kill('SIGINT');
      const code = await ended;
      const diagnostic = output
        .replaceAll(writer.PASSWORD, '<redacted>')
        .replaceAll(store.location.path, '<redacted>');
      expect(code, diagnostic).toBe(0);
      expect(output).not.toContain(writer.PASSWORD);
      expect(output).not.toContain(store.location.path);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await ended;
    }
  }, 20000);

  it('fences the actual page when an independent coordinator replaces ownership mid-page', async () => {
    const hint = await receipt(false);
    const stolen = new Proxy(coordinator, {
      get(target, key) {
        if (key === 'inspectReceipt')
          return async (...args: Parameters<typeof target.inspectReceipt>) => {
            const result = await target.inspectReceipt(...args);
            await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
              second,
            );
            confirmed(
              await new MaintenanceReconciliationRepository(second).acquire(
                randomUUID(),
              ),
            );
            return result;
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const service = new MaintenanceRecoveryService(
      stolen,
      retry,
      deliveryDb,
      new MaintenanceRecoveryAuthorization(permit),
      redis,
      1,
    );
    const value = await runtime(service);
    await value.tick();
    expect((await coordinator.read()).cursor).toBeNull();
    expect(await retry.read(hint.asset_id)).toBeUndefined();
    expect(value.diagnostics().ownsCoordinator).toBe(false);
  });

  it('remains fail-closed on a real PostgreSQL connection outage', async () => {
    const hint = await receipt(false);
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
      const value = await runtime(
        recovery,
        new MaintenanceReconciliationRepository(unavailable),
      );
      await value.tick();
      expect(value.diagnostics().state).toBe('degraded');
      expect(await retry.read(hint.asset_id)).toBeUndefined();
    } finally {
      await unavailable.destroy();
    }
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)(
    'resumes the same finite PostgreSQL pass after a real child %s',
    async (signal) => {
      await receipt(false);
      await receipt(false);
      await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
        db,
      );
      const launch = () => {
        const child = spawn(
          process.execPath,
          ['test/helpers/maintenance-child.mjs'],
          {
            env: {
              PATH: process.env.PATH,
              SAEFR_M7_TEST_CONTAINER_ID:
                process.env.SAEFR_M7_TEST_CONTAINER_ID,
              SAEFR_M7_TEST_DB: process.env.SAEFR_M7_TEST_DB,
              SAEFR_M7_TEST_USER: process.env.SAEFR_M7_TEST_USER,
              SAEFR_M7_TEST_PASSWORD: process.env.SAEFR_M7_TEST_PASSWORD,
              SAEFR_M7_TEST_PORT: process.env.SAEFR_M7_TEST_PORT,
              SAEFR_MAINTENANCE_FIXTURE_DB: databaseName,
              SAEFR_MAINTENANCE_FIXTURE: JSON.stringify({ root, binding }),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (b: Buffer) => {
            output += b.toString();
          });
        const exited = new Promise<number | null>((resolve) =>
          child.once('close', (code) => resolve(code)),
        );
        return { child, exited, output: () => output };
      };
      const ready = async (run: ReturnType<typeof launch>) => {
        for (
          let i = 0;
          i < 250 &&
          !run.output().includes('maintenance-fixture-ready') &&
          run.child.exitCode === null;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(run.output()).toContain('maintenance-fixture-ready');
      };
      const first = launch();
      try {
        await ready(first);
        const before = await new MaintenanceReconciliationRepository(
          second,
        ).read();
        expect(before.pass_status).toBe('incomplete');
        expect(before.cursor).not.toBeNull();
        first.child.kill(signal);
        await first.exited;
        if (signal === 'SIGTERM')
          expect(first.output()).toContain('maintenance-fixture-stopped');
        await sql`update public.maintenance_reconciliation set leader_expires_at = clock_timestamp() - interval '1 second'`.execute(
          db,
        );
        const next = launch();
        try {
          await ready(next);
          const after = await coordinator.read();
          expect(after.pass_id).toBe(before.pass_id);
          expect(after.upper).toEqual(before.upper);
          expect(BigInt(after.leader_epoch)).toBeGreaterThan(
            BigInt(before.leader_epoch),
          );
          expect(after.cursor).toEqual(before.upper);
          next.child.kill('SIGTERM');
          expect(await next.exited).toBe(0);
          expect(next.output()).not.toContain(
            process.env.SAEFR_M7_TEST_PASSWORD,
          );
        } finally {
          if (next.child.exitCode === null) next.child.kill('SIGKILL');
          await next.exited;
        }
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int as n from public.maintenance_retry_state
        where lifetime_attempts <> 0 or immediate_attempts <> 0`.execute(db)
          ).rows[0].n,
        ).toBe(0);
      } finally {
        if (first.child.exitCode === null) first.child.kill('SIGKILL');
        await first.exited;
      }
    },
    20000,
  );
  it('reconnects after a real backend termination but refuses work until a fresh armed permit', async () => {
    terminatingBackend = true;
    const hint = await receipt(false);
    const value = await runtime();
    let pending!: Promise<void>;
    await blocker.transaction().execute(async (tx) => {
      await sql`select singleton from public.maintenance_reconciliation for update`.execute(
        tx,
      );
      pending = value.tick();
      let pid: number | undefined;
      for (let i = 0; i < 200 && !pid; i++) {
        await sql`select pg_stat_clear_snapshot()`.execute(tx);
        pid = (
          await sql<{ pid: number }>`select pid from pg_stat_activity where
          application_name = 'saefr_delivery_first' and wait_event_type = 'Lock'`.execute(
            tx,
          )
        ).rows[0]?.pid;
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(pid).toBeDefined();
      await sql`select pg_terminate_backend(${pid!})`.execute(tx);
    });
    await pending;
    expect(value.diagnostics().state).toBe('degraded');
    expect(await retry.read(hint.asset_id)).toBeUndefined();
    await seedPermit(false);
    await value.tick();
    expect(value.diagnostics().state).toBe('blocked');
    expect(await retry.read(hint.asset_id)).toBeUndefined();
    await seedPermit(true, '8');
    await value.tick();
    expect((await retry.read(hint.asset_id))?.lifetime_attempts).toBe('0');
    expect(value.diagnostics().state).toBe('ready');
  });
  it('freshly denies maintenance on a real Redis reconnect while its permit is disarmed', async () => {
    const hint = await receipt(false);
    const value = await runtime();
    let notifications = 0;
    const synthetic = new WorkerRuntime(
      { ...disposableRedis().config, prefix: queue.opts.prefix! },
      undefined,
      () => {
        notifications++;
        void value.tick();
      },
    );
    const wait = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(check()).toBe(true);
    };
    try {
      await synthetic.start();
      await wait(
        () => notifications > 0 && value.diagnostics().state === 'ready',
      );
      const before = await retry.read(hint.asset_id);
      const count = notifications;
      await seedPermit(false);
      await restartDisposableRedis();
      await wait(
        () => notifications > count && value.diagnostics().state === 'blocked',
      );
      expect(await retry.read(hint.asset_id)).toEqual(before);
      expect(await queue.getWaitingCount()).toBe(0);
    } finally {
      expect(await synthetic.stop()).toBe(true);
    }
  }, 20000);
  it('defers a positively aborted discovery lock wait without starving the next receipt', async () => {
    const first = await receipt(false);
    await receipt(false);
    const contended = new Proxy(coordinator, {
      get(target, key) {
        if (key === 'discoverFenced')
          return async (...args: Parameters<typeof target.discoverFenced>) => {
            if (args[1] !== first.asset_id)
              return target.discoverFenced(...args);
            let release!: () => void;
            let ready!: () => void;
            const unlocked = new Promise<void>((resolve) => {
              release = resolve;
            });
            const locked = new Promise<void>((resolve) => {
              ready = resolve;
            });
            const holder = second.transaction().execute(async (tx) => {
              await sql`select asset_id from public.asset_deletion where asset_id = ${first.asset_id}::uuid for update`.execute(
                tx,
              );
              ready();
              await unlocked;
            });
            await locked;
            try {
              return await target.discoverFenced(...args);
            } finally {
              release();
              await holder;
            }
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const service = new MaintenanceRecoveryService(
      contended,
      retry,
      deliveryDb,
      new MaintenanceRecoveryAuthorization(permit),
      redis,
      1,
    );
    const value = await runtime(service);
    await value.tick();
    expect((await coordinator.read()).cursor?.assetId).toBe(first.asset_id);
    expect(await retry.read(first.asset_id)).toBeUndefined();
    await value.tick();
    expect(value.diagnostics().pages).toBe(2);
  });
});
