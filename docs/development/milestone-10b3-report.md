# Milestone 10 — Phase 10B.3 implementation report

- **Status:** Implemented and verified; awaiting maintainer review
- **Branch/base:** `feat/m10-auth-foundation` at `68d6a1a`, with Phase 10B.1/10B.2 changes preserved and still uncommitted
- **Date:** 2026-10-22
- **Implemented commit:** None

## Goal and previous-phase review

This phase implements password security, internal user persistence, and standalone local first-admin, recovery and bounded expired-session cleanup commands. It adds no public account endpoint, application login, session cookie or asset authorization change.

Before editing, the uncommitted Phase 10B.1/10B.2 documents, migration source, strict catalog validator, Kysely types, tests and disposable runner were reviewed against the approved M10 specification and accepted ADR 0004. No significant correctness or security defect requiring a stop was found. The M8 version and legacy asset validator remain untouched; the M10 version is additive, and its tests cover asset rows/table identity/history and rejection of partial or incompatible schemas. The disposable runner checks container identity, temporary storage, isolated credentials and localhost port, then removes its owned container. Exact PostgreSQL 18 catalog rendering and real-data rehearsal remain known limitations. The working tree's earlier M10 edits were preserved.

## Files changed in Phase 10B.3

| File                                                        | Purpose                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `server-nest/package.json`, `server-nest/package-lock.json` | Added `argon2@0.45.1` and three explicit operator npm commands                                                       |
| `server-nest/src/auth/password.service.ts`                  | Password policy, salted Argon2id hashing, bounded PHC verification and dummy-hash work                               |
| `server-nest/src/auth/password.service.spec.ts`             | Password validation, Unicode, salt, malformed-hash and verification unit tests                                       |
| `server-nest/src/users/username.ts`                         | Canonical ASCII username normalization and validation                                                                |
| `server-nest/src/users/users.repository.ts`                 | Kysely user/session persistence with fixed-role insert methods and passwordless public record projection             |
| `server-nest/src/users/operator-accounts.service.ts`        | Schema-gated first-admin bootstrap, ordinary-user persistence, selected-account recovery and bounded session pruning |
| `server-nest/src/users/operator-config.ts`                  | Dedicated database configuration, exact command/target parsing and standalone pool                                   |
| `server-nest/src/users/hidden-password.ts`                  | Hidden interactive, confirmed terminal password input                                                                |
| `server-nest/src/users/operator-cli.ts`                     | Standalone command entry and fixed safe error output                                                                 |
| `server-nest/src/users/operator-accounts.spec.ts`           | Username, UUID, command/config, terminal and error-sanitization unit tests                                           |
| `server-nest/test/auth-operator.integration-spec.ts`        | Actual PostgreSQL and compiled-CLI success/failure/concurrency tests                                                 |
| `server-nest/test/helpers/operator-pty.py`                  | Test-only Linux pseudo-terminal driver; sends synthetic passwords via a pipe, never process arguments                |
| `docs/development/milestone-10-spec.md`                     | Recorded separate 10B.3 authorization and local cost measurement                                                     |
| `docs/development/milestone-10-implementation-context.md`   | Phase state, actual checks, risks and 10B.4 handoff                                                                  |
| `docs/development/milestone-10b3-report.md`                 | This report                                                                                                          |

No application module, HTTP controller, asset code, database migration version, Docker volume, media file or development account/asset record was changed.

## Password and persistence decisions

The maintained `argon2` package implements Argon2id v19 at 64 MiB, three passes and one lane, with a fresh 16-byte random salt and 32-byte tag per hash. New passwords must be 15–128 Unicode code points and at most 512 UTF-8 bytes. Their bytes, spaces and composed/decomposed Unicode forms are preserved; malformed surrogate sequences and a small documented local denylist are rejected. A candidate is never silently truncated. Verification accepts only the expected bounded PHC form and returns false for malformed/corrupt hashes rather than passing native errors through. A fixed hash of a discarded random value supplies comparable Argon2id work for an absent or malformed account hash; this is not a timing-equality guarantee. The password implementation is independent of HTTP and is not wired into `AppModule`.

Five sequential hash/verify pairs on the local Node.js 24 test host measured a **254 ms median hash** (187–360 ms range) and **268 ms median verify** (193–294 ms range). These are observations on this host, not a production latency or capacity guarantee. Later login work still needs bounded concurrent Argon2 execution and rate limiting. Target deployment hardware should be measured before finalizing the cost.

`UsersRepository` returns a passwordless account projection for creation and keeps hash lookup internal. The service canonicalizes usernames and uses distinct fixed-role insert methods; ordinary creation is always `user` with required first password change. PostgreSQL enforces canonical uniqueness and approved role/status values. The operator bootstrap creates one active `admin` only when the table has **zero** users, with a transaction-scoped advisory lock and repeat check after obtaining it. Disabling every administrator does not reopen bootstrap. Recovery selects an exact canonical UUID, locks only that row, updates its hash and required-change flag, and deletes its sessions in one transaction. Role and disabled status remain unchanged. Concurrent recovery serializes on that row; if two authorized local operators recover the same account, the last committed replacement is effective. A failed revocation rolls the hash update back. Pruning deletes at most the requested 1–1000 sessions whose expiry is at or before PostgreSQL's current time.

## Operator command contract

The compiled standalone CLI provides:

```text
npm run auth:bootstrap -- --confirm-database=<name> --username=<name>
npm run auth:recover -- --confirm-database=<name> --user-id=<canonical-uuid>
npm run auth:prune-sessions -- --confirm-database=<name> --limit=<1-1000>
```

