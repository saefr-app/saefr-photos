# Saefr Photos — Roadmap and Milestone Status

**Reference:** `integration` was created from the completed Milestone 9 foundation at `94e54c9` on 2026-10-17 IST. This is the adopted development direction, not a delivery date or proof of unfinished features. Update status after verification.

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

## Adopted integration workflow

- `integration` is the shared baseline, created from the completed Milestone 9 foundation at `94e54c9`.
- Create short-lived feature branches from an up-to-date `integration`; merge them back through reviewed pull requests after relevant checks pass.
- Reserve `main` for the first validated, secure, persistent and documented self-hostable alpha. A merge into `main` requires separate maintainer approval. See the accepted `docs/decisions/0003-branching-and-first-alpha.md`.

## M10 — Authentication Foundation [POST-MERGE VERIFIED ON INTEGRATION]

Phases 10B.1–10B.6 were reviewed and committed on `feat/m10-auth-foundation` through `6751b42`; [PR #2](https://github.com/saefr-app/saefr-photos/pull/2) merged them into `integration` as `acf6ed44bb870fdae56e68c523ba660af6536897` on 2026-10-22. Post-merge build, typecheck, lint, 90 unit, 52 HTTP E2E, 91 disposable PostgreSQL integration, 44 migration and runtime-smoke checks passed after supplying synthetic configuration for E2E in the clean worktree. Manual API testing had previously used an isolated temporary database that was removed. No GitHub CI result is claimed. The existing development database remains unmigrated; production ownerless asset routes remain disabled. M10 is not production deployment-ready. M11 ownership and authorization must precede asset-route reopening; real-data upgrade and deployment require separate approval. See the [post-merge report](development/milestone-10-postmerge-report.md) and [M11 planning draft](development/milestone-11-planning-draft.md).

## Later alpha modules (ordering may adjust)

1. Asset ownership and authorization across every read/write endpoint; data migration/backfill strategy for pre-existing ownerless rows.
2. Asset lifecycle: deletion/trash/recovery, pagination and richer metadata.
3. Dockerized backend/API + PostgreSQL with persistent mounts, migration lifecycle, health checks and fresh-install guide.
4. Redis + BullMQ worker for robust background processing, retries and failed-job visibility. Do not treat BullMQ as a separate container; it is a library running in backend/worker processes.
5. CI and alpha validation: automated checks before PR integrations, production-style smoke test, backup/recovery verification, security review, documentation; first `main` merge and alpha version tag upon approval.

## Future app + ML tracks

- Mobile client, gallery, upload/backup workflows: parallel development can start on stable API contracts, not only after server release.
- Separate Python ML inference service and later intelligent search/recognition: research and prototypes can happen independently; production integration is later.
- No claim of completed mobile app, production-quality sync, video pipeline, face recognition, or ML processing yet.

## Done means

Implementation satisfies agreed acceptance criteria, tests pass with recorded evidence, docs reflect reality, changes reviewed, and commit/push occurs only with human approval. An agent's completion report alone does not mean the work is merged or released.
