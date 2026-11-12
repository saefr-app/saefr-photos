# Milestone 13B.3 — Slice 1: exact timestamps and retry repository

- **Status:** Implemented and verified locally; unstaged, uncommitted, awaiting independent review.
- **Branch/base:** `feat/m13b3-runtime-reconciliation` at `8ef39c835fa0c18a31cfe63a6ae63b645427f201`.
- **Contract:** Approved M13 v3 SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`; immutable B.1 schema and merged B.2 recovery permit.
- **Date:** 2026-10-30.

## Implemented scope

| File                                                | Change                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/worker/exact-pg-values.ts`              | Branded six-digit UTC timestamp text, parameterized `::timestamptz` rebinding, and bounded PostgreSQL bigint validation.                                                            |
| `server/src/worker/maintenance-retry.repository.ts` | Database-only journal-first retry operations and read-only confirmation methods.                                                                                                    |
| `server/test/maintenance-retry.integration-spec.ts` | Fifteen real PostgreSQL cases, including independent pools, lock contention, a simulated lost COMMIT acknowledgement, exact timestamp rebinding and M12 manual claim compatibility. |
| `docs/development/milestone-13b3-slice1-report.md`  | This report.                                                                                                                                                                        |

The repository is deliberately **not registered** in the API or worker. It cannot dispatch a job or call the M12 executor. It creates a retry row only for an already committed, pending journal without a live asset, using first durable discovery plus one minute as initial eligibility. It never creates deletion authority. All mutating operations lock the M12 journal row before the retry row, use short transactions with `SET LOCAL synchronous_commit TO on`, and set separate lock and statement deadlines. The existing PostgreSQL pools set connection timeouts. No database lock spans Redis, permit-file or storage I/O.

The repository provides `discover`, `reserve`, `confirmReservation`, `settleFailure`, `blockAdmission`, `releaseAdmissionAfterVerification`, `blockExecution`, `hasMatchingClearance`, `advanceGenerationAfterTerminalDelivery`, `closeCompleted`, `read`, and `requestedKey`. Reservation checks generation, exact due time, PostgreSQL wall-clock eligibility, counter bounds, a pending journal, no live asset, and no live M12 journal claim. It increments lifetime and immediate counters only when the reservation commits. Attempt result writes compare generation, attempt ID, incarnation ID, permit generation and state, and recheck reservation expiry after lock acquisition. The first and second immediate failures schedule 5- and 30-minute delays; the third and cooling attempts schedule six hours. No transition decreases counters or resets a generation.

Admission release requires an injected storage verifier to succeed **before** the transaction and then compares the verified binding, current `storage_binding` singleton and immutable journal tuple while locked. An invalid immutable target remains blocked. This metadata transition is not permission to perform I/O: the future B.4 executor must verify the physical binding again immediately before destructive work. The verifier in the repository test is explicitly synthetic; native storage identity was not certified by these new tests. `hasMatchingClearance` checks receipt-specific database evidence only and cannot issue clearance or release `blocked_execution`; operator quiescence proof and live release remain gated.

The repository returns `uncertain` when a mutation or COMMIT acknowledgement fails. It never treats that as rollback or execution permission. The caller must use an independent positive read before taking another step. The test simulates a successful real PostgreSQL COMMIT followed by a lost acknowledgement; the return is `uncertain` and another connection sees the committed row. No power-loss durability test was performed.

## Verification actually executed

Commands ran in the isolated M13B.3 worktree from `server/` using Node.js 24. The PostgreSQL runner created random named `postgres:18` containers with tmpfs database storage, distinct credentials, an owned label and a random localhost port. Its identity checks preceded SQL, and it removed each container. A final labeled-container listing was empty.

| Command                                    | Result                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                            | Passed as part of each final `test:integration`, `test:migrations` and runtime-smoke command; includes native helper build.                  |
| `npm run typecheck`                        | Passed. An earlier sandboxed invocation could not write TypeScript's incremental cache (`EROFS`); the authorized worktree invocation passed. |
| `npm run lint`                             | Passed after correcting a new test assertion.                                                                                                |
| `npm run test`                             | 218 passed across 24 files.                                                                                                                  |
| `npm run test:e2e`                         | 60 passed across 8 files.                                                                                                                    |
| `npm run test:integration`                 | Final run: 324 passed, 6 native-storage cases skipped (17 files passed, one skipped); disposable container removed.                          |
| `npm run test:migrations`                  | 106 passed; these cases overlap with the full integration suite; disposable container removed.                                               |
| `npm run test:runtime-smoke`               | Passed: invalid configuration and unavailable authentication database exited safely.                                                         |
| Focused Prettier and Git whitespace checks | Passed after formatting the final test addition.                                                                                             |

The first full integration run passed before two additional cases were added. An intermediate run then failed one test assertion: the test sorted its outcome array in place before identifying the winning reservation. The assertion was corrected without changing production code. Subsequent full runs passed, with the final run including the lost-acknowledgement case. Initial unit/E2E invocations under the restricted filesystem failed at Vitest startup because it could not write `.vite-temp`; rerunning in the authorized worktree passed. No failed check is presented as a pass.

## Security and data safety

All fixture SQL ran only in newly created databases inside verified disposable PostgreSQL containers. The tests used synthetic journal rows and no real photographs, storage markers, ordinary development database, persistent Docker volume or application `.env`. Historical migrations, the M12 journal authority, production worker composition and API behavior were unchanged. No migration was run against development data.

## Remaining limits and Slice 2 handoff

- No live worker admission, Redis delivery, finite-pass coordinator, leader lease, scheduler repair, actual permit enforcement or filesystem executor integration is implemented here.
- The repository's `ioDrained: true`, terminal-delivery confirmation and injected storage verifier are caller obligations. B.4 must prove these conditions and recheck the permit, storage binding, current reservation and M12 claim before every new irreversible provider call. The current class is not registered for production use.
- A receipt-specific clearance row is only a database prerequisite. Evidence issuance, process quiescence proof and release from `blocked_execution` are intentionally absent.
- The database's `timestamp with time zone` values have six-digit precision; JavaScript `Date` cannot preserve their final three fractional digits. All new CAS-sensitive reads use SQL UTC text and rebind as parameters; future finite-pass cursor code must use the same contract.
- The lock-timeout and lost-acknowledgement cases are controlled fault injection, not a physical database crash or power-loss durability proof. Native storage cases skipped by the integration runner remain separate certification work.
- Retry budgets and production capacity limits still require the approved B.3/B.4 review before automatic execution is connected. Dependency-audit follow-up remains outside this slice.

## Reproduction and review gate

From `server/`, run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations`, and `npm run test:runtime-smoke`. The PostgreSQL commands require Docker and must use the repository runner, which verifies and removes its disposable container. Run focused Prettier on the three new TypeScript files and Git whitespace checks over all four untracked files.

Independent review should inspect the journal-first lock sequence, exact timestamp/CAS predicates, expired reservation behavior, synthetic external proofs and the no-registration boundary before authorizing Slice 2. No staging, commit, push, PR or merge occurred.
