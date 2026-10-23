# Milestone 11C — Owner-scoped asset core

- **Status:** Phase 11C implemented and locally verified; final independent re-review passed and the maintainer approved its Git checkpoint on 2026-10-23.
- **Branch/base:** `feat/m11-asset-ownership` at `e0b2585d3df22f4449a99c6d9f98e5fd4a15fc7f`.
- **Date:** 2026-10-23.

## Implemented internal changes

The retained, production-unmounted asset repository now requires an owner UUID for list, metadata and file-record reads. Each Kysely query applies `owner_id` in SQL; listing retains `created_at DESC, id DESC`. The service requires the existing typed `AuthenticatedActor`, passes only its user UUID to the repository, and returns the same `Asset not found` exception for foreign, ownerless and missing rows before opening storage. The public DTO still excludes `owner_id` and `storage_path`. The asset controller propagates only the guard-provided actor; it has no fallback actor. The database insert type now requires a non-NULL owner, and the repository's create method derives it from the actor after spreading all other input fields.

After existing multipart validation, Sharp processing and no-overwrite file publication, the repository begins a scoped Kysely READ COMMITTED transaction. It locks `app_user` first, rejects missing/disabled users, locks `auth_session` by both session ID and user ID, checks expiry using a separate `clock_timestamp()` statement after both locks, rejects a valid restricted user, inserts the actor-owned row, then commits. No database lock is held during streaming or image processing. M10 account code and the M8/M10 migration versions/inspectors were not edited.

The installed Kysely transaction implementation was inspected at `server-nest/node_modules/kysely/dist/kysely.js` (TransactionBuilder.execute). It commits after callback completion; a callback error is rethrown only after rollback succeeds, while a rollback failure replaces it. A COMMIT failure also enters Kysely's rollback path, so even a later successful ROLLBACK cannot establish that COMMIT failed. The repository marks a callback abort with a private object and classifies only that same object after the scoped transaction rejects as confirmed rollback. Other failures after callback entry remain uncertain. The service best-effort deletes only this upload's UUID-derived published files after confirmed non-commit, preserves the original database failure if cleanup fails, and retains files for uncertain or acknowledged commits. It does not retry uncertain commits.

An independent Astra review found a medium-severity exception to that classification: Kysely acquires a connection and executes `BEGIN` before invoking the transaction callback. If either step failed, the old wrapper returned `uncertain` and retained files even though no asset insert could have occurred. The repository now records callback entry as its first callback operation. A failure before that point returns `not_started`; the service best-effort removes only the current upload's published UUID files and returns a sanitized 503, retaining the original database error as the exception cause for diagnostics. A cleanup error is logged through the safe error-code allowlist and cannot replace the database failure. Once the callback has entered, the existing confirmed-rollback marker and uncertain COMMIT/rollback rules are unchanged. There is no manual connection management or automatic retry.

The same review found a low-severity weakness in the login/upload contention test: it released the independent user-row lock after observing only one waiter. The test now waits for two PostgreSQL `app_user` lock waiters before release. Integration files run serially, so these are the launched login and upload operations. The holder is released in `finally`, and all three operations are settled even when the waiter assertion fails. The test then verifies both completed, ownership is correct, and the published original exists.

The isolated asset HTTP composition now uses the real default-deny guard with a synthetic session authenticator. The test module ignores environment files and uses inert synthetic database settings; it is not imported into production. `AppModule` still omits `AssetsModule`, and the production asset-prefix hook is unchanged.

## Changed files

| Area                            | Paths                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner-scoped core               | `server-nest/src/assets/assets.repository.ts`, `assets.service.ts`, `assets.controller.ts`, `server-nest/src/database/database.types.ts`                                                                                       |
| Unit tests                      | `server-nest/src/assets/assets.service.spec.ts`, `assets.upload.spec.ts`                                                                                                                                                       |
| Disposable PostgreSQL tests     | `server-nest/test/asset-ownership.integration-spec.ts`, `assets.integration-spec.ts`, `migrations.integration-spec.ts`                                                                                                         |
| Isolated HTTP and storage tests | `server-nest/test/assets.e2e-spec.ts`, `errors.e2e-spec.ts`, `swagger.e2e-spec.ts`, `upload.e2e-spec.ts`, `upload-storage.e2e-spec.ts`, `helpers/asset-auth.ts`, `helpers/legacy-assets-test.module.ts`, `helpers/test-env.ts` |
| Current documentation           | `docs/architecture.md`, `docs/roadmap.md`, this report                                                                                                                                                                         |

## Verification actually performed

Final checks on the implemented tree:

- `npm run build`: passed as a prerequisite of the final integration, migration and runtime-smoke commands.
- `npm run typecheck -- --tsBuildInfoFile /tmp/saefr-m11c-corrections-final-typecheck-2.tsbuildinfo`: passed after all source and test edits.
- `npm run lint`: passed with no warnings.
- `npm run test`: final correction run passed 13 files and 94 tests, including the new sanitized pre-callback failure response and cleanup-error-cause test.
- `npm run test:e2e`: 7 files, 52 tests passed.
- `npm run test:integration`: correction run passed 6 files and 137 tests; disposable container `saefr-m7-test-fe96ee825726` was removed. This includes two pre-callback failure cases and one lost-rollback-acknowledgement case.
- `npm run test:migrations`: 1 file, 65 tests passed; disposable container `saefr-m7-test-c8cd3ec9535c` was removed.
- Correction run of `npm run test:migrations`: 1 file, 65 tests passed; disposable container `saefr-m7-test-c0ce26c67bc5` was removed.
- `npm run test:runtime-smoke`: passed; invalid configuration and unavailable authentication database each produced the expected safe nonzero exit.
- Focused `server-nest/node_modules/.bin/prettier --check` over all 20 changed/new files: passed after the correction.
- `git diff --check`: passed. `git diff --no-index --check /dev/null` on each of the three new files produced no whitespace diagnostics (exit 1 is expected for a new-file difference).
- `git diff --exit-code HEAD -- server-nest/src/app.module.ts server-nest/src/main.ts server-nest/src/database/migrations server-nest/src/auth`: passed; historical migrations, production composition and authentication implementation were not changed.
- `docker ps -a --filter name=saefr-m7-test- --format '{{.Names}} {{.Image}} {{.Status}}'`: no disposable integration containers remained.
- `node_modules/.bin/vitest run src/assets/assets.upload.spec.ts src/assets/assets.service.spec.ts`: the initial focused run passed 2 files and 12 tests; one further focused sanitization test was added afterward and passed in the final full unit run.

