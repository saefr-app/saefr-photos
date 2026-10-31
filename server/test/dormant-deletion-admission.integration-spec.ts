import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { Migrator } from 'kysely/migration';
import {
  createMigrationProvider,
  MAINTENANCE_RECOVERY_MIGRATION,
} from '../src/database/migrations/migration-provider.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AssetDeletionRepository } from '../src/assets/asset-deletion.repository.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { exactPgTimestamp } from '../src/worker/exact-pg-values.js';
import { MaintenanceRetryRepository } from '../src/worker/maintenance-retry.repository.js';
import {
  DormantDeletionAdmissionRepository,
  type AdmissionResult,
  type BoundReservation,
} from '../src/worker/dormant-deletion-admission.repository.js';
import { testConfig } from './helpers/integration-database.js';

describe('Dormant M13B.4.1 shared admission on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let first: Kysely<Database>;
  let second: Kysely<Database>;
  let manualDb: DatabaseService;
  let databaseName: string;
  let a: DormantDeletionAdmissionRepository;
  let retry: MaintenanceRetryRepository;
  let b: DormantDeletionAdmissionRepository;
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
    retry = new MaintenanceRetryRepository(first, async () => binding);
    a = await DormantDeletionAdmissionRepository.open(first);
    b = await DormantDeletionAdmissionRepository.open(second);
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
    const snapshot = await retry.read(asset);
    expect(snapshot?.next_eligible_at_exact).not.toBeNull();
    return exactPgTimestamp(snapshot!.next_eligible_at_exact!);
  }

  function applied<T>(r: AdmissionResult<T>): T {
    expect(r.status).toBe('applied');
    if (r.status !== 'applied') throw new Error('Expected applied');
    return r.value;
  }
  async function input() {
    const id = await receipt();
    await retry.discover(id);
    return {
      a: {
        journal: (await a.identity(id))!,
        generation: '1',
        attemptId: randomUUID(),
        incarnationId: randomUUID(),
        permitGeneration: '3',
      },
      due: await due(id),
    };
  }
  const preflight = {
    permitGeneration: '3',
    storageVerified: true,
    capacityAvailable: true,
  } as const;
  async function reserved() {
    const i = await input();
    return applied(await a.reserve(i.a, i.due, '12', preflight));
  }
  async function bound() {
    const r = await reserved();
    return applied(await a.bind(r, randomUUID()));
  }
  async function snapshot(id: string) {
    return {
      journal: await first
        .selectFrom('asset_deletion')
        .selectAll()
        .where('asset_id', '=', id)
        .executeTakeFirst(),
      retry: await retry.read(id),
    };
  }
  it('reserves once through independent pools and recovers the exact database deadline', async () => {
    const i = await input();
    const results = await Promise.all([
      a.reserve(i.a, i.due, '12', preflight),
      b.reserve({ ...i.a, attemptId: randomUUID() }, i.due, '12', preflight),
    ]);
    expect(results.filter((r) => r.status === 'applied')).toHaveLength(1);
    const row = await retry.read(i.a.journal.asset_id);
    expect(row?.lifetime_attempts).toBe('1');
    const winning = applied(results.find((r) => r.status === 'applied')!);
    expect(applied(await b.confirm(winning))).toEqual(winning);
    expect(await a.reserve(i.a, i.due, '12', preflight)).toEqual({
      status: 'refused',
    });
  });

  it.each([
    'generation',
    'due',
    'capacity',
    'permit',
    'storage',
    'budget',
  ] as const)('refuses %s without spending a counter', async (kind) => {
    const i = await input();
    const before = await snapshot(i.a.journal.asset_id);
    const args = {
      ...i.a,
      ...(kind === 'generation' ? { generation: '2' } : {}),
    };
    const pf = {
      ...preflight,
      capacityAvailable: kind !== 'capacity',
      storageVerified: kind !== 'storage',
      permitGeneration: kind === 'permit' ? '4' : '3',
    };
    if (kind === 'budget') {
      await first
        .updateTable('maintenance_retry_state')
        .set({ lifetime_attempts: '12' })
        .where('asset_id', '=', i.a.journal.asset_id)
        .execute();
    }
    expect(
      (
        await a.reserve(
          args,
          kind === 'due'
            ? exactPgTimestamp('2000-01-01T00:00:00.000000Z')
            : i.due,
          '12',
          pf as typeof preflight,
        )
      ).status,
    ).toBe('refused');
    if (kind !== 'budget')
      expect(await snapshot(i.a.journal.asset_id)).toEqual(before);
    else
      expect((await retry.read(i.a.journal.asset_id))?.lifetime_attempts).toBe(
        '12',
      );
  });

  it('strict admission refuses expired manual tokens while legacy retry still replaces them', async () => {
    const i = await input();
    const token = applied(await a.claimManual(i.a.journal, randomUUID()));
    await sql`update public.asset_deletion set execution_expires_at = clock_timestamp() - interval '1 second'
      where asset_id = ${i.a.journal.asset_id}::uuid`.execute(first);
    expect((await b.claimManual(i.a.journal, randomUUID())).status).toBe(
      'refused',
    );
    expect((await b.reserve(i.a, i.due, '12', preflight)).status).toBe(
      'refused',
    );
    const legacy = new AssetDeletionRepository(manualDb);
    const next = await legacy.claim(i.a.journal.asset_id, i.a.journal.owner_id);
    expect(next.status).toBe('claimed');
    if (next.status === 'claimed') expect(next.token).not.toBe(token);
  });

  it('serializes a missing retry row with concurrent discovery', async () => {
    const id = await receipt();
    const journal = (await a.identity(id))!;
    await Promise.all([
      a.claimManual(journal, randomUUID()),
      new MaintenanceRetryRepository(second).discover(id),
    ]);
    expect((await retry.read(id))?.state).toBe('due');
    expect(
      (
        await first
          .selectFrom('asset_deletion')
          .select('execution_token')
          .where('asset_id', '=', id)
          .executeTakeFirst()
      )?.execution_token,
    ).not.toBeNull();
  });

  it.each(['manual', 'automatic'] as const)(
    'forces %s to win admission while the other backend waits',
    async (winner) => {
      const i = await input();
      const { proxy, locked, release } = barrier(first, 'update public.');
      const leadingRepo = await DormantDeletionAdmissionRepository.open(proxy);
      const leading =
        winner === 'manual'
          ? leadingRepo.claimManual(i.a.journal, randomUUID())
          : leadingRepo.reserve(i.a, i.due, '12', preflight);
      await locked;
      const trailing =
        winner === 'manual'
          ? b.reserve(i.a, i.due, '12', preflight)
          : b.claimManual(i.a.journal, randomUUID());
      try {
        await waiting();
      } finally {
        release();
      }
      expect((await leading).status).toBe('applied');
      expect((await trailing).status).toBe('refused');
    },
  );

  it('binds atomically and confirms exact identity without changing the deadline', async () => {
    const r = await reserved();
    const token = randomUUID();
    const value = applied(await a.bind(r, token));
    expect(value.deadline).toBe(r.deadline);
    expect(
      applied(await b.confirm(r, { deadline: r.deadline, token })),
    ).toEqual(value);
    expect((await b.bind(r, randomUUID())).status).toBe('refused');
  });

  it.each([
    'generation',
    'attemptId',
    'incarnationId',
    'permitGeneration',
    'deadline',
    'token',
    'owner',
    'storage',
    'timestamp',
  ] as const)(
    'rejects mismatched %s at confirmation and settlement',
    async (field) => {
      const r = await bound();
      const changed: BoundReservation = { ...r, journal: { ...r.journal } };
      if (field === 'generation' || field === 'permitGeneration')
        changed[field] = '999';
      else if (
        field === 'attemptId' ||
        field === 'incarnationId' ||
        field === 'token'
      )
        changed[field] = randomUUID();
      else if (field === 'deadline')
        changed.deadline = exactPgTimestamp('2000-01-01T00:00:00.000000Z');
      else if (field === 'owner') changed.journal.owner_id = randomUUID();
      else if (field === 'storage') changed.journal.storage_id = randomUUID();
      else
        changed.journal.requested_at_exact = exactPgTimestamp(
          '2000-01-01T00:00:00.000000Z',
        );
      const before = await snapshot(r.journal.asset_id);
      expect((await b.confirm(changed, changed)).status).toBe('refused');
      expect(
        (await b.settle(changed, { ioDrained: true, outcome: 'removed' }))
          .status,
      ).toBe('refused');
      expect(await snapshot(r.journal.asset_id)).toEqual(before);
    },
  );

  it.each(['removed', 'known_failure'] as const)(
    'atomically settles %s and preserves counters',
    async (outcome) => {
      const r = await bound();
      expect((await a.settle(r, { ioDrained: true, outcome })).status).toBe(
        'applied',
      );
      const after = await snapshot(r.journal.asset_id);
      expect(after.retry?.state).toBe(outcome === 'removed' ? 'closed' : 'due');
      expect(after.retry?.lifetime_attempts).toBe('1');
      expect(after.retry?.journal_execution_token).toBeNull();
      expect(after.journal?.execution_token).toBeNull();
      if (outcome === 'removed')
        expect(after.journal?.completed_at).not.toBeNull();
      else {
        const delay = await sql<{
          correct: boolean;
        }>`select next_eligible_at > clock_timestamp() + interval '4 minutes' as correct
        from public.maintenance_retry_state where asset_id = ${r.journal.asset_id}::uuid`.execute(
          first,
        );
        expect(delay.rows[0].correct).toBe(true);
      }
      expect((await b.settle(r, { ioDrained: true, outcome })).status).toBe(
        'refused',
      );
    },
  );

  it.each([
    {
      name: 'second immediate attempt',
      priorState: 'due',
      priorImmediate: 1,
      expectedImmediate: 2,
      expectedState: 'due',
      delayMinutes: 30,
    },
    {
      name: 'third immediate attempt',
      priorState: 'due',
      priorImmediate: 2,
      expectedImmediate: 3,
      expectedState: 'cooling',
      delayMinutes: 360,
    },
    {
      name: 'cooling probe',
      priorState: 'cooling',
      priorImmediate: 3,
      expectedImmediate: 3,
      expectedState: 'cooling',
      delayMinutes: 360,
    },
  ] as const)(
    'schedules the $name within exact database-time bounds',
    async ({
      priorState,
      priorImmediate,
      expectedImmediate,
      expectedState,
      delayMinutes,
    }) => {
      const i = await input();
      await first
        .updateTable('maintenance_retry_state')
        .set({
          immediate_attempts: priorImmediate,
          lifetime_attempts: '7',
          state: priorState,
        })
        .where('asset_id', '=', i.a.journal.asset_id)
        .execute();
      const r = applied(await a.reserve(i.a, i.due, '12', preflight));
      expect(r).toEqual({ ...i.a, deadline: expect.any(String) });
      expect(await retry.read(i.a.journal.asset_id)).toMatchObject({
        state: 'reserved',
        generation: i.a.generation,
        immediate_attempts: expectedImmediate,
        lifetime_attempts: '8',
        attempt_id: i.a.attemptId,
        worker_incarnation_id: i.a.incarnationId,
        permit_generation: i.a.permitGeneration,
        reservation_expires_at_exact: r.deadline,
        attempt_kind: priorState === 'due' ? 'immediate' : 'cooling',
      });
      const v = applied(await a.bind(r, randomUUID()));
      // Independent PostgreSQL observations bracket the actual settlement.
      // Preserve all six fractional digits; no Date conversion or time tolerance.
      async function databaseTime() {
        const result = await sql<{
          time: string;
        }>`select to_char(clock_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as time`.execute(second);
        return exactPgTimestamp(result.rows[0].time);
      }
      const before = await databaseTime();
      applied(await a.settle(v, { ioDrained: true, outcome: 'known_failure' }));
      const after = await databaseTime();
      const settled = await snapshot(r.journal.asset_id);
      expect(settled.retry).toMatchObject({
        state: expectedState,
        generation: i.a.generation,
        immediate_attempts: expectedImmediate,
        lifetime_attempts: '8',
        attempt_id: null,
        attempt_kind: null,
        worker_incarnation_id: null,
        permit_generation: null,
        reservation_expires_at_exact: null,
        journal_execution_token: null,
      });
      expect(settled.journal).toMatchObject({
        completed_at: null,
        execution_token: null,
        execution_expires_at: null,
      });
      const dueAt = exactPgTimestamp(settled.retry!.next_eligible_at_exact!);
      const timing = await sql<{
        lower: boolean;
        upper: boolean;
        future: boolean;
      }>`select
        ${dueAt}::timestamptz >= ${before}::timestamptz + ${delayMinutes} * interval '1 minute' as lower,
        ${dueAt}::timestamptz <= ${after}::timestamptz + ${delayMinutes} * interval '1 minute' as upper,
        ${dueAt}::timestamptz > clock_timestamp() as future`.execute(second);
      expect(timing.rows[0]).toEqual({
        lower: true,
        upper: true,
        future: true,
      });
      expect(
        (await b.settle(v, { ioDrained: true, outcome: 'known_failure' }))
          .status,
      ).toBe('refused');
      expect(
        (
          await b.settle(
            { ...v, incarnationId: randomUUID() },
            { ioDrained: true, outcome: 'known_failure' },
          )
        ).status,
      ).toBe('refused');
      expect(await snapshot(r.journal.asset_id)).toEqual(settled);
    },
  );

  it('retains token evidence even if the journal has completed with a different token', async () => {
    const r = await bound();
    await sql`update public.asset_deletion set execution_token = null, execution_expires_at = null,
      completed_at = clock_timestamp() where asset_id = ${r.journal.asset_id}::uuid`.execute(
      first,
    );
    applied(await a.block(r, 'quiescence_unknown'));
    const row = await retry.read(r.journal.asset_id);
    expect(row).toMatchObject({
      state: 'blocked_execution',
      journal_execution_token: r.token,
      attempt_id: r.attemptId,
      reservation_expires_at_exact: r.deadline,
    });
    expect(await retry.closeCompleted(r.journal.asset_id, r.generation)).toBe(
      'ineligible',
    );
    expect(await retry.read(r.journal.asset_id)).toEqual(row);
  });

  it('refuses expiry that occurs during an observed journal-lock wait', async () => {
    const r = await reserved();
    let ready!: (value: string) => void;
    let release!: () => void;
    const locked = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = first.transaction().execute(async (tx) => {
      await sql`select asset_id from public.asset_deletion where asset_id = ${r.journal.asset_id}::uuid for update`.execute(
        tx,
      );
      const row = await sql<{
        deadline: string;
      }>`update public.maintenance_retry_state
        set reservation_expires_at = clock_timestamp() + interval '1 second'
        where asset_id = ${r.journal.asset_id}::uuid returning
        to_char(reservation_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as deadline`.execute(
        tx,
      );
      ready(row.rows[0].deadline);
      await held;
    });
    const deadline = exactPgTimestamp(await locked);
    const pending = b.bind({ ...r, deadline }, randomUUID());
    try {
      await waiting();
      for (;;) {
        const time = await sql<{
          expired: boolean;
        }>`select clock_timestamp() > ${deadline}::timestamptz as expired`.execute(
          admin.db,
        );
        if (time.rows[0].expired) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
    }
    await holder;
    expect((await pending).status).toBe('refused');
    expect((await b.claimManual(r.journal, randomUUID())).status).toBe(
      'refused',
    );
    expect((await b.confirm(r)).status).toBe('refused');
    expect((await retry.read(r.journal.asset_id))?.attempt_id).toBe(
      r.attemptId,
    );
  });

  it.each(['bind', 'settle'] as const)(
    'rolls back both records if the second %s update is rejected',
    async (kind) => {
      const r = kind === 'bind' ? await reserved() : await bound();
      const before = await snapshot(r.journal.asset_id);
      const proxy = intercept(first, (query, run) =>
        run(
          query.startsWith('update public.maintenance_retry_state')
            ? query.replace(
                'returning r.asset_id',
                'and false returning r.asset_id',
              )
            : query,
        ),
      );
      const repo = await DormantDeletionAdmissionRepository.open(proxy);
      const result =
        kind === 'bind'
          ? await repo.bind(r, randomUUID())
          : await repo.settle(r as BoundReservation, {
              ioDrained: true,
              outcome: 'removed',
            });
      expect(result.status).toBe('refused');
      expect(await snapshot(r.journal.asset_id)).toEqual(before);
    },
  );

  it.each(['reserve', 'bind'] as const)(
    'confirms a %s after committed acknowledgement loss, never on rollback',
    async (kind) => {
      const i = await input();
      const r =
        kind === 'bind'
          ? applied(await a.reserve(i.a, i.due, '12', preflight))
          : undefined;
      const token = randomUUID();
      for (const committed of [false, true]) {
        const proxy = acknowledgementLoss(first, committed);
        const repo = await DormantDeletionAdmissionRepository.open(proxy);
        const result =
          kind === 'bind'
            ? await repo.bind(r!, token)
            : await repo.reserve(i.a, i.due, '12', preflight);
        expect(result.status).toBe('uncertain');
        const confirmed = await b.confirm(
          i.a,
          r ? { deadline: r.deadline, token } : undefined,
        );
        expect(confirmed.status).toBe(committed ? 'applied' : 'refused');
      }
      expect((await retry.read(i.a.journal.asset_id))?.lifetime_attempts).toBe(
        '1',
      );
    },
  );

  it('returns uncertain when independent confirmation is unavailable', async () => {
    const r = await reserved();
    const broken = new Proxy(first, {
      get(target, key) {
        if (key === 'getExecutor')
          return () =>
            new Proxy(target.getExecutor(), {
              get(executor, field) {
                if (field === 'executeQuery')
                  return () =>
                    Promise.reject(
                      new Error('Synthetic transport unavailable'),
                    );
                const value = Reflect.get(executor, field, executor);
                return typeof value === 'function'
                  ? value.bind(executor)
                  : value;
              },
            });
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // Factory readiness is positively established before simulating transport loss.
    let unavailable = false;
    const switchable = new Proxy(first, {
      get(target, key) {
        const value = Reflect.get(unavailable ? broken : target, key);
        return typeof value === 'function'
          ? value.bind(unavailable ? broken : target)
          : value;
      },
    });
    const repo = await DormantDeletionAdmissionRepository.open(switchable);
    unavailable = true;
    expect((await repo.confirm(r)).status).toBe('uncertain');
  });

  it('requires explicit budgets and refuses bigint exhaustion without mutation', async () => {
    const i = await input();
    for (const limit of ['0', '-1', '9223372036854775808', 'unlimited']) {
      await expect(a.reserve(i.a, i.due, limit, preflight)).rejects.toThrow();
    }
    await first
      .updateTable('maintenance_retry_state')
      .set({ lifetime_attempts: '9223372036854775807' })
      .where('asset_id', '=', i.a.journal.asset_id)
      .execute();
    expect(
      (await a.reserve(i.a, i.due, '9223372036854775807', preflight)).status,
    ).toBe('refused');
    expect((await retry.read(i.a.journal.asset_id))?.lifetime_attempts).toBe(
      '9223372036854775807',
    );
  });

  it.each(['generation', 'attempt', 'incarnation'] as const)(
    'negative control detects removing SQL %s CAS with other guards intact',
    async (kind) => {
      const r = await reserved();
      const changed = {
        ...r,
        ...(kind === 'generation'
          ? { generation: '2' }
          : kind === 'attempt'
            ? { attemptId: randomUUID() }
            : { incarnationId: randomUUID() }),
      };
      expect((await a.bind(changed, randomUUID())).status).toBe('refused');
      const column =
        kind === 'generation'
          ? 'generation'
          : kind === 'attempt'
            ? 'attempt_id'
            : 'worker_incarnation_id';
      const pattern = new RegExp(
        'r\\.' + column + ' = (\\$[0-9]+::(?:bigint|uuid))',
        'g',
      );
      let changedSql = false;
      const proxy = intercept(first, (query, run) => {
        const mutant = query.replace(pattern, '$1 is not null');
        changedSql ||= mutant !== query;
        return run(mutant);
      });
      const mutant = await DormantDeletionAdmissionRepository.open(proxy);
      // The original refusal assertion would fail: these are valid-row mutations,
      // not unrelated CHECK violations. No production source is altered.
      expect((await mutant.bind(changed, randomUUID())).status).toBe('applied');
      expect(changedSql).toBe(true);
    },
  );

  it.each(['interlock', 'expired_token'] as const)(
    'negative control detects removing %s refusal',
    async (kind) => {
      const i = await input();
      if (kind === 'interlock')
        applied(await a.reserve(i.a, i.due, '12', preflight));
      else {
        applied(await a.claimManual(i.a.journal, randomUUID()));
        await sql`update public.asset_deletion set execution_expires_at = clock_timestamp() - interval '1 second' where asset_id = ${i.a.journal.asset_id}::uuid`.execute(
          first,
        );
      }
      expect((await a.claimManual(i.a.journal, randomUUID())).status).toBe(
        'refused',
      );
      const proxy = intercept(first, (query, run) =>
        run(
          kind === 'interlock'
            ? query.replace(
                "r.state in ('reserved', 'blocked_execution', 'closed')",
                'false',
              )
            : query.replace(
                'and d.execution_token is null',
                'and (d.execution_token is null or d.execution_expires_at <= clock_timestamp())',
              ),
        ),
      );
      const mutant = await DormantDeletionAdmissionRepository.open(proxy);
      expect((await mutant.claimManual(i.a.journal, randomUUID())).status).toBe(
        'applied',
      );
    },
  );

  it('negative control detects loss of bound-token evidence', async () => {
    const r = await bound();
    const proxy = intercept(first, (query, run) =>
      run(
        query.replace(
          "set state = 'blocked_execution',",
          "set journal_execution_token = null, state = 'blocked_execution',",
        ),
      ),
    );
    applied(
      await (
        await DormantDeletionAdmissionRepository.open(proxy)
      ).block(r, 'quiescence_unknown'),
    );
    expect(
      (await retry.read(r.journal.asset_id))?.journal_execution_token,
    ).not.toBe(r.token);
  });

  it('isolates the B.3 SQL state predicate even while its TypeScript check remains', async () => {
    const i = await input();
    await sql`update public.asset_deletion set completed_at = clock_timestamp() where asset_id = ${i.a.journal.asset_id}::uuid`.execute(
      first,
    );
    expect(await retry.closeCompleted(i.a.journal.asset_id, '1')).toBe(
      'applied',
    );
    for (const removePredicate of [false, true]) {
      const proxy = intercept(first, async (query, run) => {
        const result = await run(
          removePredicate
            ? query.replace("and state in ('due', 'cooling')", 'and true')
            : query,
        );
        // Only the application's read is changed: PostgreSQL retains a valid
        // closed row. Removing SQL state eligibility alone can now mutate it.
        if (
          query.includes('as updated_at_exact') &&
          query.includes('for update')
        )
          return {
            ...result,
            rows: result.rows.map((row) => ({
              ...(row as object),
              state: 'due',
            })),
          };
        return result;
      });
      const before = await retry.read(i.a.journal.asset_id);
      const result = await new MaintenanceRetryRepository(proxy).closeCompleted(
        i.a.journal.asset_id,
        '1',
      );
      expect(result).toBe(removePredicate ? 'applied' : 'stale');
      const after = await retry.read(i.a.journal.asset_id);
      if (removePredicate)
        expect(after?.updated_at_exact).not.toBe(before?.updated_at_exact);
      else expect(after).toEqual(before);
    }
  });

  it('fails closed if M13 tables disappear after readiness, without a manual fallback', async () => {
    const r = await reserved();
    await sql`alter table public.maintenance_retry_state rename to synthetic_unavailable_retry`.execute(
      first,
    );
    try {
      await expect(
        DormantDeletionAdmissionRepository.open(second),
      ).rejects.toThrow();
      expect((await a.claimManual(r.journal, randomUUID())).status).toBe(
        'uncertain',
      );
    } finally {
      await sql`alter table public.synthetic_unavailable_retry rename to maintenance_retry_state`.execute(
        first,
      );
    }
  });

  it('rejects a genuine historical M12 schema without migrating or selecting a fallback', async () => {
    const config = testConfig();
    const name = `saefr_b41_m12_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(name)}`.execute(admin.db);
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          host: '127.0.0.1',
          port: config.getOrThrow<number>('POSTGRES_PORT'),
          database: name,
          user: config.getOrThrow<string>('POSTGRES_USER'),
          password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
          max: 1,
        }),
      }),
    });
    try {
      const all = await createMigrationProvider().getMigrations();
      const { [MAINTENANCE_RECOVERY_MIGRATION]: excluded, ...m12 } = all;
      expect(excluded).toBeDefined();
      const migrated = await new Migrator({
        db,
        migrationTableSchema: 'public',
        provider: { getMigrations: async () => m12 },
      }).migrateToLatest();
      expect(migrated.error).toBeUndefined();
      const before = await db
        .selectFrom('asset_deletion')
        .selectAll()
        .execute();
      await expect(DormantDeletionAdmissionRepository.open(db)).rejects.toThrow(
        'exact M13 schema',
      );
      expect(
        await db.selectFrom('asset_deletion').selectAll().execute(),
      ).toEqual(before);
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin.db);
    }
  });

  it.each(['reservation', 'replacement'] as const)(
    'forces %s to win against generation replacement',
    async (winner) => {
      const i = await input();
      const row = (await retry.read(i.a.journal.asset_id))!;
      const replacement = {
        assetId: i.a.journal.asset_id,
        generation: '1',
        expectedRevision: exactPgTimestamp(row.updated_at_exact),
        terminalDeliveryVerified: true,
      } as const;
      const gate = barrier(first, 'update public.maintenance_retry_state');
      const leading =
        winner === 'reservation'
          ? (await DormantDeletionAdmissionRepository.open(gate.proxy)).reserve(
              i.a,
              i.due,
              '12',
              preflight,
            )
          : new MaintenanceRetryRepository(
              gate.proxy,
            ).advanceGenerationAfterTerminalDelivery(replacement);
      await gate.locked;
      const trailing =
        winner === 'reservation'
          ? new MaintenanceRetryRepository(
              second,
            ).advanceGenerationAfterTerminalDelivery(replacement)
          : b.reserve(i.a, i.due, '12', preflight);
      try {
        await waiting();
      } finally {
        gate.release();
      }
      const head = await leading;
      expect(typeof head === 'string' ? head : head.status).toBe('applied');
      const tail = await trailing;
      expect(typeof tail === 'string' ? tail : tail.status).toBe(
        winner === 'reservation' ? 'stale' : 'refused',
      );
      const after = await retry.read(i.a.journal.asset_id);
      expect(after?.generation).toBe(winner === 'reservation' ? '1' : '2');
      expect(after?.lifetime_attempts).toBe(
        winner === 'reservation' ? '1' : '0',
      );
    },
  );

  it.each(['completed', 'live_asset', 'future_due'] as const)(
    'refuses %s authority without consuming an attempt',
    async (kind) => {
      const i = await input();
      if (kind === 'completed')
        await first
          .updateTable('asset_deletion')
          .set({ completed_at: new Date() })
          .where('asset_id', '=', i.a.journal.asset_id)
          .execute();
      if (kind === 'live_asset')
        await first
          .insertInto('asset')
          .values({
            id: i.a.journal.asset_id,
            owner_id: i.a.journal.owner_id,
            filename: 'synthetic.jpg',
            mime_type: 'image/jpeg',
            size: 1,
            storage_path: 'synthetic',
            created_at: new Date(),
          })
          .execute();
      let dueAt = i.due;
      if (kind === 'future_due') {
        await sql`update public.maintenance_retry_state set next_eligible_at = clock_timestamp() + interval '1 hour' where asset_id = ${i.a.journal.asset_id}::uuid`.execute(
          first,
        );
        dueAt = exactPgTimestamp(
          (await retry.read(i.a.journal.asset_id))!.next_eligible_at_exact!,
        );
      }
      expect((await a.reserve(i.a, dueAt, '12', preflight)).status).toBe(
        'refused',
      );
      expect((await retry.read(i.a.journal.asset_id))?.lifetime_attempts).toBe(
        '0',
      );
    },
  );

  it('refuses inconsistent pending-journal/closed-retry authority', async () => {
    const i = await input();
    await first
      .updateTable('maintenance_retry_state')
      .set({ state: 'closed', next_eligible_at: null })
      .where('asset_id', '=', i.a.journal.asset_id)
      .execute();
    expect((await a.claimManual(i.a.journal, randomUUID())).status).toBe(
      'refused',
    );
  });

  it('cannot infer historical predecessor drainage from a later NULL legacy token', async () => {
    const i = await input();
    const legacy = new AssetDeletionRepository(manualDb);
    const initial = await legacy.claim(
      i.a.journal.asset_id,
      i.a.journal.owner_id,
    );
    expect(initial.status).toBe('claimed');
    // Represents A's unresolved provider call; no filesystem operation is issued.
    let drain!: () => void;
    const outstanding = new Promise<void>((resolve) => {
      drain = resolve;
    });
    try {
      await sql`update public.asset_deletion set execution_expires_at = clock_timestamp() - interval '1 second' where asset_id = ${i.a.journal.asset_id}::uuid`.execute(
        first,
      );
      const later = await legacy.claim(
        i.a.journal.asset_id,
        i.a.journal.owner_id,
      );
      if (later.status !== 'claimed')
        throw new Error('Expected legacy replacement');
      expect(
        await legacy.recordFailure(
          i.a.journal.asset_id,
          i.a.journal.owner_id,
          later.token,
          'filesystem_error',
        ),
      ).toBe(true);
      // This DB state contains no record of A. Only an externally fenced
      // activation can establish the strict protocol's initial condition.
      expect((await a.reserve(i.a, i.due, '12', preflight)).status).toBe(
        'applied',
      );
    } finally {
      drain();
      await outstanding;
    }
  });

  it.each(['removed', 'known_failure'] as const)(
    'does not attribute an uncertain %s settlement to a fresh attempt',
    async (outcome) => {
      const r = await bound();
      const repo = await DormantDeletionAdmissionRepository.open(
        acknowledgementLoss(first, true),
      );
      expect((await repo.settle(r, { ioDrained: true, outcome })).status).toBe(
        'uncertain',
      );
      expect((await b.confirm(r, r)).status).toBe('refused');
      const row = await retry.read(r.journal.asset_id);
      expect(row?.state).toBe(outcome === 'removed' ? 'closed' : 'due');
      expect(row?.lifetime_attempts).toBe('1');
      expect(row?.attempt_id).toBeNull();
      expect((await b.settle(r, { ioDrained: true, outcome })).status).toBe(
        'refused',
      );
      expect(await retry.read(r.journal.asset_id)).toEqual(row);
    },
  );

  // Pauses a real transaction AFTER a matching statement while retaining locks.
  function barrier(db: Kysely<Database>, marker: string) {
    let unlock!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let paused = false;
    const proxy = intercept(db, async (query, run) => {
      const result = await run();
      if (!paused && query.includes(marker)) {
        paused = true;
        acquired();
        await held;
      }
      return result;
    });
    return { proxy, locked, release: unlock };
  }
  async function waiting() {
    for (let tries = 0; tries < 150; tries++) {
      const r = await sql<{
        waiting: boolean;
      }>`select exists(select 1 from pg_stat_activity
        where datname = ${databaseName} and application_name = 'saefr_retry_second'
          and wait_event_type = 'Lock') as waiting`.execute(admin.db);
      if (r.rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Independent backend did not wait on the journal');
  }
});

