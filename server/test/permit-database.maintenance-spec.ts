import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  migrateToLatest,
  getMigrationStatus,
} from '../src/database/migrations/migration-runner.js';
import {
  PermitDatabasePool,
  PERMIT_DATABASE_LIMITS,
} from '../src/worker/permit-database-pool.js';
import { createPermitPairing } from '../src/worker/recovery-permit-config.js';
import {
  DatabasePermitPairing,
  RecoveryPermitService,
} from '../src/worker/recovery-permit.service.js';
import { MaintenanceRecoveryAuthorization } from '../src/worker/maintenance-recovery-authorization.js';
import { RecoveryPermitStore } from '../src/worker/recovery-permit-store.js';
import {
  encodePermit,
  pairingFingerprint,
  RecoveryPermitError,
} from '../src/worker/recovery-permit.js';
import { MaintenanceRuntime } from '../src/worker/maintenance-runtime.js';
import { maintenanceConfig } from '../src/worker/maintenance-config.js';
import { MaintenanceReconciliationRepository } from '../src/worker/maintenance-reconciliation.repository.js';
import { MaintenanceRecoveryService } from '../src/worker/maintenance-recovery.service.js';
import { MaintenanceRetryRepository } from '../src/worker/maintenance-retry.repository.js';
import { MaintenanceDeliveryRepository } from '../src/worker/maintenance-delivery.repository.js';
import { StorageBindingVerifier } from '../src/storage/storage-binding.service.js';
import { locationFingerprint } from '../src/storage/storage-marker.js';
import { PostgresFaultProxy } from './helpers/postgres-fault-proxy.js';
import { testConfig } from './helpers/integration-database.js';

async function eventually(check: () => Promise<boolean>, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Disposable connection condition not observed');
}

