import { createHash, randomUUID } from 'node:crypto';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service.js';
import { migrateToLatest } from '../src/database/migrations/migration-runner.js';
import { BoundImageStorageService } from '../src/storage/bound-image-storage.service.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import { M12ApplicationReadinessService } from '../src/storage/m12-application-readiness.service.js';
import { SchemaAwareImageStorageService } from '../src/storage/schema-aware-image-storage.service.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from '../src/storage/storage-binding.service.js';
import {
  StorageBindingProvisioner,
  type ProvisioningIdentityObserver,
} from '../src/storage/storage-binding-provisioner.js';
import type { StorageRole } from '../src/storage/storage-marker.js';
import { testConfig } from './helpers/integration-database.js';

const ids = {
  storageId: 'c1111111-1111-4111-8111-111111111111',
  originalsBindingId: 'c2222222-2222-4222-8222-222222222222',
  thumbnailsBindingId: 'c3333333-3333-4333-8333-333333333333',
};

describe('synthetic fresh storage provisioning on disposable PostgreSQL', () => {
  let database: DatabaseService;
  let databaseName: string;
  beforeAll(async () => {
    const config = testConfig();
    databaseName = config.getOrThrow<string>('POSTGRES_DB');
    database = new DatabaseService(config);
    await database.ping();
    await migrateToLatest(database.db);
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  async function fixture(changeAfterWrite = false) {
    const root = await mkdtemp(join(tmpdir(), 'saefr-provision-'));
    await mkdir(join(root, 'originals'));
    await mkdir(join(root, 'thumbnails'));
    const config = new ConfigService({
      POSTGRES_DB: databaseName,
      STORAGE_ROOT: root,
      STORAGE_ID: ids.storageId,
      STORAGE_ORIGINALS_BINDING_ID: ids.originalsBindingId,
      STORAGE_THUMBNAILS_BINDING_ID: ids.thumbnailsBindingId,
      STORAGE_ORIGINALS_PROFILE: 'linux-ext4-v1',
      STORAGE_THUMBNAILS_PROFILE: 'linux-ext4-v1',
    });
    const physical = (role: StorageRole, changed = false) => ({
      format: 'linux-ext4-handle-v1' as const,
      profile: 'linux-ext4-v1' as const,
      filesystem_uuid: 'c4444444-4444-4444-8444-444444444444',
      directory_handle_type: 1,
      directory_handle_hex: changed
        ? 'ffcc'
        : role === 'originals'
          ? 'aabb'
          : 'ccdd',
    });
    let thumbnailObservations = 0;
    const identityObserver: ProvisioningIdentityObserver = {
      async observeIdentity(role) {
        if (role === 'thumbnails') thumbnailObservations++;
        return physical(role, changeAfterWrite && thumbnailObservations > 1);
      },
    };
    const markerObserver: PhysicalStorageObserver = {
      async observe(role, location) {
        return {
          markerBytes: await readFile(join(location, '.saefr-storage.json')),
          identity: physical(role),
        };
      },
      async observePinned(role, _location, directory) {
        return {
          markerBytes: await readFile(
            `/proc/self/fd/${directory.fd}/.saefr-storage.json`,
          ),
          identity: physical(role),
        };
      },
    };
    const verifier = new StorageBindingVerifier(
      database,
      config,
      markerObserver,
    );
    return {
      root,
      config,
      provisioner: new StorageBindingProvisioner(
        database,
        config,
        identityObserver,
        markerObserver,
        verifier,
      ),
      verifier,
    };
  }

  it('writes two exclusive markers before the short singleton transaction', async () => {
    const setup = await fixture();
    try {
      await setup.provisioner.provisionFresh(ids);
      await expect(setup.verifier.assertVerified()).resolves.toMatchObject({
        storage_id: ids.storageId,
      });
      for (const role of ['originals', 'thumbnails']) {
        expect(await readdir(join(setup.root, role))).toEqual([
          '.saefr-storage.json',
        ]);
      }
      await expect(setup.provisioner.provisionFresh(ids)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
    } finally {
      await database.db.deleteFrom('storage_binding').execute();
      await rm(setup.root, { recursive: true, force: true });
    }
  });

  it('leaves partial evidence unadopted when post-write physical identity changes', async () => {
    const setup = await fixture(true);
    try {
      await expect(setup.provisioner.provisionFresh(ids)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
      expect(await readdir(join(setup.root, 'originals'))).toEqual([
        '.saefr-storage.json',
      ]);
      expect(await readdir(join(setup.root, 'thumbnails'))).toEqual([
        '.saefr-storage.json',
      ]);
      expect(
        await database.db.selectFrom('storage_binding').selectAll().execute(),
      ).toEqual([]);
      await expect(setup.provisioner.provisionFresh(ids)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  });

  it('assesses a synthetic historical population without adopting or changing metadata', async () => {
    const setup = await fixture();
    const userId = randomUUID();
    const assetId = randomUUID();
    const original = Buffer.from('synthetic historical original');
    const thumbnail = Buffer.from('synthetic historical thumbnail');
    const digest = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    const storedPath = `/reviewed/legacy/originals/${assetId}.jpg`;
    try {
      await writeFile(
        join(setup.root, 'originals', `${assetId}.jpg`),
        original,
      );
      await writeFile(
        join(setup.root, 'thumbnails', `${assetId}.jpg`),
        thumbnail,
      );
      await database.db
        .insertInto('app_user')
        .values({
          id: userId,
          username: `adoption-${userId.slice(0, 8)}`,
          password_hash: 'synthetic-unused-hash',
          role: 'user',
          status: 'active',
          password_change_required: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      await database.db
        .insertInto('asset')
        .values({
          id: assetId,
          owner_id: userId,
          filename: 'synthetic.jpg',
          mime_type: 'image/jpeg',
          size: original.length,
          storage_path: storedPath,
          created_at: new Date(),
        })
        .execute();
      const before = await database.db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow();
      const manifest = {
        version: 1 as const,
        recordedOriginalRoots: ['/reviewed/legacy/originals'],
        assets: [
          {
            id: assetId,
            originalSha256: digest(original),
            thumbnailSha256: digest(thumbnail),
          },
        ],
      };

      await expect(
        setup.provisioner.assessHistoricalAdoption(manifest),
      ).resolves.toBeUndefined();
      await expect(
        setup.provisioner.assessHistoricalAdoption({
          ...manifest,
          recordedOriginalRoots: ['/wrong/originals'],
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        await database.db
          .selectFrom('asset')
          .selectAll()
          .where('id', '=', assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(
        await database.db.selectFrom('storage_binding').selectAll().execute(),
      ).toEqual([]);
      expect(await readdir(join(setup.root, 'originals'))).toEqual([
        `${assetId}.jpg`,
      ]);
    } finally {
      await database.db.deleteFrom('asset').where('id', '=', assetId).execute();
      await database.db
        .deleteFrom('app_user')
        .where('id', '=', userId)
        .execute();
      await rm(setup.root, { recursive: true, force: true });
    }
  });

  it('adopts only a complete protected synthetic pairing and preserves historical rows', async () => {
    const setup = await fixture();
    const relocated = await fixture();
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'saefr-evidence-'));
    const userId = randomUUID();
    const assetId = randomUUID();
    const pendingId = randomUUID();
    const original = Buffer.from('synthetic adoption original');
    const thumbnail = Buffer.from('synthetic adoption thumbnail');
    const digest = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    const backupHash = 'a'.repeat(64);
    const evidencePath = join(evidenceRoot, 'reviewed.json');
    try {
      await writeFile(
        join(setup.root, 'originals', `${assetId}.jpg`),
        original,
      );
      await writeFile(
        join(setup.root, 'thumbnails', `${assetId}.jpg`),
        thumbnail,
      );
      await database.db
        .insertInto('app_user')
        .values({
          id: userId,
          username: `adopt-${userId.slice(0, 8)}`,
          password_hash: 'synthetic-unused-hash',
          role: 'user',
          status: 'active',
          password_change_required: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      await database.db
        .insertInto('asset')
        .values({
          id: assetId,
          owner_id: userId,
          filename: 'synthetic.jpg',
          mime_type: 'image/jpeg',
          size: original.length,
          storage_path: `/reviewed/legacy/originals/${assetId}.jpg`,
          created_at: new Date(),
        })
        .execute();
      const before = await database.db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow();
      await writeFile(
        evidencePath,
        JSON.stringify({
          version: 1,
          databaseName,
          storageRoot: setup.root,
          backupRecordSha256: backupHash,
          manifest: {
            version: 1,
            recordedOriginalRoots: ['/reviewed/legacy/originals'],
            assets: [
              {
                id: assetId,
                originalSha256: digest(original),
                thumbnailSha256: digest(thumbnail),
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      const storage = new SchemaAwareImageStorageService(
        database,
        setup.config,
        new BoundImageStorageService(
          new LocalStorageProvider(setup.verifier, setup.config),
          setup.config,
        ),
      );
      const readiness = new M12ApplicationReadinessService(
        database,
        setup.verifier,
      );
      expect(await readiness.assess()).toBe('metadata-only');
      await expect(storage.assertReady()).rejects.toMatchObject({
        status: 503,
      });
      await expect(
        storage.openOriginal(
          assetId,
          'image/jpeg',
          `/reviewed/legacy/originals/${assetId}.jpg`,
        ),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        setup.provisioner.adoptHistorical(evidencePath, ids, 'b'.repeat(64)),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        await database.db.selectFrom('storage_binding').selectAll().execute(),
      ).toEqual([]);
      expect(await readdir(join(setup.root, 'originals'))).toEqual([
        `${assetId}.jpg`,
      ]);

      await setup.provisioner.adoptHistorical(evidencePath, ids, backupHash);
      expect(await readiness.assess()).toBe('media-ready');
      await expect(storage.assertReady()).resolves.toBeUndefined();
      const opened = await storage.openOriginal(
        assetId,
        'image/jpeg',
        `/reviewed/legacy/originals/${assetId}.jpg`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(original);
      await expect(setup.verifier.assertVerified()).resolves.toMatchObject({
        storage_id: ids.storageId,
      });
      expect(
        await database.db
          .selectFrom('asset')
          .selectAll()
          .where('id', '=', assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      for (const role of ['originals', 'thumbnails']) {
        expect(await readdir(join(setup.root, role))).toContain(
          '.saefr-storage.json',
        );
      }
      await expect(
        setup.provisioner.adoptHistorical(evidencePath, ids, backupHash),
      ).rejects.toMatchObject({ status: 503 });

      // A different synthetic location must not inherit authority from a
      // copied marker. A reviewed full recovery inventory permits an explicit
      // re-establishment without changing any SQL row or logical identity.
      for (const role of ['originals', 'thumbnails'] as const) {
        await writeFile(
          join(relocated.root, role, `${assetId}.jpg`),
          role === 'originals' ? original : thumbnail,
        );
      }
      const pendingOriginal = Buffer.from(
        'synthetic pending deletion original',
      );
      await writeFile(
        join(relocated.root, 'originals', `${pendingId}.jpg`),
        pendingOriginal,
      );
      await database.db
        .insertInto('asset_deletion')
        .values({
          asset_id: pendingId,
          owner_id: userId,
          accepted_lifecycle_version: '0',
          storage_id: ids.storageId,
          originals_binding_id: ids.originalsBindingId,
          thumbnails_binding_id: ids.thumbnailsBindingId,
          storage_layout_version: 1,
          original_extension: '.jpg',
          requested_at: new Date(),
          completed_at: null,
          last_error_code: null,
          execution_token: null,
          execution_expires_at: null,
        })
        .execute();
      const journalBefore = await database.db
        .selectFrom('asset_deletion')
        .selectAll()
        .where('asset_id', '=', pendingId)
        .executeTakeFirstOrThrow();
      const recoveryPath = join(evidenceRoot, 'recovery.json');
      const snapshotHash = (value: unknown) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const recovery = {
        version: 1,
        databaseName,
        storageRoot: relocated.root,
        backupRecordSha256: backupHash,
        binding: {
          storageId: ids.storageId,
          originalsBindingId: ids.originalsBindingId,
          thumbnailsBindingId: ids.thumbnailsBindingId,
        },
        assetRowsSha256: snapshotHash(
          await database.db
            .selectFrom('asset')
            .selectAll()
            .orderBy('id')
            .execute(),
        ),
        deletionRowsSha256: snapshotHash(
          await database.db
            .selectFrom('asset_deletion')
            .selectAll()
            .orderBy('asset_id')
            .execute(),
        ),
        files: [
          {
            role: 'originals',
            name: `${assetId}.jpg`,
            size: original.length,
            sha256: digest(original),
          },
          {
            role: 'originals',
            name: `${pendingId}.jpg`,
            size: pendingOriginal.length,
            sha256: digest(pendingOriginal),
          },
          {
            role: 'thumbnails',
            name: `${assetId}.jpg`,
            size: thumbnail.length,
            sha256: digest(thumbnail),
          },
        ],
      };
      await writeFile(recoveryPath, JSON.stringify(recovery), { mode: 0o600 });
      await expect(
        relocated.provisioner.reestablishControlledLocation(
          recoveryPath,
          'b'.repeat(64),
        ),
      ).rejects.toMatchObject({ status: 503 });
      await writeFile(
        join(relocated.root, 'originals', '.saefr-storage.json'),
        await readFile(join(setup.root, 'originals', '.saefr-storage.json')),
      );
      await expect(
        relocated.provisioner.reestablishControlledLocation(
          recoveryPath,
          backupHash,
        ),
      ).rejects.toMatchObject({ status: 503 });
      await rm(join(relocated.root, 'originals', '.saefr-storage.json'));
      await relocated.provisioner.reestablishControlledLocation(
        recoveryPath,
        backupHash,
      );
      await expect(relocated.verifier.assertVerified()).resolves.toMatchObject({
        storage_id: ids.storageId,
      });
      expect(
        await database.db
          .selectFrom('asset')
          .selectAll()
          .where('id', '=', assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(
        await database.db
          .selectFrom('asset_deletion')
          .selectAll()
          .where('asset_id', '=', pendingId)
          .executeTakeFirstOrThrow(),
      ).toEqual(journalBefore);
      await expect(
        relocated.provisioner.reestablishControlledLocation(
          recoveryPath,
          backupHash,
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await database.db
        .deleteFrom('asset_deletion')
        .where('asset_id', '=', pendingId)
        .execute();
      await database.db.deleteFrom('storage_binding').execute();
      await database.db.deleteFrom('asset').where('id', '=', assetId).execute();
      await database.db
        .deleteFrom('app_user')
        .where('id', '=', userId)
        .execute();
      await rm(setup.root, { recursive: true, force: true });
      await rm(relocated.root, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});