/** Test-only SQL transport; every unmodified statement reaches PostgreSQL. */
function intercept(
  db: Kysely<Database>,
  visit: (
    query: string,
    run: (
      replacement?: string,
    ) => Promise<import('kysely').QueryResult<unknown>>,
  ) => Promise<import('kysely').QueryResult<unknown>>,
) {
  const wrap = (tx: import('kysely').Transaction<Database>) =>
    new Proxy(tx, {
      get(transaction, member) {
        if (member === 'getExecutor')
          return () => {
            const executor = transaction.getExecutor();
            return new Proxy(executor, {
              get(ex, name) {
                if (name === 'executeQuery')
                  return (...args: Parameters<typeof executor.executeQuery>) =>
                    visit(args[0].sql, (replacement) =>
                      executor.executeQuery(
                        { ...args[0], sql: replacement ?? args[0].sql },
                        args[1],
                      ),
                    );
                const value = Reflect.get(ex, name, ex);
                return typeof value === 'function' ? value.bind(ex) : value;
              },
            });
          };
        const value = Reflect.get(transaction, member, transaction);
        return typeof value === 'function' ? value.bind(transaction) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'transaction')
        return () => {
          const execute = <T>(
            work: (tx: import('kysely').Transaction<Database>) => Promise<T>,
          ) =>
            target
              .transaction()
              .setIsolationLevel('read committed')
              .execute((tx) => work(wrap(tx)));
          return { execute, setIsolationLevel: () => ({ execute }) };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function acknowledgementLoss(
  db: Kysely<Database>,
  committed: boolean,
): Kysely<Database> {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'transaction')
        return () => ({
          setIsolationLevel: () => ({
            execute: async <T>(
              work: (tx: import('kysely').Transaction<Database>) => Promise<T>,
            ) => {
              await target
                .transaction()
                .setIsolationLevel('read committed')
                .execute(async (tx) => {
                  await work(tx);
                  if (!committed)
                    throw new Error('Synthetic transport loss before COMMIT');
                });
              throw new Error('Synthetic acknowledgement loss after COMMIT');
            },
          }),
        });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
