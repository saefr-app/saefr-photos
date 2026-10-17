# Milestone 9 — Phase 9C: Logging, error handling and final verification

- **Status:** Implemented; awaiting maintainer review; uncommitted
- **Branch and base commit:** `refactor/nestjs-migration`, `69dbeaf` (committed Phase 9B)
- **Date:** 2026-10-17 IST
- **Scope:** Phase 9C as requested in this chat. No separate Phase 9C specification file exists.

## Goal and implementation

The audit found that Nest's default exception handler logs unexpected error objects and may return messages from framework-style HTTP errors. Driver exceptions can contain database details, filesystem paths or user-controlled content. The API now installs one app-wide Nest exception filter. Known application 4xx messages and the readiness 503 remain useful; other exception messages are replaced with stable status messages. Unexpected failures return a fixed HTTP 500 body. Server logs identify an allowlisted route pattern and allowlisted error code/category, never a raw exception, request URL, file path, image metadata or private content. If response headers have already been sent, the filter ends the response; it cannot replace partial streamed content with JSON.

The same safe diagnostic helper now annotates startup, readiness, PostgreSQL idle-client and failed upload cleanup logs. The database shutdown hook catches a failed pool close, logs a safe category and rethrows a fixed-message error so Nest's signal handler cannot print the raw driver stack. Existing Nest shutdown hooks and startup cleanup remain in place. The migration CLI was audited but not changed: it already uses fixed safety messages and a `safeMigrationError` mapping rather than raw driver text.

No logging framework, schema change, migration execution change or new service was introduced. Successful API responses, status codes for existing handled errors and media behavior remain unchanged. An npm runtime smoke command uses fake database settings, a temporary storage root and ephemeral localhost ports.

## Changed files

| Path | Purpose |
| --- | --- |
| `server-nest/src/errors/safe-http-exception.filter.ts` | Sanitize HTTP error responses and unexpected request logs |
| `server-nest/src/errors/safe-error-code.ts` | Fixed, allowlisted diagnostic categories |
| `server-nest/src/errors/safe-error-code.spec.ts`, `server-nest/test/errors.e2e-spec.ts` | Secret-bearing error, response and log checks |
| `server-nest/src/app.module.ts` | Register the Nest-wide filter |
| `server-nest/src/main.ts` | Safe startup and cleanup diagnostics |
| `server-nest/src/database/database.service.ts`, `server-nest/src/database/database.service.spec.ts` | Safe idle-client and shutdown errors; shutdown regression test |
| `server-nest/src/health/health.service.ts` | Safe readiness warning |
| `server-nest/src/assets/assets.service.ts`, `server-nest/src/storage/local-storage.service.ts` | Safe cleanup diagnostics |
| `server-nest/test/runtime-smoke.mjs`, `server-nest/package.json` | Repeatable invalid-config, occupied-port and SIGTERM smoke check |
| `docs/architecture.md`, `docs/roadmap.md` | Current architecture and milestone status |
| `docs/development/milestone-09a-report.md`, `docs/development/milestone-09b-report.md` | Correct their committed status; retain historical test evidence |
| This report and `docs/development/milestone-09-report.md` | Phase and consolidated evidence |

## Verification results

All npm commands ran in `server-nest/` with Node.js `v24.22.0`. The repository branch was `refactor/nestjs-migration`, with a clean tree before work. The integration runner verified each uniquely named PostgreSQL 18 container's tmpfs, test-only credentials and random localhost binding before tests, then removed it. A read-only Docker listing after verification showed no remaining integration container.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run build` | PASS | Nest build completed |
| `npm run typecheck` | PASS | TypeScript no-emit check completed |
| `npm run lint` | PASS | Type-aware oxlint completed |
| Targeted `npx prettier --check` on all changed code and `package.json` | PASS | All matched files formatted |
| `npm run test` | PASS | 9 files, 59 unit tests |
| `npm run test:e2e` | PASS | 6 files, 34 HTTP tests, including safe-response and secret-bearing error cases |
| `npm run test:integration` | PASS | 2 files, 35 tests against disposable PostgreSQL 18; container removed |
| `npm run test:migrations` | PASS | 1 file, 28 migration tests against a separate disposable PostgreSQL 18 container; container removed |
| `npm run test:runtime-smoke` | PASS | Invalid configuration and occupied port exited nonzero without exposing fake settings; SIGTERM closed a localhost listener |
| `node --check test/run-integration.mjs` and targeted Prettier | PASS | Runner syntax and formatting checked after restoring test selection |
| `git diff --check` | PASS | No whitespace errors |

