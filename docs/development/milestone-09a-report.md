# Milestone 9 — Phase 9A: Runtime configuration and dependency hardening

- **Status:** Committed as `f8930be` after maintainer review; verification below records the pre-commit implementation
- **Branch and base commit:** `refactor/nestjs-migration`, `452473c` (committed M8)
- **Date:** 2026-10-17 IST
- **Scope:** Phase 9A only, as requested in this chat. No separate Phase 9A specification file existed.

## Implementation

`server-nest/src/runtime-config.ts` now validates API settings through the existing Nest ConfigModule before application initialization. Database name, user and password must be nonblank. PostgreSQL/listen hosts must be IP addresses or valid DNS hostnames; ports must be decimal integers from 1 to 65535; `NODE_ENV` must be `development`, `test` or `production`. `STORAGE_ROOT` must be nonblank, contain no NUL byte, and is resolved to an absolute path. Defaults retain `127.0.0.1` for both hosts, `5432` for PostgreSQL, `3000` for HTTP, `development` for environment and the existing `../storage` location. Error messages name invalid settings but never include supplied values. The migration CLI's independent configuration and behavior were not changed.

`main.ts` reads validated values from ConfigService, keeps Nest shutdown hooks, and closes a created app if startup fails. It exits nonzero with a safe error message. A dynamic AppModule import puts configuration-loading errors inside the startup catch. Database and storage services consume validated settings; the PostgreSQL pool still closes in `onModuleDestroy`.

The final self-review removed raw PostgreSQL idle-client error-stack logging. That handler now logs a fixed message so a driver error cannot print connection details or credentials.

Removed unused direct `@nestjs/platform-express`, Express types, Supertest packages and the unconfigured Nest Mau deployment starter. No source or tests imported these packages, HTTP E2E tests use Fastify injection, and the project has no Mau deployment configuration. The unused `deploy` script and starter README deployment claims were removed. Nest's lockfile still names Express as an **optional peer**, but it is no longer installed (`npm ls` showed an empty tree). No replacement dependency or configuration framework was added.

Changed files: `server-nest/src/runtime-config.ts` and `.spec.ts`; `src/app.module.ts`, `src/main.ts`, `src/database/database.service.ts`, `src/storage/local-storage.service.ts`; two storage unit fixtures and two PostgreSQL integration fixtures; `server-nest/package.json`, `package-lock.json`, `README.md`; `docs/architecture.md`, `docs/roadmap.md`, and this report. `docs/development/milestone-08-report.md` now records M8's committed status.

## Verification

All npm commands ran from `server-nest/` on Node.js `v24.22.0`. The final runs after dependency removal were:

| Command | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test` | PASS: 7 files, 45 tests, including 14 new configuration cases |
| `npm run test:e2e` | PASS: 4 files, 18 mocked HTTP tests |
| `npm run test:integration` | PASS: 2 files, 35 tests against disposable PostgreSQL 18; runner removed the container |
| `npm audit --audit-level=low` | PASS: 0 vulnerabilities after unused Mau removal |
| Targeted `npx prettier --check` on changed TypeScript and `package.json` | PASS |
| Compiled invalid-`NODE_ENV` startup smoke | PASS: nonzero exit, setting-specific error, no configured value printed |
| Compiled occupied-port startup smoke with fake DB settings | PASS: nonzero exit and safe failure message; process terminated after cleanup |
| `git diff --check` | PASS |

Self-review reruns after the logging change: `npm run typecheck` PASS, `npm run lint` PASS, targeted Prettier check PASS, and `npm run test:integration` PASS (the command rebuilt the app and ran 35 tests in 2 files). Unit and HTTP E2E results above predate that logging-only change and were not rerun because their behavior was unaffected.

The first integration run **failed** during setup for all 28 migration scenarios because the isolated test helper's PostgreSQL port became numeric while the CLI fixture expected an environment string. Seven repository tests passed in that run. Converting the port to a string at the fixture's CLI boundary fixed it; the full 35-test suite then passed, and the final post-dependency-change run passed again. Each failed and successful run removed its disposable container. The earlier full npm audit reported five development-dependency findings in the unused Mau tree; after removal, the final full audit reported zero.

## Safety and remaining risks

The integration runner used uniquely named PostgreSQL 18 containers with tmpfs data, random localhost ports and test-only credentials; it did not use the development Compose project, volume or `.env`. A read-only Docker listing after the failed run showed no leftover labeled test container. No command migrated or queried the existing development database, and no photo files were changed. Database schema, migration code and public API contracts were preserved. Only explicitly configured `HOST` can bind beyond localhost; public exposure remains unsafe until authentication and authorization exist.

Startup validates syntax and presence, not live database connectivity or filesystem access. Database readiness is still checked by `/health/ready`, and storage errors occur on use. Nest also logs a stack for a validation exception, but the validator's message contains only setting names and fixed guidance. Shutdown-hook behavior under a real signal and successful startup against a real deployment were not manually exercised **at the time of this report**. Phase 9B and 9C were unstarted then.

## Repeating checks

```bash
cd /home/kartik/Saefr/saefr-photos/server-nest
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
npm audit --audit-level=low
```

The integration command requires Docker and creates only its isolated disposable PostgreSQL container. Do not run migration commands against the development database as part of this verification.

## Review gate (historical Phase 9A snapshot)

- [x] Maintainer reviewed Phase 9A diff
- [x] Required automated checks passed on the final implementation
- [x] M8 committed status and current architecture/roadmap updated
- [x] Phase 9A commit approved and completed as `f8930be`; push status is not asserted here
- [x] Phase 9B and 9C not started at the time of this report
