# Milestone 10 — Phase 10B.6 final security verification

- **Status:** Implemented on `feat/m10-auth-foundation`; awaiting independent review. Unstaged and uncommitted.
- **Base:** reviewed Phase 10B.5 checkpoint `903b2a62cc084a78901a8e597dd1cef1a4a7764a`.
- **Date:** 2026-10-22.

## Scope and acceptance

This phase reviewed the complete M10 authentication foundation against the approved [specification](milestone-10-spec.md) and [ADR 0004](../decisions/0004-authentication-foundation.md), expanded deterministic security regression coverage, ran the full available backend checks and reconciled current documentation. No production source, database schema, historical migration, asset controller or storage implementation changed.

| Acceptance boundary                                                                                                      | Result                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed accounts, Argon2id password handling, local bootstrap/recovery and administrator-only account operations          | Reviewed in source and exercised by existing unit and disposable PostgreSQL tests; no confirmed bypass found                                        |
| Opaque hashed sessions, seven-day/15-minute expiry, ten-session cap, revocation, password change and login race handling | Reviewed in source; existing real-socket/PostgreSQL tests passed                                                                                    |
| Exact Origin, CSRF, browser-only cookie transport, restricted sessions, bounded login/reauthentication and Argon2 work   | Reviewed; additional negative-path assertions passed                                                                                                |
| Default-deny application and ownerless-asset lockdown for every role                                                     | `AssetsModule` absent from production `AppModule`; expanded namespace matrix and real user/admin requests passed; no asset bytes or metadata served |
| Explicit, history-aware migrations and schema-readiness failure without startup migration                                | Existing migration and startup regressions passed on disposable PostgreSQL only                                                                     |
| Production deployment, existing-database upgrade and M11 ownership                                                       | Not performed or claimed; separate gates remain                                                                                                     |

## Files changed

- Tests: `server-nest/test/asset-lockdown.e2e-spec.ts`, `auth-http.integration-spec.ts`, `users-http.integration-spec.ts`.
- Reports: this file and `docs/development/milestone-10-report.md`.
- Current documentation: `AGENTS.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/development/milestone-10-spec.md`, `docs/development/milestone-10-implementation-context.md`, `docs/development/database-migrations.md`, `server-nest/README.md`.

The expanded lockdown test checks anonymous asset listing, upload, metadata, originals, thumbnails, unknown subpaths, trailing slashes, a percent-encoded alias and HEAD/Range; both authenticated user and administrator cases receive fixed 503 responses without range or download headers, including a malformed multipart upload. A separate real-socket case confirms an ordinary logged-in user also receives 503. Existing tests cover database lookup failure with a sanitized 503 and preserve isolated legacy asset component behavior.

The real-socket authentication suite now additionally rejects null Origin on login; missing/null Origin and malformed CSRF on logout; bearer-only and proxy-authorization attempts; and administrator access from a restricted first-login session. Earlier tests retain coverage for disabled accounts, logout-all/login races, password recovery/change, foreign sessions, session cap, current-password reauthentication, cross-disables, login/disable races, parser errors and safe logging. No production threshold or security configuration was weakened to make a test pass.

## Security review findings

No confirmed critical or high-severity correctness defect was found in the reviewed M10 application, credential, operator, migration and lockdown paths. The first added-test typecheck failed because a heterogeneous header array inferred an optional `Origin` property; an explicit string-header type corrected the **test only**. Subsequent typecheck and all relevant suites passed. No production code change or schema change was needed.

The review cannot prove the absence of every bypass. In particular, a request already authorized before revocation can finish; in-memory limiter state resets on restart and is not shared across nodes. These are documented M10 limits, not test failures. Framework behavior outside the Nest exception pipeline and a real proxy/TLS stack remain unverified.

## Actual verification

Commands were run from `server-nest/` with Node.js `v24.22.0` on 2026-10-22:

| Command                                                           | Result                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                                                   | PASS                                                                              |
| `npm run typecheck`                                               | PASS after correcting the test-only header type                                   |
| `npm run lint`                                                    | PASS                                                                              |
| Focused `npx prettier --check` on changed tests and documentation | PASS                                                                              |
| `npm run test`                                                    | PASS: 13 files, 90 tests                                                          |
| `npm run test:e2e`                                                | PASS: 7 files, 52 tests; focused asset-lockdown run also passed 14/14             |
| `npm run test:integration`                                        | PASS: 5 files, 91 tests; verified disposable PostgreSQL 18 container removed      |
| `npm run test:migrations`                                         | PASS: 1 file, 44 tests; separate verified disposable container removed            |
| `npm run test:runtime-smoke`                                      | PASS: invalid configuration and unavailable authentication database exited safely |
| Tracked and untracked Git whitespace checks                       | PASS                                                                              |

The database runner verified random container identity, `postgres:18`, generated credentials, tmpfs storage and a localhost-only random port before tests. Tests created random databases inside that container. No root Compose service, development database, persistent Docker volume or stored photograph was used. The disposable-container listing was empty after both runs. Build/unit/E2E and targeted format checks completed before documentation-only edits; final formatting and whitespace checks were repeated after the documentation updates. No full suite was rerun solely for prose changes.

## Remaining gates and M11 handoff

- Independent maintainer review, an explicitly approved 10B.6 checkpoint, and a separately approved PR into `integration` remain. No CI workflow was added or executed; the repository's automated CI gate for this branch is therefore unverified.
- A real installation needs an isolated upgrade rehearsal, verified database and media backups, a reviewed recovery plan, explicit migration approval and a migration job before API startup. The development database has **not** been upgraded.
- Deployment must validate HTTPS, reverse-proxy and trusted-proxy settings, browser cookie behavior, temporary-password delivery, host-only recovery access, disabled-administrator restoration and Argon2 performance on target hardware. No production deployment was tested.
- M11 must design an explicit owner mapping for existing ownerless rows and enforce owner/share predicates on list, upload, metadata, originals, thumbnails, HEAD/Range and aliases before reopening asset routes. Administrator role is not photo ownership. The frozen M8 legacy baseline must remain intact while the current-state validator evolves for any future ownership migration.
- Filesystem write/cleanup failure injection, upload crash recovery and cross-system database/filesystem reconciliation remain outside M10.

**Recommendation:** M10 is ready for independent review of this phase. After that review and a separately approved checkpoint, the feature branch can be considered for an `integration` pull request. It is not ready for public deployment or M11 asset access.

## Repeat verification

From `server-nest/` on Node.js 24, run the npm commands in the table. `test:integration` and `test:migrations` must be invoked through their npm scripts so the verified disposable runner controls PostgreSQL; never point them at the development database. Review `git diff --check` and the untracked-file whitespace checks from the repository root.
