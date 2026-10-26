import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Selectable } from 'kysely';
import type { FileHandle } from 'node:fs/promises';

import { DatabaseService } from '../database/database.service.js';
import type { StorageBindingTable } from '../database/database.types.js';
import {
  locationFingerprint,
  parseStorageMarker,
  roleLocation,
  type Ext4PhysicalIdentity,
  type StorageRole,
} from './storage-marker.js';

export type StorageBinding = Selectable<StorageBindingTable>;

/**
 * Implementations must read the marker and physical identity from the same
 * safely opened directory and detect replacement before returning. No such
 * native implementation is certified yet; the default refuses observation.
 */
export interface PhysicalStorageObserver {
  observe(
    role: StorageRole,
    location: string,
  ): Promise<{
    markerBytes: Uint8Array;
    identity: Omit<Ext4PhysicalIdentity, 'location_sha256'>;
  }>;
  observePinned?(
    role: StorageRole,
    location: string,
    directory: FileHandle,
  ): ReturnType<PhysicalStorageObserver['observe']>;
}

@Injectable()
export class UnavailablePhysicalStorageObserver implements PhysicalStorageObserver {
  async observe(): Promise<never> {
    throw new Error('Physical identity observation unavailable');
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Storage unavailable');
}

/** Database authority + configuration + two independently observed roles. */
export class StorageBindingVerifier {
  private readonly cwd = process.cwd();

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly observer: PhysicalStorageObserver,
  ) {}

  async assertVerified(pinned?: {
    role: StorageRole;
    directory: FileHandle;
  }): Promise<StorageBinding> {
    try {
      const binding = await this.database.db
        .selectFrom('storage_binding')
        .selectAll()
        .where('singleton', '=', true)
        .executeTakeFirst();
      if (!binding || binding.storage_layout_version !== 1) throw unavailable();
      if (
        binding.storage_id !== this.config.get<string>('STORAGE_ID') ||
        binding.originals_binding_id !==
          this.config.get<string>('STORAGE_ORIGINALS_BINDING_ID') ||
        binding.thumbnails_binding_id !==
          this.config.get<string>('STORAGE_THUMBNAILS_BINDING_ID') ||
        binding.originals_binding_id === binding.thumbnails_binding_id
      )
        throw unavailable();

      for (const role of ['originals', 'thumbnails'] as const) {
        if (
          this.config.get<string>(
            role === 'originals'
              ? 'STORAGE_ORIGINALS_PROFILE'
              : 'STORAGE_THUMBNAILS_PROFILE',
          ) !== 'linux-ext4-v1'
        )
          throw unavailable();
        const location = roleLocation(
          this.config.getOrThrow<string>('STORAGE_ROOT'),
          this.cwd,
          role,
        );
        const observed =
          pinned?.role === role
            ? await this.observer.observePinned?.(
                role,
                location,
                pinned.directory,
              )
            : await this.observer.observe(role, location);
        if (!observed) throw unavailable();
        const marker = parseStorageMarker(observed.markerBytes);
        const expectedBinding =
          role === 'originals'
            ? binding.originals_binding_id
            : binding.thumbnails_binding_id;
        if (
          marker.storage_id !== binding.storage_id ||
          marker.binding_id !== expectedBinding ||
          marker.role !== role ||
          marker.physical_identity.location_sha256 !==
            locationFingerprint(location, role) ||
          marker.physical_identity.format !== observed.identity.format ||
          marker.physical_identity.profile !== observed.identity.profile ||
          marker.physical_identity.filesystem_uuid !==
            observed.identity.filesystem_uuid ||
          marker.physical_identity.directory_handle_type !==
            observed.identity.directory_handle_type ||
          marker.physical_identity.directory_handle_hex !==
            observed.identity.directory_handle_hex
        )
          throw unavailable();
      }
      return binding;
    } catch {
      // Never expose database details, configured paths, handles or marker data.
      throw unavailable();
    }
  }
}
