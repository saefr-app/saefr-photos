# Milestone 08 — Database migrations

- **Status:** Awaiting maintainer review
- **Branch and base commit:** `refactor/nestjs-migration`, `977514c`
- **Implemented commit:** None; M8 changes are uncommitted
- **Date:** 2026-10-17 IST
- **Scope:** The maintainer's M8 request and verified legacy schema supplied in this chat; no separate M8 specification file existed in the repository.

## Implementation overview

Added standalone, version-controlled Kysely migrations for PostgreSQL 18, explicit CLI configuration, an immutable initial asset version, strict compatibility checks and isolated migration tests. Fresh installations can create the required schema. Existing SQLModel installations can opt into a checked baseline that records the initial migration without changing the table or its records. Repeated execution is idempotent. Incompatible schemas, damaged history and partial metadata fail without destructive repair.

Application startup, API routes/services/repositories, existing database connection behavior, root Compose configuration, media storage and dependency versions are unchanged. No migrations were run against the existing development database.

## Files created and modified

| Path | Change |
| --- | --- |
| `server-nest/src/database/migrations/versions/202610170001_initial_asset.ts` | Initial schema creation or explicitly authorized legacy baseline; destructive rollback refused |
| `server-nest/src/database/migrations/legacy-asset-schema.ts` | Frozen catalog-based compatibility contract for the initial version |
| `server-nest/src/database/migrations/migration-provider.ts` | Immutable version registry through Kysely's standard provider interface |
| `server-nest/src/database/migrations/migration-runner.ts` | Serialized preflight/bootstrap, schema/history validation, Kysely execution and safe error descriptions |
| `server-nest/src/database/migrations/migration-config.ts` | Dedicated required connection settings and explicit CLI confirmation |
| `server-nest/src/database/migrations/cli.ts` | Compiled status/up entry point, nonzero failure status and connection cleanup |
| `server-nest/src/database/migrations/migration-config.spec.ts` | Configuration/argument guards and secret-safe error unit tests |
| `server-nest/test/helpers/integration-database.ts` | Extracted existing M7 container-isolation guard for reuse |
| `server-nest/test/migrations.integration-spec.ts` | Fresh, legacy, repeat, concurrency, failure, rollback and compiled CLI scenarios |
| `server-nest/test/assets.integration-spec.ts` | Existing seven repository tests now create the schema through migrations |
| `server-nest/test/run-integration.mjs` | Optional migration-suite filter; retains the M7 container lifecycle and safety checks |
| `server-nest/package.json` | Migration/status/typecheck scripts and migration-specific test command; integration commands build compiled CLI first |
| `server-nest/README.md` | Migration/test commands and guide link |
| `docs/development/database-migrations.md` | Detailed strategy, configuration, safe baseline/recovery instructions and future deployment design |
| `docs/architecture.md`, `docs/roadmap.md` | Current M8 implementation and approval boundaries |
| `docs/development/milestone-07-report.md` | Historical follow-up: M7 commit and maintainer-provided schema confirmation |
| `docs/development/milestone-08-report.md` | This verification and review report |

## Architecture and baseline strategy

The strategy was reviewed before implementation: use Kysely's own `Migrator` and ledger rather than manual migration-record insertion, validate the exact legacy contract, require explicit baseline intent, keep migration execution separate from API startup and test only disposable databases.

The current schema contract comes from the maintainer's real `psql \d+ public.asset` inspection: UUID `id`, unbounded VARCHAR `filename`/`mime_type`/`storage_path`, INTEGER `size`, and TIMESTAMP WITH TIME ZONE `created_at`, all NOT NULL and without database defaults. `asset_pkey` is the sole primary key/index on `id`. This matches M7's SQLModel-generated DDL. M8 did not query the real table or inspect historical row contents.

The runner uses a standard Kysely `MigrationProvider` with explicit ESM imports of version files, avoiding a new dependency or build-dependent file discovery. Kysely stores successful versions in `public.kysely_migration` and maintains `public.kysely_migration_lock`. The runner serializes preflight and metadata bootstrap with a PostgreSQL session advisory lock; Kysely retains its own migration lock and transactional execution. A concurrency test used two separate pools and confirmed that only one applied the initial version.

Catalog validation checks types, nullability, defaults, identity/generated columns, primary keys, indexes and incompatible table features. Partial or malformed metadata and unknown/missing/out-of-order history are rejected. The current preflight also detects a managed database whose asset table has disappeared and refuses to recreate it. The initial migration locks and revalidates a legacy table before recording the baseline. No `ALTER`, copy, rename, replacement or row update is used in the baseline path.

## Fresh-install and existing-install behavior

| Target state | Result |
| --- | --- |
| Empty PostgreSQL 18 database with `public` schema | Create the exact asset table and record the initial version |
| Compatible untracked legacy table, no baseline flag | Refuse before metadata creation; require `--baseline-legacy` |
| Compatible legacy table with baseline flag | Retain the existing table and rows; record the version through Kysely |
| Fully migrated database | No pending changes; ledger timestamps and table remain unchanged |
| Baseline flag on missing table | Refuse; require the fresh-install path |
| Incompatible table or damaged/partial ledger | Fail nonzero without attempting repair |
| Pending migration fails | Roll back pending version DDL and ledger entries; Kysely bootstrap metadata may remain |
| Attempt to migrate down from the initial version | Refuse to drop potentially legacy data |

