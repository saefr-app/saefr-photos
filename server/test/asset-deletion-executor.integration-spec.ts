import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { sql, type Kysely } from 'kysely';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { AssetDeletionExecutor } from '../src/assets/asset-deletion.executor.js';
import { AssetDeletionRepository } from '../src/assets/asset-deletion.repository.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  createMigrationDatabase,
  migrationConfig,
} from '../src/database/migrations/migration-config.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import type { StorageBindingVerifier } from '../src/storage/storage-binding.service.js';
import type { StorageBinding } from '../src/storage/storage-binding.service.js';
import type {
  ExpectedStorageBinding,
  LogicalStorageTarget,
  RemovalOutcome,
} from '../src/storage/storage-provider.js';
import { testConfig } from './helpers/integration-database.js';

describe('M12E.1 committed-deletion executor on disposable PostgreSQL and synthetic media', () => {
  let admin: DatabaseService;
  let db: Kysely<unknown>;
  let databaseName: string;
  let root: string;
  let validBinding: boolean;
  let config: ConfigService;
  let verifier: StorageBindingVerifier;
  let repository: AssetDeletionRepository;
  let provider: LocalStorageProvider;
  let executor: AssetDeletionExecutor;
  const ownerId = '00000000-0000-4000-8000-000000000951';
  const storageId = '00000000-0000-4000-8000-000000000952';
  const originalsId = '00000000-0000-4000-8000-000000000953';
  const thumbnailsId = '00000000-0000-4000-8000-000000000954';
  async function journal(id = randomUUID(), extension = '.jpg') {
    await sql`insert into public.asset_deletion (
      asset_id, owner_id, accepted_lifecycle_version, storage_id,
      originals_binding_id, thumbnails_binding_id, storage_layout_version,
      original_extension, requested_at, completed_at, last_error_code,
      execution_token, execution_expires_at)
      values (${id}::uuid, ${ownerId}::uuid, 0, ${storageId}::uuid,
        ${originalsId}::uuid, ${thumbnailsId}::uuid, 1, ${extension},
        clock_timestamp(), null, null, null, null)`.execute(db);
    return id;
  }

  async function files(id: string, extension = '.jpg') {
    await writeFile(
      join(root, 'originals', `${id}${extension}`),
      'private-original',
    );
    await writeFile(join(root, 'thumbnails', `${id}.jpg`), 'private-thumbnail');
  }

  async function receipt(id: string) {
    const found = await repository.findForOwner(id, ownerId);
    if (!found) throw new Error('Synthetic receipt absent');
    return found;
  }

  function makeExecutor(storage = provider, journalRepo = repository) {
    return new AssetDeletionExecutor(journalRepo, storage);
  }

  function gate() {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { waiting, held, entered, release };
  }

  beforeAll(async () => {
    const test = testConfig();
    admin = new DatabaseService(test);
    databaseName = `saefr_m12e_${randomUUID().replaceAll('-', '')}`;
    await sql`create database ${sql.id(databaseName)}`.execute(admin.db);
    db = createMigrationDatabase(
      migrationConfig({
        MIGRATION_POSTGRES_HOST: '127.0.0.1',
        MIGRATION_POSTGRES_PORT: String(
          test.getOrThrow<number>('POSTGRES_PORT'),
        ),
        MIGRATION_POSTGRES_DB: databaseName,
        MIGRATION_POSTGRES_USER: test.getOrThrow<string>('POSTGRES_USER'),
        MIGRATION_POSTGRES_PASSWORD:
          test.getOrThrow<string>('POSTGRES_PASSWORD'),
      }),
    );
    await migrateToLatest(db);
    await sql`insert into public.app_user values
      (${ownerId}::uuid, 'executor-owner', 'synthetic-hash', 'user', 'active', false,
       clock_timestamp(), clock_timestamp())`.execute(db);
    await sql`insert into public.storage_binding values
      (true, ${storageId}::uuid, ${originalsId}::uuid, ${thumbnailsId}::uuid, 1)`.execute(
      db,
    );
    repository = new AssetDeletionRepository({ db } as DatabaseService);
  });

  beforeEach(async () => {
    await sql`delete from public.asset`.execute(db);
    await sql`delete from public.asset_deletion`.execute(db);
    await sql`update public.storage_binding set
      storage_id = ${storageId}::uuid,
      originals_binding_id = ${originalsId}::uuid,
      thumbnails_binding_id = ${thumbnailsId}::uuid
      where singleton = true`.execute(db);
    root = await mkdtemp(join(tmpdir(), 'saefr-m12e-'));
    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));
    validBinding = true;
    config = new ConfigService({ STORAGE_ROOT: root });
    verifier = {
      assertVerified: async () => {
        if (!validBinding)
          throw new Error('synthetic physical identity mismatch');
        const observed =
          await sql<StorageBinding>`select * from public.storage_binding
          where singleton = true`.execute(db);
        if (!observed.rows[0]) throw new Error('Synthetic anchor absent');
        return observed.rows[0];
      },
    } as StorageBindingVerifier;
    provider = new LocalStorageProvider(verifier, config);
    executor = makeExecutor();
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin && databaseName)
      await sql`drop database ${sql.id(databaseName)}`.execute(admin.db);
    await admin?.onModuleDestroy();
  });

  it('removes only the two immutable targets, completes once and leaves neighbors intact', async () => {
    const id = await journal();
    await files(id);
    const neighbor = randomUUID();
    await files(neighbor);
    expect(await executor.execute(id, ownerId)).toBe('completed');
    expect(await readdir(join(root, 'originals'))).toEqual([`${neighbor}.jpg`]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([
      `${neighbor}.jpg`,
    ]);
    expect((await receipt(id)).completed_at).not.toBeNull();
    expect((await receipt(id)).execution_token).toBeNull();
    expect(await executor.execute(id, ownerId)).toBe('completed');
    expect(
      await readFile(join(root, 'originals', `${neighbor}.jpg`), 'utf8'),
    ).toBe('private-original');
  });

  it('completes from authoritative original absence and a present thumbnail', async () => {
    const id = await journal();
    await writeFile(join(root, 'thumbnails', `${id}.jpg`), 'thumbnail');
    expect(await executor.execute(id, ownerId)).toBe('completed');
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
  });

  it('uses the immutable approved original extension', async () => {
    const id = await journal(randomUUID(), '.png');
    await files(id, '.png');
    await writeFile(
      join(root, 'originals', `${id}.jpg`),
      'unrelated rendition',
    );
    expect(await executor.execute(id, ownerId)).toBe('completed');
    expect(await readFile(join(root, 'originals', `${id}.jpg`), 'utf8')).toBe(
      'unrelated rendition',
    );
  });

  it('retains a partial deletion for explicit retry after thumbnail failure', async () => {
    const id = await journal();
    await files(id);
    class FailedThumbnail extends LocalStorageProvider {
      override async removeExact(
        target: LogicalStorageTarget,
        expected?: ExpectedStorageBinding,
      ): Promise<RemovalOutcome> {
        if (target.role === 'thumbnails')
          return { status: 'unavailable', durable: false };
        return super.removeExact(target, expected);
      }
    }
    const failing = new FailedThumbnail(verifier, config);
    expect(await makeExecutor(failing).execute(id, ownerId)).toBe('pending');
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readFile(join(root, 'thumbnails', `${id}.jpg`), 'utf8')).toBe(
      'private-thumbnail',
    );
    expect((await receipt(id)).completed_at).toBeNull();
    expect((await receipt(id)).last_error_code).toBe('storage_unavailable');
    expect(await executor.execute(id, ownerId)).toBe('completed');
  });

  it('refuses an absent root, physical mismatch, unsupported capability and live asset', async () => {
    const id = await journal();
    await files(id);
    validBinding = false;
    expect(await executor.execute(id, ownerId)).toBe('unavailable');
    validBinding = true;
    const unsupported = Object.create(provider) as LocalStorageProvider;
    Object.defineProperty(unsupported, 'capabilities', {
      value: { ...provider.capabilities, deletionDurability: false },
    });
    expect(await makeExecutor(unsupported).execute(id, ownerId)).toBe(
      'unavailable',
    );
    await rm(join(root, 'originals'), { recursive: true });
    expect(await executor.execute(id, ownerId)).toBe('pending');
    expect((await receipt(id)).completed_at).toBeNull();
    await mkdir(join(root, 'originals'));
    await sql`insert into public.asset
      (id, filename, mime_type, size, storage_path, created_at, owner_id,
       trashed_at, lifecycle_version) values
      (${id}::uuid, 'synthetic.jpg', 'image/jpeg', 1, 'originals/synthetic.jpg',
       clock_timestamp(), ${ownerId}::uuid, null, 0)`.execute(db);
    expect(await executor.execute(id, ownerId)).toBe('unavailable');
    expect(await readFile(join(root, 'thumbnails', `${id}.jpg`), 'utf8')).toBe(
      'private-thumbnail',
    );
  });

  it('never substitutes a changed database anchor for the journal target', async () => {
    const id = await journal();
    await files(id);
    await sql`update public.storage_binding set storage_id = ${randomUUID()}::uuid
      where singleton = true`.execute(db);
    expect(await executor.execute(id, ownerId)).toBe('unavailable');
    expect((await receipt(id)).execution_token).toBeNull();
    expect(await readFile(join(root, 'originals', `${id}.jpg`), 'utf8')).toBe(
      'private-original',
    );
  });

  it('refuses a binding change between executor preflight and provider pin', async () => {
    const id = await journal();
    await files(id);
    class ReboundBeforePin extends LocalStorageProvider {
      override async removeExact(
        target: LogicalStorageTarget,
        expected?: ExpectedStorageBinding,
      ): Promise<RemovalOutcome> {
        await sql`update public.storage_binding
          set storage_id = ${randomUUID()}::uuid where singleton = true`.execute(
          db,
        );
        return super.removeExact(target, expected);
      }
    }
    expect(
      await makeExecutor(new ReboundBeforePin(verifier, config)).execute(
        id,
        ownerId,
      ),
    ).toBe('pending');
    expect(await readFile(join(root, 'originals', `${id}.jpg`), 'utf8')).toBe(
      'private-original',
    );
    expect((await receipt(id)).completed_at).toBeNull();
  });

  it('rejects unexpected symlinks and never follows the target', async () => {
    const id = await journal();
    await files(id);
    await rm(join(root, 'originals', `${id}.jpg`));
    const neighbor = join(root, 'originals', 'neighbor');
    await writeFile(neighbor, 'preserved');
    const { symlink } = await import('node:fs/promises');
    await symlink(neighbor, join(root, 'originals', `${id}.jpg`));
    expect(await executor.execute(id, ownerId)).toBe('pending');
    expect(await readFile(neighbor, 'utf8')).toBe('preserved');
    expect((await receipt(id)).completed_at).toBeNull();
  });

  it('keeps both targets pending on unlink failure', async () => {
    const id = await journal();
    await files(id);
    class FailedUnlink extends LocalStorageProvider {
      protected override async unlinkPath(): Promise<void> {
        throw new Error('synthetic permission or I/O failure at unlink');
      }
    }
    expect(
      await makeExecutor(new FailedUnlink(verifier, config)).execute(
        id,
        ownerId,
      ),
    ).toBe('pending');
    expect((await receipt(id)).completed_at).toBeNull();
    expect(await readFile(join(root, 'originals', `${id}.jpg`), 'utf8')).toBe(
      'private-original',
    );
    expect(await readFile(join(root, 'thumbnails', `${id}.jpg`), 'utf8')).toBe(
      'private-thumbnail',
    );
    expect(await executor.execute(id, ownerId)).toBe('completed');
  });

  it('does not complete after a lost directory-sync acknowledgement', async () => {
    const id = await journal();
    await files(id);
    class FailedSync extends LocalStorageProvider {
      protected override async syncDirectory(): Promise<void> {
        throw new Error('synthetic fsync failure');
      }
    }
    expect(
      await makeExecutor(new FailedSync(verifier, config)).execute(id, ownerId),
    ).toBe('pending');
    expect((await receipt(id)).completed_at).toBeNull();
    expect(await executor.execute(id, ownerId)).toBe('completed');
  });

  it('does not mistake two absent targets for completion when directory sync fails', async () => {
    const id = await journal();
    class FailedSync extends LocalStorageProvider {
      protected override async syncDirectory(): Promise<void> {
        throw new Error('synthetic absent-target fsync failure');
      }
    }
    expect(
      await makeExecutor(new FailedSync(verifier, config)).execute(id, ownerId),
    ).toBe('pending');
    expect((await receipt(id)).completed_at).toBeNull();
    expect(await executor.execute(id, ownerId)).toBe('completed');
  });

  it('does not start thumbnail I/O after PostgreSQL renewal becomes unavailable', async () => {
    const id = await journal();
    await files(id);
    class LostDatabase extends AssetDeletionRepository {
      private renewals = 0;
      override async renew(
        asset: string,
        owner: string,
        token: string,
      ): Promise<boolean> {
        if (++this.renewals === 2) throw new Error('synthetic connection loss');
        return super.renew(asset, owner, token);
      }
    }
    const disconnected = new LostDatabase({ db } as DatabaseService);
    expect(
      await makeExecutor(provider, disconnected).execute(id, ownerId),
    ).toBe('pending');
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readFile(join(root, 'thumbnails', `${id}.jpg`), 'utf8')).toBe(
      'private-thumbnail',
    );
    expect((await receipt(id)).completed_at).toBeNull();
    expect(await executor.execute(id, ownerId)).toBe('completed');
  });

  it('rejects an uncertain journal claim without starting filesystem I/O', async () => {
    const id = await journal();
    await files(id);
    class UnconfirmedClaim extends AssetDeletionRepository {
      override async claim(): Promise<never> {
        throw new Error('synthetic unavailable claim acknowledgement');
      }
    }
    expect(
      await makeExecutor(
        provider,
        new UnconfirmedClaim({ db } as DatabaseService),
      ).execute(id, ownerId),
    ).toBe('unavailable');
    expect(await readFile(join(root, 'originals', `${id}.jpg`), 'utf8')).toBe(
      'private-original',
    );
    expect((await receipt(id)).execution_token).toBeNull();
  });

  it('does not release a local slot while a cancelled provider operation remains in flight', async () => {
    const ids = await Promise.all([journal(), journal(), journal()]);
    await Promise.all(ids.map((id) => files(id)));
    const first = gate();
    const second = gate();
    let entered = 0;
    class BlockedProvider extends LocalStorageProvider {
      override async removeExact(
        target: LogicalStorageTarget,
        expected?: ExpectedStorageBinding,
      ): Promise<RemovalOutcome> {
        if (target.role === 'originals') {
          const blocker = ++entered === 1 ? first : second;
          blocker.entered();
          await blocker.held;
        }
        return super.removeExact(target, expected);
      }
    }
    const bounded = makeExecutor(new BlockedProvider(verifier, config));
    const cancelled = new AbortController();
    const a = bounded.execute(ids[0], ownerId, cancelled.signal);
    const b = bounded.execute(ids[1], ownerId);
    await Promise.all([first.waiting, second.waiting]);
    cancelled.abort();
    expect(await bounded.execute(ids[2], ownerId)).toBe('pending');
    expect((await receipt(ids[2])).execution_token).toBeNull();
    first.release();
    expect(await a).toBe('pending');
    second.release();
    expect(await b).toBe('completed');
    expect(await bounded.execute(ids[2], ownerId)).toBe('completed');
  });

  it('returns pending to a concurrent claimant without duplicate filesystem work', async () => {
    const id = await journal();
    await files(id);
    const pause = gate();
    class PausedOriginal extends LocalStorageProvider {
      override async removeExact(
        target: LogicalStorageTarget,
        expected?: ExpectedStorageBinding,
      ): Promise<RemovalOutcome> {
        if (target.role === 'originals') {
          pause.entered();
          await pause.held;
        }
        return super.removeExact(target, expected);
      }
    }
    const first = makeExecutor(new PausedOriginal(verifier, config)).execute(
      id,
      ownerId,
    );
    await pause.waiting;
    expect(await executor.execute(id, ownerId)).toBe('pending');
    expect(await readFile(join(root, 'originals', `${id}.jpg`), 'utf8')).toBe(
      'private-original',
    );
    pause.release();
    expect(await first).toBe('completed');
  });

  it('stops after claim loss during original I/O and lets a new claimant finish', async () => {
    const id = await journal();
    await files(id);
    const pause = gate();
    class PausedOriginal extends LocalStorageProvider {
      override async removeExact(
        target: LogicalStorageTarget,
        expected?: ExpectedStorageBinding,
      ): Promise<RemovalOutcome> {
        if (target.role === 'originals') {
          pause.entered();
          await pause.held;
        }
        return super.removeExact(target, expected);
      }
    }
    const stale = makeExecutor(new PausedOriginal(verifier, config));
    const running = stale.execute(id, ownerId);
    await pause.waiting;
    await sql`update public.asset_deletion
      set execution_expires_at = clock_timestamp() - interval '1 second'
      where asset_id = ${id}::uuid`.execute(db);
    expect(await executor.execute(id, ownerId)).toBe('completed');
    pause.release();
    expect(await running).toBe('pending');
    expect((await receipt(id)).completed_at).not.toBeNull();
  });

  it('does not proceed to another target if immutable journal data changes during I/O', async () => {
    const id = await journal();
    await files(id);
    const pause = gate();
    class PausedOriginal extends LocalStorageProvider {
      override async removeExact(
        target: LogicalStorageTarget,
        expected?: ExpectedStorageBinding,
      ): Promise<RemovalOutcome> {
        if (target.role === 'originals') {
          pause.entered();
          await pause.held;
        }
        return super.removeExact(target, expected);
      }
    }
    const running = makeExecutor(new PausedOriginal(verifier, config)).execute(
      id,
      ownerId,
    );
    await pause.waiting;
    await sql`update public.asset_deletion
      set requested_at = requested_at + interval '1 microsecond'
      where asset_id = ${id}::uuid`.execute(db);
    pause.release();
    expect(await running).toBe('pending');
    expect(await readFile(join(root, 'thumbnails', `${id}.jpg`), 'utf8')).toBe(
      'private-thumbnail',
    );
    expect((await receipt(id)).completed_at).toBeNull();
  });

  it('confirms a completed receipt after a lost completion acknowledgement', async () => {
    const id = await journal();
    await files(id);
    class LostAck extends AssetDeletionRepository {
      override async completeAfterVerifiedRemoval(
        asset: string,
        owner: string,
        token: string,
      ): Promise<boolean> {
        await super.completeAfterVerifiedRemoval(asset, owner, token);
        throw new Error('synthetic lost PostgreSQL acknowledgement');
      }
    }
    const lost = new LostAck({ db } as DatabaseService);
    expect(await makeExecutor(provider, lost).execute(id, ownerId)).toBe(
      'completed',
    );
    expect((await receipt(id)).completed_at).not.toBeNull();
  });

  it('retries safely when both files were removed but completion did not commit', async () => {
    const id = await journal();
    await files(id);
    class FailedCompletion extends AssetDeletionRepository {
      override async completeAfterVerifiedRemoval(): Promise<boolean> {
        throw new Error('synthetic completion transaction unavailable');
      }
    }
    const failed = new FailedCompletion({ db } as DatabaseService);
    expect(await makeExecutor(provider, failed).execute(id, ownerId)).toBe(
      'pending',
    );
    expect(await readdir(join(root, 'originals'))).toEqual([]);
    expect(await readdir(join(root, 'thumbnails'))).toEqual([]);
    expect((await receipt(id)).completed_at).toBeNull();
    await sql`update public.asset_deletion
      set execution_expires_at = clock_timestamp() - interval '1 second'
      where asset_id = ${id}::uuid`.execute(db);
    expect(await executor.execute(id, ownerId)).toBe('completed');
  });
});
