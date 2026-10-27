import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';

import {
  AssetDeletionRepository,
  type DeletionErrorCode,
  type ExecutionAuthority,
} from './asset-deletion.repository.js';
import { LocalStorageProvider } from '../storage/local-storage.provider.js';
import type { StorageBinding } from '../storage/storage-binding.service.js';

export type DeletionExecutionResult =
  'completed' | 'pending' | 'missing' | 'unavailable';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSIONS = new Set(['.jpg', '.png', '.webp']);
const MAX_ACTIVE = 2;
const START_BUDGET_MS = 30_000;

function matchesAuthority(
  receipt: ExecutionAuthority,
  binding: StorageBinding,
): boolean {
  return (
    UUID.test(receipt.asset_id) &&
    UUID.test(receipt.owner_id) &&
    UUID.test(receipt.storage_id) &&
    UUID.test(receipt.originals_binding_id) &&
    UUID.test(receipt.thumbnails_binding_id) &&
    receipt.originals_binding_id !== receipt.thumbnails_binding_id &&
    receipt.storage_layout_version === 1 &&
    EXTENSIONS.has(receipt.original_extension) &&
    /^(0|[1-9][0-9]*)$/.test(receipt.accepted_lifecycle_version) &&
    Number.isFinite(receipt.requested_at.getTime()) &&
    typeof receipt.requested_at_exact === 'string' &&
    receipt.storage_id === binding.storage_id &&
    receipt.originals_binding_id === binding.originals_binding_id &&
    receipt.thumbnails_binding_id === binding.thumbnails_binding_id &&
    binding.storage_layout_version === 1
  );
}

/**
 * Executes only a committed journal target. This is deliberately not an HTTP
 * handler: a future request or M13 worker supplies an operation ID and owner,
 * never a path, binding, extension or authority from a queue message.
 */
@Injectable()
export class AssetDeletionExecutor {
  private active = 0;

  constructor(
    private readonly journal: AssetDeletionRepository,
    private readonly storage: LocalStorageProvider,
  ) {}

