import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
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
import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import {
  DormantDeletionAdmissionRepository,
  type AdmissionResult,
  type BoundReservation,
} from '../src/worker/dormant-deletion-admission.repository.js';
import { MaintenanceRetryRepository } from '../src/worker/maintenance-retry.repository.js';
import { ControlledDeletionExecutor } from '../src/worker/controlled-deletion.executor.js';
import { exactPgTimestamp } from '../src/worker/exact-pg-values.js';
import { RecoveryPermitStore } from '../src/worker/recovery-permit-store.js';
import {
  DatabasePermitPairing,
  RecoveryPermitService,
} from '../src/worker/recovery-permit.service.js';
import {
  encodePermit,
  pairingFingerprint,
} from '../src/worker/recovery-permit.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from '../src/storage/storage-binding.service.js';
import {
  locationFingerprint,
  type StorageRole,
} from '../src/storage/storage-marker.js';
import { testConfig } from './helpers/integration-database.js';

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  return { enter, release, entered, held };
}
function applied<T>(r: AdmissionResult<T>): T {
  expect(r.status).toBe('applied');
  if (r.status !== 'applied') throw new Error('Fixture admission refused');
  return r.value;
}

describe('B.4.2 controlled execution on disposable PostgreSQL and synthetic storage', () => {
  let admin: DatabaseService;
  let db: DatabaseService;
  let name: string;
  let admission: DormantDeletionAdmissionRepository;
  let retry: MaintenanceRetryRepository;
  let root: string;
  let media: string;
  let store: RecoveryPermitStore;
  let provider: LocalStorageProvider;
  let permitService: RecoveryPermitService;
  let executor: ControlledDeletionExecutor;
  let a: BoundReservation;
  let pinnedHook: ((role: StorageRole) => Promise<void>) | undefined;
  let unlinkHook: ((path: string) => Promise<void>) | undefined;
  let syncHook: ((role: StorageRole) => Promise<void>) | undefined;
  let afterUnlink: (() => Promise<void>) | undefined;
  let afterSync: ((role: StorageRole) => Promise<void>) | undefined;
  let identityUnavailable: boolean;
  let events: string[];
  const binding = {
    singleton: true,
    storage_id: randomUUID(),
    originals_binding_id: randomUUID(),
    thumbnails_binding_id: randomUUID(),
    storage_layout_version: 1,
  };
  const owner = randomUUID();
  const incarnation = randomUUID();
  const physicalUuid = randomUUID();

  beforeAll(async () => {
    const c = testConfig();
    admin = new DatabaseService(c);
    name = `saefr_b42_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(name)}`.execute(admin.db);
    db = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: c.getOrThrow<number>('POSTGRES_PORT'),
        POSTGRES_DB: name,
        POSTGRES_USER: c.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: c.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
    await migrateToLatest(db.db);
    await db.db.insertInto('storage_binding').values(binding).execute();
    await sql`insert into public.app_user values (${owner}::uuid, 'controlled-fixture', 'synthetic-hash',
      'user', 'active', false, clock_timestamp(), clock_timestamp())`.execute(
      db.db,
    );
    admission = await DormantDeletionAdmissionRepository.open(db.db);
    retry = new MaintenanceRetryRepository(db.db, async () => binding);
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
    if (admin && name)
      await sql`drop database ${sql.id(name)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });
  async function physical(location: string, handle?: FileHandle) {
    const info = handle
      ? await handle.stat({ bigint: true })
      : await lstat(location, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || identityUnavailable)
      throw new Error('Synthetic unsupported physical identity');
    return {
      format: 'linux-ext4-handle-v1' as const,
      profile: 'linux-ext4-v1' as const,
      filesystem_uuid: physicalUuid,
      directory_handle_type: 1,
      directory_handle_hex: info.ino.toString(16).padStart(16, '0'),
    };
  }
  const observer: PhysicalStorageObserver = {
    async observe(_role, location) {
      return {
        markerBytes: await readFile(join(location, '.saefr-storage.json')),
        identity: await physical(location),
      };
    },
    async observePinned(role, location, directory) {
      const result = {
        markerBytes: await readFile(
          `/proc/self/fd/${directory.fd}/.saefr-storage.json`,
        ),
        identity: await physical(location, directory),
      };
      await pinnedHook?.(role);
      return result;
    },
  };
  async function permit(armed: boolean, generation = '8') {
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
  class FixtureProvider extends LocalStorageProvider {
    protected override async unlinkPath(path: string) {
      await unlinkHook?.(path);
      events.push(path.includes('/originals/') ? 'original-unlink' : 'unlink');
      await super.unlinkPath(path);
      await afterUnlink?.();
    }
    protected override async syncDirectory(
      role: StorageRole,
      directory?: FileHandle,
    ) {
      await syncHook?.(role);
      events.push(`${role}-sync`);
      await super.syncDirectory(role, directory);
      await afterSync?.(role);
    }
  }
  async function seed() {
    const asset = randomUUID();
    await sql`insert into public.asset_deletion
      (asset_id, owner_id, accepted_lifecycle_version, storage_id, originals_binding_id,
      thumbnails_binding_id, storage_layout_version, original_extension, requested_at)
      values (${asset}::uuid, ${owner}::uuid, 1, ${binding.storage_id}::uuid,
      ${binding.originals_binding_id}::uuid, ${binding.thumbnails_binding_id}::uuid, 1, '.jpg', clock_timestamp())`.execute(
      db.db,
    );
    await retry.discover(asset);
    await sql`update public.maintenance_retry_state set next_eligible_at = clock_timestamp() - interval '1 second' where asset_id = ${asset}::uuid`.execute(
      db.db,
    );
    const row = await retry.read(asset);
    const attempt = {
      journal: (await admission.identity(asset))!,
      generation: '1',
      attemptId: randomUUID(),
      incarnationId: incarnation,
      permitGeneration: '8',
    };
    const reserved = applied(
      await admission.reserve(
        attempt,
        exactPgTimestamp(row!.next_eligible_at_exact!),
        '12',
        {
          permitGeneration: '8',
          storageVerified: true,
          capacityAvailable: true,
        },
      ),
    );
    for (const role of ['originals', 'thumbnails'])
      await writeFile(join(media, role, `${asset}.jpg`), `synthetic-${role}`);
    return applied(await admission.bind(reserved, randomUUID()));
  }
  beforeEach(async () => {
    pinnedHook = undefined;
    unlinkHook = undefined;
    syncHook = undefined;
    afterUnlink = undefined;
    afterSync = undefined;
    identityUnavailable = false;
    events = [];
    root = await mkdtemp(join(tmpdir(), 'saefr-b42-synthetic-'));
    await chmod(root, 0o750);
    media = join(root, 'media');
    for (const role of ['originals', 'thumbnails'] as const) {
      const location = join(media, role);
      await mkdir(location, { recursive: true, mode: 0o700 });
      await writeFile(
        join(location, '.saefr-storage.json'),
        JSON.stringify({
          version: 2,
          storage_id: binding.storage_id,
          binding_id:
            role === 'originals'
              ? binding.originals_binding_id
              : binding.thumbnails_binding_id,
          role,
          physical_identity: {
            ...(await physical(location)),
            location_sha256: locationFingerprint(location, role),
          },
        }),
      );
    }
    store = new RecoveryPermitStore({
      path: join(root, 'permit.json'),
      operatorUid: process.geteuid!(),
      readerGid: process.getegid!(),
      restoreRoots: [media],
    });
    await permit(true);
    const config = new ConfigService({
      STORAGE_ROOT: media,
      STORAGE_ID: binding.storage_id,
      STORAGE_ORIGINALS_BINDING_ID: binding.originals_binding_id,
      STORAGE_THUMBNAILS_BINDING_ID: binding.thumbnails_binding_id,
      STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
      STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
    });
    const verifier = new StorageBindingVerifier(db, config, observer);
    provider = new FixtureProvider(verifier, config);
    // Same-UID synthetic fixture adapter; real B.2 reader privilege separation
    // remains covered by its existing tests. No actual operator command/arming.
    permitService = new RecoveryPermitService(
      { readRuntime: () => store.readOperator() },
      new DatabasePermitPairing(db.db, verifier),
    );
    executor = new ControlledDeletionExecutor(
      admission,
      permitService,
      provider,
      incarnation,
    );
    a = await seed();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await executor?.shutdown();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const file = (role: StorageRole) =>
    join(media, role, `${a.journal.asset_id}.jpg`);
  const present = async (role: StorageRole) => {
    try {
      await stat(file(role));
      return true;
    } catch {
      return false;
    }
  };
  async function rows() {
    return {
      journal: await db.db
        .selectFrom('asset_deletion')
        .selectAll()
        .where('asset_id', '=', a.journal.asset_id)
        .executeTakeFirst(),
      retry: await retry.read(a.journal.asset_id),
    };
  }
  async function preserved() {
    const s = await rows();
    expect(s.journal?.completed_at).toBeNull();
    expect(s.journal?.execution_token).toBe(a.token);
    expect(s.retry?.journal_execution_token).toBe(a.token);
    expect(s.retry?.attempt_id).toBe(a.attemptId);
  }
  it('confirms bound authority, removes original before thumbnail, persists both and atomically settles', async () => {
    expect(applied(await admission.confirm(a, a))).toEqual(a);
    expect(await executor.execute(a)).toBe('completed');
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(false);
    expect(events).toEqual([
      'unlink',
      'originals-sync',
      'originals-sync',
      'unlink',
      'thumbnails-sync',
      'thumbnails-sync',
    ]);
    const s = await rows();
    expect(s.journal?.completed_at).not.toBeNull();
    expect(s.journal?.execution_token).toBeNull();
    expect(s.retry?.state).toBe('closed');
    expect(s.retry?.lifetime_attempts).toBe('1');
  });
  it.each([
    'generation',
    'attemptId',
    'incarnationId',
    'permitGeneration',
    'token',
    'deadline',
    'owner',
    'extension',
    'timestamp',
  ] as const)('refuses altered %s without file removal', async (key) => {
    const changed = { ...a, journal: { ...a.journal } };
    if (key === 'generation' || key === 'permitGeneration') changed[key] = '9';
    else if (key === 'attemptId' || key === 'incarnationId' || key === 'token')
      changed[key] = randomUUID();
    else if (key === 'deadline')
      changed.deadline = exactPgTimestamp('2026-01-01T00:00:00.000000Z');
    else if (key === 'owner') changed.journal.owner_id = randomUUID();
    else if (key === 'extension') changed.journal.original_extension = '.png';
    else
      changed.journal.requested_at_exact = exactPgTimestamp(
        '2026-01-01T00:00:00.000001Z',
      );
    expect(await executor.execute(changed)).not.toBe('completed');
    expect(events).toEqual([]);
    expect(await present('originals')).toBe(true);
    await preserved();
  });
  it('refuses a missing journal even if a queue caller supplies a complete tuple', async () => {
    const missing = { ...a, journal: { ...a.journal, asset_id: randomUUID() } };
    expect(await executor.execute(missing)).toBe('stale');
    expect(events).toEqual([]);
    await preserved();
  });
  it.each(['reservation', 'journal'] as const)(
    'refuses expired %s authority using DB time',
    async (kind) => {
      if (kind === 'reservation') {
        const expired = await sql<{
          deadline: string;
        }>`update public.maintenance_retry_state
          set reservation_expires_at = clock_timestamp() - interval '1 second'
          where asset_id = ${a.journal.asset_id}::uuid returning to_char(reservation_expires_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as deadline`.execute(db.db);
        a.deadline = exactPgTimestamp(expired.rows[0].deadline);
      } else
        await sql`update public.asset_deletion set execution_expires_at = clock_timestamp() - interval '1 second' where asset_id = ${a.journal.asset_id}::uuid`.execute(
          db.db,
        );
      expect(await executor.execute(a)).toBe('stale');
      expect(events).toEqual([]);
      await preserved();
    },
  );
  it.each(['disarm', 'replace'] as const)(
    'refuses permit %s after binding',
    async (kind) => {
      await permit(kind !== 'disarm', '9');
      expect(await executor.execute(a)).toBe('permit_denied');
      expect(events).toEqual([]);
      await preserved();
    },
  );
  it.each(['originals', 'thumbnails'] as const)(
    'revalidates permit at last boundary after held %s preparation',
    async (role) => {
      const gate = barrier();
      pinnedHook = async (current) => {
        if (current === role) {
          pinnedHook = undefined;
          gate.enter();
          await gate.held;
        }
      };
      const result = executor.execute(a);
      await gate.entered;
      try {
        await permit(false, '9');
      } finally {
        gate.release();
      }
      expect(await result).toBe('permit_denied');
      expect(await present(role)).toBe(true);
      await preserved();
    },
  );
  it.each(['originals', 'thumbnails'] as const)(
    'refuses copied markers on replaced %s directory',
    async (role) => {
      const old = join(media, role);
      await rename(old, `${old}-previous`);
      await mkdir(old);
      await writeFile(
        join(old, '.saefr-storage.json'),
        await readFile(join(`${old}-previous`, '.saefr-storage.json')),
      );
      expect(await executor.execute(a)).not.toBe('completed');
      expect(events).toEqual([]);
      await preserved();
    },
  );
  it.each(['symlink', 'unsupported'] as const)(
    'refuses %s physical storage',
    async (kind) => {
      if (kind === 'symlink') {
        await rename(join(media, 'originals'), join(media, 'old'));
        await symlink(join(media, 'old'), join(media, 'originals'));
      } else identityUnavailable = true;
      expect(await executor.execute(a)).not.toBe('completed');
      expect(events).toEqual([]);
      await preserved();
    },
  );
  it('keeps capacity through cancellation, shutdown and an overdue outstanding unlink', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const held = barrier();
    unlinkHook = async () => {
      unlinkHook = undefined;
      held.enter();
      await held.held;
    };
    const abort = new AbortController();
    let done = false;
    let drained = false;
    const result = executor.execute(a, abort.signal);
    void result.then(() => {
      done = true;
    });
    await held.entered;
    let stop!: Promise<void>;
    try {
      expect(await executor.execute(a)).toBe('refused');
      now += 30_001;
      abort.abort();
      stop = executor.shutdown().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      expect(drained).toBe(false);
      expect(await executor.execute(a)).toBe('refused');
    } finally {
      held.release();
    }
    expect(await result).toBe('interrupted');
    await stop;
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(true);
    expect(events).toEqual(['unlink']);
    await preserved();
  });
  it('rechecks cancellation after held preparation and before unlink', async () => {
    const held = barrier();
    const abort = new AbortController();
    pinnedHook = async () => {
      pinnedHook = undefined;
      held.enter();
      await held.held;
    };
    const result = executor.execute(a, abort.signal);
    await held.entered;
    abort.abort();
    held.release();
    expect(await result).toBe('interrupted');
    expect(events).toEqual([]);
    await preserved();
  });
  it('retains evidence on unknown unlink after a successful original removal', async () => {
    let unlinks = 0;
    unlinkHook = async () => {
      if (++unlinks === 2)
        throw new Error('synthetic private unlink uncertainty');
    };
    expect(await executor.execute(a)).toBe('provider_unknown');
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(true);
    await preserved();
    expect((await rows()).retry?.state).toBe('blocked_execution');
  });
  it('schedules a known drained pre-unlink failure atomically after original removal', async () => {
    await mkdir(join(media, 'thumbnails', 'not-file'));
    await rm(file('thumbnails'));
    await rename(join(media, 'thumbnails', 'not-file'), file('thumbnails'));
    expect(await executor.execute(a)).toBe('known_failure');
    const s = await rows();
    expect(s.journal?.completed_at).toBeNull();
    expect(s.journal?.execution_token).toBeNull();
    expect(s.retry?.state).toBe('due');
    expect(s.retry?.attempt_id).toBeNull();
    expect(s.retry?.lifetime_attempts).toBe('1');
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(true);
  });
  it('never completes an uncertain directory persistence outcome', async () => {
    syncHook = async () => {
      throw new Error('private fsync failure');
    };
    expect(await executor.execute(a)).toBe('provider_unknown');
    await preserved();
    expect(await present('thumbnails')).toBe(true);
  });
  it('does not hold a DB transaction while the provider is held', async () => {
    const held = barrier();
    unlinkHook = async () => {
      unlinkHook = undefined;
      held.enter();
      await held.held;
    };
    const result = executor.execute(a);
    await held.entered;
    try {
      const locks = await sql<{
        count: string;
      }>`select count(*)::text from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null`.execute(
        db.db,
      );
      expect(locks.rows[0].count).toBe('0');
    } finally {
      held.release();
    }
    expect(await result).toBe('completed');
  });
  it('refuses database confirmation uncertainty without starting provider I/O', async () => {
    vi.spyOn(admission, 'confirm').mockResolvedValue({ status: 'uncertain' });
    expect(await executor.execute(a)).toBe('database_unknown');
    expect(events).toEqual([]);
    await preserved();
  });
  it('preserves an exact token when success COMMIT acknowledgement is unknown', async () => {
    vi.spyOn(admission, 'settle').mockResolvedValue({ status: 'uncertain' });
    expect(await executor.execute(a)).toBe('database_unknown');
    await preserved();
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(false);
  });
  it('refuses stale results after a held call and generation change', async () => {
    const held = barrier();
    unlinkHook = async () => {
      unlinkHook = undefined;
      held.enter();
      await held.held;
    };
    const result = executor.execute(a);
    await held.entered;
    try {
      await sql`update public.maintenance_retry_state set generation = 2 where asset_id = ${a.journal.asset_id}::uuid`.execute(
        db.db,
      );
    } finally {
      held.release();
    }
    expect(await result).toBe('stale');
    expect((await rows()).retry?.generation).toBe('2');
    await preserved();
    expect(await present('thumbnails')).toBe(true);
  });
  it('strict manual admission cannot steal this token, even after expiry', async () => {
    expect((await admission.claimManual(a.journal, randomUUID())).status).toBe(
      'refused',
    );
    await sql`update public.asset_deletion set execution_expires_at = clock_timestamp() - interval '1 second' where asset_id = ${a.journal.asset_id}::uuid`.execute(
      db.db,
    );
    expect((await admission.claimManual(a.journal, randomUUID())).status).toBe(
      'refused',
    );
    await preserved();
  });
  it('requires directory persistence even for verified absence', async () => {
    await rm(file('originals'));
    await rm(file('thumbnails'));
    expect(await executor.execute(a)).toBe('completed');
    expect(events).toEqual([
      'originals-sync',
      'originals-sync',
      'thumbnails-sync',
      'thumbnails-sync',
    ]);
  });
  it.each(['attempt', 'incarnation', 'token'] as const)(
    'refuses changed DB %s with otherwise identical live authority',
    async (kind) => {
      const replacement = randomUUID();
      if (kind === 'attempt')
        await sql`update public.maintenance_retry_state set attempt_id = ${replacement}::uuid where asset_id = ${a.journal.asset_id}::uuid`.execute(
          db.db,
        );
      if (kind === 'incarnation')
        await sql`update public.maintenance_retry_state set worker_incarnation_id = ${replacement}::uuid where asset_id = ${a.journal.asset_id}::uuid`.execute(
          db.db,
        );
      if (kind === 'token') {
        await sql`update public.maintenance_retry_state set journal_execution_token = ${replacement}::uuid where asset_id = ${a.journal.asset_id}::uuid`.execute(
          db.db,
        );
        await sql`update public.asset_deletion set execution_token = ${replacement}::uuid where asset_id = ${a.journal.asset_id}::uuid`.execute(
          db.db,
        );
      }
      const before = await rows();
      expect(await executor.execute(a)).toBe('stale');
      expect(events).toEqual([]);
      expect(await present('originals')).toBe(true);
      // Blocking a replaced token with an otherwise exact attempt may preserve that
      // original durable evidence, but it must never clear or copy a token.
      const after = await rows();
      expect(after.journal).toEqual(before.journal);
      expect(after.retry?.journal_execution_token).toBe(
        before.retry?.journal_execution_token,
      );
      expect(after.retry?.attempt_id).toBe(before.retry?.attempt_id);
      expect(after.retry?.worker_incarnation_id).toBe(
        before.retry?.worker_incarnation_id,
      );
    },
  );
  it('rechecks permit after a deliberately held storage observation', async () => {
    const held = barrier();
    const original = provider.verifyBinding.bind(provider);
    let first = true;
    vi.spyOn(provider, 'verifyBinding').mockImplementation(async () => {
      const binding = await original();
      if (first) {
        first = false;
        held.enter();
        await held.held;
      }
      return binding;
    });
    const result = executor.execute(a);
    await held.entered;
    try {
      await permit(false, '9');
    } finally {
      held.release();
    }
    expect(await result).toBe('permit_denied');
    expect(events).toEqual([]);
    await preserved();
  });
  it('does not start unlink when the local budget expires during preparation', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const held = barrier();
    pinnedHook = async () => {
      pinnedHook = undefined;
      held.enter();
      await held.held;
    };
    const result = executor.execute(a);
    await held.entered;
    now += 30_001;
    held.release();
    expect(await result).toBe('interrupted');
    expect(events).toEqual([]);
    await preserved();
  });
  it('does not turn a real closed PostgreSQL pool into deletion authority', async () => {
    const c = testConfig();
    const offline = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: c.getOrThrow<number>('POSTGRES_PORT'),
        POSTGRES_DB: name,
        POSTGRES_USER: c.getOrThrow<string>('POSTGRES_USER'),
        POSTGRES_PASSWORD: c.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
    const isolated = await DormantDeletionAdmissionRepository.open(offline.db);
    await offline.onModuleDestroy();
    const stopped = new ControlledDeletionExecutor(
      isolated,
      permitService,
      provider,
      incarnation,
    );
    expect(await stopped.execute(a)).toBe('database_unknown');
    expect(events).toEqual([]);
    await preserved();
    await stopped.shutdown();
  });
  it('returns unknown after a real settlement commits but its acknowledgement is lost', async () => {
    const real = admission.settle.bind(admission);
    vi.spyOn(admission, 'settle').mockImplementation(async (...args) => {
      expect((await real(...args)).status).toBe('applied');
      return { status: 'uncertain' };
    });
    expect(await executor.execute(a)).toBe('database_unknown');
    const s = await rows();
    expect(s.journal?.completed_at).not.toBeNull();
    expect(s.retry?.state).toBe('closed');
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(false);
  });
  it('cannot retract an issued unlink, but disarm prevents further persistence or removal', async () => {
    const held = barrier();
    unlinkHook = async () => {
      unlinkHook = undefined;
      held.enter();
      await held.held;
    };
    const result = executor.execute(a);
    await held.entered;
    try {
      await permit(false, '9');
    } finally {
      held.release();
    }
    expect(await result).toBe('permit_denied');
    expect(events).toEqual(['unlink']);
    expect(await present('originals')).toBe(false);
    expect(await present('thumbnails')).toBe(true);
    await preserved();
  });
  it('refuses settlement CAS after generation replacement following the final observation', async () => {
    const real = admission.settle.bind(admission);
    vi.spyOn(admission, 'settle').mockImplementation(async (...args) => {
      await sql`update public.maintenance_retry_state set generation = 2 where asset_id = ${a.journal.asset_id}::uuid`.execute(
        db.db,
      );
      return real(...args);
    });
    expect(await executor.execute(a)).toBe('database_unknown');
    expect((await rows()).retry?.generation).toBe('2');
    await preserved();
  });
  it('retains authority for an unresolved predecessor and never treats expiry as drainage', async () => {
    applied(await admission.block(a, 'quiescence_unknown'));
    const before = await rows();
    expect(await executor.execute(a)).toBe('stale');
    expect(events).toEqual([]);
    const after = await rows();
    expect(after.journal).toEqual(before.journal);
    // Reasserting the same exact block may advance its audit revision.
    expect({
      ...after.retry,
      updated_at_exact: before.retry?.updated_at_exact,
    }).toEqual(before.retry);
  });
  it('refuses automatic execution when a competing manual token replaces the journal token', async () => {
    const manualToken = randomUUID();
    await sql`update public.asset_deletion set execution_token = ${manualToken}::uuid where asset_id = ${a.journal.asset_id}::uuid`.execute(
      db.db,
    );
    expect(await executor.execute(a)).toBe('stale');
    expect(events).toEqual([]);
    const state = await rows();
    expect(state.journal?.execution_token).toBe(manualToken);
    expect(state.retry?.journal_execution_token).toBe(a.token);
  });
  it('latches admission closed when unknown provider outcome cannot be durably blocked', async () => {
    vi.spyOn(admission, 'block').mockResolvedValue({ status: 'uncertain' });
    unlinkHook = async () => {
      unlinkHook = undefined;
      throw new Error('synthetic unknown unlink');
    };
    expect(await executor.execute(a)).toBe('provider_unknown');
    expect((await rows()).retry?.state).toBe('reserved');
    await preserved();
    expect(await executor.execute(a)).toBe('refused');
    expect(await present('originals')).toBe(true);
    expect(await present('thumbnails')).toBe(true);
  });
  it.each(['reservation', 'journal'] as const)(
    'stops new persistence after %s expiry while unlink was outstanding',
    async (kind) => {
      const held = barrier();
      unlinkHook = async () => {
        unlinkHook = undefined;
        held.enter();
        await held.held;
      };
      const result = executor.execute(a);
      await held.entered;
      try {
        if (kind === 'reservation')
          await sql`update public.maintenance_retry_state set reservation_expires_at = clock_timestamp() - interval '1 second' where asset_id = ${a.journal.asset_id}::uuid`.execute(
            db.db,
          );
        else
          await sql`update public.asset_deletion set execution_expires_at = clock_timestamp() - interval '1 second' where asset_id = ${a.journal.asset_id}::uuid`.execute(
            db.db,
          );
        expect(await executor.execute(a)).toBe('refused');
      } finally {
        held.release();
      }
      expect(await result).toBe('stale');
      expect(events).toEqual(['unlink']);
      expect(await present('thumbnails')).toBe(true);
      await preserved();
    },
  );
  it('refuses a live asset conflicting with the committed journal', async () => {
    await db.db
      .insertInto('asset')
      .values({
        id: a.journal.asset_id,
        owner_id: owner,
        filename: 'synthetic',
        mime_type: 'image/jpeg',
        size: 1,
        storage_path: 'synthetic-only',
        created_at: new Date(),
      })
      .execute();
    expect(await executor.execute(a)).toBe('stale');
    expect(events).toEqual([]);
    await preserved();
  });
  it('rejects an already cancelled call without mutating evidence', async () => {
    const abort = new AbortController();
    abort.abort();
    const before = await rows();
    expect(await executor.execute(a, abort.signal)).toBe('refused');
    expect(await rows()).toEqual(before);
    expect(events).toEqual([]);
  });
  it.each(
    (['originals', 'thumbnails'] as const).flatMap((role) =>
      (['lost_ack', 'failed_sync', 'post_sync_verification'] as const).map(
        (fault) => ({ role, fault }),
      ),
    ),
  )(
    'preserves absent $role persistence uncertainty for $fault',
    async ({ role, fault }) => {
      await rm(file(role));
      const before = await rows();
      let injected = false;
      if (fault === 'failed_sync')
        syncHook = async (current) => {
          if (current === role && !injected) {
            injected = true;
            throw new Error('Synthetic directory-sync failure');
          }
        };
      else
        afterSync = async (current) => {
          if (current === role && !injected) {
            injected = true;
            if (fault === 'lost_ack')
              throw new Error(
                'Synthetic lost sync acknowledgement after actual fsync',
              );
            identityUnavailable = true;
          }
        };
      const removals = vi.spyOn(provider, 'removeExactGuarded');
      const settlement = vi.spyOn(admission, 'settle');
      const result = await executor.execute(a);
      expect(injected).toBe(true);
      // This assertion detects continued thumbnail execution independently of
      // the eventual result or a later persistence/settlement refusal.
      expect(removals.mock.calls.map(([target]) => target.role)).toEqual(
        role === 'originals' ? ['originals'] : ['originals', 'thumbnails'],
      );
      expect(
        await removals.mock.results[role === 'originals' ? 0 : 1].value,
      ).toEqual({ status: 'uncertain', durable: false });
      expect(result).toBe('provider_unknown');
      const state = await rows();
      expect(state.retry?.state).toBe('blocked_execution');
      expect(state.journal?.completed_at).toBeNull();
      expect(state.journal?.execution_token).toBe(a.token);
      expect(state.journal?.execution_expires_at).toEqual(
        before.journal?.execution_expires_at,
      );
      expect(state.retry).toMatchObject({
        generation: before.retry!.generation,
        attempt_id: a.attemptId,
        worker_incarnation_id: a.incarnationId,
        permit_generation: a.permitGeneration,
        journal_execution_token: a.token,
        reservation_expires_at_exact: a.deadline,
        lifetime_attempts: before.retry!.lifetime_attempts,
        immediate_attempts: before.retry!.immediate_attempts,
        next_eligible_at_exact: null,
      });
      expect(settlement).not.toHaveBeenCalled();
      if (role === 'originals') expect(await present('thumbnails')).toBe(true);
      expect(
        (
          await admission.reserve(
            { ...a, attemptId: randomUUID() },
            exactPgTimestamp('2026-11-01T00:00:00.000000Z'),
            '12',
            {
              permitGeneration: a.permitGeneration,
              storageVerified: true,
              capacityAvailable: true,
            },
          )
        ).status,
      ).toBe('refused');
      expect(await rows()).toEqual(state);
      expect(await executor.execute(a)).toBe('refused');
    },
  );
  it.each(['originals', 'thumbnails'] as const)(
    'retains absent %s evidence when blocking acknowledgement is uncertain',
    async (role) => {
      await rm(file(role));
      const before = await rows();
      afterSync = async (current) => {
        if (current === role) {
          afterSync = undefined;
          throw new Error('Synthetic lost sync acknowledgement');
        }
      };
      vi.spyOn(admission, 'block').mockResolvedValue({ status: 'uncertain' });
      const settlement = vi.spyOn(admission, 'settle');
      expect(await executor.execute(a)).toBe('provider_unknown');
      expect(await rows()).toEqual(before);
      expect(settlement).not.toHaveBeenCalled();
      expect(await executor.execute(a)).toBe('refused');
      if (role === 'originals') expect(await present('thumbnails')).toBe(true);
    },
  );
  it.each(['originals', 'thumbnails'] as const)(
    'keeps known pre-I/O %s failures eligible for atomic ordinary settlement',
    async (role) => {
      await rm(file(role));
      await mkdir(file(role));
      const removals = vi.spyOn(provider, 'removeExactGuarded');
      const settlement = vi.spyOn(admission, 'settle');
      expect(await executor.execute(a)).toBe('known_failure');
      expect(
        await removals.mock.results[role === 'originals' ? 0 : 1].value,
      ).toEqual({ status: 'unavailable', durable: false });
      expect(settlement).toHaveBeenCalledExactlyOnceWith(a, {
        ioDrained: true,
        outcome: 'known_failure',
      });
      const state = await rows();
      expect(state.journal?.completed_at).toBeNull();
      expect(state.journal?.execution_token).toBeNull();
      expect(state.retry).toMatchObject({
        state: 'due',
        attempt_id: null,
        journal_execution_token: null,
        lifetime_attempts: '1',
        immediate_attempts: 1,
      });
    },
  );
  it.each(['originals', 'thumbnails'] as const)(
    'completes authoritative %s absence with positively confirmed persistence',
    async (role) => {
      await rm(file(role));
      const removals = vi.spyOn(provider, 'removeExactGuarded');
      expect(await executor.execute(a)).toBe('completed');
      expect(
        await removals.mock.results[role === 'originals' ? 0 : 1].value,
      ).toEqual({ status: 'absent', durable: true });
      expect(await present('originals')).toBe(false);
      expect(await present('thumbnails')).toBe(false);
      const state = await rows();
      expect(state.journal?.completed_at).not.toBeNull();
      expect(state.retry?.state).toBe('closed');
    },
  );
});
