# Milestone 13B.3 — Slice 2: durable reconciliation coordinator

- **Status:** Implemented and locally verified; uncommitted and awaiting independent review. No self-approval or later-slice authorization is implied.
- **Branch/base:** `feat/m13b3-runtime-reconciliation` at `8ef39c835fa0c18a31cfe63a6ae63b645427f201`.
- **Date:** 2026-10-30.
- **Authority:** Maintainer's Slice 2 implementation authorization, approved M13 v3 SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`, immutable B.1 schema and merged B.2 permit contract. The historical proposal wording of the hash-verified planning document was not rewritten.
- **Slice 1 baseline:** The four files in the independently reviewed 56,821-byte patch remain unchanged; SHA-256 `1bafa8f93a4b4aa4fa3a02240f9929f9477f95dda5b0e5857312121c91ed0500`. See the [Slice 1 report](milestone-13b3-slice1-report.md).

## Files and boundaries

| New Slice 2 file                                               | Purpose                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `server/src/worker/maintenance-reconciliation.repository.ts`   | Singleton lease, exact finite-pass keys, fenced progress, receipt inspection and conservative completion sweep. |
| `server/src/worker/maintenance-reconciliation.service.ts`      | Bounded passive metadata reconciliation using Slice 1 discovery; explicit synthetic authorization only.         |
| `server/src/worker/maintenance-reconciliation.service.spec.ts` | Page-limit validation, default denial and uncertain-pass orchestration tests.                                   |
| `server/test/maintenance-reconciliation.integration-spec.ts`   | Real disposable PostgreSQL transactions, independent pools/processes, restart and failure cases.                |
| `docs/development/milestone-13b3-slice2-report.md`             | Implementation and verification evidence.                                                                       |

No historical migration, inspector, database type, production composition, dependency, Redis handler, permit implementation, authentication or M12 journal implementation changed. No new schema is required. Both new classes are unregistered, with no timer, runtime entrypoint, Redis client, executor or storage-provider dependency. A service invocation without explicit `synthetic-metadata-only` authorization performs no database operation. This synthetic test contract is not a live recovery permit; production integration remains gated by the [B.2 recovery-permit contract](recovery-permit.md).

## Coordinator and transaction protocol

Acquisition locks the singleton and advances its bigint epoch, installing a caller-supplied fresh UUID and a 60-second PostgreSQL-clock lease. Expired identities cannot renew or be reused for acquisition; overflow refuses acquisition. Renewal checks both token and epoch after acquiring the row lock, then rechecks database time in the update. An unknown acquisition outcome must be independently confirmed against the caller's retained token before using ownership.

Each coordinator transaction explicitly uses `READ COMMITTED`, `SET LOCAL synchronous_commit TO on`, a one-second lock timeout and a five-second statement timeout. The existing supplied PostgreSQL pools bound connection acquisition to five seconds. No transaction holds a connection across Redis, permit-file, storage I/O, periodic sleeps or per-receipt service calls.

Control transactions lock only the singleton. Their journal scans are ordinary MVCC reads and acquire no journal or retry row locks. Receipt inspection and passive closure lock **journal first → retry row second → singleton SHARE fence last**, then evaluate ownership. The original Slice 1 discovery uses its unchanged journal-first transaction. A passive idempotent discovery already in flight may finish after lease loss; it cannot consume an attempt or move the coordinator cursor. The service rechecks ownership and receipt evidence afterward. No path locks the singleton and then acquires journal/retry row locks, avoiding that wait cycle.

The SQLSTATE `55P03` lock timeout aborts the transaction before COMMIT and is returned as an explicit safe deferral. Other errors, including lost COMMIT acknowledgements, remain `uncertain`; the service stops without advancing dependent progress. No negative read or unavailable connection is treated as proof of rollback. A subsequent invocation reads the persisted pass and replays idempotently; a committed unknown checkpoint is observable through a separate exact snapshot. Mutation results are acknowledged only after the transaction promise confirms COMMIT.

## Finite passes, fairness and exact keys

A new pass captures the greatest **actual** pending `(requested_at, asset_id)` tuple using descending tuple order and `LIMIT 1`, never independent maxima. It persists a UUID, inclusive upper key and null cursor. An incomplete pass keeps its UUID, upper key and cursor through owner replacement; only its owner epoch changes. New inserts cannot extend that pass.

Pages use ascending keyset traversal with a default limit of 100 and a validated range of 1–100. SQL formats timestamps as six-digit UTC text; JSON serialization and parameterized `::timestamptz` rebinding never pass checkpoint values through JavaScript `Date`. Progress compares owner token/epoch, pass ID, upper key and expected cursor while holding the singleton lock. It refuses backward/out-of-bound movement and skipping an earlier still-pending receipt. Completion separately confirms exhaustion of the bounded range. The next invocation starts a new pass from the beginning, revisiting late commits behind the old cursor.

