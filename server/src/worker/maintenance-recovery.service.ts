import type { MaintenanceRetryRepository } from './maintenance-retry.repository.js';
import {
  MaintenanceReconciliationRepository,
  reconciliationPageLimit,
  type CoordinatorOwner,
} from './maintenance-reconciliation.repository.js';
import { MaintenanceDeliveryRepository } from './maintenance-delivery.repository.js';
import { MaintenanceRecoveryAuthorization } from './maintenance-recovery-authorization.js';
import type { RedisRecoveryDelivery } from './redis-recovery-delivery.js';
import {
  parseRecoveryHint,
  type RecoveryHint,
} from './recovery-delivery-contract.js';

export type RecoveryDeliveryStatus =
  'queued' | 'pending' | 'denied' | 'stale' | 'conflict' | 'uncertain';

export interface RecoveryPageControl {
  continue: () => boolean;
  delivery: boolean;
}

/** Permit-gated metadata/delivery orchestration; no reservation or executor dependency. */
export class MaintenanceRecoveryService {
  private readonly limit: number;
  constructor(
    private readonly coordinator: MaintenanceReconciliationRepository,
    private readonly retry: Pick<
      MaintenanceRetryRepository,
      'discover' | 'read'
    >,
    private readonly database: MaintenanceDeliveryRepository,
    private readonly authorization: MaintenanceRecoveryAuthorization,
    private readonly redis: Pick<RedisRecoveryDelivery, 'inspect' | 'enqueue'>,
    limit = 100,
  ) {
    this.limit = reconciliationPageLimit(limit);
  }

  /** This observation is not an execution capability; B.4 must enforce each I/O boundary. */
  async checkHint(
    owner: CoordinatorOwner,
    hint: RecoveryHint,
    permitGeneration: string,
  ): Promise<boolean> {
    parseRecoveryHint(hint);
    if (!(await this.authorization.allowed(permitGeneration))) return false;
    const current = await this.database.inspect(owner, hint);
    return (
      current.status === 'ok' &&
      current.value.eligible &&
      (await this.authorization.allowed(permitGeneration))
    );
  }

  async deliver(
    owner: CoordinatorOwner,
    hint: RecoveryHint,
    permitGeneration: string,
    continuing: () => boolean = () => true,
    databaseUnknown: () => void = () => undefined,
  ): Promise<RecoveryDeliveryStatus> {
    parseRecoveryHint(hint);
    if (!(await this.allowed(permitGeneration, continuing))) return 'denied';
    const observation = await this.database.inspect(owner, hint);
    if (observation.status !== 'ok') {
      if (observation.status === 'uncertain') databaseUnknown();
      return observation.status === 'stale' ? 'stale' : 'uncertain';
    }
    if (!observation.value.eligible) return 'pending';
    if (!continuing()) return 'denied';
    const inspected = await this.redis.inspect(hint);
    if (inspected.status === 'uncertain' || inspected.status === 'conflict')
      return inspected.status;
    if (!(await this.allowed(permitGeneration, continuing))) return 'denied';
    if (inspected.status === 'terminal') {
      const replacement = await this.database.replaceTerminal(
        owner,
        observation.value,
      );
      if (replacement.status !== 'ok') {
        if (replacement.status === 'uncertain') databaseUnknown();
        return replacement.status === 'stale' ? 'stale' : 'uncertain';
      }
      hint = replacement.value; // Only a positively committed generation can be enqueued.
    }
    // Revalidate after Redis waits and any replacement transaction.
    if (!(await this.allowed(permitGeneration, continuing))) return 'denied';
    const checked = await this.database.inspect(owner, hint);
    if (checked.status === 'uncertain') databaseUnknown();
    if (
      checked.status !== 'ok' ||
      !checked.value.eligible ||
      !(await this.allowed(permitGeneration, continuing))
    )
      return 'denied';
    const result = await this.redis.enqueue(hint);
    if (!(await this.allowed(permitGeneration, continuing))) return 'uncertain';
    if (result.status === 'queued') return 'queued';
    if (result.status === 'terminal' || result.status === 'missing')
      return 'pending';
    return result.status;
  }

