# Database migrations

## M11 ownership foundation (Phase 11B; committed on the feature branch)

The new version `202610220001_asset_ownership` adds nullable UUID `public.asset.owner_id` without a default. It adds a validated, non-deferrable foreign key to `public.app_user(id)` with `ON DELETE RESTRICT` and `ON UPDATE NO ACTION`, a B-tree index on `(owner_id, created_at DESC, id DESC)`, and an enforced `CHECK (owner_id IS NOT NULL) NOT VALID`. Existing rows remain NULL-owned; the check rejects new NULL inserts and updates to old NULL-owned rows until ownership is supplied. It is intentionally unvalidated even on fresh installations.

The runner validates Kysely metadata and the ordered migration ledger before choosing an asset inspector. Before M11 is applied, it uses the frozen M8 asset contract and rejects premature ownership objects. After M11, it uses the exact ownership catalog contract and rejects missing, changed or extra columns, constraints, indexes, triggers, rules, row security and relation substitutions. M8 and M10 migration files and historical inspectors are unchanged. Status remains read-only, and API startup never applies a version. The reviewed M11D feature-branch application mounts owner-scoped asset routes behind an early authentication gate and requires exact M11 readiness before listening. This is not deployment approval.

Fresh, M8-managed, M10-managed and explicitly baselined compatible legacy databases are supported by the disposable tests. This source change **does not authorize** a real database upgrade. Old application binaries have a strict validator that rejects the M11 schema; use a maintenance window and a separately reviewed backup, recovery and isolated rehearsal plan before seeking approval for any real migration. Historical NULL rows remain quarantined and must not be assigned by inference.

For recovery planning, `NOT VALID` exempts existing NULL-owned rows from the initial scan, but the enforced check rejects subsequent NULL inserts and updates. Restoring historical NULL-owned rows into an already-M11 schema can therefore fail; an isolated restore may need to load the legacy data before installing the M11 check (for example, restore the pre-M11 state, then apply the reviewed migration). The restore order and matching media backup need a separate rehearsal and approval. No real-data restore was rehearsed in Phase 11B.

The following M10 and M8 sections retain their original historical design and verification context. Their present-tense descriptions of the then-current version count and asset validator refer to those earlier phases.

## M10 authentication foundation (Phase 10B.2)

M10 adds the immutable version `202610210001_authentication_foundation` after the M8 asset version. It creates only `public.app_user` and `public.auth_session`, with required UUIDs, timestamps, canonical usernames, role/status checks, a restricted user foreign key, 32-byte session/CSRF checks, expiry ordering, and the named unique/query indexes specified in the [approved M10 specification](milestone-10-spec.md). It does not alter `public.asset`, assign owners, create accounts, activate login, or touch media files.

The runner now checks schema according to applied history: no authentication relations are permitted before the M10 version; after it is recorded, both authentication tables must exactly match the approved catalog contract. Every state still validates the unchanged historical `asset` schema through the frozen M8 inspector. Reserved-name collisions, incomplete tables, missing/wrong constraints and indexes, altered defaults or types, row security and damaged history fail without repair. The new migration checks for collisions before DDL and validates the result inside Kysely's migration transaction. A failed pending version rolls back its DDL and ledger entry; Kysely metadata bootstrap remains subject to the existing M8 limitation below.

Fresh installs apply both versions. An M8-managed database applies only the new M10 version. A compatible untracked legacy asset table still requires explicit `--baseline-legacy`; the runner records the M8 version through its unchanged baseline procedure, then applies M10. Repeat execution has no pending changes. The API does not run migrations at startup. The M10 source migration has no automatic destructive down path.

**The Phase 10B.2 authorization covered source and disposable PostgreSQL tests only.** It did not authorize running `db:migrate` or `db:status` against the development database. Review backups, schema compatibility, recovery and an isolated rehearsal before seeking separate approval for any real upgrade. The M10 application now requires the managed authentication schema at startup and blocks all production asset routes; asset ownership remains absent and M11 authorization is required before reopening them.

