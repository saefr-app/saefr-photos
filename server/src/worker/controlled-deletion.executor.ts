import { performance } from 'node:perf_hooks';
import { removeJournalFiles } from '../assets/asset-deletion-steps.js';
import type {
  GuardedDeletionProvider,
  ProviderExecutionGuard,
} from '../storage/storage-provider.js';
import type { RecoveryPermitService } from './recovery-permit.service.js';
import type {
  DormantDeletionAdmissionRepository,
  BoundReservation,
} from './dormant-deletion-admission.repository.js';

export type ControlledResult =
  | 'completed'
  | 'known_failure'
  | 'refused'
  | 'stale'
  | 'interrupted'
  | 'database_unknown'
  | 'provider_unknown'
  | 'storage_mismatch'
  | 'permit_denied';

/** DORMANT: explicit construction in synthetic tests only; no Nest/HTTP/consumer wiring. */
export class ControlledDeletionExecutor {
  private active: Promise<ControlledResult> | undefined;
  private closed = false;
  constructor(
    private readonly admission: DormantDeletionAdmissionRepository,
    private readonly permit: RecoveryPermitService,
    private readonly storage: GuardedDeletionProvider,
    private readonly incarnationId: string,
  ) {}

  /** Close admission synchronously. Outstanding calls retain capacity until actual settlement. */
  shutdown(): Promise<void> {
    this.closed = true;
    return this.active ? this.active.then(() => undefined) : Promise.resolve();
  }

  execute(
    input: BoundReservation,
    signal?: AbortSignal,
  ): Promise<ControlledResult> {
    if (
      this.closed ||
      this.active ||
      signal?.aborted ||
      input.incarnationId !== this.incarnationId
    )
      return Promise.resolve('refused');
    const a = Object.freeze({
      ...input,
      journal: Object.freeze({ ...input.journal }),
    });
    const deadline = performance.now() + 30_000;
    // Install capacity before asynchronous guard reads can begin.
    const result = Promise.resolve().then(() => this.run(a, deadline, signal));
    const tracked = result.finally(() => {
      if (this.active === tracked) this.active = undefined;
    });
    this.active = tracked;
    return tracked;
  }

  private async run(
    a: BoundReservation,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ControlledResult> {
    let refusal: ControlledResult | undefined;
    const canDispatch = () => {
      if (this.closed || signal?.aborted || performance.now() >= deadline) {
        refusal ??= 'interrupted';
        return false;
      }
      return !refusal;
    };
    const guard: ProviderExecutionGuard = {
      canDispatch,
      observe: async () => {
        if (!canDispatch()) return false;
        try {
          // Independent confirmation, never a reservation/claim renewal.
          const first = await this.admission.confirm(a, a);
          if (first.status !== 'applied') {
            refusal =
              first.status === 'uncertain' ? 'database_unknown' : 'stale';
            return false;
          }
          const b = await this.storage.verifyBinding();
          if (
            b.storage_id !== a.journal.storage_id ||
            b.originals_binding_id !== a.journal.originals_binding_id ||
            b.thumbnails_binding_id !== a.journal.thumbnails_binding_id ||
            b.storage_layout_version !== a.journal.storage_layout_version
          ) {
            refusal = 'storage_mismatch';
            return false;
          }
        } catch {
          refusal = 'storage_mismatch';
          return false;
        }
        // Real B.2 service: re-read the expected generation after external waits.
        const permit = await this.permit.check(a.permitGeneration);
        if (!permit.allowed || permit.generation !== a.permitGeneration) {
          refusal = 'permit_denied';
          return false;
        }
        const last = await this.admission.confirm(a, a);
        if (last.status !== 'applied') {
          refusal = last.status === 'uncertain' ? 'database_unknown' : 'stale';
          return false;
        }
        return canDispatch();
      },
    };
    const block = async (
      fallback: ControlledResult,
    ): Promise<ControlledResult> => {
      // Refusal/uncertainty closes this local executor permanently. A failed
      // block acknowledgement must never permit replay through this instance.
      // Later activation needs a new incarnation plus B.4.3 clearance, not reset().
      this.closed = true;
      const reason = refusal ?? fallback;
      try {
        await this.admission.block(
          a,
          reason === 'permit_denied'
            ? 'permit_changed'
            : reason === 'storage_mismatch'
              ? 'storage_identity_mismatch'
              : reason === 'provider_unknown'
                ? 'provider_unknown'
                : 'quiescence_unknown',
        );
      } catch {
        return 'database_unknown';
      }
      return reason;
    };
    try {
      const c = this.storage.capabilities;
      if (
        !c.bindingObservation ||
        !c.exactRemoval ||
        !c.authoritativeAbsence ||
        !c.deletionDurability
      )
        return block('refused');
      if (!(await guard.observe())) return block('refused');
      const stopped = await removeJournalFiles<ControlledResult>({
        remove: async (role) => {
          if (!(await guard.observe())) return block('refused');
          const outcome = await this.storage.removeExactGuarded(
            {
              role,
              assetId: a.journal.asset_id,
              extension:
                role === 'originals'
                  ? (a.journal.original_extension as '.jpg' | '.png' | '.webp')
                  : '.jpg',
            },
            a.journal,
            guard,
          );
          if (refusal) return block('refused');
          if (outcome.durable) return;
          if (outcome.status === 'uncertain') return block('provider_unknown');
          if (!(await guard.observe())) return block('refused');
          // This provider call positively settled with a known pre-unlink failure.
          const settled = await this.admission.settle(a, {
            ioDrained: true,
            outcome: 'known_failure',
          });
          return settled.status === 'applied'
            ? 'known_failure'
            : block('database_unknown');
        },
        persist: async (role) => {
          if (!(await guard.observe())) return block('refused');
          const result = await this.storage.confirmDirectoryPersistenceGuarded(
            role,
            a.journal,
            guard,
          );
          if (refusal) return block('refused');
          if (result.status !== 'durable') return block('provider_unknown');
        },
      });
      if (stopped !== undefined) return stopped;
      if (!(await guard.observe())) return block('refused');
      const settled = await this.admission.settle(a, {
        ioDrained: true,
        outcome: 'removed',
      });
      return settled.status === 'applied'
        ? 'completed'
        : block('database_unknown');
    } catch {
      return block('provider_unknown');
    }
  }
}