The first runtime smoke run failed because it expected exit code 0 after SIGTERM. Nest's installed shutdown-hook implementation completes shutdown and then re-sends SIGTERM to the process, so a signal exit is expected. The smoke assertion was corrected to accept that signal only after the process exits and the listener is confirmed closed. The final `npm run test:runtime-smoke` passed. Tests intentionally inject a database error containing a fake credential/path; the test output contains only a fixed log category.

After the initial verification, a concurrent edit removed several checks from `test/run-integration.mjs`. Its exact pre-restoration diff was saved at `/tmp/saefr-run-integration-concurrent.patch`. On maintainer instruction, the runner's name/ID, image, label, isolated credentials, tmpfs, localhost-port, signal and ownership-checked cleanup safeguards were restored. A subsequent maintainer request restored the original `--migrations` argument validation and Vitest file selection, leaving all container safeguards intact. Final reruns passed 35 tests in `test:integration` and 28 in `test:migrations`. Each run printed container removal; a `docker ps -a` query by the integration label after each returned no containers. Runner syntax, formatting and `git diff --check` passed after the final correction. The only remaining runner diff against the committed version is the concurrent inspect-by-ID formatting and equivalent Docker `--time` spelling; that diff is outside Phase 9C and excluded from its review patch.

## Security and data safety

The smoke process used `POSTGRES_HOST=127.0.0.1`, a non-development test database name, and port `1`; it requested only `/health`, which does not query PostgreSQL. It used and removed an OS temporary storage root. HTTP storage tests from Phase 9B also use isolated temporary roots. The PostgreSQL integration and migration runners never use the development Compose project, named volume or application `.env`; no migration command targeted the development database. Existing metadata and photographs were not read or modified as part of this phase.

Known application errors keep appropriate 400/404/413/415/503 responses. Unexpected database, filesystem and programming failures return a safe 500 body and leave a fixed route/category diagnostic on the server. Unknown error strings and unrecognized codes are never logged. Logs do not include raw stack traces for request failures; that reduces detail and requires local reproduction or further instrumentation to diagnose unusual failures.

## Limits and remaining risks

- The filter handles exceptions that reach Nest's HTTP pipeline. Fastify errors raised before routing, and transport errors after headers are sent, can follow different paths. A stream failure after response headers cannot be represented as a new JSON error.
- The smoke test confirms process termination and listener closure, but it does not connect to a real database, inspect operating-system file descriptors or prove graceful behavior under hung I/O or host crashes.
- PostgreSQL metadata and files are still not atomic. Crash recovery, ambiguous DB commit outcomes and cleanup failures remain as described in the Phase 9B report. No broad automatic media deletion was added.
- The API has no authentication or asset authorization and is suitable only for localhost development by default. No Dockerized API deployment, Redis/BullMQ worker or production observability is implemented.
- Startup validation does not prove live database connectivity or storage availability. `/health/ready` tests the database when called; storage errors occur on use.

## Repeat verification

```bash
cd /home/kartik/Saefr/saefr-photos/server-nest
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
npm run test:migrations
npm run test:runtime-smoke
```

The two database test commands require Docker and create only disposable PostgreSQL containers. Do not run `db:migrate` or `db:status` against the development database as part of this verification.

## Review gate

- [ ] Maintainer reviewed Phase 9C diff and both M9 reports
- [x] Required checks passed with recorded evidence
- [x] Development database, Docker volume and stored photographs preserved
- [ ] Commit or push approved
- [x] Integration branch and authentication work not started