There is no automatic development upgrade. The CLI requires all five `MIGRATION_POSTGRES_*` settings and `--confirm-database` matching the target. It never loads `.env` or falls back to application `POSTGRES_*` variables. `db:status` reads compatibility/history without creating tables or rows; its advisory lock is session-only. Existing installations must receive separate migration approval after backup and recovery review.

## Verification results

Environment: Node.js `v24.22.0`, npm `11.19.1`, Docker Engine `29.7.2`, installed Kysely `0.29.6`, Vitest `4.1.11`. All npm commands ran from `server-nest/`. Real integration connections verified PostgreSQL major version 18.

| Command | Actual result |
| --- | --- |
| `npm run build` | PASS; Nest compiled the migration CLI and version files |
| `npm run typecheck` | PASS; source and tests type-check |
| `npm run lint` | PASS without warnings after fixing a numeric-sort comparator |
| `npm run test` | PASS: 6 files, 31 tests (22 existing and 9 migration/configuration cases) |
| `npm run test:e2e` | PASS: 4 files, 18 mocked HTTP E2E tests |
| `npm run test:integration` | PASS: 2 files, 35 real PostgreSQL tests (7 repository + 28 migration) |
| `npm run test:migrations` | PASS: 1 file, 28 real PostgreSQL migration tests |
| Targeted `npx prettier --check` on all changed/new TypeScript and runner files plus package.json | PASS after targeted formatting |
| `git diff --check` | PASS |

The migration suite independently builds legacy fixtures, verifies table OID/physical relation identity and complete synthetic row snapshots before/after baselining and repeat execution, and confirms retained storage-path strings. Negative scenarios cover missing/extra columns, wrong timestamp/size/string types, nullability/default differences, missing/renamed primary keys, extra constraints/indexes, RLS, a view at the asset name, partial/damaged Kysely metadata, unknown history, a missing managed table and insufficient schema privileges. A controlled later-version failure verifies transaction rollback and retry; a down attempt verifies the refusal to drop the baseline. Compiled CLI tests cover fresh status, create/repeat execution, and explicit legacy opt-in, while inherited application connection settings deliberately point elsewhere.

The initial type check exposed Kysely generic incompatibility when the existing typed repository connection was passed to the runner; the runner and catalog inspector now preserve the caller's database generic. Final type checks passed. No failed or skipped tests are presented as passes.

## Security and data preservation

Every migration scenario runs inside the existing M7 disposable PostgreSQL container, after its image/name/label/credentials/tmpfs/localhost-port guards pass. Tests create a random database per scenario and remove only that test database after closing its pool. The permission scenario creates and removes a random role only in the disposable cluster. Test fixtures deliberately alter or drop disposable objects to exercise failure handling; none target the regular development connection settings. The container has no development database volume or media bind mount.

The final test runs removed their containers. Read-only Docker inspection observed the existing `saefr-photos-db` container running with `saefr-photos_saefr_photos_db_data` at `/var/lib/postgresql`; no lifecycle command, SQL statement or migration was issued against that container/database. No commands modified or read photo contents under `storage/`. These are operation/isolation guarantees, not a claim that real development rows or media were independently checksummed.

The CLI suppresses raw driver errors and SQL/row details, reports errors with a nonzero exit status and closes its pool in `finally`. It imposes connection/lock/statement timeouts. Migration source has no storage-service dependency. No secrets, new package dependencies, app behavior changes, Git commits, pushes, branch switches or M9 work were introduced.

## Known limitations and future considerations

- Kysely metadata bootstrap precedes its migration transaction. Valid empty metadata can remain after failure and is retryable. A partial bootstrap requires manual inspection and a separate recovery plan; the runner does not repair it automatically.
- The strict M8 contract rejects customized schemas, including additional indexes that might otherwise be harmless. Such installations need review, not a force flag. Future schema-changing versions must update current-state preflight while preserving the initial migration and frozen legacy contract.
- Kysely tracks names/timestamps, not file checksums. Applied version files must remain immutable through code review and release discipline.
- As recorded in M7, an abrupt runner/process/host termination can leave the disposable test container running. Normal cleanup remains intact; manual cleanup must identify the exact test container rather than remove volumes in bulk.
- Production backup/restore rehearsal, applying a baseline to the actual development database, remote/TLS deployment behavior and Docker deployment integration were **NOT RUN**. They require their own approved targets and operational review. Database server validation currently supports major version 18 only.
- No timestamp conversion, INTEGER-to-BIGINT change, authentication, API startup migration or Dockerized API was introduced.

The guide describes a future one-shot migration job built into the same release image, waiting for PostgreSQL health, using dedicated migration credentials without a media mount, and gating API startup on successful completion. That Docker deployment work is documented only; it is not implemented in M8.

## Repeating verification

```bash
cd /home/kartik/Saefr/saefr-photos/server-nest
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
npm run test:migrations
```

Node.js 24, installed npm dependencies and a running Docker daemon are required. The test runner supplies all test connection settings; do not repoint the application `.env`. See `database-migrations.md` for explicit migration commands on separately approved targets.

## Review gate

- [ ] Maintainer reviewed implementation, schema validator and baseline behavior
- [x] Required automated verification passed
- [x] Current architecture, roadmap and developer instructions updated
- [ ] Commit/push explicitly approved
- [ ] Any real database migration separately approved with a recovery plan
- [x] Milestone 9 not started