The remainder of this document records the original M8 migration design and commands, which remain in force.

M8 introduces a standalone, explicit migration command for PostgreSQL 18. Starting the Nest application does **not** run migrations. The application API and database connection settings are unchanged.

## Architecture and version history

- Version files live in `server-nest/src/database/migrations/versions/`. The first is `202610170001_initial_asset.ts`.
- `migration-provider.ts` registers immutable version files through Kysely's standard `MigrationProvider` interface. Explicit ESM imports work in both compiled Node code and Vitest, without filesystem discovery or another dependency.
- Kysely's `Migrator` orders and executes versions, records successful versions in `public.kysely_migration`, and maintains `public.kysely_migration_lock`. Do not edit or manually insert ledger records.
- A PostgreSQL session advisory lock serializes the runner's preflight and metadata bootstrap. Kysely retains its own PostgreSQL lock and transaction for pending migrations. The CLI uses a single connection, a five-second connection timeout, a five-second lock timeout and a 30-second statement timeout. Kysely's internal lock acquisition remains bounded by the statement timeout.
- The namespace is fixed to `public`; connection search path is explicitly `pg_catalog,public`. The runner rejects unsupported PostgreSQL major versions.

See the [Kysely Migrator API](https://kysely-org.github.io/kysely-apidoc/classes/migration.Migrator.html) for the underlying migration contract. In particular, migration methods return an error result rather than throwing; this runner checks that result before printing success.

## Baseline strategy reviewed for M8

The maintainer inspected the real legacy table with `psql \d+ public.asset` and supplied this contract:

| Column         | PostgreSQL type          | Nullability/default  |
| -------------- | ------------------------ | -------------------- |
| `id`           | UUID                     | NOT NULL; no default |
| `filename`     | unbounded VARCHAR        | NOT NULL; no default |
| `mime_type`    | unbounded VARCHAR        | NOT NULL; no default |
| `size`         | INTEGER                  | NOT NULL; no default |
| `storage_path` | unbounded VARCHAR        | NOT NULL; no default |
| `created_at`   | TIMESTAMP WITH TIME ZONE | NOT NULL; no default |

The sole primary key/index is `asset_pkey` on `id`. This agrees with the SQLModel-generated DDL tested in M7. Column order does not affect compatibility.

The runner takes these paths:

1. **Fresh database:** preflight finds no asset table or applied history. The first migration creates exactly the table above, then Kysely records the version in the same migration transaction.
2. **Legacy table without applied history:** normal migration refuses to proceed. With `--baseline-legacy`, preflight checks the complete contract. The initial migration locks the existing table against concurrent DDL, checks it again, and returns without altering the table or its records. Kysely then records the version. No hand-written ledger insertion, `CREATE TABLE IF NOT EXISTS`, copy, rename or replacement is used for baselining.
3. **Already managed:** validate the current M8 schema and metadata, then let Kysely execute pending versions. With no pending versions, the ledger timestamps and asset table stay unchanged. The baseline flag is not needed on subsequent runs.
4. **Incompatible or partial schema:** exit nonzero with a schema/history error. There is no automatic repair. Missing or extra columns, wrong types/precision/nullability/defaults, extra indexes or constraints, different primary keys, RLS, inheritance, partitions, views, custom triggers/rules and malformed migration metadata require manual review. This is intentionally stricter than accepting an arbitrary customized installation.

The baseline checks catalog metadata rather than assuming that a table with the right name is compatible. It does not scan media files or read asset contents. PostgreSQL table locks may briefly wait for other work; use a maintenance window and avoid unrelated DDL during migration.

## Commands and explicit connection configuration

Run npm commands from `server-nest/` with Node.js 24. Each migration npm command builds the current source before launching the compiled CLI.

Supply **all** of these settings through an approved environment or secret mechanism:

| Variable                      | Purpose                                        |
| ----------------------------- | ---------------------------------------------- |
| `MIGRATION_POSTGRES_HOST`     | Explicit PostgreSQL host                       |
| `MIGRATION_POSTGRES_PORT`     | Explicit port, 1–65535                         |
| `MIGRATION_POSTGRES_DB`       | Intended database                              |
| `MIGRATION_POSTGRES_USER`     | Migration role                                 |
| `MIGRATION_POSTGRES_PASSWORD` | Migration credential; never commit or print it |

The CLI does not load `.env` and does not fall back to application `POSTGRES_*` settings. No example here supplies the existing development database's credentials.

```bash
# Inspect compatibility and applied/pending versions; does not create metadata.
npm run db:status

# Only for a fresh or already managed target reviewed for migration:
npm run db:migrate -- --confirm-database="$MIGRATION_POSTGRES_DB"

# One-time opt-in for a reviewed legacy installation, after backup approval:
npm run db:migrate -- --confirm-database="$MIGRATION_POSTGRES_DB" --baseline-legacy
```

The confirmation must exactly match the configured database. Missing/invalid settings, unsupported arguments, failed compatibility checks, connection errors and migration errors exit nonzero. Error output omits raw driver messages, connection secrets and row values. No `down`, `reset` or destructive repair CLI is provided; the first migration's `down` function also refuses to drop the asset table.

**These instructions do not authorize applying migrations to the existing development database.** That operation requires separate maintainer approval and a reviewed backup/recovery plan. Before an existing installation's first baseline, review its schema, take a PostgreSQL backup, verify the matching media backup/recovery process, and test the baseline on a disposable restored copy. No backup or migration of development data was performed in M8.

## Failure and recovery boundaries

Pending version changes and their ledger entries are transactional on PostgreSQL. A failure rolls them back. Kysely creates its metadata tables and lock row **before** the migration transaction, so a failed first run can leave empty, valid metadata. The runner permits retry with that valid state.

A crash during metadata bootstrap can instead leave only one metadata table or a missing lock row. The runner refuses that partial state. Inspect it and prepare a separate recovery plan; do not delete metadata or recreate asset tables to make a command pass. Applied history with a missing `asset` table also fails instead of creating an empty replacement.

Successful versions must not be renamed, edited or removed. Kysely tracks names/timestamps, not file checksums; code review enforces migration immutability. Add subsequent versions to the provider and test upgrades from each supported prior state. When a future migration changes the schema, evolve the runner's current-state validator separately from the frozen legacy baseline contract.

## Isolated verification

```bash
cd server-nest
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
npm run test:migrations
```

Both integration commands use the M7 disposable PostgreSQL 18 runner. It verifies the container's identity, temporary storage, credentials and localhost port before test SQL. Each migration scenario creates a separate random database within that verified container and drops only that database after closing its connections. The original seven repository tests now install the schema through the migration runner. The migration suite also executes the compiled CLI with explicit test connection settings. No development database or media volume is attached.

Normal completion, test failures and handled signals clean up the container. Abrupt termination can still leave a disposable test container; follow the M7 cleanup instructions in `server-nest/README.md`. Never perform a bulk Docker volume cleanup.

## Future self-hosted Docker deployment (not implemented in M8)

Build the application and migration code into the same release image. Add a one-shot migration service/job that waits for PostgreSQL health and runs:

```bash
node dist/database/migrations/cli.js up --confirm-database="$MIGRATION_POSTGRES_DB"
```

Pass migration credentials through a dedicated secret/environment configuration. The job needs schema/metadata creation rights and, for legacy baselining, sufficient ownership/lock privileges. It needs no media mount. Use a separate API role without DDL privileges where practical. Gate API startup on successful job completion; do not restart a failing migration job indefinitely or put migration side effects in request handling.

For existing installations, perform the reviewed one-time baseline explicitly before adopting the ordinary job. Keep backups and release/recovery procedures in the deployment design. Do not retain `--baseline-legacy` as an automatic repair mechanism. Docker Compose integration, images, backup automation and deployment were not added in this milestone.
