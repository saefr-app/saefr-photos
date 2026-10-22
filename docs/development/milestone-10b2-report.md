# Milestone 10 — Phase 10B.2 database foundation report

- **Status:** Implemented and verified in disposable PostgreSQL; awaiting maintainer review
- **Branch and base:** `feat/m10-auth-foundation` from `integration` at `68d6a1a`
- **Date:** 2026-10-21
- **Implemented commit:** None; this phase is uncommitted

## Goal and delivered scope

The approved Phase 10B.2 adds versioned authentication storage without enabling authentication. It creates `public.app_user` and `public.auth_session`, extends Kysely types, registers `202610210001_authentication_foundation`, evolves the migration runner's strict preflight according to applied history, and tests fresh installation, M8-managed upgrade, explicit legacy baseline, repeats, concurrent runs, schema drift and failures on disposable PostgreSQL 18.

The maintainer also approved a phase-order correction: **production asset lockdown must be implemented and verified before functional login is activated in `AppModule`**. The [specification](milestone-10-spec.md), [accepted ADR 0004](../decisions/0004-authentication-foundation.md) and [implementation context](milestone-10-implementation-context.md) record that boundary. This phase does not implement login, account tools, sessions in the running app or asset lockdown.

## Files created and modified

| File                                                                                     | Change                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docs/development/milestone-10-spec.md`                                                  | Phase 10B.1 document, updated with architectural approval and lockdown order                            |
| `docs/decisions/0004-authentication-foundation.md`                                       | Phase 10B.1 proposal, marked ACCEPTED with the correction                                               |
| `docs/development/milestone-10-implementation-context.md`                                | Updated status, schema, test evidence, risks and Phase 10B.3 handoff                                    |
| `docs/development/database-migrations.md`                                                | Documented M10 version, history-aware validation and operational safety                                 |
| `docs/development/milestone-10b2-report.md`                                              | This verification record                                                                                |
| `server-nest/src/database/database.types.ts`                                             | Typed the two new tables; left `asset` unchanged                                                        |
| `server-nest/src/database/migrations/auth-schema.ts`                                     | Catalog checks for absent or exact managed M10 relations                                                |
| `server-nest/src/database/migrations/migration-provider.ts`                              | Registered the new immutable version                                                                    |
| `server-nest/src/database/migrations/migration-runner.ts`                                | Chose absence or exact M10 validation from the Kysely migration ledger                                  |
| `server-nest/src/database/migrations/versions/202610210001_authentication_foundation.ts` | Created the two tables and validated them inside the migration transaction; destructive down is refused |
| `server-nest/test/migrations.integration-spec.ts`                                        | Added disposable-database upgrade, constraint, drift, rollback and concurrency coverage                 |

The original M8 migration, frozen legacy asset inspector, application composition and HTTP code were not changed.

## Schema and migration behavior

`app_user` has UUID `id`; `username` VARCHAR(64) with unique and canonical ASCII format checks; `password_hash` TEXT; `role` and `status` VARCHAR(16) with approved value checks; `password_change_required` BOOLEAN; and `created_at`/`updated_at` TIMESTAMPTZ. `auth_session` has UUID `id` and `user_id`, unique 32-byte `token_hash`, 32-byte `csrf_token`, and TIMESTAMPTZ `created_at`/`expires_at`. Its user FK uses `ON DELETE RESTRICT`; expiry must follow creation. Named primary/unique/check constraints and user/expiry query indexes are installed. Every column is NOT NULL and has no database default. The username check uses PostgreSQL's explicit `C` collation so its ASCII ranges have a stable interpretation.

The runner still validates the exact M8 asset contract and historical migration metadata. Before the M10 ledger entry, authentication relation names must be absent; after it, both tables, columns, constraints and indexes must match the M10 contract. It rejects partial or incompatible states without repair. A fresh database applies M8 then M10. An M8-managed database applies M10 only. An exact legacy asset table still requires `--baseline-legacy`; the unchanged M8 baseline records history without changing the asset table or rows, then M10 applies. Repeated execution returns no pending versions. M10 checks prerequisites and its final schema within Kysely's transaction; failed version DDL and ledger entries roll back. Kysely metadata bootstrap may precede that transaction, as documented in the [migration guide](database-migrations.md).

The tests compared historical asset records, storage-path strings, asset table identity and prior ledger entries before and after upgrade and repeat execution. They also tested real PostgreSQL constraint enforcement, including unique usernames/token hashes, FK restriction, 32-byte values and expiry ordering. No real installation was upgraded.

## Actual verification

All npm commands ran in `server-nest/` with Node.js `v24.22.0`. The isolated commands used `test/run-integration.mjs`, which verifies the disposable PostgreSQL 18 container, credentials, temporary storage and localhost port before running SQL.

| Command                                                                                                | Final result                                                                                             |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                                                        | PASS; also passed inside each final integration command                                                  |
| `npm run typecheck`                                                                                    | PASS                                                                                                     |
| `npm run lint`                                                                                         | PASS                                                                                                     |
| `npm run test`                                                                                         | PASS: 9 files, 59 tests                                                                                  |
| `npm run test:e2e`                                                                                     | PASS: 6 files, 38 tests                                                                                  |
| `npm run test:migrations`                                                                              | PASS: 1 file, 44 tests; disposable container removed                                                     |
| `npm run test:integration`                                                                             | PASS: 2 files, 51 tests; disposable container removed                                                    |
| `npx prettier --check` on changed/new TypeScript                                                       | PASS                                                                                                     |
| `git diff --check`; `git diff --no-index --check /dev/null` for each new file                          | PASS: no whitespace errors; the latter returns status 1 solely because new files differ from `/dev/null` |
| `docker ps -a --filter label=dev.saefr.purpose=milestone-07-integration --format '{{.ID}} {{.Names}}'` | PASS: empty output after final runs                                                                      |

During implementation, an earlier migration run failed three test fixtures; those fixtures were corrected. After making the username check's `C` collation explicit, 25 migration tests initially failed because the validator's expected deparsed constraint text lacked PostgreSQL's extra parentheses. A temporary diagnostic assertion identified the exact catalog text; that diagnostic was removed, the validator corrected and all 44 migration tests passed. No failed run used the development database. The [implementation context](milestone-10-implementation-context.md#h-actual-test-and-check-evidence) retains the sequence.

## Data safety and limitations

The tests created random databases only inside the runner-owned, temporary PostgreSQL container; they dropped their own databases and the runner removed each container. No development PostgreSQL connection, migration, Docker volume operation, media mount, original or thumbnail file operation was performed. The migration source does not alter `asset`, and API startup still does not run migrations. Applying this migration to the development installation requires separate approval, a reviewed backup/recovery plan and an isolated rehearsal.

The validator intentionally rejects customized M8/M10 schemas, including unexpected auth columns/indexes, RLS, triggers and incompatible history. It has been verified against PostgreSQL 18 in the disposable environment, not a restored production snapshot or another PostgreSQL major version. Kysely tracks migration names/timestamps rather than source checksums, so file immutability remains a review discipline. Abrupt termination may leave a disposable test container despite normal and handled-signal cleanup; use the narrow cleanup instructions in `server-nest/README.md` if that happens. Existing ownerless asset routes are still unrestricted because application auth and lockdown are out of this phase; do not expose the API publicly. The frozen M8 asset validator must be evolved in a future reviewed ownership migration before M11 can change `asset`.

## Repeat verification and handoff

From `server-nest/` with Node.js 24 and Docker available, run:

```sh
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:migrations
npm run test:integration
```

The migration-specific and full integration commands each start and clean up a separately verified temporary container. Do not run `db:migrate` against the development database as part of this check. Phase 10B.3 may use the approved schema for passwords and local operator tools only after separate authorization; functional login must remain inactive until asset lockdown is implemented and verified.

## Review gate

- [ ] Maintainer reviewed this phase's diff
- [x] Required source and disposable-database checks passed
- [x] Approved architectural correction recorded
- [ ] Commit or push approved separately
- [ ] Phase 10B.3 authorized separately
