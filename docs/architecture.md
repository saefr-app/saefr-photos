# Saefr Photos — Backend Architecture (as implemented)

**Verified reference:** M9 foundation through `3679682`; M10 merged through [PR #2](https://github.com/saefr-app/saefr-photos/pull/2) into `integration` as `acf6ed44bb870fdae56e68c523ba660af6536897` on 2026-10-22. M11B ownership schema, M11C owner-scoped core and M11D secure HTTP exposure were independently reviewed and committed as `e0b2585`, `a355b138` and `4aa46ed`. M11F passed independent GPT-6 Astra Extra High security review and was committed as `04674f0`; see the [11F report](development/milestone-11f-report.md). [PR #4](https://github.com/saefr-app/saefr-photos/pull/4) merged M11 into `integration` as `2141bb955b251ca44132d13af7ebfe3b18c7dfc2` on 2026-10-23, followed by [local post-merge verification](development/milestone-11-postmerge-report.md). No production deployment or development-database migration has been approved or performed. **Implemented** and **planned** are deliberately separated.

## Authentication and current asset privacy boundary

The production `AppModule` mounts the reviewed owner-scoped `AssetsModule`. Bootstrap installs `registerAssetAccess()` at Fastify's `onRequest` stage before listening: cookie-only authentication, unrestricted-account checks and exact Origin/session CSRF for unsafe asset-namespace methods run before content parsing. Invalid or absent credentials receive sanitized 401, restricted accounts 403, and authentication lookup failures 503. The default-deny Nest guard independently enforces route policy and attaches the typed actor; controllers still require it. A private request-keyed WeakMap reuses successful session resolution within that request, while credential parsing, unsupported-header rejection and guard policy still run. Future requests resolve current session state; upload commit retains 11C's final locked revalidation. Administrators have no media bypass. Legacy NULL-owned rows remain invisible and unassigned.

Namespace detection uses the matched router pattern for actual handlers plus decoded static-path checks for unmatched namespace requests. The shared `createHttpAdapter()` sanitizes malformed-URL errors that happen before hooks. All recognized asset responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Real-socket tests cover matched percent-encoded segments, trailing slashes, unknown unsafe paths, HEAD fallback and full-200 Range responses. Unsupported encoded separators/double encoding remain unavailable; no aliases were added. `/api/v1/me` reports `assetsAvailable:true` only for unrestricted authenticated users/admins, indicating route capability rather than ownership or deployment readiness.

The backend now requires an exact `APP_ORIGIN`. Production requires HTTPS; development/test HTTP is limited to loopback. Browser login at `/api/v1/auth/login` issues a random opaque session credential in an HttpOnly, SameSite=Lax cookie (`__Host-saefr_session` with Secure/Path=/ in production). PostgreSQL stores only its SHA-256 hash. Session resolution checks current account status and expiry on every protected request. Login, `/api/v1/me`, password change, logout, logout-all and own-session list/revocation are implemented. Phase 10B.5 adds administrator-only ordinary-user creation, account listing and account disable. Creation and disable reverify the administrator password under a user-row lock; disable serializes concurrent administrator operations before revoking target sessions. Unsafe authenticated requests require exact Origin and a separate session CSRF token. A default-deny Nest guard protects non-public routes. The single-process login and password-work limits are bounded, with restart and multi-node limits documented in the phase reports.

Startup requires the applied M8, M10 and M11 migration prefix and the exact current asset/authentication catalog through the existing strict migration-status validator. M10-only, partial M11 or tampered history fails before listening. It never runs migrations. Swagger is disabled in the production composition by default. M10 authentication and the [M11 ownership design](decisions/0005-asset-ownership.md) are merged and locally post-merge verified on `integration`, but this is **not** a self-hostable multi-user photo release: existing ownerless records remain quarantined pending a separately approved mapping, and deployment controls remain unverified. Phase 10B.6 expanded Origin, CSRF, restricted-session and asset-lockdown regressions; its actual results are in the [Phase 10B.6 report](development/milestone-10b6-report.md).

## Current system

- **HTTP/API:** `server-nest/` — NestJS 12 on Fastify, Node.js 24, TypeScript ESM/NodeNext. The server binds to `127.0.0.1:3000` by default while deployment controls remain unverified.
- **Runtime configuration:** Nest ConfigModule loads the existing environment files and validates database, listen, environment, storage and exact `APP_ORIGIN` settings before application initialization. Database name, user, password and application origin are required; host, ports, environment and storage path have explicit defaults. Startup errors do not print configuration values. The migration CLI retains its separate `MIGRATION_POSTGRES_*` configuration and never runs during API startup.
- **Database:** PostgreSQL 18 with a Kysely query builder and `pg` connection pool; root `compose.yml` starts the **database only**. NestJS currently runs on the host, not in Docker.
- **Files:** local root `storage/originals/` contains original image bytes; `storage/thumbnails/` contains JPEG previews.
- **Processing:** Sharp/libvips validates JPEG, PNG, WebP and generates 300px bounding-box JPEG thumbnails (quality 85). Multipart parsing and storage independently enforce a 20 MiB file limit; Sharp rejects images over 40 million pixels and multi-page images.
- **Documentation:** Swagger is disabled by default in the M10 production composition. Legacy asset OpenAPI behavior remains covered in an isolated test composition.
- **Errors and logs:** Nest's app-wide exception filter returns stable, sanitized HTTP error bodies. An early media-stream failure clears stale media headers before the JSON error is sent; a failure after headers are sent closes the connection. Unexpected request failures log a known route pattern and allowlisted error category, never raw exception objects. Readiness, storage cleanup, PostgreSQL idle-client and startup failures likewise avoid raw driver messages and filesystem paths.
- **Legacy code:** `server/` contains the previous FastAPI + SQLModel implementation. The existing PostgreSQL `asset` schema originated there; existing image files remain in `storage/`.

## Request flow

```mermaid
flowchart TD
  Client[Browser session] --> Gate[Fastify onRequest: identity and Origin/CSRF]
  Gate --> Guard[Nest default-deny guard]
  Guard --> Controller[NestJS AssetsController]
  Controller --> Service[AssetsService]
  Service --> Repo[AssetsRepository / Kysely]
  Repo --> DB[(PostgreSQL: asset table)]
  Service --> Storage[LocalStorageService]
  Storage --> Originals[storage/originals]
  Storage --> Thumbs[storage/thumbnails]
  Storage --> Sharp[Sharp image processing]
```

### Owner-scoped asset implementation

The flow below is mounted in the merged `integration` application behind the early gate. Isolated component/storage tests are also retained. Post-merge verification used disposable PostgreSQL and temporary media, not the development database or stored photographs.

#### Upload: `POST /api/v1/assets/upload`

1. After early authentication/Origin/CSRF and the guard, the controller accepts one multipart `file` part, starts its stream immediately, and enforces part and file-size limits.
2. Controller forwards filename, claimed MIME type and stream to `AssetsService.upload()`; it also verifies the multipart parser reached the request's end before storage publishes files.
3. Service validates/sanitizes filename, creates a UUID and calls `LocalStorageService.saveImage()`.
4. Storage streams to a private temporary original with a second 20 MiB limit. Sharp checks actual file format/dimensions and generates a temporary thumbnail.
5. After full multipart validation, storage hard-links the temporary files to UUID-derived final names. Existing final files cannot be overwritten. The reviewed 11C core then locks the actor's user and session rows in a short transaction, rechecks active/unrestricted status and database wall-clock expiry, and inserts metadata with the actor's owner UUID.
6. Normal stream, parsing, image, and filesystem failures remove temporary and newly published files where the filesystem permits. The 11C core attempts to remove only this upload's files after failure before transaction callback entry or an acknowledged callback rollback; it retains files if COMMIT outcome is uncertain or acknowledged. Cross-filesystem/DB atomicity is **not guaranteed**; crash recovery and reconciliation remain planned.
7. Returns `201 Created` with public asset metadata (`storage_path` is never in the public response).

#### Retrieval

- `GET /api/v1/assets/` (and without trailing slash) returns only actor-owned metadata, newest first.
- `GET /api/v1/assets/:assetId` uses an owner predicate and returns metadata or the same 404 for foreign, ownerless and missing rows.
- `GET /api/v1/assets/:assetId/original` and `/thumbnail` require scoped metadata before any storage open. Foreign, NULL-owned and absent valid IDs have the same sanitized 404 before storage is opened. HEAD uses the same scope checks with no body; Range is ignored, preserving full 200 responses.
- `GET /health`: process liveness response; `GET /health/ready`: performs database `SELECT 1` and returns 503 if unavailable.

## Current backend layout

```text
server-nest/
  src/
    main.ts              # app bootstrap, asset boundary, schema readiness
    app.module.ts        # Config, Health, Auth, Users, scoped AssetsModule
    http-adapter.ts      # shared Fastify options and safe pre-hook URL errors
    runtime-config.ts    # validated API runtime settings and defaults
    errors/              # safe HTTP exception responses and log categories
    assets/              # HTTP controller, orchestration, Kysely repository, DTO
    auth/                # browser sessions, guard, origin/CSRF, asset boundary
    users/               # administrator account API and local operator tools
    database/            # connection pool, Kysely types, DB ping
      migrations/        # standalone CLI, schema checks, immutable versions
    health/              # health and readiness checks
    storage/             # original/thumbnail reading, upload staging, Sharp
    openapi/             # Swagger setup
  test/                  # mocked HTTP tests and isolated PostgreSQL integration tests
  package.json           # npm scripts and dependencies
server/                  # legacy Python backend (do not delete yet)
compose.yml              # only PostgreSQL currently
storage/originals/       # ignored original files (preserve)
storage/thumbnails/      # ignored generated files (preserve)
```

## Verified database schema and migrations

The maintainer's `psql \d+ public.asset` inspection confirmed UUID `id`, unbounded VARCHAR `filename`/`mime_type`/`storage_path`, INTEGER `size`, and TIMESTAMP WITH TIME ZONE `created_at`. All columns are NOT NULL with no database defaults; `asset_pkey` is the primary key/index on `id`. This matches the SQLModel-generated schema tested in M7. M8 did not independently query the development database.

The standalone migration CLI uses Kysely `Migrator`, version files and `public.kysely_migration`/`public.kysely_migration_lock`. Fresh installs create the verified schema. Explicitly opted-in legacy baselines validate and lock the existing table, then record the initial version without changing the table or rows. Incompatible schemas/history fail without automatic repair. A runner advisory lock serializes preflight/bootstrap; Kysely applies pending versions and ledger entries transactionally. Metadata bootstrap itself precedes that transaction and may remain after failure.

The Phase 11B version adds nullable `owner_id` to `asset`, an owner FK, ordering index and an enforced but unvalidated non-NULL check. Migration history selects the frozen M8 inspector for pre-M11 assets or an exact M11 inspector after that version. Existing asset rows and paths remain unchanged, with NULL ownership. The schema source is merged into `integration`, but it has been applied only to disposable test databases; the development database was not upgraded. The 11D API requires M11 readiness before listening and enforces owner-scoped asset authorization.

The merged M12B migration adds asset lifecycle columns, a separate permanent-deletion journal and an initially empty `storage_binding` singleton table. Its exact validator preserves historical M8/M10/M11 schema contracts. The M12C feature branch adds marker-v2 parsing, binding verification, a provider-backed image adapter selected only for exact M12 schema history, explicit synthetic-tested provisioning/adoption/recovery primitives, upload asset-ID coordination and a descriptor-only Linux observer. The feature-branch production bootstrap accepts exact M11 history unchanged and exact M12 history for authenticated metadata-only access when storage is unadopted or unavailable. M12 media operations require both verified role identities at operation time and never fall back to M11 storage. Invalid history refuses startup before listening. Focused native ext4 and process-kill tests passed on a disposable hosted VM; broader crash and deployment certification remains open. No M12 storage behavior is deployed or approved for real-data use.

Migration commands require dedicated `MIGRATION_POSTGRES_*` settings and database confirmation, and never run during API startup. See [database-migrations.md](development/database-migrations.md). The application still exposes `created_at` as UTC ISO text and keeps storage paths internal.

## Known limitations / not yet implemented

- Phases 11B, 11C and 11D are independently reviewed checkpoints. Phase 11F completed fresh regression verification, passed independent GPT-6 Astra Extra High review with a PASS verdict, and was committed as `04674f0`. M11 merged into `integration` through [PR #4](https://github.com/saefr-app/saefr-photos/pull/4) at `2141bb9` and passed [local post-merge checks](development/milestone-11-postmerge-report.md). Legacy NULL-owned rows remain quarantined, and optional M11E mapping is deferred. Public exposure, deployment and real-data migration remain unapproved. See the [11F report](development/milestone-11f-report.md) for its historical pre-merge evidence.
- No asset deletion/trash or cursor pagination.
- Component HTTP tests mock repository/storage; the 11D production-composition matrix uses real localhost sockets, real sessions/PostgreSQL and temporary media. Only failure-injection cases replace storage reads or session lookup. Phase 9B also runs upload HTTP cases against real storage in isolated temporary directories. The separate PostgreSQL 18 suite verifies the migrated schema, repository behavior, legacy baselining, repeat runs, concurrency and failure cases using a disposable database. Real development migrations and restoration from a real backup were not exercised.
- `size` remains a signed 32-bit INTEGER. No large-file or timestamp conversion was introduced. Historical development records were not inspected or changed by M8.
- Cross-system upload durability and startup recovery are not complete. A process/host crash can strand temporary files, one published file, or files without metadata. The reviewed 11C core retains files when COMMIT outcome is uncertain, avoiding deliberate deletion of possibly committed media. Cleanup after an acknowledged rollback can fail if the filesystem is unavailable or permissions change. No broad automatic deletion is implemented.
- Focused filesystem write-failure injection remains to be added. Existing tests cover stream interruptions, invalid images, collisions, simulated database failures and a cleanup failure that preserves the original error.
- Local filesystem safety assumes the configured storage root and its parent are controlled by the operator; it does not defend against a privileged process replacing directories concurrently. Isolated filesystem/NAS support and a full upload resource threat model remain future work.
- No fully Dockerized backend or Redis/BullMQ worker yet; no mobile application or ML service integrated.
- Swagger/OpenAPI remains in source for isolated tests but is disabled in the production composition during M10.
- Explicit `HOST` values can bind the API beyond localhost; TLS/proxy and deployment controls are still required before public exposure. Startup validates configuration and the exact managed M11 schema, but does not create storage directories.
- The app handles SIGTERM through Nest shutdown hooks and closes its HTTP listener and Kysely pool. The standalone runtime smoke checks safe configuration and database-startup failures; a real localhost listener and SIGTERM are checked against disposable PostgreSQL in the authentication integration suite. Neither proves behavior during a host crash, blocked I/O or a real production deployment. An error after streaming response headers have been sent cannot be turned into a fresh JSON error response.
- Logs retain safe route/category diagnostics but do not yet have request correlation, durable collection or alerting. Malformed URL errors before Nest hooks have fixed JSON responses. Deployment-facing proxy/TLS and other transport error behavior still need review with a secured production stack.

## Documentation rule

Source code and actual test observations supersede stale diagrams. Update this file when architecture changes, and mark new capabilities as **planned** until implemented and verified.
