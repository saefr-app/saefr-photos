# Saefr Photos — Roadmap and Milestone Status

**Reference:** Local `refactor/nestjs-migration` working tree based on `e14fd10`, with uncommitted Milestone 7 test changes verified on 2026-10-17 IST. This is the approved development direction, not a delivery date or proof of unfinished features. Update status after verification.

## Completed: initial NestJS functional migration
- NestJS 12 + Fastify + TypeScript foundation, Node.js 24.
- PostgreSQL 18 connectivity via Kysely and health/readiness checks.
- Asset list/single metadata; original and thumbnail streaming.
- Streamed JPEG/PNG/WebP uploads and Sharp thumbnail generation.
- Swagger/OpenAPI documentation and local manual upload/retrieval checks.
- Unit and mocked HTTP tests; the separate real-database suite is described in M7 below.

## Next milestones — work one at a time on `refactor/nestjs-migration`

### M7 — Real PostgreSQL integration tests [AWAITING REVIEW]
An isolated PostgreSQL 18 test suite now verifies repository and readiness behavior against the schema generated from the legacy SQLModel definition. The persisted development table has not yet been inspected because its container was stopped; see `docs/development/milestone-07-report.md` for verified results and the remaining manual check. No commit or next milestone has been approved.

### M8 — Versioned Kysely database migrations [PLANNED]
Introduce migrations, safe baseline of the legacy SQLModel-created `asset` table without destroying data, fresh-install schema creation and repeated idempotent startup behavior. Design and test against disposable copies; review and approve any migration of real development DB separately. Clarify timezone and large-file columns based on M7 findings.

### M9 — Backend hardening [PLANNED]
Configuration validation; safe upload and filesystem edge cases; file-size and image formats; failure cleanup/reconciliation; logging/error responses; cleanup of unused Express-related dependencies; security/configuration verification. Split into smaller commits if necessary. Re-run meaningful end-to-end tests and explicitly record remaining production risks.

## Branching transition **after M9 approval**
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