It requires all five dedicated `AUTH_ADMIN_POSTGRES_HOST`, `_PORT`, `_DB`, `_USER` and `_PASSWORD` settings and an exact `--confirm-database` match. It does not load `.env`, fall back to application or migration settings, or run migrations. Bootstrap and recovery refuse non-terminal input and any password argument; they read and confirm a hidden password on an interactive terminal. The CLI validates the complete M10 schema and migration history before prompting/mutating. It prints only fixed diagnostic categories, internal UUIDs and counts. Unknown PostgreSQL/native errors are sanitized; no password, hash, connection string or raw driver message is printed. The test-only PTY driver confirmed that successful and mismatched prompts did not echo its synthetic passwords.

The environment variable holding the operator **database credential** still exists in the operator process environment, as specified; a trusted host administrator can inspect it. Choose a protected secret-injection mechanism and least-privileged operator role during deployment design. No first-password delivery mechanism is implemented. The integration CLI subprocesses receive a deliberately minimal environment with only the verified disposable `AUTH_ADMIN_POSTGRES_*` settings and basic executable/locale settings; inherited development or migration database variables are excluded.

## Actual verification

Commands ran from `server-nest/` with Node.js `v24.22.0` and Docker 29.7.2. Functional database tests used only the verified disposable PostgreSQL 18 runner and random databases within its container. The source did not connect to the development database.

| Command/check                                                                                          | Result                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `npm_config_cache=/tmp/saefr-m10-npm-cache npm install argon2@0.45.1`                                  | PASS; npm audit reported zero vulnerabilities; npm noted blocked install scripts, but native import, hash and verify passed |
| `npm run build`                                                                                        | PASS; also passed inside integration, migration and runtime-smoke commands                                                  |
| `npm run typecheck`                                                                                    | PASS                                                                                                                        |
| `npm run lint`                                                                                         | PASS without warnings after correcting one lint warning                                                                     |
| Targeted `npx prettier --check`                                                                        | PASS after formatting only Phase 10B.3 TypeScript                                                                           |
| `npm run test`                                                                                         | PASS: 11 files, 77 tests; real Argon2id operations, no database                                                             |
| `npm run test:e2e`                                                                                     | PASS: 6 files, 38 existing HTTP tests; no account route added                                                               |
| `npm run test:integration`                                                                             | PASS: 3 files, 62 tests; includes 11 operator PostgreSQL/CLI tests; container removed                                       |
| `npm run test:migrations`                                                                              | PASS: 1 file, 44 tests; container removed                                                                                   |
| `npm run test:runtime-smoke`                                                                           | PASS: safe invalid-config and occupied-port failures, and SIGTERM listener closure                                          |
| Argon2id five-pair local benchmark                                                                     | PASS; medians/ranges above                                                                                                  |
| `git diff --check`, targeted Prettier, final typecheck and lint                                        | PASS; no whitespace, formatting or static-analysis errors                                                                   |
| `git diff --no-index --check /dev/null` for 18 untracked M10 files                                     | PASS: no whitespace errors; status 1 indicates a new-file diff                                                              |
| `docker ps -a --filter label=dev.saefr.purpose=milestone-07-integration --format '{{.ID}} {{.Names}}'` | PASS: empty output after the database suites                                                                                |
| Read-only Git diff of original M8 migration, legacy validator, disposable runner and `AppModule`       | PASS: no changes                                                                                                            |

An initial typecheck found a generic Kysely transaction type inference issue and then a typed SQL expression/test-error narrowing issue; those were corrected. One parallel `npm run test` run reported **76 passed, one timed out** because a multi-hash Argon2id test exceeded Vitest's five-second default under concurrent checks. The two multi-hash tests now have a focused 20-second deadline; the subsequent standalone unit run passed all 77. Final test review also found that CLI test subprocesses inherited the parent environment; they now receive only disposable target variables, and the full 62-test integration command passed again. These failed or corrected attempts were not treated as successful verification.

## Safety, limitations and handoff

No development PostgreSQL credentials or `.env` were used by tests; the CLI tests received only credentials from `testConfig()` after it verified the temporary container's image, label, tmpfs, ownership and localhost port. Every operator scenario used its own random database. The existing development volume, photographs, asset records and migration history were not read or modified. The application still has ownerless, unrestricted asset routes and **no active login**; it must remain localhost-only.

No HTTP user administration, account disable/last-admin rule, browser session issuing, password-change endpoint, login throttling, Argon2 concurrency limiter, account recovery over HTTP, mobile transport or production deployment was implemented. A local operator can replace a selected password; there is no separate restore-disabled-admin operation. Crash/recovery limits for filesystem assets and the need for a real upgrade rehearsal remain as documented in earlier reports. The PTY integration helper requires Python 3 on the Linux test host; production commands require only Node.js and an interactive terminal. The native Argon2 package has not been installed or benchmarked in a future deployment image.

**Phase 10B.4 requires separate authorization.** Its handoff must preserve the M10/M11 boundary: implement and verify structural production asset lockdown **before** functional login is activated in `AppModule`. Applying migrations or running these account commands against the development database requires a separate approved backup/recovery plan. No commit, push or merge was performed.

## Repeat verification

From `server-nest/` with Node.js 24 and Docker available:

```sh
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
npm run test:migrations
npm run test:runtime-smoke
```

The two database suites independently create and remove their own temporary PostgreSQL containers. Do not run operator or migration commands against the development database to repeat these checks.

## Review gate

- [ ] Maintainer reviewed the preserved 10B.1/10B.2 and new 10B.3 diffs
- [x] Required automated checks passed after diagnosed test-timeout correction
- [x] No HTTP login or ownerless-asset authorization change
- [ ] Commit/push approved separately
- [ ] Phase 10B.4 authorized separately