  async execute(
    assetId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<DeletionExecutionResult> {
    if (!UUID.test(assetId) || !UUID.test(ownerId)) return 'missing';
    if (this.active >= MAX_ACTIVE) return 'pending';
    this.active++;
    const deadline = performance.now() + START_BUDGET_MS;
    try {
      return await this.executeInSlot(assetId, ownerId, deadline, signal);
    } catch {
      // Raw SQL, storage paths and provider errors never become diagnostics.
      return 'unavailable';
    } finally {
      // Every issued provider promise is awaited before this slot is released.
      this.active--;
    }
  }

  private async executeInSlot(
    assetId: string,
    ownerId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<DeletionExecutionResult> {
    const receipt = await this.journal.findExecutionAuthority(assetId, ownerId);
    if (!receipt) return 'missing';
    if (receipt.completed_at) return 'completed';
    if (!this.canStart(deadline, signal)) return 'pending';
    if (!this.supported() || !(await this.verify(receipt)))
      return 'unavailable';
    if (!this.canStart(deadline, signal)) return 'pending';

    const claim = await this.journal.claim(assetId, ownerId);
    if (claim.status !== 'claimed') {
      if (claim.status === 'missing') return 'missing';
      if (claim.status === 'completed') return 'completed';
      if (claim.status === 'inconsistent') return 'unavailable';
      return 'pending';
    }
    const token = claim.token;

    // A successful UPDATE acknowledgement is supplemented by a fresh read;
    // claim() itself independently confirms a lost acknowledgement.
    try {
      if (!this.canStart(deadline, signal)) return 'pending';
      if (!(await this.journal.confirmClaim(assetId, ownerId, token)))
        return 'pending';
      if (!this.canStart(deadline, signal)) return 'pending';
      const current = await this.journal.findExecutionAuthority(
        assetId,
        ownerId,
      );
      if (
        !current ||
        !sameTarget(receipt, current) ||
        !(await this.verify(current))
      )
        return this.fail(assetId, ownerId, token, 'storage_identity_mismatch');
      if (!this.canStart(deadline, signal)) return 'pending';

      for (const role of ['originals', 'thumbnails'] as const) {
        if (
          !(await this.mayContinue(assetId, ownerId, token, deadline, signal))
        )
          return 'pending';
        if (!(await this.authorityStillMatches(current)))
          return this.fail(
            assetId,
            ownerId,
            token,
            'storage_identity_mismatch',
          );
        // No await may separate this check from the provider dispatch.
        if (!this.canStart(deadline, signal)) return 'pending';

        const outcome = await this.storage.removeExact(
          {
            role,
            assetId: current.asset_id,
            extension:
              role === 'originals'
                ? (current.original_extension as '.jpg' | '.png' | '.webp')
                : '.jpg',
          },
          current,
        );
        if (!outcome.durable)
          return this.fail(
            assetId,
            ownerId,
            token,
            outcome.status === 'uncertain'
              ? 'unknown_outcome'
              : 'storage_unavailable',
          );

        // The provider fsyncs the pinned directory before returning. Confirm
        // persistence again under the same role's verified binding.
        if (
          !(await this.mayContinue(assetId, ownerId, token, deadline, signal))
        )
          return 'pending';
        if (!this.canStart(deadline, signal)) return 'pending';
        const persistence = await this.storage.confirmDirectoryPersistence(
          role,
          current,
        );
        if (persistence.status !== 'durable')
          return this.fail(assetId, ownerId, token, 'durability_unavailable');
      }

      if (!(await this.mayContinue(assetId, ownerId, token, deadline, signal)))
        return 'pending';
      if (!(await this.authorityStillMatches(current)))
        return this.fail(assetId, ownerId, token, 'storage_identity_mismatch');
      try {
        if (
          await this.journal.completeAfterVerifiedRemoval(
            assetId,
            ownerId,
            token,
          )
        )
          return 'completed';
      } catch {
        // A lost COMMIT acknowledgement is not evidence of failure or success.
      }
      const after = await this.journal.findExecutionAuthority(assetId, ownerId);
      return after?.completed_at && sameTarget(current, after)
        ? 'completed'
        : 'pending';
    } catch {
      // Do not start more I/O after a lost database connection or uncertain
      // provider result. The current provider promise has already drained.
      return this.fail(assetId, ownerId, token, 'unknown_outcome');
    }
  }

  private supported(): boolean {
    const capabilities = this.storage.capabilities;
    return (
      capabilities.bindingObservation &&
      capabilities.exactRemoval &&
      capabilities.authoritativeAbsence &&
      capabilities.deletionDurability
    );
  }

  private async verify(receipt: ExecutionAuthority): Promise<boolean> {
    try {
      return matchesAuthority(receipt, await this.storage.verifyBinding());
    } catch {
      return false;
    }
  }

  private async authorityStillMatches(
    receipt: ExecutionAuthority,
  ): Promise<boolean> {
    const fresh = await this.journal.findExecutionAuthority(
      receipt.asset_id,
      receipt.owner_id,
    );
    return (
      !!fresh &&
      !fresh.completed_at &&
      sameTarget(receipt, fresh) &&
      this.verify(fresh)
    );
  }

  private async mayContinue(
    assetId: string,
    ownerId: string,
    token: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.canStart(deadline, signal)) return false;
    // This short transaction checks PostgreSQL time after any row-lock wait.
    const renewed = await this.journal.renew(assetId, ownerId, token);
    return renewed && this.canStart(deadline, signal);
  }

  private canStart(deadline: number, signal?: AbortSignal): boolean {
    return !signal?.aborted && performance.now() < deadline;
  }

  private async fail(
    assetId: string,
    ownerId: string,
    token: string,
    code: DeletionErrorCode,
  ): Promise<'pending'> {
    try {
      await this.journal.recordFailure(assetId, ownerId, token, code);
    } catch {
      // Best effort only. An unresolved claim expires for explicit retry.
    }
    return 'pending';
  }
}

function sameTarget(
  left: ExecutionAuthority,
  right: ExecutionAuthority,
): boolean {
  return (
    left.asset_id === right.asset_id &&
    left.owner_id === right.owner_id &&
    left.accepted_lifecycle_version === right.accepted_lifecycle_version &&
    left.storage_id === right.storage_id &&
    left.originals_binding_id === right.originals_binding_id &&
    left.thumbnails_binding_id === right.thumbnails_binding_id &&
    left.storage_layout_version === right.storage_layout_version &&
    left.original_extension === right.original_extension &&
    left.requested_at_exact === right.requested_at_exact
  );
}
