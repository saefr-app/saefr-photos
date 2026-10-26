import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { posix } from 'node:path';

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql, type Kysely, type Transaction } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import type { Database } from '../database/database.types.js';
import {
  assertHistoricalInventory,
  readProtectedAdoptionEvidence,
  type HistoricalAdoptionManifest,
} from './storage-adoption-inventory.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from './storage-binding.service.js';
import {
  assertControlledRecoveryDatabase,
  assertControlledRecoveryInventory,
} from './storage-recovery-inventory.js';
import {
  locationFingerprint,
  roleLocation,
  serializeStorageMarker,
  type Ext4PhysicalIdentity,
  type StorageRole,
} from './storage-marker.js';

export interface FreshStorageIdentity {
  readonly storageId: string;
  readonly originalsBindingId: string;
  readonly thumbnailsBindingId: string;
}

/** Native implementation must observe the same safely opened role directory. */
export interface ProvisioningIdentityObserver {
  observeIdentity(
    role: StorageRole,
    location: string,
  ): Promise<Omit<Ext4PhysicalIdentity, 'location_sha256'>>;
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Storage unavailable');
}

async function assertEmptyDatabase(
  db: Kysely<Database> | Transaction<Database>,
) {
  const result = await sql<{ occupied: boolean }>`select
    exists(select 1 from public.asset) or
    exists(select 1 from public.asset_deletion) or
    exists(select 1 from public.storage_binding) as occupied`.execute(db);
  if (result.rows[0]?.occupied !== false) throw unavailable();
}

/**
 * Explicit stopped-service operator primitives. None runs at HTTP startup;
 * preflight alone cannot create binding authority. Partial markers are never
 * repaired automatically.
 */