  /** Redis failure permits progress; unresolved PostgreSQL mutations do not. */
  async reconcilePage(
    owner: CoordinatorOwner,
    permitGeneration: string,
    control: RecoveryPageControl = { continue: () => true, delivery: true },
  ): Promise<{
    status: 'page' | 'complete' | 'denied' | 'stale' | 'uncertain';
    checkpointed: number;
    delivered: number;
    deferred: number;
  }> {
    const result = { checkpointed: 0, delivered: 0, deferred: 0 };
    if (!(await this.allowed(permitGeneration, control.continue)))
      return { ...result, status: 'denied' };
    const pass = await this.coordinator.beginOrResume(owner);
    if (pass.status !== 'ok') return { ...result, status: 'uncertain' };
    let cursor = pass.value;
    if (cursor.pass_status === 'complete')
      return { ...result, status: 'complete' };
    if (!(await this.allowed(permitGeneration, control.continue)))
      return { ...result, status: 'denied' };
    const page = await this.coordinator.page(owner, cursor, this.limit);
    if (page.status !== 'ok')
      return {
        ...result,
        status: page.status === 'stale' ? 'stale' : 'uncertain',
      };
    for (const key of page.value) {
      if (!(await this.allowed(permitGeneration, control.continue)))
        return { ...result, status: 'denied' };
      let observed = await this.coordinator.inspectReceipt(owner, key.assetId);
      if (observed.status === 'ok' && observed.value === 'discover') {
        if (!(await this.allowed(permitGeneration, control.continue)))
          return { ...result, status: 'denied' };
        const discovered = await this.coordinator.discoverFenced(
          owner,
          key.assetId,
        );
        if (discovered.status === 'deferred_lock') {
          // Confirmed transaction abort: revisit next finite pass, never claim discovery.
          observed = { status: 'deferred_lock' };
        } else {
          if (discovered.status !== 'ok')
            return {
              ...result,
              status: discovered.status === 'stale' ? 'stale' : 'uncertain',
            };
          if (!control.continue()) return { ...result, status: 'denied' };
          observed = await this.coordinator.inspectReceipt(owner, key.assetId);
        }
      }
      if (observed.status !== 'ok' && observed.status !== 'deferred_lock')
        return { ...result, status: 'uncertain' };
      if (observed.status === 'ok' && observed.value === 'discover')
        return { ...result, status: 'uncertain' };
      if (!(await this.allowed(permitGeneration, control.continue)))
        return { ...result, status: 'denied' };
      if (
        observed.status === 'ok' &&
        observed.value === 'established' &&
        control.delivery
      ) {
        try {
          const row = await this.retry.read(key.assetId);
          if (!row) return { ...result, status: 'uncertain' };
          let unknown = false;
          const delivered = await this.deliver(
            owner,
            { version: 1, asset_id: key.assetId, generation: row.generation },
            permitGeneration,
            control.continue,
            () => {
              unknown = true;
            },
          );
          if (unknown) return { ...result, status: 'uncertain' };
          if (delivered === 'denied') return { ...result, status: 'denied' };
          if (delivered === 'stale') return { ...result, status: 'stale' };
          if (delivered === 'queued') result.delivered++;
          else result.deferred++;
        } catch {
          return { ...result, status: 'uncertain' };
        }
      } else if (
        observed.status === 'deferred_lock' ||
        (observed.status === 'ok' && observed.value !== 'established')
      ) {
        result.deferred++;
      }
      if (!(await this.allowed(permitGeneration, control.continue)))
        return { ...result, status: 'denied' };
      const advanced = await this.coordinator.advance(owner, cursor, key);
      if (advanced.status !== 'ok')
        return {
          ...result,
          status: advanced.status === 'stale' ? 'stale' : 'uncertain',
        };
      cursor = advanced.value;
      result.checkpointed++;
    }
    if (page.value.length) return { ...result, status: 'page' };
    if (!(await this.allowed(permitGeneration, control.continue)))
      return { ...result, status: 'denied' };
    const complete = await this.coordinator.complete(owner, cursor);
    return {
      ...result,
      status: complete.status === 'ok' ? 'complete' : 'uncertain',
    };
  }
  async sweepCompleted(
    owner: CoordinatorOwner,
    permitGeneration: string,
    afterId: string | null,
    continuing: () => boolean = () => true,
  ) {
    const result = {
      status: 'denied' as
        'page' | 'complete' | 'denied' | 'uncertain' | 'stale',
      cursor: afterId,
      closed: 0,
    };
    if (!(await this.allowed(permitGeneration, continuing))) return result;
    const page = await this.coordinator.sweepPage(owner, afterId, this.limit);
    if (page.status !== 'ok')
      return {
        ...result,
        status:
          page.status === 'stale' ? ('stale' as const) : ('uncertain' as const),
      };
    for (const assetId of page.value) {
      if (!(await this.allowed(permitGeneration, continuing))) return result;
      const closed = await this.coordinator.closePassiveCompleted(
        owner,
        assetId,
      );
      if (closed.status !== 'ok' && closed.status !== 'deferred_lock')
        return {
          ...result,
          status:
            closed.status === 'stale'
              ? ('stale' as const)
              : ('uncertain' as const),
        };
      if (closed.status === 'ok' && closed.value === 'closed') result.closed++;
      result.cursor = assetId;
    }
    return {
      ...result,
      status: page.value.length ? ('page' as const) : ('complete' as const),
      cursor: page.value.length ? result.cursor : null,
    };
  }

  private async allowed(generation: string, continuing: () => boolean) {
    return (
      continuing() &&
      (await this.authorization.allowed(generation)) &&
      continuing()
    );
  }
}
