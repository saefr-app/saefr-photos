# Saefr Photos — Roadmap and Milestone Status

**Reference:** Backend implementation on `refactor/nestjs-migration` through the completed Milestone 9 corrective commit (`3679682`) on 2026-10-17 IST. This is the approved development direction, not a delivery date or proof of unfinished features. Update status after verification.

## Completed: initial NestJS functional migration
- NestJS 12 + Fastify + TypeScript foundation, Node.js 24.
- PostgreSQL 18 connectivity via Kysely and health/readiness checks.
- Asset list/single metadata; original and thumbnail streaming.
- Streamed JPEG/PNG/WebP uploads and Sharp thumbnail generation.
- Swagger/OpenAPI documentation and local manual upload/retrieval checks.
- Unit and mocked HTTP tests; the separate real-database suite is described in M7 below.

## Backend milestone history

### M7 — Real PostgreSQL integration tests [COMPLETED]
Committed as `977514c`. The maintainer subsequently verified the real legacy schema with `psql`, resolving M7's schema uncertainty. See `docs/development/milestone-07-report.md` for the original test evidence and cleanup limitations.

### M8 — Versioned Kysely database migrations [COMMITTED]
Committed as `452473c`. Standalone Kysely migration commands, fresh-install schema creation, explicit legacy baselining, metadata/history validation and repeat/concurrency/failure tests are implemented. API startup does not run migrations. Existing development data has not been migrated. See `docs/development/milestone-08-report.md` and `docs/development/database-migrations.md`; approval for any real database migration remains separate.

### M9 — Backend hardening [COMPLETED]
Phase 9A was committed as `f8930be`: runtime configuration validation, startup failure handling and unused framework dependencies. Phase 9B was committed as `69dbeaf`: multipart completion, interrupted uploads, temporary-file cleanup, storage paths, collision handling and upload limits. Phase 9C was committed as `99a8646`: sanitized error responses and logging, focused error tests and a startup/shutdown smoke check. The reviewed correction for early media-stream errors was committed as `3679682`. All four commits were pushed, as confirmed by the maintainer. See the three phase reports and `docs/development/milestone-09-report.md`. Upload crash recovery, database/filesystem reconciliation and targeted filesystem failure-injection tests remain future work.

## Branching transition **after separate approval**
- Proposed integration branch name: `integration` (not created automatically by these documents).
- Create `integration` from the verified `refactor/nestjs-migration` head when the user approves.
- From `integration`, create feature branches for substantial modules and merge reviewed PRs back into `integration`.
- Do **not** merge into `main` until first self-hostable alpha validation passes. See `docs/decisions/0003-branching-and-first-alpha.md` (proposal).

## Later alpha modules (ordering may adjust)
1. Authentication: account registration/login, secure sessions, password handling.
2. Asset ownership and authorization across every read/write endpoint; data migration/backfill strategy for pre-existing ownerless rows.
3. Asset lifecycle: deletion/trash/recovery, pagination and richer metadata.
4. Dockerized backend/API + PostgreSQL with persistent mounts, migration lifecycle, health checks and fresh-install guide.
5. Redis + BullMQ worker for robust background processing, retries and failed-job visibility. Do not treat BullMQ as a separate container; it is a library running in backend/worker processes.
6. CI and alpha validation: automated checks before PR integrations, production-style smoke test, backup/recovery verification, security review, documentation; first `main` merge and alpha version tag upon approval.

## Future app + ML tracks
- Mobile client, gallery, upload/backup workflows: parallel development can start on stable API contracts, not only after server release.
- Separate Python ML inference service and later intelligent search/recognition: research and prototypes can happen independently; production integration is later.
- No claim of completed mobile app, production-quality sync, video pipeline, face recognition, or ML processing yet.

## Done means
Implementation satisfies agreed acceptance criteria, tests pass with recorded evidence, docs reflect reality, changes reviewed, and commit/push occurs only with human approval. An agent's completion report alone does not mean the work is merged or released.
