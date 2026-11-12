import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { MaintenanceConfig } from './maintenance-config.js';
import type {
  MaintenanceReconciliationRepository,
  CoordinatorOwner,
} from './maintenance-reconciliation.repository.js';
import type { MaintenanceRecoveryAuthorization } from './maintenance-recovery-authorization.js';
import type { MaintenanceRecoveryService } from './maintenance-recovery.service.js';

/** Metadata only. No consumer, producer, reservation, clearance or executor is owned here. */
export class MaintenanceRuntime {
  private owner?: CoordinatorOwner;
  private pendingToken?: string;
  private permitGeneration?: string;
  private tickTask?: Promise<void>;
  private renewalTask?: Promise<void>;
  private tickTimer?: NodeJS.Timeout;
  private renewTimer?: NodeJS.Timeout;
  private deadline = 0;
  private stopping = false;
  private started = false;
  private stopTask?: Promise<boolean>;
  private sweepCursor: string | null = null;
  private status:
    | 'stopped'
    | 'idle'
    | 'ready'
    | 'blocked'
    | 'degraded'
    | 'stopping'
    | 'incomplete' = 'stopped';
  private pages = 0;
  private renewals = 0;
  private lastLog = -Infinity;

  constructor(
    private readonly config: MaintenanceConfig,
    private readonly coordinator: Pick<
      MaintenanceReconciliationRepository,
      'acquire' | 'read' | 'renew'
    >,
    private readonly authorization: Pick<
      MaintenanceRecoveryAuthorization,
      'observe'
    >,
    private readonly recovery: Pick<
      MaintenanceRecoveryService,
      'reconcilePage' | 'sweepCompleted'
    >,
    private readonly closeResources: () => Promise<void> = async () =>
      undefined,
  ) {}

  diagnostics() {
    // No receipt IDs, ownership tokens, permit generations, paths or driver errors.
    return {
      state: this.status,
      pages: this.pages,
      renewals: this.renewals,
      tickActive: !!this.tickTask,
      renewalActive: !!this.renewalTask,
      ownsCoordinator: !!this.owner,
    };
  }

  start(): void {
    if (this.started || this.stopping)
      throw new Error('Maintenance runtime already started or stopping');
    this.started = true;
    if (!this.config.enabled) return;
    this.status = 'idle';
    // Scheduling is independent of Redis and of the longer reconciliation cadence.
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
    this.renewTimer = setInterval(() => {
      void this.renew();
    }, this.config.renewMs);
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.stopping || !this.config.enabled || this.tickTask)
      return this.tickTask ?? Promise.resolve();
    this.deadline = performance.now() + this.config.budgetMs;
    this.tickTask = this.runTick()
      .catch(() => this.degrade())
      .finally(() => {
        this.tickTask = undefined;
      });
    return this.tickTask;
  }

  private async runTick(): Promise<void> {
    const decision = await this.authorization.observe();
    if (this.stopping) return;
    if (!decision.allowed) {
      this.owner = undefined;
      this.status =
        decision.reason === 'pairing_unavailable' ||
        decision.reason === 'permit_unavailable'
          ? 'degraded'
          : 'blocked';
      return;
    }
    if (!this.open()) {
      this.degrade();
      return;
    }
    if (this.permitGeneration && this.permitGeneration !== decision.generation)
      this.owner = undefined;
    this.permitGeneration = decision.generation;
    // Confirmation precedes any reuse after an unknown acquisition/renewal COMMIT.
    if (this.pendingToken) {
      const row = await this.coordinator.read();
      if (!this.open()) return;
      const token = this.pendingToken;
      this.pendingToken = undefined;
      if (row.leader_token === token && row.lease_live)
        this.owner = { token, epoch: row.leader_epoch };
    }
    if (!this.owner) {
      const token = randomUUID();
      this.pendingToken = token;
      const acquired = await this.coordinator.acquire(token);
      if (!this.open()) return;
      if (acquired.status !== 'ok') {
        if (acquired.status !== 'uncertain') this.pendingToken = undefined;
        this.status = acquired.status === 'busy' ? 'idle' : 'degraded';
        return;
      }
      this.pendingToken = undefined;
      this.owner = acquired.value;
    }
    const owner = this.owner;
    const continuing = () => this.open() && this.owner === owner;
    const result = await this.recovery.reconcilePage(
      owner,
      decision.generation,
      { continue: continuing, delivery: false },
    );
    if (!continuing()) return;
    if (result.status !== 'page' && result.status !== 'complete') {
      this.owner = undefined;
      this.status = result.status === 'denied' ? 'blocked' : 'degraded';
      return;
    }
    this.pages++;
    const sweep = await this.recovery.sweepCompleted(
      owner,
      decision.generation,
      this.sweepCursor,
      continuing,
    );
    if (!continuing()) return;
    if (sweep.status !== 'page' && sweep.status !== 'complete') {
      this.owner = undefined;
      this.status = sweep.status === 'denied' ? 'blocked' : 'degraded';
      return;
    }
    this.sweepCursor = sweep.cursor;
    this.status = 'ready';
  }

  renew(): Promise<void> {
    if (this.stopping || !this.owner || this.renewalTask)
      return this.renewalTask ?? Promise.resolve();
    // Do not sustain a hung control operation indefinitely.
    if (this.tickTask && !this.open()) {
      this.degrade();
      return Promise.resolve();
    }
    const owner = this.owner;
    this.renewalTask = (async () => {
      const decision = await this.authorization.observe();
      if (this.stopping || this.owner !== owner) return;
      if (!decision.allowed || decision.generation !== this.permitGeneration) {
        this.owner = undefined;
        this.status =
          !decision.allowed &&
          (decision.reason === 'pairing_unavailable' ||
            decision.reason === 'permit_unavailable')
            ? 'degraded'
            : 'blocked';
        return;
      }
      const renewed = await this.coordinator.renew(owner);
      if (this.stopping || this.owner !== owner) return;
      if (renewed.status === 'ok') this.renewals++;
      else {
        if (renewed.status === 'uncertain') this.pendingToken = owner.token;
        this.degrade();
      }
    })()
      .catch(() => this.degrade())
      .finally(() => {
        this.renewalTask = undefined;
      });
    return this.renewalTask;
  }

  requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.owner = undefined;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.status = 'stopping';
  }

  stop(): Promise<boolean> {
    if (this.stopTask) return this.stopTask;
    this.requestStop();
    // Never release or clear the database lease; database-clock expiry handles metadata leadership.
    this.stopTask = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const drain = (async () => {
        await Promise.allSettled([this.tickTask, this.renewalTask]);
        await this.closeResources();
      })();
      try {
        await Promise.race([
          drain,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Maintenance shutdown incomplete')),
              this.config.shutdownMs,
            );
          }),
        ]);
        this.status = 'stopped';
        return true;
      } catch {
        this.status = 'incomplete';
        return false;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.stopTask;
  }

  async onModuleDestroy(): Promise<void> {
    if (!(await this.stop()))
      throw new Error('Maintenance shutdown incomplete');
  }

  private open() {
    return !this.stopping && performance.now() < this.deadline;
  }
  private degrade() {
    this.owner = undefined;
    if (this.stopping) return;
    this.status = 'degraded';
    if (performance.now() - this.lastLog >= 60000) {
      console.error('Maintenance metadata reconciliation degraded');
      this.lastLog = performance.now();
    }
  }
}
