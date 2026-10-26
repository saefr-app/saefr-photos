# M12B — Database Foundation implementation report

- **Status:** Implemented with targeted independent-review corrections; unstaged and awaiting re-review.
- **Branch/worktree:** `codex/m12b-database-foundation` at `/tmp/saefr-m12b-database-foundation`.
- **Base:** `origin/integration` merge commit `8e238abe9146019899eb63caeace684ae10be158` (M12A PR #6).
- **Date:** 2026-10-26.
- **Contracts:** [Accepted ADR 0006](../decisions/0006-asset-lifecycle-and-deletion.md) and [approved M12 specification](milestone-12-spec.md). This phase implements only the database foundation.

## Implemented

The new `202610260001_asset_lifecycle` version adds nullable `asset.trashed_at`, `asset.lifecycle_version BIGINT NOT NULL DEFAULT 0`, both named checks and the two specified partial owner-ordering indexes. It retains the historical M11 owner FK, unvalidated enforced owner-required check and index. It creates `asset_deletion` with the exact 13 columns, owner FK, named checks and pending index, plus the five-column `storage_binding` singleton table with its named checks. The binding table is **empty** after migration. There is no ownership backfill, storage-identity inference, marker creation, media read or filesystem mutation. The migration's down path refuses automatic rollback.

The explicit provider registers the new version. The runner validates the exact ordered migration-history prefix, rejects premature M12 names and selects the frozen M8, M11 or new M12 asset inspector according to applied history. The new M12 inspector checks the nine-column asset shape and preserved M11 contract; journal and singleton relation types, columns, nullability, defaults, checks, indexes and predicates; and the journal owner FK and enabled internal triggers. The M8/M10/M11 version files and historical inspectors are unchanged. Migration remains an explicit CLI operation, never an API startup side effect.

Kysely types represent PostgreSQL `BIGINT` lifecycle versions as decimal strings. The new, unmounted `AssetDeletionRepository` supports owner-scoped receipt lookup; an atomic 60-second token claim; positive confirmation before later I/O after an uncertain claim acknowledgement; token-guarded renewal, completion and bounded diagnostic failure updates. It refuses claims when an asset row still exists with the journal UUID. No repository method mutates immutable journal targets. No journal acceptance or filesystem execution method is exposed in this phase: acceptance requires M12C storage provenance and later phase review.

### Targeted independent-review corrections

The first independent review identified three Medium findings. Renewal, completion and failure updates now use short transactions that lock the owner-scoped journal row first. A separate SQL statement evaluates token, pending state and `clock_timestamp()` **after the lock is acquired**; the subsequent update also rechecks expiry while retaining the lock. No connection is held for future filesystem I/O. The M12 inspector now requires each named primary key to be a genuine `p` constraint on the expected column, tied to its `indisprimary` index. Finally, journal claim tests use separate PostgreSQL pools and observe distinct contenders blocked on the same row through `pg_stat_activity`, instead of relying on `Promise.all` through a one-connection pool. Tests cover valid claims, post-wait expiry, stale replacement tokens, completed receipts and spoofed primary keys for both new tables.

**Temporary fail-closed gate:** `AuthSessionService.assertReady()` rejects every M12-applied schema before the production `main.ts` listener starts, whether `storage_binding` is empty or synthetically populated. A row alone is not proof of a verified filesystem binding. M11 HTTP regression fixtures remain on explicit M11 migration state. The migration CLI, inspector and isolated repository tests can use M12 databases independently. M12C must replace this temporary refusal with verified binding-aware upload and media behavior before an M12 HTTP application can start.

## Files changed

| Path                                                                           | Purpose                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `server-nest/src/database/migrations/versions/202610260001_asset_lifecycle.ts` | New immutable M12 DDL.                                                      |
| `server-nest/src/database/migrations/asset-lifecycle-schema.ts`                | New exact M12 inspector and premature-object rejection.                     |
| `server-nest/src/database/migrations/migration-provider.ts`                    | Explicit M12 registration.                                                  |
| `server-nest/src/database/migrations/migration-runner.ts`                      | History-aware M12 dispatch.                                                 |
| `server-nest/src/database/database.types.ts`                                   | Lifecycle, journal and binding types.                                       |
| `server-nest/src/assets/asset-deletion.repository.ts`                          | Unmounted database-only claim and receipt primitives.                       |
| `server-nest/src/auth/auth-session.service.ts`                                 | Temporary M12 startup refusal.                                              |
| `server-nest/test/migrations.integration-spec.ts`                              | M12 upgrades, catalog/ledger, singleton, incompatibility and startup tests. |
| `server-nest/test/asset-deletion.integration-spec.ts`                          | Real PostgreSQL journal/claim tests.                                        |
| `server-nest/test/helpers/m11-schema.ts`                                       | Historical M11-only HTTP fixture helper.                                    |
| `server-nest/test/asset-ownership-http.integration-spec.ts`                    | Keep M11 HTTP fixture on M11 schema.                                        |
| `server-nest/test/auth-http.integration-spec.ts`                               | Keep M10 HTTP fixture on M11-compatible app schema.                         |
| `server-nest/test/users-http.integration-spec.ts`                              | Keep administrator HTTP fixture on M11 schema.                              |
| `server-nest/test/assets.integration-spec.ts`                                  | Nine-column fixture and type expectations.                                  |
| `docs/development/milestone-12b-report.md`                                     | This actual-evidence report.                                                |

## Verification actually run

All npm commands ran from `server-nest/` on Node.js `v24.22.0`. PostgreSQL checks used only the existing guarded `postgres:18` runner with random credentials, localhost port and tmpfs data; migration scenarios used separate temporary databases inside that verified container.

| Command                                                                 | Result                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci`                                                                | PASS, 293 lockfile packages installed in this isolated worktree. npm reported 16 audit findings (1 low, 15 moderate); no dependency changes were made. |
| `npm run build`                                                         | PASS.                                                                                                                                                  |
| `npm run typecheck`                                                     | PASS.                                                                                                                                                  |
| `npm run lint`                                                          | PASS without warnings after a test-only typing correction.                                                                                             |
| `npm run test`                                                          | PASS: 98 unit tests, 13 files.                                                                                                                         |
| `npm run test:e2e`                                                      | PASS: 52 HTTP E2E tests, 7 files.                                                                                                                      |
| `npm run test:integration`                                              | PASS: 198 PostgreSQL integration tests, 8 files; includes the 82 migration cases. The final run removed its disposable container.                      |
| `npm run test:migrations`                                               | PASS: 82 migration cases, 1 file. Its disposable container was removed.                                                                                |
| `npm run test:runtime-smoke`                                            | PASS: invalid configuration and unavailable synthetic database exit safely.                                                                            |
| Focused Prettier, Markdown-link and tracked/untracked whitespace checks | PASS after the report was finalized.                                                                                                                   |

The first migration runs failed while the new inspector and old three-version test expectations were being implemented. The first full integration run failed because historical HTTP fixtures migrated to M12 and correctly hit the new startup refusal; those fixtures now explicitly use M11 state. The first lint pass warned about two test-only unknown-value template expressions; they were fixed. No final failing check remains. These iterations are not represented as passing runs.

The corrective pass initially found focused Prettier differences in three edited files; those files were formatted before verification. The final integration suite was rerun after a test-only cleanup adjustment. The 82 migration cases are a subset of the 198 integration cases and are not additional distinct tests.

Tests cover fresh, M8/M10/M11 and explicit legacy-baseline upgrades; unchanged historical asset values, paths and prior ledger entries; NULL-owner quarantine; repeat and concurrent migration execution; premature objects, false ledger claims and schema drift; empty and synthetically populated binding states; singleton constraints; journal constraints; primary-key spoofing rejection on both new tables; owner-scoped receipts; separate-connection claim contention; post-lock expiry rejection for renewal, completion and failure updates; stale-token rejection; and real child-process startup refusal before listening on M12. They do **not** certify native filesystem durability or a real-data upgrade.

## Safety and limitations

- No real development PostgreSQL, persistent Docker volume, original or thumbnail was accessed or changed. Synthetic SQL paths in tests do not point to real media. Disposable test containers were removed; a final `docker ps -a` check found none with the test-purpose label.
- No M12B code accepts irreversible deletion or unlinks a file. The completion primitive is unmounted and must only be called by a future reviewed executor after provider-verified removal and durability.
- M12B does not yet establish upload-finalization and deletion-acceptance same-ID coordination. M12C/E must add and test that shared transaction lock before an HTTP deletion API or M12 media operation is enabled.
- M12C must implement verified storage binding, controlled adoption and the provider contract for both independently mounted media roles. A populated singleton alone is insufficient; the temporary startup refusal must remain until that gate is verified.
- An uncertain claim acknowledgement authorizes no I/O unless an independent read confirms the same unexpired token. Tests exercise positive confirmation and stale-token rejection, but do not inject a lost network acknowledgement or OS crash. Filesystem fault injection, actual deletion, crash recovery, and cross-platform certification belong to later approved phases.
- The dependency installation reported 16 audit findings (1 low, 15 moderate). Package-level triage was not established in this phase. No dependency remediation or update was made.
- This phase does not run real-data migrations. The strict M11 binary rejects M12 schema, so an upgrade requires a separately approved maintenance and recovery procedure; no mixed rollout or automatic downgrade is supported.

## Repeating verification

From this isolated worktree, with Node.js 24 and Docker available, run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations`, and `npm run test:runtime-smoke` inside `server-nest/`. Use only the two npm integration scripts; direct integration Vitest invocation refuses unverified databases. Inspect any remaining test container by its exact identity and label rather than using Docker volume cleanup. This is not permission to run `db:migrate` against a development or other persistent database.

## Review gate

- [ ] Maintainer reviews all unstaged changes and the temporary readiness gate.
- [ ] M12C separately authorized; no storage adoption or media route activation in this phase.
- [ ] Git checkpoint separately authorized; nothing staged, committed or pushed.
