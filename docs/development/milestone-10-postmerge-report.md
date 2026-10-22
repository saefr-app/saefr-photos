# Milestone 10 — post-merge verification and closure

- **Status:** POST-MERGE VERIFIED COMPLETE on `integration`; this is not production deployment approval.
- **Verified merge:** [PR #2](https://github.com/saefr-app/saefr-photos/pull/2) merged 2026-10-22 at 11:20:54 UTC (16:50:54 IST). Merge commit and remote `integration` HEAD: `acf6ed44bb870fdae56e68c523ba660af6536897`.
- **Source:** `feat/m10-auth-foundation` at `6751b42de8730966b4a01e801e8358d7eeede618`. The five M10 commits (`7c9fc9d`, `d5d91d7`, `903b2a6`, `c5cdc05`, `6751b42`) are ancestors of the merge commit. Remote `main` remained `dfd22e64317c4ea6fc7ddd91e797c4793ae498fa`.
- **Verification checkout:** isolated `codex/m10-postmerge-m11-planning` worktree created from the exact merge commit; the existing feature checkout was not changed.

## Actual post-merge checks

Node.js `v24.22.0`; Docker server `29.7.2`; npm commands ran from `server-nest/` in the isolated worktree on 2026-10-22. `npm ci` used the committed lockfile and succeeded in about 13 seconds. No backend source, tests, dependency versions or migration files were edited.

| Command                                                                                                                                             | Result                                                                                                                                                                                         | Wall time |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------: |
| `npm run build`                                                                                                                                     | PASS                                                                                                                                                                                           |    5.79 s |
| `npm run typecheck`                                                                                                                                 | PASS                                                                                                                                                                                           |    5.63 s |
| `npm run lint`                                                                                                                                      | PASS                                                                                                                                                                                           |    2.37 s |
| `npm run test`                                                                                                                                      | PASS: 13 files, 90 tests                                                                                                                                                                       |   12.97 s |
| `npm run test:e2e`                                                                                                                                  | Initial run failed before assertions because this clean worktree had no local `.env` and `POSTGRES_DB` was required; 7 tests failed and 45 were skipped. No real database connection was made. |    4.90 s |
| `npm run test:e2e` with explicit synthetic `NODE_ENV=test`, `APP_ORIGIN`, `POSTGRES_*` values, invalid database host and unused `/tmp` storage root | PASS: 7 files, 52 tests. The E2E modules override the database service and use temporary storage.                                                                                              |    5.69 s |
| `npm run test:integration`                                                                                                                          | PASS: 5 files, 91 tests; runner removed `saefr-m7-test-ca0b09353cd8`.                                                                                                                          |   50.22 s |
| `npm run test:migrations`                                                                                                                           | PASS: 1 file, 44 tests; runner removed `saefr-m7-test-65148c356199`.                                                                                                                           |   13.81 s |
| `npm run test:runtime-smoke`                                                                                                                        | PASS: invalid configuration and unavailable authentication database exited safely.                                                                                                             |    7.34 s |

The successful E2E rerun used this synthetic configuration (the host does not resolve to a database):

```bash
env NODE_ENV=test POSTGRES_HOST=invalid.invalid POSTGRES_PORT=65432 \
  POSTGRES_DB=saefr_e2e_unused POSTGRES_USER=saefr_e2e_unused \
  POSTGRES_PASSWORD=synthetic-test-only APP_ORIGIN=http://127.0.0.1:3000 \
  STORAGE_ROOT=/tmp/saefr-postmerge-e2e-unused npm run test:e2e
```

The initial E2E failure was corrected only by supplying synthetic process configuration; no test assertion or production behavior was weakened. Seven empty `/tmp/saefr-upload-http-test-*` directories created by that failed run were identified by timestamp and removed individually with `rmdir`. Seven directories timestamped earlier on 2026-10-22 at 01:39 IST predated this run and were left untouched. The successful E2E rerun cleaned up its own temporary directories. The Docker listing for the integration-test label was empty after both PostgreSQL suites.

The integration runner was inspected before use. It creates a random `postgres:18` container with generated credentials, a tmpfs data directory, no persistent mount and a random port bound to `127.0.0.1`; the runner and fixture helper verify container identity, ownership, storage, credentials and port before test SQL. The fixture helper builds its connection settings from that verified container rather than inherited `POSTGRES_*` variables. No development Compose service, PostgreSQL volume or stored photograph was accessed by these commands. No migration or operator command was run against the development database.

`npm ci` reported three moderate npm advisories in Vitest-related development dependencies. A separate `npm audit --omit=dev --audit-level=moderate` reported zero production-dependency advisories. Dependency changes and full advisory triage were outside this verification task. GitHub PR #2 showed no check results; this report claims only the local checks above.

## M10 security boundary confirmed in merged source

- `AppModule` imports Auth, Users and Health, but not `AssetsModule`. `main.ts` registers the asset-namespace `onRequest` lockdown before listening. It returns fixed 401 for anonymous callers and 503 for authenticated callers, including administrators, before multipart or storage work. The post-merge HTTP and real-socket suites passed the route/role matrix.
- Startup calls `AuthSessionService.assertReady()`, which requires the managed M10 schema. Neither startup nor the HTTP application invokes migration execution. Migrations remain explicit CLI operations.
- There is no public registration or first-admin HTTP endpoint. Local bootstrap/recovery live in a standalone operator service; administrator account mutations require role checks, current-password reauthentication and database locking. Restricted password-change sessions are denied privileged routes.
- `PasswordService` uses Argon2id. Login stores only a SHA-256 hash of the opaque session credential. Resolution requires an unexpired session and active account; password changes, recovery, logout-all and account disable revoke sessions. Existing concurrency regressions passed.
- Default-deny route protection, exact Origin on login and unsafe authenticated requests, CSRF checks, and browser-cookie-only transport remain in place. No administrator photo bypass or owner assignment exists.

The review and passing tests do not prove behavior under a production proxy, after a host crash, or for every future route alias. An already-authorized request can finish after revocation.

## Remaining gates

M10 implementation and integration are complete, but **not production-ready**. The existing development database has not been migrated. Any real-data upgrade needs an isolated rehearsal, verified database and media backups, a recovery plan and separate approval. Production HTTPS, reverse-proxy/cookie behavior, temporary-password delivery, target-hardware Argon2 performance and CI remain unverified. In-memory throttling resets on restart. Filesystem write/cleanup failure injection and database/filesystem crash reconciliation remain open from M9. M11 must establish explicit ownership and repository-level authorization before production ownerless asset routes can reopen; administrators must not gain blanket media access. Manual API testing was completed previously against an isolated temporary database and its container was removed, as recorded in the [M10 summary](milestone-10-report.md); it was not repeated in this post-merge run.

The [M11 planning draft](milestone-11-planning-draft.md) is a proposal requiring maintainer review. No M11 implementation, PR, commit, push or deployment was performed here.
