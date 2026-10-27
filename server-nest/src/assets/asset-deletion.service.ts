import {
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import { LocalStorageProvider } from '../storage/local-storage.provider.js';
import {
  AssetDeletionAcceptanceRepository,
  type PublicDeletionReceipt,
} from './asset-deletion-acceptance.repository.js';
import { AssetDeletionExecutor } from './asset-deletion.executor.js';

export interface DeletionHttpResult {
  code: 200 | 202;
  receipt: PublicDeletionReceipt;
}

@Injectable()
export class AssetDeletionService {
  constructor(
    private readonly acceptance: AssetDeletionAcceptanceRepository,
    private readonly executor: AssetDeletionExecutor,
    private readonly storage: LocalStorageProvider,
  ) {}

  async status(
    actor: AuthenticatedActor,
    assetId: string,
  ): Promise<PublicDeletionReceipt> {
    let receipt: PublicDeletionReceipt | null;
    try {
      receipt = await this.acceptance.findForOwner(assetId, actor.userId);
    } catch {
      throw this.unavailable();
    }
    if (!receipt) throw new NotFoundException('Asset not found');
    return receipt;
  }

  async accept(
    actor: AuthenticatedActor,
    assetId: string,
    ifMatch: string | string[] | undefined,
    signal?: AbortSignal,
  ): Promise<DeletionHttpResult> {
    if (signal?.aborted) throw this.unavailable();
    // An existing journal is authoritative even when the storage is offline.
    let existing: PublicDeletionReceipt | null;
    try {
      existing = await this.acceptance.existing(assetId, actor.userId, ifMatch);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    }
    if (existing) return this.result(existing);
    try {
      await this.acceptance.candidate(assetId, actor.userId, ifMatch);
    } catch (error) {
      // A concurrent acceptance may have removed the asset after the first
      // journal read. Only its owner-scoped committed receipt can resolve it.
      if (error instanceof NotFoundException) {
        let raced: PublicDeletionReceipt | null;
        try {
          raced = await this.acceptance.existing(
            assetId,
            actor.userId,
            ifMatch,
          );
        } catch (lookupError) {
          if (lookupError instanceof HttpException) throw lookupError;
          throw this.unavailable();
        }
        if (raced) return this.result(raced);
      }
      if (!(error instanceof HttpException)) throw this.unavailable();
      throw error;
    }

    const capabilities = this.storage.capabilities;
    if (!(
      capabilities.bindingObservation &&
      capabilities.exactRemoval &&
      capabilities.authoritativeAbsence &&
      capabilities.deletionDurability
    ))
      throw this.unavailable();
    let verified;
    try {
      verified = await this.storage.verifyBinding();
    } catch {
      throw this.unavailable();
    }
    // If the client left during read-only preflight, do not start a new
    // irreversible acceptance. Once acceptance starts, its outcome stands.
    if (signal?.aborted) throw this.unavailable();
    const acceptance = await this.acceptance.accept(
      actor,
      assetId,
      ifMatch,
      verified,
    );
    if (acceptance.status === 'existing')
      return this.result(acceptance.receipt);
    if (acceptance.status === 'not_started') throw this.unavailable();
    if (acceptance.status === 'rolled_back') {
      if (acceptance.error instanceof HttpException) throw acceptance.error;
      throw this.unavailable();
    }
    if (acceptance.status === 'uncertain') {
      // An absent read is never proof of rollback. A matching committed row
      // is the only authority for a later operation.
      try {
        if (!(await this.acceptance.confirmUncertain(acceptance.expected)))
          throw this.unavailable();
      } catch {
        throw this.unavailable();
      }
    }
    return this.executeAndRead(actor, assetId, signal);
  }

  async retry(
    actor: AuthenticatedActor,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<DeletionHttpResult> {
    if (signal?.aborted) throw this.unavailable();
    let existing: PublicDeletionReceipt | null;
    try {
      await this.acceptance.assertCurrentActor(actor);
      existing = await this.acceptance.findForOwner(assetId, actor.userId);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    }
    if (!existing) throw new NotFoundException('Asset not found');
    if (existing.status === 'completed') return this.result(existing);
    return this.executeAndRead(actor, assetId, signal);
  }

  private async executeAndRead(
    actor: AuthenticatedActor,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<DeletionHttpResult> {
    const outcome = await this.executor.execute(assetId, actor.userId, signal);
    if (outcome === 'unavailable' || outcome === 'missing')
      throw this.unavailable();
    let receipt: PublicDeletionReceipt | null;
    try {
      receipt = await this.acceptance.findForOwner(assetId, actor.userId);
    } catch {
      throw this.unavailable();
    }
    if (!receipt) throw this.unavailable();
    if (outcome === 'completed' && receipt.status !== 'completed')
      throw this.unavailable();
    return this.result(receipt);
  }

  private result(receipt: PublicDeletionReceipt): DeletionHttpResult {
    return { code: receipt.status === 'completed' ? 200 : 202, receipt };
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException('Service unavailable');
  }
}