Each receipt is handled independently. Positive existing retry metadata or completed journals permit progress. Live-asset/journal conflicts and closed-retry/pending-journal conflicts are explicitly deferred without repair. A positively aborted inspection lock wait is deferred to the next finite pass so a perpetually locked oldest row does not block later rows. An uncertain discovery or checkpoint stops the page. A crash after discovery but before checkpoint merely replays discovery; passive reconciliation never increments automatic-attempt counters.

## Separate completed-journal sweep

The supplementary sweep traverses retry primary keys in bounded pages, independently of the durable pending-pass cursor. Its cursor is caller-held; interruption may replay work, and exhaustion resets it. Under journal-first locks and fresh coordinator fencing, only `due`/`cooling` metadata with a positively completed journal and no conflicting live asset becomes `closed`. Counters, generations, last error and clearance references remain intact. Repeated closure is harmless and unknown closure outcomes require confirmation/replay.

`reserved`, `blocked_execution` and `blocked_admission` rows are retained unchanged, including attempt, incarnation, permit, journal token and blocking reason. The schema requires those active fields to be null in `closed`, so clearing them would lose evidence; the sweep deliberately defers these rows rather than invoking Slice 1's more general closure primitive. It neither issues clearance nor proves predecessor I/O quiescence. Their resolution remains a separately reviewed execution/operator task.

## Verification actually executed

Commands ran from `server/` in the isolated worktree under Node.js 24. The final sequential verification command exited successfully.

| Command/check                                                   | Actual result                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                 | Passed inside the full integration, migration-only and runtime-smoke commands; includes the native helper build.                              |
| `npm run typecheck`                                             | Passed. The first invocation exposed generic result inference/narrowing errors in the new source; corrected before database tests.            |
| `npm run lint`                                                  | Passed.                                                                                                                                       |
| `npm run test`                                                  | **227 passed**, 25 files; includes 9 new unit cases.                                                                                          |
| `npm run test:e2e`                                              | **60 passed**, 8 files.                                                                                                                       |
| `npm run test:integration`                                      | **347 passed**, 18 files; **6 native-storage tests skipped**, one file. Includes 23 new coordinator cases and all 15 unchanged Slice 1 cases. |
| `npm run test:migrations`                                       | **106 passed**, one file; these cases overlap the full PostgreSQL suite.                                                                      |
| `npm run test:runtime-smoke`                                    | Passed: invalid configuration and unavailable authentication database exited safely.                                                          |
| Focused Prettier, report links and tracked/untracked whitespace | Passed in final review preparation.                                                                                                           |
| Redis suite / hosted CI / native certification                  | **NOT RUN** for this slice. No shared Redis component changed; native cases remain separately gated.                                          |

An earlier integration run passed 343 cases. Final coverage then added process-shutdown resumption, inherited asynchronous-commit verification, inconsistent closed metadata, unknown closure and stronger expiry/clearance assertions; the complete 347-case suite passed afterward. There were no integration-test failures in this implementation pass. The three PostgreSQL containers from the two full runs and migration-only run were removed by their runners; the final ownership-label listing was empty. No required check is represented by an unexecuted command.

## Safety, limits and handoff

- All schema and fixture SQL uses fresh databases inside the existing identity-checked `postgres:18` tmpfs runner, with random isolated credentials and localhost binding. Child-process tests explicitly select the verified disposable target from runner variables and never fall back to ordinary application credentials; no application `.env` is loaded.
- Tests exercise two independent PostgreSQL pools, two independent Node processes competing for leadership, and a process exiting with a persisted partial pass. Controlled SQL expiry and observed PostgreSQL lock waits establish fencing; this is not host power-loss certification or a SIGKILL filesystem test.
- Lost acknowledgements are injected **after real PostgreSQL COMMIT**, not simulated database responses. No physical network partition or database power-loss experiment is claimed.
- The service performs one bounded page per call. Periodic scheduling, lease-renewal cadence, shutdown orchestration, Redis delivery/recovery and runtime metrics are deferred. Sustained capacity and future runtime failover still need their own verification.
- B.4 must independently enforce the live permit, current automatic reservation, quiescence and M12 claims before any irreversible provider action. This slice makes no reservation and invokes no filesystem operation. Completed journals never authorize evidence erasure or automatic takeover.
- The existing dependency advisories, native storage certification and deployment/real-data recovery gates remain open. No real database, media, storage markers or persistent Docker volumes were accessed. No staging, commit, push, PR or merge is authorized here.

## Review artifacts and reproduction

Run from `server/`: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations`, and `npm run test:runtime-smoke`. The last three commands include a build; database commands must use the existing disposable runner. Focused Prettier covers the four new TypeScript files and this report.

Two complete patches outside the repository distinguish the five Slice 2 additions from the nine-file cumulative M13B.3 change. They include untracked contents and file modes. Their final sizes and SHA-256 hashes are supplied in the review handoff rather than embedded into this self-containing report. Independent review and separate authorization remain required before further slices or Git publication.
