# Milestone 13B.1 — Database foundation report

- **Status:** Implemented in an isolated worktree; awaiting independent review.
- **Branch:** `codex/m13b-database-foundation`
- **Base:** `origin/integration` at `6bcc10745644964b6da7cb8d333d47b507f0c224`.
- **Contract:** Approved M13 v3, SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`, plus the final B.1 schema review clarifications.
- **Date:** 2026-10-29.

## Scope and implementation

B.1 adds coordination metadata only. It does not register an automatic retry processor, arm a recovery permit, enable Trash expiry, call the M12 deletion executor or touch storage. API startup continues to validate the migration schema and does not run migrations.

The immutable `202610290001_maintenance_recovery` migration appends three tables:

| Table                            | Purpose and enforced invariants                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maintenance_retry_state`        | One row per M12 deletion receipt, with six states (`due`, `reserved`, `cooling`, `blocked_admission`, `blocked_execution`, `closed`), a monotonic generation field, lifetime and immediate attempt counters, due or reservation fields, permit and worker identity, and bounded error/reason codes. A real primary key and immediate restrictive FK tie it to `asset_deletion`. |
| `maintenance_takeover_clearance` | Receipt-specific operator clearance evidence. Real unique constraints prohibit reuse of a blocked attempt identity and support the reverse composite FK from retry state to a clearance for the same receipt. The FK cycle is created in the reviewed order.                                                                                                                    |
| `maintenance_reconciliation`     | A one-row singleton for leader epoch/lease and finite reconciliation passes. A pass with an identity has a positive owner epoch, complete upper key, paired cursor and cursor no greater than the upper key. The initial row is identity-free `complete`.                                                                                                                       |

The migration adds a global pending-journal index on `asset_deletion(requested_at, asset_id)`, a partial due-work index and a partial unique attempt-ID index. It has no automatic `down`: retained retry and clearance evidence needs a reviewed recovery plan.

The final LOW schema clarifications are included: the reconciliation CHECKs reject infinity, half-null keys, nonpositive pass owner epochs, incomplete identity tuples and cursor keys beyond the upper bound; `last_error_code` permits exactly the nine M12 journal error codes or NULL. Blocking reasons have independent admission and execution allowlists. No raw provider message or path has a database field.

Kysely types expose the new tables and keep PostgreSQL `bigint` values as decimal strings. PostgreSQL's ordinary JavaScript `Date` parsing loses microseconds. B.2 must read reconciliation keys as exact SQL text and compare them in PostgreSQL; B.1's round-trip test verifies six-digit precision through SQL.

## Migration compatibility and exact validation

The provider appends the M13 version after M8, M10, M11 and M12. The runner dispatches by the exact applied history prefix. It invokes the unchanged historical inspector for older prefixes; before M13 history it refuses reserved M13 objects. For M13 history, a new inspector checks the post-M13 M12 catalog plus all three new relations, columns, types, nullability, CHECK definitions, real PK/FK/unique constraints and keys, FK actions and enabled internal triggers, exact index definitions and predicates, and the singleton row count. Incompatible or partial schema fails before another migration is attempted; no repair is performed.

The new post-M13 inspector carries the historical M12 catalog checks with only the additional global journal index and M13 table validation. Historical migration versions and inspector files were not edited. Existing asset rows and prior Kysely ledger entries were preserved in a synthetic legacy-to-M12-to-M13 upgrade test. M12 binaries remain incompatible with the M13 schema and must be upgraded together with a separately approved real-data plan.

## Changed files

| File                                                                           | Change                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `server/src/database/migrations/versions/202610290001_maintenance_recovery.ts` | New versioned migration.                                            |
| `server/src/database/migrations/maintenance-schema.ts`                         | Post-M13 schema dispatch and reserved-object rejection.             |
| `server/src/database/migrations/maintenance-tables-schema.ts`                  | Exact PostgreSQL 18 catalog inspection for new tables.              |
| `server/src/database/migrations/migration-provider.ts`                         | Register M13 version.                                               |
| `server/src/database/migrations/migration-runner.ts`                           | History-aware M13 inspection and premature-object refusal.          |
| `server/src/database/database.types.ts`                                        | Kysely table and state types.                                       |
| `server/test/migrations.integration-spec.ts`                                   | Disposable PostgreSQL fixtures and historical/M13 regression tests. |
| `docs/development/milestone-13b1-report.md`                                    | This evidence and handoff.                                          |

## Verification actually executed

Commands ran from `server/` in the isolated M13B worktree with Node.js 24 and the pinned npm dependencies. The PostgreSQL and Redis commands used the repository's owned disposable runners; containers were labeled, identity-checked, bound to localhost and removed by the runners.

| Command                                    | Result                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --cache /tmp/saefr-m13b-npm-cache` | Passed; no lockfile modification. npm reported 2 low and 4 moderate dependency advisories; no package-level triage or dependency change in B.1. |
| `npm run build`                            | Passed, including native helper build.                                                                                                          |
| `npm run typecheck`                        | Passed.                                                                                                                                         |
| `npm run lint`                             | Passed without warnings after fixing a new test's numeric sort comparator.                                                                      |
| `npm run test`                             | 159 passed across 22 files.                                                                                                                     |
| `npm run test:e2e`                         | 60 passed across 8 files.                                                                                                                       |
| `npm run test:migrations`                  | 106 passed, disposable PostgreSQL 18. These cases also appear in the full integration suite.                                                    |
| `npm run test:integration`                 | 297 passed; 6 native-storage cases skipped by the runner (16 files, one skipped). Disposable PostgreSQL 18 container removed.                   |
| `npm run test:redis`                       | 17 passed, disposable Redis container removed.                                                                                                  |
| `npm run test:runtime-smoke`               | Passed; invalid configuration and unavailable authentication database exited safely.                                                            |
| Focused Prettier and Git whitespace checks | Passed for all eight changed files; `git diff --check` and reverse patch whitespace validation passed.                                          |

During implementation, an initial TypeScript build caught a generated inspector syntax error; two migration runs then exposed outdated M12-latest expectations and a legacy fixture setup mistake. They were corrected. The final migration run passed 106 tests. The first focused Prettier check after the lint fix found formatting drift; the test file was reformatted. These were test/development iterations, not final passing checks.

Tests cover fresh and legacy installation, M12 upgrade, repeat/concurrent migration, ledger/data preservation, all six valid row shapes, invalid state/counter/time/error values, the nine allowed errors, FK and clearance uniqueness, cross-receipt rejection, singleton and checkpoint invariants, exact microseconds, catalog drift, partial pre-history objects, startup refusal, and a real two-backend row-lock/CAS interleaving. The CAS fixture verifies that a stale generation update returns no row after a competing transaction commits; it does not implement or prove a runtime retry processor.

## Data safety, limitations and handoff

All SQL writes were inside freshly created databases in owned disposable PostgreSQL containers. The original checkout, existing M13A worktree, ordinary development PostgreSQL, persistent Docker volumes and real media were not used. No Git staging, commit, push, PR or merge occurred.

Remaining work belongs to later M13B slices: runtime retry reservations, restoration permit and takeover clearance enforcement, reconciliation loops, Redis recovery and deletion execution. The B.1 schema cannot alone enforce counter monotonicity across updates, generation CAS, operator quiescence proof, or unknown-COMMIT handling; these require short transactions and verified runtime protocols. Native ext4 storage certification, production recovery and real-data migration were not performed. Automatic deletion remains disabled.

Review gate: inspect the eight-file diff, migration catalog assertions and disposable test evidence before authorizing a B.1 checkpoint or any later slice.
