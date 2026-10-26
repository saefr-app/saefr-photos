import type { Readable } from 'node:stream';
import type { StorageBinding } from './storage-binding.service.js';
import type { StorageRole } from './storage-marker.js';

/** Callers supply an asset identifier and a fixed layout-1 extension, never a path. */
export interface LogicalStorageTarget {
  readonly role: StorageRole;
  readonly assetId: string;
  readonly extension: '.jpg' | '.png' | '.webp';
}

export interface StorageCapabilities {
  readonly bindingObservation: boolean;
  readonly exclusiveStaging: boolean;
  readonly noReplacePublication: boolean;
  readonly regularFileOpen: boolean;
  readonly exactRemoval: boolean;
  readonly authoritativeAbsence: boolean;
  readonly deletionDurability: boolean;
}

export interface PublishedObject {
  readonly target: LogicalStorageTarget;
  readonly attemptId: string;
  readonly byteLength: number;
  /** Opaque, process-local proof that this attempt created the staging link. */
  readonly receiptId: string;
}

export type PublicationOutcome =
  | {
      readonly status: 'published';
      readonly object: PublishedObject;
      readonly durable: true;
    }
  | {
      readonly status: 'collision' | 'too_large' | 'unavailable' | 'uncertain';
      readonly object?: PublishedObject;
      readonly durable: false;
    }
  | {
      /** Source or caller validation failed before publication. Internal only. */
      readonly status: 'input_error';
      readonly error: unknown;
      readonly object?: undefined;
      readonly durable: false;
    }
  | {
      readonly status: 'empty_input';
      readonly object?: undefined;
      readonly durable: false;
    };

export type OpenOutcome =
  | {
      readonly status: 'opened';
      readonly stream: Readable;
      readonly size: number;
    }
  | { readonly status: 'absent' | 'unavailable' | 'uncertain' };

export type PersistenceOutcome =
  | { readonly status: 'durable' }
  | { readonly status: 'unavailable' | 'uncertain' };

export type RemovalOutcome =
  | { readonly status: 'removed' | 'absent'; readonly durable: true }
  | { readonly status: 'unavailable' | 'uncertain'; readonly durable: false };

/**
 * Every operation verifies the binding at operation time. Publication never
 * replaces an existing name and retains any uncertain result for reconciliation.
 * Compensation verifies attempt ownership; a target name or attempt ID alone
 * cannot authorize unlink. Confirmed absence only applies to verified storage.
 * No native adapter is certified yet, so this interface grants no access.
 */
export interface StorageProvider {
  readonly capabilities: StorageCapabilities;
  verifyBinding(): Promise<StorageBinding>;
  publish(
    target: LogicalStorageTarget,
    attemptId: string,
    source: Readable,
    beforePublish?: (bytes: Buffer) => Promise<void>,
  ): Promise<PublicationOutcome>;
  open(target: LogicalStorageTarget): Promise<OpenOutcome>;
  removeExact(target: LogicalStorageTarget): Promise<RemovalOutcome>;
  confirmDirectoryPersistence(role: StorageRole): Promise<PersistenceOutcome>;
  compensateOwned(published: PublishedObject): Promise<RemovalOutcome>;
  releaseOwned(published: PublishedObject): Promise<PersistenceOutcome>;
}
