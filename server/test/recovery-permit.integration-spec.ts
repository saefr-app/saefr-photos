import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigService } from '@nestjs/config';
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
} from 'vitest';

import type { Database } from '../src/database/database.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from '../src/storage/storage-binding.service.js';
import {
  locationFingerprint,
  type StorageRole,
} from '../src/storage/storage-marker.js';
import { RecoveryPermitStore } from '../src/worker/recovery-permit-store.js';
import {
  DatabasePermitPairing,
  RecoveryPermitOperator,
  RecoveryPermitService,
} from '../src/worker/recovery-permit.service.js';
import {
  encodePermit,
  pairingFingerprint,
} from '../src/worker/recovery-permit.js';
import { testConfig } from './helpers/integration-database.js';

// All SQL uses the ownership-verified disposable runner. Physical storage is
// synthetic: the real verifier consumes bounded marker bytes and observed
// identities from this explicit test double, never host media.
describe('M13B.2 recovery permit on disposable PostgreSQL', () => {
  let admin: DatabaseService;
  let writer: DatabaseService;
  let reader: Kysely<Database>;
  let databaseName: string;
  let root: string;
  let store: RecoveryPermitStore;
  let probe: DatabasePermitPairing;
  let mismatch: StorageRole | undefined;
  let unavailable = false;
  let observed: StorageRole[];
  const binding = {
    singleton: true,
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
    storage_layout_version: 1,
  };
  const fingerprint = pairingFingerprint(binding);
  const owner = randomUUID();
  const receipt = randomUUID();
  const attempt = randomUUID();
  const incarnation = randomUUID();
  const clearance = randomUUID();
  const identity = {
    format: 'linux-ext4-handle-v1' as const,
    profile: 'linux-ext4-v1' as const,
    filesystem_uuid: randomUUID(),
    directory_handle_type: 1,
    directory_handle_hex: '01020304',
  };

  const observer: PhysicalStorageObserver = {
    async observe(role, location) {
      observed.push(role);
      if (unavailable) throw new Error('synthetic private mount failure');
      const marker = {
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
      };
      return {
        markerBytes: Buffer.from(JSON.stringify(marker)),
        identity: {
          ...identity,
          directory_handle_hex:
            mismatch === role ? 'deadbeef' : identity.directory_handle_hex,
        },
      };
    },
  };

  beforeAll(async () => {
    const config = testConfig();
    admin = new DatabaseService(config);
    databaseName = `saefr_permit_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    const credentials = {
      host: '127.0.0.1',
      port: config.getOrThrow<number>('POSTGRES_PORT'),
      database: databaseName,
      user: config.getOrThrow<string>('POSTGRES_USER'),
      password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
    };
    writer = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: credentials.host,
        POSTGRES_PORT: credentials.port,
        POSTGRES_DB: databaseName,
        POSTGRES_USER: credentials.user,
        POSTGRES_PASSWORD: credentials.password,
      }),
    );
    await migrateToLatest(writer.db);
    reader = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          ...credentials,
          max: 1,
          options:
            '-c default_transaction_read_only=on -c search_path=pg_catalog,public -c lock_timeout=2000',
          statement_timeout: 5000,
        }),
      }),
    });
    await writer.db.insertInto('storage_binding').values(binding).execute();
    await sql`insert into public.app_user values (${owner}::uuid, 'permit-fixture', 'synthetic-hash',
      'user', 'active', false, clock_timestamp(), clock_timestamp())`.execute(
      writer.db,
    );
    await sql`insert into public.asset_deletion (asset_id, owner_id, accepted_lifecycle_version, storage_id,
      originals_binding_id, thumbnails_binding_id, storage_layout_version, original_extension, requested_at)
      values (${receipt}::uuid, ${owner}::uuid, 0, ${binding.storage_id}::uuid,
        ${binding.originals_binding_id}::uuid, ${binding.thumbnails_binding_id}::uuid, 1, '.jpg', clock_timestamp())`.execute(
      writer.db,
    );
    await sql`insert into public.maintenance_retry_state (asset_id, generation, state, lifetime_attempts,
      immediate_attempts, attempt_id, attempt_kind, reservation_expires_at, worker_incarnation_id,
      permit_generation, blocked_reason, created_at, updated_at)
      values (${receipt}::uuid, 1, 'blocked_execution', 1, 1, ${attempt}::uuid, 'immediate',
        clock_timestamp(), ${incarnation}::uuid, 5, 'quiescence_unknown', clock_timestamp(), clock_timestamp())`.execute(
      writer.db,
    );
    await sql`insert into public.maintenance_takeover_clearance values (${clearance}::uuid, ${receipt}::uuid,
      1, ${attempt}::uuid, ${incarnation}::uuid, 5, null, 6, 'fixture-review', 'fixture-evidence', clock_timestamp())`.execute(
      writer.db,
    );
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saefr-permit-pg-'));
    await chmod(root, 0o750);
    store = new RecoveryPermitStore({
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
        generation: '8',
        pairing_sha256: fingerprint,
      }),
      { mode: 0o640 },
    );
    mismatch = undefined;
    unavailable = false;
    observed = [];
    const config = new ConfigService({
      STORAGE_ROOT: join(root, 'media'),
      STORAGE_ID: binding.storage_id,
      STORAGE_ORIGINALS_BINDING_ID: binding.originals_binding_id,
      STORAGE_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
      STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
      STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
    });
    probe = new DatabasePermitPairing(
      reader,
      new StorageBindingVerifier(
        { db: reader } as DatabaseService,
        config,
        observer,
      ),
    );
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await reader?.destroy();
    await writer?.onModuleDestroy();
    if (admin && databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  // The positive policy tests deliberately substitute the operator reader for
  // runtime reads; the actual production reader under a separate UID is tested below in the
  // verified disposable container. This is not native ext4 certification.
  const service = () =>
    new RecoveryPermitService(
      { readRuntime: () => store.readOperator() },
      probe,
    );
  async function snapshot() {
    const result = [];
    for (const table of [
      'asset_deletion',
      'maintenance_retry_state',
      'maintenance_takeover_clearance',
      'maintenance_reconciliation',
      'storage_binding',
      'kysely_migration',
    ]) {
      result.push(
        (
          await sql`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as contents from ${sql.id('public', table)} t`.execute(
            reader,
          )
        ).rows,
      );
    }
    return result;
  }

  it('checks exact M13 schema and both roles using read-only SQL without changing recovery records', async () => {
    const before = await snapshot();
    expect(await probe.verify()).toEqual({
      fingerprint,
      recordedGeneration: '6',
    });
    expect(observed).toEqual([
      'originals',
      'thumbnails',
      'originals',
      'thumbnails',
    ]);
    expect(await service().check('8')).toEqual({
      allowed: true,
      generation: '8',
    });
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await sql<{
          transaction_read_only: string;
        }>`show transaction_read_only`.execute(reader)
      ).rows[0].transaction_read_only,
    ).toBe('on');
  });

  it.each(['originals', 'thumbnails'] as const)(
    'rejects a replaced %s identity',
    async (role) => {
      mismatch = role;
      expect(await service().check()).toEqual({
        allowed: false,
        reason: 'pairing_unavailable',
      });
    },
  );

  it('rejects unavailable media and can still disarm without a pairing probe', async () => {
    unavailable = true;
    expect(await service().check()).toEqual({
      allowed: false,
      reason: 'pairing_unavailable',
    });
    const operator = new RecoveryPermitOperator(store, probe);
    expect(await operator.disarm('8')).toMatchObject({
      armed: false,
      generation: '9',
    });
    observed = [];
    expect(await service().check()).toEqual({
      allowed: false,
      reason: 'permit_disarmed',
    });
    expect(observed).toEqual([]);
  });

  it('requires fresh checks after restart and refuses restored pending receipts while disarmed', async () => {
    const before = await snapshot();
    expect(await service().check()).toEqual({ allowed: true, generation: '8' });
    await new RecoveryPermitOperator(store, probe).disarm('8');
    for (let restart = 0; restart < 2; restart++) {
      expect(await service().check()).toEqual({
        allowed: false,
        reason: 'permit_disarmed',
      });
    }
    expect(await snapshot()).toEqual(before); // receipt, retry, clearance and checkpoint untouched
  });

  it('rejects a permit behind database clearance history', async () => {
    await writeFile(
      store.location.path,
      encodePermit({
        version: 1,
        armed: true,
        generation: '5',
        pairing_sha256: fingerprint,
      }),
    );
    expect(await service().check()).toEqual({
      allowed: false,
      reason: 'permit_changed',
    });
  });

  it('rejects an incompatible exact schema then recovers only after it is restored', async () => {
    await sql`create index permit_unapproved_index on public.maintenance_retry_state (generation)`.execute(
      writer.db,
    );
    try {
      expect(await service().check()).toEqual({
        allowed: false,
        reason: 'pairing_unavailable',
      });
    } finally {
      await sql`drop index public.permit_unapproved_index`.execute(writer.db);
    }
    expect(await service().check()).toEqual({ allowed: true, generation: '8' });
  });

  it('rejects missing M13 history without attempting migration', async () => {
    const name = '202610290001_maintenance_recovery';
    const prior = (
      await sql<{
        timestamp: string;
      }>`select timestamp from public.kysely_migration where name = ${name}`.execute(
        writer.db,
      )
    ).rows[0];
    await sql`delete from public.kysely_migration where name = ${name}`.execute(
      writer.db,
    );
    try {
      expect(await service().check()).toEqual({
        allowed: false,
        reason: 'pairing_unavailable',
      });
    } finally {
      await sql`insert into public.kysely_migration (name, timestamp) values (${name}, ${prior.timestamp})`.execute(
        writer.db,
      );
    }
  });

  it('sanitizes a disconnected database and leaves disarm available', async () => {
    const disconnected = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new Pool({ max: 1 }) }),
    });
    await disconnected.destroy(); // no connection is ever opened
    const outage = new DatabasePermitPairing(disconnected, {
      assertVerified: async () => binding,
    });
    const decision = await new RecoveryPermitService(
      { readRuntime: () => store.readOperator() },
      outage,
    ).check();
    expect(decision).toEqual({ allowed: false, reason: 'pairing_unavailable' });
    expect(
      await new RecoveryPermitOperator(store, outage).disarm('8'),
    ).toMatchObject({ armed: false, generation: '9' });
  });

  it('retains a blocking lock across SIGKILL of an operator before publication', async () => {
    const module = pathToFileURL(
      join(process.cwd(), 'dist/worker/recovery-permit-store.js'),
    ).href;
    await new RecoveryPermitOperator(store, probe).disarm('8');
    const held = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { RecoveryPermitStore } from ${JSON.stringify(module)};
       const store = new RecoveryPermitStore(JSON.parse(process.argv[1]));
       await store.update('arm', '9', async () => {
         process.send('locked'); await new Promise(() => {}); return ${JSON.stringify(fingerprint)};
       });`,
        JSON.stringify(store.location),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    try {
      expect(
        (await once(held, 'message', { signal: AbortSignal.timeout(3000) }))[0],
      ).toBe('locked');
      const exited = once(held, 'exit');
      held.kill('SIGKILL');
      await exited;
      expect(await service().check()).toEqual({
        allowed: false,
        reason: 'permit_busy',
      });
      expect(
        JSON.parse(await readFile(store.location.path, 'utf8')),
      ).toMatchObject({ armed: false, generation: '9' });
    } finally {
      if (held.exitCode === null && held.signalCode === null) {
        const exited = once(held, 'exit');
        held.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('runs real CLI status/disarm without database settings and sanitizes rejected initialization', async () => {
    const cli = join(
      process.cwd(),
      'dist/worker/recovery-permit-operator-cli.js',
    );
    const env = {
      PATH: process.env.PATH,
      RECOVERY_PERMIT_PATH: store.location.path,
      RECOVERY_PERMIT_OPERATOR_UID: String(store.location.operatorUid),
      RECOVERY_PERMIT_READER_GID: String(store.location.readerGid),
      RECOVERY_PERMIT_RESTORE_ROOTS: JSON.stringify(
        store.location.restoreRoots,
      ),
    };
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      try {
        const [code] = await once(child, 'close', {
          signal: AbortSignal.timeout(4000),
        });
        return { code, stdout, stderr };
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'close');
          child.kill('SIGKILL');
          await exited;
        }
      }
    };
    const confirm = `--confirm-permit=${store.location.path}`;
    expect(await run(['status', confirm])).toEqual({
      code: 0,
      stdout: '{"armed":true,"generation":"8"}\n',
      stderr: '',
    });
    expect(await run(['disarm', confirm, '--expected-generation=8'])).toEqual({
      code: 0,
      stdout: '{"armed":false,"generation":"9"}\n',
      stderr: '',
    });
    const failed = await run([
      'arm',
      confirm,
      '--expected-generation=9',
      '--approval=/private/evidence',
      `--approval-sha256=${'a'.repeat(64)}`,
    ]);
    expect(failed).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Recovery permit blocked: approval_invalid\n',
    });
    expect(await store.readOperator()).toMatchObject({
      armed: false,
      generation: '9',
    });
  });

  it('runs the production runtime reader under a separate UID across replacement and disarm', () => {
    testConfig(); // re-prove container ownership immediately before exec
    const container = process.env.SAEFR_M7_TEST_CONTAINER_ID!;
    const dir = `/tmp/saefr-permit-dac-${randomUUID()}`;
    const docker = (uid: string, script: string) =>
      execFileSync(
        'docker',
        [
          'exec',
          '--user',
          uid,
          container,
          'sh',
          '-eu',
          '-c',
          script,
          'fixture',
          dir,
        ],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    const copy = (source: string, target: string) =>
      execFileSync('docker', ['cp', source, `${container}:${dir}/${target}`], {
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    // Copy only trusted build output, Node and its pure-JS Kysely import dependency.
    // No host mount, .env, media or host UID/permission changes are involved.
    const runNode = (uid: string, code: string) =>
      execFileSync(
        'docker',
        [
          'exec',
          '--user',
          uid,
          container,
          `${dir}/node`,
          '--input-type=module',
          '-e',
          `import { RecoveryPermitStore } from ${JSON.stringify(`file://${dir}/worker/recovery-permit-store.js`)};
       import * as fs from 'node:fs/promises';
       const directory = ${JSON.stringify(dir + '/control')};
       const path = directory + '/permit.json';
       const store = new RecoveryPermitStore({ path, operatorUid: 0, readerGid: 65534, restoreRoots: ['/synthetic/media'] });
       ${code}`,
        ],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    const readRuntime = () =>
      JSON.parse(
        runNode(
          '65534:65534',
          `
      try { console.log(JSON.stringify(await store.readRuntime())); }
      catch (error) { console.log(JSON.stringify({ error: error.code })); }
    `,
        ),
      ) as unknown;
    try {
      docker(
        '0:0',
        'mkdir "$1"; chmod 755 "$1"; mkdir "$1/worker" "$1/database" "$1/node_modules" "$1/control"; chown 0:65534 "$1/control"; chmod 750 "$1/control"; printf \'{"type":"module"}\' > "$1/package.json"',
      );
      copy(process.execPath, 'node');
      copy(
        join(process.cwd(), 'dist/worker/recovery-permit-store.js'),
        'worker/recovery-permit-store.js',
      );
      copy(
        join(process.cwd(), 'dist/worker/recovery-permit.js'),
        'worker/recovery-permit.js',
      );
      copy(
        join(process.cwd(), 'dist/database/migrations'),
        'database/migrations',
      );
      copy(join(process.cwd(), 'node_modules/kysely'), 'node_modules/kysely');
      runNode(
        '0:0',
        `
        await fs.writeFile(path, ${JSON.stringify(encodePermit({ version: 1, armed: false, generation: '7', pairing_sha256: fingerprint }).toString())}, { mode: 0o640 });
        await fs.chown(path, 0, 65534);
      `,
      );
      expect(readRuntime()).toMatchObject({ armed: false, generation: '7' });
      expect(() =>
        docker('65534:65534', 'printf forged > "$1/control/permit.json"'),
      ).toThrow();
      expect(() => docker('65534:65534', 'touch "$1/control/new"')).toThrow();
      expect(() =>
        docker(
          '65534:65534',
          'mv "$1/control/permit.json" "$1/control/replaced"',
        ),
      ).toThrow();
      expect(
        JSON.parse(
          runNode(
            '65534:65534',
            `try { await store.update('disarm', '7'); } catch (error) { console.log(JSON.stringify({ error: error.code })); }`,
          ),
        ),
      ).toEqual({ error: 'permit_untrusted' });
      runNode(
        '0:0',
        `await store.update('arm', '7', async () => ${JSON.stringify(fingerprint)});`,
      );
      expect(readRuntime()).toMatchObject({ armed: true, generation: '8' });
      runNode('0:0', "await store.update('disarm', '8');");
      expect(readRuntime()).toMatchObject({ armed: false, generation: '9' });
      runNode('0:0', 'await fs.chown(path, 65534, 65534);');
      expect(readRuntime()).toEqual({ error: 'permit_untrusted' });
      runNode(
        '0:0',
        'await fs.chown(path, 0, 65534); await fs.chmod(path, 0o660);',
      );
      expect(readRuntime()).toEqual({ error: 'permit_untrusted' });
      runNode('0:0', 'await fs.chmod(path, 0o640);');
      expect(readRuntime()).toMatchObject({ armed: false, generation: '9' });
    } finally {
      testConfig(); // verify ownership again before removing only this random fixture
      docker('0:0', 'rm -rf -- "$1"');
    }
  }, 60000);
});