describe('production permit connection retirement and actual runtime faults', () => {
  let admin: DatabaseService;
  let db: Kysely<Database>;
  let name: string;
  let root: string;
  let proxy: PostgresFaultProxy;
  const pools: PermitDatabasePool[] = [];
  const runtimes: MaintenanceRuntime[] = [];
  const folders: string[] = [];
  const owner = randomUUID();
  const binding = {
    singleton: true,
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
    storage_layout_version: 1,
  };
  const coordinator = () => new MaintenanceReconciliationRepository(db);
  const options = (port?: number) => {
    const config = testConfig();
    return {
      host: '127.0.0.1',
      port: port ?? config.getOrThrow<number>('POSTGRES_PORT'),
      database: name,
      user: config.getOrThrow<string>('POSTGRES_USER'),
      password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
      statement_timeout: 5000,
      options:
        '-c default_transaction_read_only=on -c search_path=pg_catalog,public -c lock_timeout=2000',
    };
  };
  function pool(port?: number) {
    const result = new PermitDatabasePool(options(port));
    pools.push(result);
    return result;
  }
  beforeAll(async () => {
    admin = new DatabaseService(testConfig());
    name = `saefr_permit_transport_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(name)}`.execute(admin.db);
    const { Pool } = await import('pg');
    const config = options();
    const fixturePool = new Pool({
      ...config,
      max: 2,
      options: '-c search_path=pg_catalog,public',
    });
    fixturePool.on('error', () => undefined); // fixture metadata connection is never the fault target
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: fixturePool }),
    });
    await migrateToLatest(db);
    await db.insertInto('storage_binding').values(binding).execute();
    await sql`insert into public.app_user values (${owner}::uuid,'permit-network-fixture','synthetic-hash','user','active',false,clock_timestamp(),clock_timestamp())`.execute(
      db,
    );
  });
  beforeEach(async () => {
    await sql`truncate public.asset, public.asset_deletion, public.maintenance_retry_state, public.maintenance_takeover_clearance`.execute(
      db,
    );
    await sql`update public.maintenance_reconciliation set leader_epoch=0,leader_token=null,leader_expires_at=null,
      pass_status='complete',pass_id=null,pass_owner_epoch=null,upper_requested_at=null,upper_asset_id=null,
      cursor_requested_at=null,cursor_asset_id=null,updated_at=clock_timestamp()`.execute(
      db,
    );
    root = await mkdtemp(join(tmpdir(), 'saefr-permit-transport-'));
    folders.push(root);
    proxy = new PostgresFaultProxy();
    await proxy.start();
  });
  afterEach(async () => {
    // Explicitly finish only this proxy's synthetic remote sessions before final local disposal.
    await proxy.close();
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    for (const item of pools.splice(0)) await item.end().catch(() => undefined); // failed end remains truthfully failed
    for (const folder of folders.splice(0))
      await rm(folder, { recursive: true, force: true });
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin && name)
      await sql`drop database ${sql.id(name)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  async function lockAvailable() {
    return db.connection().execute(async (connection) => {
      const row = (
        await sql<{
          available: boolean;
        }>`select pg_try_advisory_lock(708202610170001::bigint) as available`.execute(
          connection,
        )
      ).rows[0];
      if (row.available)
        await sql`select pg_advisory_unlock(708202610170001::bigint)`.execute(
          connection,
        );
      return row.available;
    });
  }
  async function receipt() {
    const id = randomUUID();
    await sql`insert into public.asset_deletion (asset_id,owner_id,accepted_lifecycle_version,storage_id,
      originals_binding_id,thumbnails_binding_id,storage_layout_version,original_extension,requested_at)
      values (${id}::uuid,${owner}::uuid,1,${binding.storage_id}::uuid,${binding.originals_binding_id}::uuid,
      ${binding.thumbnails_binding_id}::uuid,1,'.jpg',clock_timestamp())`.execute(
      db,
    );
    return id;
  }
  async function runtime(databasePool: PermitDatabasePool) {
    const permitDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: databasePool }),
    });
    const verifier = new StorageBindingVerifier(
      { db } as DatabaseService,
      new ConfigService({
        STORAGE_ROOT: join(root, 'media'),
        STORAGE_ID: binding.storage_id,
        STORAGE_ORIGINALS_BINDING_ID: binding.originals_binding_id,
        STORAGE_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
        STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
        STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
      }),
      {
        observe: async (role, location) => {
          const identity = {
            format: 'linux-ext4-handle-v1' as const,
            profile: 'linux-ext4-v1' as const,
            filesystem_uuid: binding.storage_id,
            directory_handle_type: 1,
            directory_handle_hex: '01020304',
          };
          return {
            identity,
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
          };
        },
      },
    );
    // Explicit synthetic storage and operator reader, not a production configuration bypass.
    await import('node:fs/promises').then((fs) => fs.chmod(root, 0o750));
    const store = new RecoveryPermitStore({
      path: join(root, 'permit.json'),
      operatorUid: process.geteuid!(),
      readerGid: process.getegid!(),
      restoreRoots: [join(root, 'media')],
    });
    await writeFile(
      store.location.path,
      encodePermit({
        version: 1,
        armed: true,
        generation: '7',
        pairing_sha256: pairingFingerprint(binding),
      }),
      { mode: 0o640 },
    );
    const authorization = new MaintenanceRecoveryAuthorization(
      new RecoveryPermitService(
        { readRuntime: () => store.readOperator() },
        new DatabasePermitPairing(permitDb, verifier),
      ),
    );
    const coord = coordinator();
    const service = new MaintenanceRecoveryService(
      coord,
      new MaintenanceRetryRepository(db),
      new MaintenanceDeliveryRepository(db),
      authorization,
      {
        inspect: async () => {
          throw new Error('No recovery producer');
        },
        enqueue: async () => {
          throw new Error('No recovery producer');
        },
      },
      1,
    );
    const value = new MaintenanceRuntime(
      maintenanceConfig({
        SAEFR_MAINTENANCE_ENABLED: 'true',
        SAEFR_MAINTENANCE_INTERVAL_MS: '1000',
        SAEFR_MAINTENANCE_RENEW_MS: '1000',
        SAEFR_MAINTENANCE_PAGE_SIZE: '1',
      }),
      coord,
      authorization,
      service,
      () => databasePool.end(),
    );
    runtimes.push(value);
    return value;
  }

  it('preserves successful production validation, normal advisory unlock and repeated close', async () => {
    const actual = pool();
    const reader = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: actual }),
    });
    expect(
      (await getMigrationStatus(reader)).migrations.every((row) => row.applied),
    ).toBe(true);
    expect(await lockAvailable()).toBe(true);
    expect(actual.diagnostics().unconfirmedSessions).toBe(0);
    await actual.end();
    await actual.end();
  });

  it('bounds connection establishment and never falls back to ordinary database configuration', async () => {
    const actual = pool(1);
    const began = Date.now();
    await expect(actual.connect()).rejects.toThrow('pairing_unavailable');
    expect(Date.now() - began).toBeLessThan(
      PERMIT_DATABASE_LIMITS.connect + 1500,
    );
    expect(actual.diagnostics().unconfirmedSessions).toBe(0);
  });

  it('retires a checked-out production session after a server statement error before revalidation', async () => {
    const actual = pool();
    const client = await actual.connect();
    const id = (
      await client.query<{ pid: number }>('select pg_backend_pid() as pid', [])
    ).rows[0].pid;
    await client.query("set statement_timeout='100ms'", []);
    await expect(client.query('select pg_sleep(1)', [])).rejects.toThrow(
      'pairing_unavailable',
    );
    await expect(client.query('select 1', [])).rejects.toThrow(
      'pairing_unavailable',
    );
    client.release();
    expect(actual.diagnostics().unconfirmedSessions).toBe(1);
    await eventually(
      async () =>
        !(
          await sql<{
            present: boolean;
          }>`select exists(select 1 from pg_stat_activity where pid=${id}) as present`.execute(
            db,
          )
        ).rows[0].present,
    );
    const fresh = await actual.connect();
    expect(
      (await fresh.query<{ pid: number }>('select pg_backend_pid() as pid', []))
        .rows[0].pid,
    ).not.toBe(id);
    fresh.release();
    expect(actual.diagnostics().unconfirmedSessions).toBe(0);
  });

  it('bounds the actual createPermitPairing receive path after authentication', async () => {
    proxy.fault = 'after-auth';
    const config = options(proxy.port());
    const env = {
      RECOVERY_PERMIT_STORAGE_ROOT: join(root, 'never-open-media'),
      RECOVERY_PERMIT_STORAGE_ID: binding.storage_id,
      RECOVERY_PERMIT_ORIGINALS_BINDING_ID: binding.originals_binding_id,
      RECOVERY_PERMIT_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
      RECOVERY_PERMIT_POSTGRES_HOST: config.host,
      RECOVERY_PERMIT_POSTGRES_PORT: String(config.port),
      RECOVERY_PERMIT_POSTGRES_DB: name,
      RECOVERY_PERMIT_POSTGRES_USER: config.user,
      RECOVERY_PERMIT_POSTGRES_PASSWORD: config.password,
    };
    const actual = createPermitPairing(env, {
      path: join(root, 'never-created-permit'),
      operatorUid: process.geteuid!(),
      readerGid: process.getegid!(),
      restoreRoots: [join(root, 'never-open-media')],
    });
    const began = Date.now();
    let guard: NodeJS.Timeout | undefined;
    try {
      // An absent production deadline fails this assertion, rather than the process/test timeout.
      const outcome = await Promise.race([
        actual.pairing.verify().then(
          () => 'unexpected-authorization',
          (error: unknown) =>
            error instanceof RecoveryPermitError
              ? error.code
              : 'unexpected-error',
        ),
        new Promise<string>((resolve) => {
          guard = setTimeout(() => resolve('still-pending'), 6000);
        }),
      ]);
      expect(outcome).toBe('pairing_unavailable');
      expect(proxy.droppedBytes).toBeGreaterThan(0);
      expect(Date.now() - began).toBeLessThan(
        PERMIT_DATABASE_LIMITS.receive + PERMIT_DATABASE_LIMITS.dispose + 2000,
      );
      expect(actual.databaseDiagnostics().unconfirmedSessions).toBe(1);
    } finally {
      clearTimeout(guard);
      proxy.fault = 'none';
      await actual.close().catch(() => undefined); // preserve an assertion failure during fault cleanup
    }
    await actual.close(); // positive path must still acknowledge complete disposal
  });

  it('fences uncertain remote lock ownership and recovers only after positive disappearance evidence', async () => {
    proxy.fault = 'after-identity';
    proxy.preserveBackend = true;
    const actual = pool(proxy.port());
    const value = await runtime(actual);
    const id = await receipt();
    const tick = value.tick();
    expect(value.tick()).toBe(tick);
    const began = Date.now();
    await tick;
    expect(Date.now() - began).toBeLessThan(6000);
    expect(value.diagnostics()).toMatchObject({
      state: 'degraded',
      pages: 0,
      tickActive: false,
      ownsCoordinator: false,
    });
    expect(actual.diagnostics()).toMatchObject({
      unconfirmedSessions: 1,
      pendingLocalDisposals: 0,
    });
    expect(await lockAvailable()).toBe(false);
    const count = proxy.primaryConnections;
    await value.tick();
    expect(proxy.primaryConnections).toBe(count);
    expect(value.diagnostics().state).toBe('degraded');
    expect(await new MaintenanceRetryRepository(db).read(id)).toBeUndefined();
    proxy.releaseRetiredBackends();
    proxy.fault = 'none';
    await eventually(lockAvailable);
    await value.tick();
    expect(actual.diagnostics().unconfirmedSessions).toBe(0);
    expect(value.diagnostics().state).toBe('ready');
    expect(
      (await new MaintenanceRetryRepository(db).read(id))?.lifetime_attempts,
    ).toBe('0');
    const pages = value.diagnostics().pages;
    proxy.flushLateReplies();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(value.diagnostics().pages).toBe(pages);
    expect(
      (
        await db
          .selectFrom('maintenance_takeover_clearance')
          .selectAll()
          .execute()
      ).length,
    ).toBe(0);
  });

  it('stays unconfirmed when the independent remote proof cannot be received', async () => {
    proxy.fault = 'after-identity';
    proxy.preserveBackend = true;
    const actual = pool(proxy.port());
    const value = await runtime(actual);
    await receipt();
    await value.tick();
    proxy.releaseRetiredBackends();
    proxy.fault = 'none';
    proxy.blockProof = true;
    await value.tick();
    expect(value.diagnostics().state).toBe('degraded');
    expect(actual.diagnostics().unconfirmedSessions).toBe(1);
    proxy.blockProof = false;
    await value.tick();
    expect(actual.diagnostics().unconfirmedSessions).toBe(0);
    expect(value.diagnostics().state).toBe('ready');
  });

  it('returns truthful incomplete shutdown when the retired remote session is still observable', async () => {
    proxy.fault = 'after-identity';
    proxy.preserveBackend = true;
    const actual = pool(proxy.port());
    const value = await runtime(actual);
    await receipt();
    const tick = value.tick();
    await eventually(async () => proxy.droppedBytes > 0);
    const stopped = value.stop();
    expect(value.stop()).toBe(stopped);
    expect(await stopped).toBe(false);
    await tick;
    expect(value.diagnostics().state).toBe('incomplete');
    expect(actual.diagnostics().unconfirmedSessions).toBe(1);
    proxy.releaseRetiredBackends();
    await eventually(lockAvailable);
    await value.tick();
    expect(value.diagnostics().pages).toBe(0);
  });

  it.each([false, true])(
    'production checked-out error listener negative control (removed: %s)',
    async (removed) => {
      let modulePath: string | undefined;
      if (removed) {
        const folder = await mkdtemp(
          join(tmpdir(), 'saefr-permit-listener-mutant-'),
        );
        folders.push(folder);
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(
          join(process.cwd(), 'dist/worker/permit-database-pool.js'),
          'utf8',
        );
        const mutant = source.replace(
          /client\.on\('error', \(\) => \{\s*this\.retire\(session\);\s*console\.error\('Recovery permit database connection unavailable\.'\);\s*\}\);/,
          '',
        );
        expect(mutant).not.toBe(source);
        modulePath = join(folder, 'permit-database-pool.mjs');
        await writeFile(modulePath, mutant);
        await symlink(
          join(process.cwd(), 'node_modules'),
          join(folder, 'node_modules'),
          'dir',
        );
        await symlink(
          join(process.cwd(), 'dist/worker/recovery-permit.js'),
          join(folder, 'recovery-permit.js'),
        );
      }
      const child = spawn(
        process.execPath,
        [
          'test/helpers/permit-pool-child.mjs',
          ...(modulePath ? [modulePath] : []),
        ],
        {
          env: {
            PATH: process.env.PATH,
            SAEFR_M7_TEST_CONTAINER_ID: process.env.SAEFR_M7_TEST_CONTAINER_ID,
            SAEFR_M7_TEST_DB: process.env.SAEFR_M7_TEST_DB,
            SAEFR_M7_TEST_PORT: process.env.SAEFR_M7_TEST_PORT,
            SAEFR_M7_TEST_USER: process.env.SAEFR_M7_TEST_USER,
            SAEFR_M7_TEST_PASSWORD: process.env.SAEFR_M7_TEST_PASSWORD,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let errors = '';
      child.stdout.on('data', (b: Buffer) => {
        output += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        errors += b.toString();
      });
      const ended = new Promise<number | null>((resolve) =>
        child.once('close', (code) => resolve(code)),
      );
      const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
      try {
        await eventually(async () => output.includes('{"ready":'), 5000);
        const pid = (
          JSON.parse(
            output.split('\n').find((line) => line.startsWith('{"ready":'))!,
          ) as { ready: number }
        ).ready;
        // Kill only the PID emitted by this owned disposable child's production connection.
        expect(
          (
            await sql<{
              owned: boolean;
            }>`select exists(select 1 from pg_stat_activity where pid=${pid}
        and datname=${process.env.SAEFR_M7_TEST_DB} and application_name like 'saefr-permit-%') as owned`.execute(
              admin.db,
            )
          ).rows[0].owned,
        ).toBe(true);
        await sql`select pg_terminate_backend(${pid})`.execute(admin.db);
        const code = await ended;
        if (removed) {
          expect(code).not.toBe(0);
          expect(errors).toContain("Unhandled 'error' event");
        } else {
          expect(code).toBe(0);
          expect(output).toContain('production-listener-recovered');
        }
        expect(output + errors).not.toContain(
          process.env.SAEFR_M7_TEST_PASSWORD,
        );
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill('SIGKILL');
        await ended;
      }
    },
    20000,
  );
});
