# Milestone 07 — Real PostgreSQL integration tests (implementation specification)

- **Status:** Ready for implementation; **not yet completed**
- **Branch:** `refactor/nestjs-migration`
- **Predecessor:** `19b1467` Swagger/OpenAPI milestone
- **Owner/runner:** Codex in a workspace with explicitly approved local test access

## Goal
Prove that NestJS/Kysely works against a **real isolated PostgreSQL 18 instance**, while preserving the user's existing Docker volume, original images and schema.

## Read first
`AGENTS.md`, `docs/architecture.md`, `docs/roadmap.md`, `server-nest/src/database/*`, `server-nest/src/assets/assets.repository.ts`, `server-nest/src/assets/assets.service.ts`, `server-nest/test/*`, `compose.yml`, `server/app/models/asset.py`.

## In scope
1. Choose a maintainable disposable PostgreSQL 18 strategy (e.g., Testcontainers or dedicated Compose **test-only** service with distinct DB/volumes). State why. Never reuse production/dev secrets or database names without clear isolation.
2. Add integration tests that actually connect to PostgreSQL and exercise `AssetsRepository.create`, `findById`, `findFileById`, `findAll` ordering, and missing-record behavior. Test database `ping()`/readiness where appropriate.
3. Create schema in the disposable DB accurately enough to reflect the legacy Python-created table. Inspect or derive the actual existing schema **read-only** when available; distinguish observed schema from assumptions.
4. Verify UUID, `created_at` time-zone handling, integer size limitations, paths and public response serialization. If mismatch discovered, report it; do not silently alter the real schema in M7.
5. Add explicit test runner script(s) (`test:integration` or similar) and clear setup docs; include cleanup and isolation mechanisms.
6. Keep all existing unit, mocked HTTP E2E, and Swagger tests passing, or report environmental blockers honestly.

## Out of scope
- Migrating, truncating, dropping or resetting the existing PostgreSQL database/table/volume.
- New production schema migrations (M8), new authentication, asset deletion, dockerizing API, Redis/BullMQ (later).
- Broad refactoring, changing public API shape, or unapproved Git operations.

## Acceptance criteria
- The test setup cannot accidentally target the app's ordinary dev DB just because `.env` exists; fail safely if isolation requirements aren't met.
- On a machine with supported Docker/PostgreSQL access, real integration tests **demonstrably** pass with meaningful assertions and cleanup of test resources.
- Existing `npm run build`, `npm run test`, `npm run test:e2e`, `npm run lint` still pass.
- No existing media or database content changes; the agent explicitly checks and reports boundaries and permissions.
- New report `docs/development/milestone-07-report.md` includes commands and actual results, DB isolation proof, schema compatibility findings, uncertainty and risks.
- Stop for human review: **no commit, push, branch switch, or M8 start** without approval.

## Agent handoff instruction
> Implement only Milestone 7 as described here. Inspect the repository before editing. Explain your disposable-database strategy before performing any irreversible command. Keep the development database and storage untouched. Run available relevant tests, create the milestone report, show your diff summary, and stop for review without committing or pushing.
