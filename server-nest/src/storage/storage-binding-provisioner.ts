import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { posix } from 'node:path';

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql, type Kysely, type Transaction } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import type { Database } from '../database/database.types.js';
import {
  StorageBindingVerifier,
  type PhysicalStorageObserver,
} from './storage-binding.service.js';
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
 * Explicit fresh-install primitive, deliberately not registered as an HTTP
 * provider or operator command. It cannot run until a separately approved
 * native observer, deployment procedure and certification exist. Existing
 * installations require reviewed inventory/adoption, which this class does
 * not implement. Partial marker creation is intentionally never repaired.
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
    const marker = posix.join(this.location(role), '.saefr-storage.json');
    const handle = await open(
      marker,
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
    const directory = await open(
      this.location(role),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
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