The final independent re-review returned **PASS** with both prior findings resolved and no confirmed blocker. The reviewer separately ran 13 focused asset unit tests, 14 production asset-lockdown HTTP tests and the complete 137-test disposable PostgreSQL integration suite (including 65 migration tests); its build, formatting and whitespace checks passed, and no disposable container remained. The full 94-unit and 52-E2E runs, separate migration-only run, typecheck, lint and runtime smoke above are implementation verification results; the reviewer did not repeat those entire suites.

Earlier verification attempts and corrections:

- Initial typechecks caught expected call-signature changes during test adaptation; a later test-only generic inference error was corrected.
- The first focused HTTP E2E run failed because synthetic PostgreSQL settings were absent from the isolated test composition. After correcting that test environment, the focused five-file run passed 34 tests.
- The first full integration run passed 117 tests before later failure-injection cases were added.
- The next full integration run passed 120 tests and failed one duplicate-key rollback test. Its rejection bypassed the callback marker because the insert lacked `await`; adding it fixed the classification. A subsequent run passed 129 tests, and the pre-review 134-test run also verified the correction.
- One pre-review integration attempt was rejected before execution because automatic approval review had reached its account usage limit. After approval review became available, the 134-test run passed. No alternate invocation bypassed review.
- A pre-review source review identified that only logout-all had an explicit upload-first lock-winner test. The controlled case was extended to logout, logout-all, individual revocation, password change, password recovery and administrator disable. The 134-test run passed all six variants.
- The first post-correction focused Vitest invocation failed before running tests because the default sandbox mounted the authorized worktree read-only and Vite could not write a temporary bundled config. The same command passed with approved writable worktree execution. An attempted narrow Prettier `--write` met the same read-only mount; formatting was applied directly to the intended test file and the final check passed. Neither initial failure indicated a code or test failure.

The new disposable-database tests include A/B/admin/disabled owner isolation, legacy NULL-owner denial through the migration suite, forged owner ignored, byte preservation, restricted/disabled/revoked/expired final authorization, confirmed callback rollback, a simulated COMMIT that succeeds before its acknowledgement is lost, and controlled lock-wait arrangements for logout, logout-all, individual revocation, password change/recovery and administrator disable winning before upload, as well as upload winning before each of those operations. Concurrent login/uploads and expiry during a wait are also covered. Correction tests use the installed Kysely transaction builder with injected connection-acquisition and pre-`BEGIN` failures. They assert `not_started`, no compiled insert, no database row, successful cleanup of newly published files, preservation of unrelated sentinel bytes, original failure as the sanitized exception's cause when cleanup fails, and pool release. A lost ROLLBACK acknowledgement remains uncertain and retains files; the existing lost-COMMIT and post-commit response-failure tests retain files. These tests passed in the final suites above.

## Security and data safety

Only the existing disposable PostgreSQL 18 runner was used. It checks container identity, tmpfs-only storage, isolated credentials and localhost binding, and reported removal of every executed test container. A separate `docker ps -a` check found none remaining. Tests use temporary filesystem roots. No command addressed the development database, persistent Docker volume, or real photographs. No migration was run against development data. Production asset routes remain locked for every caller, including administrators; `/me` was not changed.

## Remaining work and risks

1. Filesystem and PostgreSQL are not atomic. A crash can leave temporary or published private orphans; a lost COMMIT acknowledgement intentionally retains files, and client retry can produce a second asset UUID. No reconciliation, broad cleanup, real-data upgrade, deployment TLS/proxy validation or production route activation is included.
2. The finalization transaction serializes tested lock orders, but future changes to account/session operations must preserve the user-row-first locking contract. These tests are not a formal proof of every possible interleaving.
3. Phase 11D must separately review the complete early HTTP authorization boundary, exact Origin/CSRF handling, aliases, HEAD/Range behavior, M11 startup readiness and secure production mounting. Owner-scoped internal methods are not permission to reopen routes.

## Repeating verification

Use Node.js 24 from `server-nest/`. Run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:runtime-smoke`, `npm run test:integration` and `npm run test:migrations`. The last two must use their approved disposable PostgreSQL runner; never invoke integration Vitest directly against an arbitrary database. In this restricted worktree, the typecheck build-info output was redirected to `/tmp`; full test/build commands require an approved writable worktree execution. Check `git diff --check` and focused Prettier separately.

## Review gate

- [x] Final automated verification passes.
- [x] Final independent security and database re-review returned PASS.
- [x] Maintainer separately authorized the M11C checkpoint.
- [x] Production asset routes remain unmounted and locked during 11C.
- [x] No development data or real media was accessed or modified.