export class StorageBindingProvisioner {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly observer: ProvisioningIdentityObserver,
    private readonly markerObserver: PhysicalStorageObserver,
    private readonly verifier: StorageBindingVerifier,
  ) {}

  private location(role: StorageRole): string {
    return roleLocation(
      this.config.getOrThrow<string>('STORAGE_ROOT'),
      process.cwd(),
      role,
    );
  }

  private async assertEmptyRole(role: StorageRole): Promise<void> {
    const location = this.location(role);
    let current = '/';
    for (const part of location.split('/').filter(Boolean)) {
      current = posix.join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    }
    if ((await readdir(location)).length !== 0) throw unavailable();
  }

  private async writeMarker(role: StorageRole, bytes: Buffer): Promise<void> {
    const location = this.location(role);
    let cursor = '/';
    for (const part of location.split('/').filter(Boolean)) {
      cursor = posix.join(cursor, part);
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    }
    const directory = await open(
      location,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const handle = await open(
        `/proc/self/fd/${directory.fd}/.saefr-storage.json`,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async assessHistoricalAdoption(
    manifest: HistoricalAdoptionManifest,
  ): Promise<void> {
    try {
      const occupied = await sql<{ occupied: boolean }>`select
        exists(select 1 from public.asset_deletion) or
        exists(select 1 from public.storage_binding) as occupied`.execute(
        this.database.db,
      );
      if (occupied.rows[0]?.occupied !== false) throw unavailable();
      const rows = await this.database.db
        .selectFrom('asset')
        .select(['id', 'mime_type', 'size', 'storage_path'])
        .orderBy('id')
        .execute();
      await assertHistoricalInventory(
        this.config.getOrThrow<string>('STORAGE_ROOT'),
        rows,
        manifest,
      );
      await Promise.all(
        (['originals', 'thumbnails'] as const).map((role) =>
          this.observer.observeIdentity(role, this.location(role)),
        ),
      );
      // Recheck population after the filesystem pass. Offline writer fencing
      // remains a mandatory operator prerequisite, not something this read-only
      // method can establish by looking at a single database snapshot.
      const after = await this.database.db
        .selectFrom('asset')
        .select(['id', 'mime_type', 'size', 'storage_path'])
        .orderBy('id')
        .execute();
      if (JSON.stringify(rows) !== JSON.stringify(after)) throw unavailable();
    } catch {
      throw unavailable();
    }
  }

  /**
   * Stopped-service operator primitive. The caller must independently fence
   * every writer/executor and approve the protected pairing and backup record.
   * Partial markers are intentionally left untouched on any failure.
   */
  async adoptHistorical(
    evidencePath: string,
    identity: FreshStorageIdentity,
    expectedBackupRecordSha256: string,
  ): Promise<void> {
    try {
      if (
        identity.storageId !== this.config.get<string>('STORAGE_ID') ||
        identity.originalsBindingId !==
          this.config.get<string>('STORAGE_ORIGINALS_BINDING_ID') ||
        identity.thumbnailsBindingId !==
          this.config.get<string>('STORAGE_THUMBNAILS_BINDING_ID') ||
        identity.originalsBindingId === identity.thumbnailsBindingId ||
        this.config.get<string>('STORAGE_ORIGINALS_PROFILE') !==
          'linux-ext4-v1' ||
        this.config.get<string>('STORAGE_THUMBNAILS_PROFILE') !==
          'linux-ext4-v1'
      )
        throw unavailable();
      const manifest = await readProtectedAdoptionEvidence(
        evidencePath,
        this.config.getOrThrow<string>('POSTGRES_DB'),
        this.config.getOrThrow<string>('STORAGE_ROOT'),
        expectedBackupRecordSha256,
      );
      const before = await this.database.db
        .selectFrom('asset')
        .select(['id', 'mime_type', 'size', 'storage_path'])
        .orderBy('id')
        .execute();
      await this.assessHistoricalAdoption(manifest);

      const roles = ['originals', 'thumbnails'] as const;
      const observations = await Promise.all(
        roles.map((role) =>
          this.observer.observeIdentity(role, this.location(role)),
        ),
      );
      const markers = roles.map((role, index) =>
        serializeStorageMarker({
          version: 2,
          storage_id: identity.storageId,
          binding_id:
            role === 'originals'
              ? identity.originalsBindingId
              : identity.thumbnailsBindingId,
          role,
          physical_identity: {
            ...observations[index],
            location_sha256: locationFingerprint(this.location(role), role),
          },
        }),
      );
      await this.writeMarker('originals', markers[0]);
      await this.writeMarker('thumbnails', markers[1]);
      for (const [index, role] of roles.entries()) {
        const current = await this.observer.observeIdentity(
          role,
          this.location(role),
        );
        const witnessed = await this.markerObserver.observe(
          role,
          this.location(role),
        );
        if (
          !Buffer.from(witnessed.markerBytes).equals(markers[index]) ||
          JSON.stringify(current) !== JSON.stringify(observations[index]) ||
          JSON.stringify(witnessed.identity) !== JSON.stringify(current)
        )
          throw unavailable();
      }

      let inserted = false;
      try {
        await this.database.db.transaction().execute(async (transaction) => {
          await sql`lock table public.asset, public.asset_deletion,
            public.storage_binding in share mode`.execute(transaction);
          const occupied = await sql<{ occupied: boolean }>`select
            exists(select 1 from public.asset_deletion) or
            exists(select 1 from public.storage_binding) as occupied`.execute(
            transaction,
          );
          if (occupied.rows[0]?.occupied !== false) throw unavailable();
          const current = await transaction
            .selectFrom('asset')
            .select(['id', 'mime_type', 'size', 'storage_path'])
            .orderBy('id')
            .execute();
          if (JSON.stringify(current) !== JSON.stringify(before))
            throw unavailable();
          await transaction
            .insertInto('storage_binding')
            .values({
              singleton: true,
              storage_id: identity.storageId,
              originals_binding_id: identity.originalsBindingId,
              thumbnails_binding_id: identity.thumbnailsBindingId,
              storage_layout_version: 1,
            })
            .execute();
          inserted = true;
        });
      } catch {
        if (!inserted) throw unavailable();
        const committed = await this.database.db
          .selectFrom('storage_binding')
          .selectAll()
          .where('singleton', '=', true)
          .executeTakeFirst();
        if (
          committed?.storage_id !== identity.storageId ||
          committed.originals_binding_id !== identity.originalsBindingId ||
          committed.thumbnails_binding_id !== identity.thumbnailsBindingId ||
          committed.storage_layout_version !== 1
        )
          throw unavailable();
      }
      await this.verifier.assertVerified();
    } catch {
      throw unavailable();
    }
  }

  /**
   * Re-establish physical role markers after a reviewed relocation or matched
   * database/media restoration. This never changes logical IDs, asset rows or
   * deletion receipts. Both destination markers must be absent; partial work
   * is deliberately left for explicit operator recovery.
   */
  async reestablishControlledLocation(
    evidencePath: string,
    expectedBackupRecordSha256: string,
  ): Promise<void> {
    try {
      const root = this.config.getOrThrow<string>('STORAGE_ROOT');
      const evidence = await assertControlledRecoveryInventory(
        this.database,
        root,
        this.config.getOrThrow<string>('POSTGRES_DB'),
        evidencePath,
        expectedBackupRecordSha256,
      );
      if (
        evidence.binding.storageId !== this.config.get<string>('STORAGE_ID') ||
        evidence.binding.originalsBindingId !==
          this.config.get<string>('STORAGE_ORIGINALS_BINDING_ID') ||
        evidence.binding.thumbnailsBindingId !==
          this.config.get<string>('STORAGE_THUMBNAILS_BINDING_ID') ||
        evidence.binding.originalsBindingId ===
          evidence.binding.thumbnailsBindingId ||
        this.config.get<string>('STORAGE_ORIGINALS_PROFILE') !==
          'linux-ext4-v1' ||
        this.config.get<string>('STORAGE_THUMBNAILS_PROFILE') !==
          'linux-ext4-v1'
      )
        throw unavailable();
      const roles = ['originals', 'thumbnails'] as const;
      const observed = await Promise.all(
        roles.map((role) =>
          this.observer.observeIdentity(role, this.location(role)),
        ),
      );
      const markers = roles.map((role, index) =>
        serializeStorageMarker({
          version: 2,
          storage_id: evidence.binding.storageId,
          binding_id:
            role === 'originals'
              ? evidence.binding.originalsBindingId
              : evidence.binding.thumbnailsBindingId,
          role,
          physical_identity: {
            ...observed[index],
            location_sha256: locationFingerprint(this.location(role), role),
          },
        }),
      );
      await this.writeMarker('originals', markers[0]);
      await this.writeMarker('thumbnails', markers[1]);
      await assertControlledRecoveryDatabase(this.database, evidence);
      for (const [index, role] of roles.entries()) {
        const current = await this.observer.observeIdentity(
          role,
          this.location(role),
        );
        const witnessed = await this.markerObserver.observe(
          role,
          this.location(role),
        );
        if (
          JSON.stringify(current) !== JSON.stringify(observed[index]) ||
          JSON.stringify(witnessed.identity) !== JSON.stringify(current) ||
          !Buffer.from(witnessed.markerBytes).equals(markers[index])
        )
          throw unavailable();
      }
      await this.verifier.assertVerified();
    } catch {
      throw unavailable();
    }
  }

  async provisionFresh(identity: FreshStorageIdentity): Promise<void> {
    try {
      if (
        identity.storageId !== this.config.get<string>('STORAGE_ID') ||
        identity.originalsBindingId !==
          this.config.get<string>('STORAGE_ORIGINALS_BINDING_ID') ||
        identity.thumbnailsBindingId !==
          this.config.get<string>('STORAGE_THUMBNAILS_BINDING_ID') ||
        identity.originalsBindingId === identity.thumbnailsBindingId ||
        this.config.get<string>('STORAGE_ORIGINALS_PROFILE') !==
          'linux-ext4-v1' ||
        this.config.get<string>('STORAGE_THUMBNAILS_PROFILE') !==
          'linux-ext4-v1'
      )
        throw unavailable();
      await assertEmptyDatabase(this.database.db);
      await this.assertEmptyRole('originals');
      await this.assertEmptyRole('thumbnails');

      // All native observations precede the first filesystem mutation.
      const observations = await Promise.all(
        (['originals', 'thumbnails'] as const).map((role) =>
          this.observer.observeIdentity(role, this.location(role)),
        ),
      );
      const markers = (['originals', 'thumbnails'] as const).map(
        (role, index) =>
          serializeStorageMarker({
            version: 2,
            storage_id: identity.storageId,
            binding_id:
              role === 'originals'
                ? identity.originalsBindingId
                : identity.thumbnailsBindingId,
            role,
            physical_identity: {
              ...observations[index],
              location_sha256: locationFingerprint(this.location(role), role),
            },
          }),
      );
      await this.assertEmptyRole('originals');
      await this.assertEmptyRole('thumbnails');
      await this.writeMarker('originals', markers[0]);
      await this.writeMarker('thumbnails', markers[1]);

      // Reobserve after both writes. A mount change leaves markers in place
      // for explicit recovery and never installs the database anchor.
      for (const [index, role] of (
        ['originals', 'thumbnails'] as const
      ).entries()) {
        const current = await this.observer.observeIdentity(
          role,
          this.location(role),
        );
        const witnessed = await this.markerObserver.observe(
          role,
          this.location(role),
        );
        if (
          witnessed.markerBytes.byteLength > 1024 ||
          !Buffer.from(witnessed.markerBytes).equals(markers[index]) ||
          current.format !== observations[index].format ||
          current.profile !== observations[index].profile ||
          current.filesystem_uuid !== observations[index].filesystem_uuid ||
          current.directory_handle_type !==
            observations[index].directory_handle_type ||
          current.directory_handle_hex !==
            observations[index].directory_handle_hex ||
          witnessed.identity.format !== current.format ||
          witnessed.identity.profile !== current.profile ||
          witnessed.identity.filesystem_uuid !== current.filesystem_uuid ||
          witnessed.identity.directory_handle_type !==
            current.directory_handle_type ||
          witnessed.identity.directory_handle_hex !==
            current.directory_handle_hex
        )
          throw unavailable();
      }

      let inserted = false;
      try {
        await this.database.db.transaction().execute(async (transaction) => {
          await sql`lock table public.asset, public.asset_deletion,
            public.storage_binding in share mode`.execute(transaction);
          await assertEmptyDatabase(transaction);
          await transaction
            .insertInto('storage_binding')
            .values({
              singleton: true,
              storage_id: identity.storageId,
              originals_binding_id: identity.originalsBindingId,
              thumbnails_binding_id: identity.thumbnailsBindingId,
              storage_layout_version: 1,
            })
            .execute();
          inserted = true;
        });
      } catch {
        if (!inserted) throw unavailable();
        // A lost COMMIT acknowledgement is resolved only by an independent
        // read of the exact tuple. Unavailable/mismatched remains unavailable.
        const committed = await this.database.db
          .selectFrom('storage_binding')
          .selectAll()
          .where('singleton', '=', true)
          .executeTakeFirst();
        if (
          committed?.storage_id !== identity.storageId ||
          committed.originals_binding_id !== identity.originalsBindingId ||
          committed.thumbnails_binding_id !== identity.thumbnailsBindingId ||
          committed.storage_layout_version !== 1
        )
          throw unavailable();
      }
      await this.verifier.assertVerified();
    } catch {
      throw unavailable();
    }
  }
}
