import type { MaintenanceRetryRepository } from './maintenance-retry.repository.js';
import {
  MaintenanceReconciliationRepository,
  reconciliationPageLimit,
  type CoordinatorOwner,
} from './maintenance-reconciliation.repository.js';

export interface SyntheticReconciliationAuthorization {
  purpose: 'synthetic-metadata-only';
}

export interface ReconciliationProgress {
  status:
    'page' | 'complete' | 'denied' | 'stale' | 'uncertain' | 'deferred_lock';
  checkpointed: number;
  deferred: number;
}

/** Test-only composition until a separately reviewed live permit/runtime adapter exists. */
export class MaintenanceReconciliationService {
  private readonly pageLimit: number;

  constructor(
    private readonly coordinator: MaintenanceReconciliationRepository,
    private readonly retry: Pick<MaintenanceRetryRepository, 'discover'>,
    pageLimit = 100,
  ) {
    this.pageLimit = reconciliationPageLimit(pageLimit);
  }

  async reconcilePage(
    owner: CoordinatorOwner,
    authorization?: SyntheticReconciliationAuthorization,
  ): Promise<ReconciliationProgress> {
    const progress: ReconciliationProgress = {
      status: 'denied',
      checkpointed: 0,
      deferred: 0,
    };
    if (authorization?.purpose !== 'synthetic-metadata-only') return progress;
    const pass = await this.coordinator.beginOrResume(owner);
    if (pass.status !== 'ok')
      return { ...progress, status: this.failure(pass.status) };
    let current = pass.value;
    if (current.pass_status === 'complete')
      return { ...progress, status: 'complete' };
    const page = await this.coordinator.page(owner, current, this.pageLimit);
    if (page.status !== 'ok')
      return { ...progress, status: this.failure(page.status) };
    for (const key of page.value) {
      let observed = await this.coordinator.inspectReceipt(owner, key.assetId);
      if (observed.status === 'ok' && observed.value === 'discover') {
        // Idempotent passive discovery can finish after lease loss; it cannot
        // reserve, spend a budget or advance progress. The following fence is mandatory.
        const discovery = await this.retry.discover(key.assetId);
        if (discovery === 'uncertain')
          return { ...progress, status: 'uncertain' };
        observed = await this.coordinator.inspectReceipt(owner, key.assetId);
      }
      if (observed.status === 'ok' && observed.value === 'discover')
        return { ...progress, status: 'uncertain' };
      if (observed.status !== 'ok' && observed.status !== 'deferred_lock')
        return { ...progress, status: this.failure(observed.status) };
      // A positively identified lock-timeout rollback is a safe deferral to
      // the next finite pass, not a claim that discovery succeeded.
      if (
        observed.status === 'deferred_lock' ||
        (observed.status === 'ok' && observed.value === 'inconsistent')
      )
        progress.deferred++;
      const advanced = await this.coordinator.advance(owner, current, key);
      if (advanced.status !== 'ok')
        return { ...progress, status: this.failure(advanced.status) };
      current = advanced.value;
      progress.checkpointed++;
    }
    if (page.value.length !== 0) return { ...progress, status: 'page' };
    const completed = await this.coordinator.complete(owner, current);
    return {
      ...progress,
      status:
        completed.status === 'ok' ? 'complete' : this.failure(completed.status),
    };
  }

  /** Caller keeps this independent sweep cursor; lost progress simply replays it. */
  async sweepCompleted(
    owner: CoordinatorOwner,
    afterId: string | null,
    authorization?: SyntheticReconciliationAuthorization,
  ): Promise<{
    status: ReconciliationProgress['status'];
    cursor: string | null;
    closed: number;
    retained: number;
  }> {
    const progress = {
      status: 'denied' as ReconciliationProgress['status'],
      cursor: afterId,
      closed: 0,
      retained: 0,
    };
    if (authorization?.purpose !== 'synthetic-metadata-only') return progress;
    const page = await this.coordinator.sweepPage(
      owner,
      afterId,
      this.pageLimit,
    );
    if (page.status !== 'ok')
      return { ...progress, status: this.failure(page.status) };
    for (const assetId of page.value) {
      const closed = await this.coordinator.closePassiveCompleted(
        owner,
        assetId,
      );
      if (closed.status !== 'ok' && closed.status !== 'deferred_lock')
        return { ...progress, status: this.failure(closed.status) };
      if (closed.status === 'ok' && closed.value === 'closed')
        progress.closed++;
      if (
        closed.status === 'deferred_lock' ||
        (closed.status === 'ok' && closed.value === 'evidence_preserved')
      )
        progress.retained++;
      progress.cursor = assetId;
    }
    return {
      ...progress,
      status: page.value.length === 0 ? 'complete' : 'page',
      cursor: page.value.length === 0 ? null : progress.cursor,
    };
  }

  private failure(
    status: 'stale' | 'busy' | 'overflow' | 'deferred_lock' | 'uncertain',
  ): ReconciliationProgress['status'] {
    if (status === 'deferred_lock' || status === 'uncertain') return status;
    return 'stale';
  }
}
