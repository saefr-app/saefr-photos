# Milestone 10 — Authentication Foundation specification

- **Status:** APPROVED architectural contract; Phase 10B.5 separately authorized on 2026-10-22
- **Starting baseline:** `integration` at `68d6a1aa1fc98c8103953c702b5289e79873dde0` (verified 2026-10-21)
- **Working branch:** `feat/m10-auth-foundation`
- **Companion documents:** [implementation context](milestone-10-implementation-context.md), [accepted ADR 0004](../decisions/0004-authentication-foundation.md), [migration guide](database-migrations.md)
- **Draft reviewed:** `/home/kartik/Downloads/saefr-m10-authentication-foundation-spec.md` (external proposal, not an approved repository specification)

This specification describes the approved M10 architectural contract. **Phase 10B.5 is currently authorized; later phases require separate approval.** Requirements below are implementation targets unless the phase reports verify them. The maintainer's approval does not authorize application to the development database.

## Goal and release boundary

Provide account identity, closed provisioning, password authentication, revocable browser sessions, account administration and a typed actor for later authorization. The current `asset` rows have no owner. M10 must therefore make all production asset operations unavailable to everyone, including administrators, until M11 provides reviewed ownership and repository-level predicates. M10 alone is not a self-hostable multi-user photo release.

The trusted host operator can access database and files directly. Per-user privacy in the application is the goal; end-to-end encryption against the host is not part of M10.

## Verified starting architecture and discrepancies

- [`AppModule`](../../server-nest/src/app.module.ts) imports `AssetsModule` and `HealthModule`; there is no auth module or global auth guard. [`AssetsController`](../../server-nest/src/assets/assets.controller.ts) exposes list, upload, metadata, original and thumbnail routes. The legacy table in [`database.types.ts`](../../server-nest/src/database/database.types.ts) has no owner.
- [`main.ts`](../../server-nest/src/main.ts) registers Swagger for non-production environments through [`swagger.ts`](../../server-nest/src/openapi/swagger.ts). Swagger/Fastify routes cannot be assumed to pass through a Nest controller guard. Fastify ignores trailing slashes in the production adapter.
- [`runtime-config.ts`](../../server-nest/src/runtime-config.ts) defaults HOST to `127.0.0.1` and validates PostgreSQL, listener and storage settings. It has no application-origin or auth-specific configuration.
- [`migration-runner.ts`](../../server-nest/src/database/migrations/migration-runner.ts) strictly inspects the frozen [`legacy-asset-schema.ts`](../../server-nest/src/database/migrations/legacy-asset-schema.ts) contract. Only [`202610170001_initial_asset.ts`](../../server-nest/src/database/migrations/versions/202610170001_initial_asset.ts) is registered by [`migration-provider.ts`](../../server-nest/src/database/migrations/migration-provider.ts). There are no auth tables.
- The [roadmap](../roadmap.md) currently says “account registration”; M10 proposes closed administrator provisioning instead. The historical [M9 report](milestone-09-report.md) still describes `integration` as pending, while the current branch and accepted [ADR 0003](../decisions/0003-branching-and-first-alpha.md) confirm it exists. Reconcile those documents in a later authorized documentation phase without rewriting their historical test evidence.

## Functional and security requirements

### Identity and passwords

- Use UUID account IDs. Normalize username by trimming surrounding whitespace and lowercasing ASCII. Accept only 3–64 characters matching `[a-z0-9][a-z0-9._-]{2,63}`; reject canonical duplicates. No email requirement, family ID or profile data.
- Roles are `admin` and `user`; status is `active` or `disabled`. The public API creates only `user` accounts and cannot change roles. There is no public signup, account deletion or impersonation.
- Store only encoded Argon2id password hashes with independently generated salts. Proposed parameters: 64 MiB, three iterations, parallelism one; benchmark on the target test host before finalizing. Proposed password length: 15–128 Unicode code points and at most 512 UTF-8 bytes; preserve exact input, allow spaces/Unicode, reject a small documented local common-password list, and do not impose composition rules. Never silently truncate.
- Administrator-created accounts receive an out-of-band temporary password and `password_change_required=true`. The authenticated administrator must re-enter their own password for provisioning and disable. Whoever receives or creates a temporary password can use it until changed; do not claim a verified delivery channel.
- A restricted first-login session may reach only `/me`, password change, logout and own-session management. Password change verifies the current password, replaces the hash, clears the restriction and revokes all sessions. The user signs in again. Account disable immediately revokes sessions and prevents subsequent authenticated requests.
- Passwords are allowed in validated **request** DTOs only. Never include plaintext passwords, hashes, cookies or session tokens in response DTOs, examples, errors or logs. The independently generated CSRF token is returned only in the authenticated login/current-user response; do not log it or expose it in OpenAPI examples. Disable automatic request-body logging and redact auth headers/cookies.

### Browser sessions

- Use 32 random credential bytes per login (base64url for transport), with only SHA-256 of the random token stored in PostgreSQL. Never accept a client-provided session ID. Query session and current account status on each authenticated request; no authorization cache.
- Proposed absolute expiry: seven days, no sliding expiry. Password-change-required sessions expire after 15 minutes. Proposed limit: ten live sessions per user; reject an additional login with a safe response rather than silently revoking another device. Expired rows remain unusable even before an explicit operator cleanup command removes them.
- Current-session logout, logout-all and individual own-session revocation delete session rows. Another user's or unknown session ID returns the same 404. Clearing a current cookie occurs even if the credential has become invalid where the route can safely identify it.
- Serialize session creation, password change, disable and logout-all on the user row. Recheck account and credential state inside the issuing transaction after password verification. After a revocation transaction commits, subsequent authorization checks fail; requests already authorized cannot be retroactively recalled.
- Browser-only M10: no Authorization bearer header support. Reject simultaneous or unsupported credential mechanisms instead of silently choosing one. Future mobile clients may reuse the user/session model after a separate transport design.

### Cookie, origin, CSRF and throttling

- Require a configured exact `APP_ORIGIN` (scheme, host and optional port; no path, query, credentials or wildcard). Production origin must be HTTPS. Loopback HTTP is permitted only in development/test. Do not infer this value from Host or forwarded headers; do not enable credentialed cross-origin CORS or proxy trust by default.
- Production cookie name: `__Host-saefr_session`, with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no Domain, and expiry matching the server record. Use a distinct development cookie name over explicitly approved loopback HTTP. Never put session tokens in URLs, JSON responses or browser local storage.
- Require exact allowed Origin on all unsafe methods; reject absent, `null` and foreign Origin. Login additionally requires `Content-Type: application/json` and `X-Saefr-Login: 1` to prevent ordinary cross-site form login. Authenticated unsafe methods require an independent random `X-CSRF-Token` bound to the session. `GET /me` supplies it after reload; CSRF tokens cannot authenticate alone. Require `Cache-Control: no-store` for auth responses.
- Proposed single-process, bounded limiter: 30 login attempts per source address and 10 per normalized username per 15 minutes, including unknown usernames; equivalent limits for password reauthentication. Never trust unapproved forwarded IP headers. Bound memory, expire entries and cap concurrent Argon2 work at two with a bounded queue. Return sanitized 429 plus `Retry-After`. Document restart and multi-node limitations.
- Unknown usernames and disabled accounts take comparable password verification work through a dummy hash where practical. Return the same generic login failure. No absolute timing-equality claim.

### Route policy and asset lockdown

- Default-deny every Nest route unless explicitly public. Public routes are only health/readiness and guarded-by-origin/throttle login. Local bootstrap and recovery are **not** HTTP routes. Admin routes require a current active admin actor. Never derive actor ID/role from body, query or request headers.
- Temporarily remove `AssetsModule` from production `AppModule` and mount an explicit unavailable-assets surface. Retain existing assets code and exercise it in a dedicated test composition. Provide an early Fastify `onRequest` boundary to reject asset requests before multipart parsing or storage work. Review Swagger and framework routes separately; Nest guards alone do not cover them.
- **Required ordering:** the production asset lockdown must be implemented and verified before functional login can become active in `AppModule`. Authentication internals may be developed and tested separately beforehand, but no intermediate runnable application composition may expose login while ownerless asset endpoints remain accessible.
- Every path in the asset namespace, including list, upload, metadata, original, thumbnail, unknown subpaths, HEAD, Range and trailing-slash aliases, returns 401 for no valid session; an active authenticated user or administrator receives 503 `{statusCode:503,message:"Asset access is unavailable",error:"Service Unavailable"}` for methods that permit a body. HEAD has the same status and safe headers with no body. No route returns asset bytes, existence or range metadata. A session database failure fails closed with sanitized 503. No admin bypass, static media mount, emergency ownerless flag or public legacy API.
- Swagger is disabled by default in M10. Any optional development exposure must be loopback only and explicitly configured; never publish privileged examples or real credentials. The localhost default remains in place. The API does not become deployment-ready by adding auth alone.
- Extend the existing safe exception filter's fixed allowlists/status labels for 401, 403, 404, 409, 429 and 503. Preserve the M9 early-media-header cleanup and post-header stream termination. Keep raw driver, filesystem and framework details out of bodies/logs. Use fixed event categories and internal UUIDs where operationally useful; never log request bodies or usernames.

## Proposed PostgreSQL schema

Add one immutable version, `202610210001_authentication_foundation.ts`, under `server-nest/src/database/migrations/versions/`. SQL type names below are exact targets. UUIDs and timestamps are supplied by application code; no column defaults. No alteration of `public.asset` or existing history.

### `public.app_user`

| Column                     | Type and constraint                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                       | UUID NOT NULL, primary key `app_user_pkey`                                                   |
| `username`                 | VARCHAR(64) NOT NULL, unique `app_user_username_key`; canonical ASCII form enforced by CHECK |
| `password_hash`            | TEXT NOT NULL                                                                                |
| `role`                     | VARCHAR(16) NOT NULL, CHECK `admin` or `user`                                                |
| `status`                   | VARCHAR(16) NOT NULL, CHECK `active` or `disabled`                                           |
| `password_change_required` | BOOLEAN NOT NULL                                                                             |
| `created_at`               | TIMESTAMPTZ NOT NULL                                                                         |
| `updated_at`               | TIMESTAMPTZ NOT NULL                                                                         |

### `public.auth_session`

| Column       | Type and constraint                                                                          |
| ------------ | -------------------------------------------------------------------------------------------- |
| `id`         | UUID NOT NULL, primary key `auth_session_pkey`                                               |
| `user_id`    | UUID NOT NULL, FK to `app_user(id)` with `ON DELETE RESTRICT`; index for own-session queries |
| `token_hash` | BYTEA NOT NULL, unique, CHECK octet length = 32                                              |
| `csrf_token` | BYTEA NOT NULL, CHECK octet length = 32; not an authentication credential                    |
| `created_at` | TIMESTAMPTZ NOT NULL                                                                         |
| `expires_at` | TIMESTAMPTZ NOT NULL, CHECK `expires_at > created_at`; index for bounded expiry cleanup      |

No automatic account deletion or media cascade. Enforce canonical username and all schema constraints in tests. The CSRF token is not the session credential; it is returned only to that authenticated browser in an appropriate response.

## Migration and upgrade contract

M8's original version, frozen legacy inspector, Kysely ledger and strict safety rules remain. Evolve **current-state** preflight based on exact applied migration history:

| History and schema                                                        | Expected action                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No history, empty fresh database                                          | Reject reserved-name collisions; apply M8 asset then M10 auth version                                    |
| No history, exact legacy asset                                            | Require explicit `--baseline-legacy`; record M8 baseline without changing its table/rows, then apply M10 |
| Only M8 applied, exact M8 asset and no auth relations                     | Apply M10                                                                                                |
| M8 + M10 applied                                                          | Validate unchanged asset and exact M10 auth tables; report no pending versions                           |
| Missing, extra or incompatible relations; malformed/unknown/gapped ledger | Fail nonzero with safe error; no automatic repair or baseline of auth tables                             |

Preserve the runner's PostgreSQL 18 check, public schema restriction, advisory/Kysely locks, explicit ESM provider registration and dedicated `MIGRATION_POSTGRES_*` credentials plus database confirmation. Recheck prerequisites and resulting auth schema **inside** the M10 transaction so a failure rolls back M10 DDL and its ledger entry. Existing Kysely metadata bootstrap can precede the migration transaction, as documented in the [M8 guide](database-migrations.md). Version files remain immutable; there is no destructive down path.

The Nest API validates its required auth schema/readiness and fails safely if missing or incompatible; it never executes a migration on startup. A production deployment must gate API startup on an explicit successful migration job and have a backup/restore plan. **No development database migration is authorized by this specification.** Any real baseline/upgrade requires separate approval and a reviewed backup/recovery plan. Integration tests must use only the existing verified disposable PostgreSQL 18 runner, random test databases and its container cleanup safeguards. No real media mount.

## HTTP contract

Paths are under `/api/v1`. Request bodies are JSON with explicit size limits, type/length checks and unknown-field rejection. Timestamps are UTC ISO strings. UUID path parameters require strict validation. Response DTOs never contain password hashes, tokens or internal paths. Auth responses are non-cacheable. The current M9 error envelope remains `{statusCode,message,error}` with fixed messages only.

| Method/path                    | Access and request                                                                     | Success response                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`             | Public, throttled; `{username,password}`; exact Origin, JSON and fixed custom header   | `200`; set cookie; `{user:{id,username,role,passwordChangeRequired},session:{id,expiresAt},csrfToken}`                          |
| `GET /me`                      | Valid session, including restricted                                                    | `200`; `{id,username,role,passwordChangeRequired,session:{id,expiresAt},csrfToken,assetsAvailable:false}`                       |
| `POST /auth/password`          | Session including restricted; CSRF; `{currentPassword,newPassword}`                    | `204`; revoke all sessions and clear cookie; next login required                                                                |
| `POST /auth/logout`            | Valid session; CSRF                                                                    | `204`; revoke current session and clear cookie                                                                                  |
| `POST /auth/logout-all`        | Valid session; CSRF                                                                    | `204`; revoke all own sessions and clear cookie                                                                                 |
| `GET /auth/sessions`           | Valid session, including restricted                                                    | `200`; `[{id,createdAt,expiresAt,current}]` for own live sessions                                                               |
| `DELETE /auth/sessions/:id`    | Valid session, including restricted; CSRF                                              | `204`; revoke own session; clear cookie if current                                                                              |
| `POST /users`                  | Active admin, unrestricted session; CSRF; `{username,initialPassword,currentPassword}` | `201`; `{id,username,role:"user",status:"active",passwordChangeRequired:true,createdAt,updatedAt}`                              |
| `GET /users?limit=50&offset=0` | Active admin, unrestricted session; limit 1–100, offset >=0                            | `200`; `{items:[{id,username,role,status,passwordChangeRequired,createdAt,updatedAt}],limit,offset}`; no hashes or session data |
| `POST /users/:id/disable`      | Active admin, unrestricted session; CSRF; `{currentPassword}`                          | `204`; disable target and revoke target sessions                                                                                |

Expected safe errors: 400 malformed request; 401 invalid or absent credentials and generic login failure; 403 authenticated non-admin or CSRF/origin failure; 404 unknown/foreign session or unknown user; 409 duplicate username, last-admin/self-disable or live-session cap; 429 throttled requests; 503 database unavailable or intentionally blocked asset access. Never include raw provider/driver messages. Reauthentication failures for sensitive admin actions must not reveal whether a target account exists.

## Operator CLI contract

Proposed standalone local commands, built from the same source but separate from API startup:

- `auth:bootstrap --confirm-database=<name> --username=<name>`: require explicit operator DB credentials, matching database confirmation, M10 schema and **zero existing users**; prompt twice for hidden password; advisory lock + transaction; create one active admin. No public endpoint, password argv/environment fallback or bootstrap reopening when all admins are disabled.
- `auth:recover --confirm-database=<name> --user-id=<uuid>`: require local operator access and hidden replacement password twice; update only selected account, set `password_change_required`, revoke all its sessions atomically. Keep role and disabled status unless an explicit separately confirmed restore-admin operation changes status. No email/security-question recovery.
- `auth:prune-sessions --confirm-database=<name> --limit=<bounded integer>`: delete only expired auth sessions in bounded batches; no asset/media operation.

Use dedicated, explicit `AUTH_ADMIN_POSTGRES_HOST`, `_PORT`, `_DB`, `_USER` and `_PASSWORD` settings, no loading of application `.env` or implicit fallback to `POSTGRES_*` or `MIGRATION_POSTGRES_*`. Require an interactive terminal for hidden password entry; reject password argv and stdin pipes. Emit only fixed diagnostic categories and internal target IDs, never passwords. Operator privilege and deployment ergonomics need maintainer sign-off. Protect against concurrent bootstrap and concurrent last-admin disable via database locking/transaction tests.

## Runtime configuration and module responsibilities

- Extend central runtime validation with `APP_ORIGIN`, cookie/transport policy and optional development Swagger setting. Reject production HTTP origin, malformed origin, wildcard origin, non-loopback HTTP and ambiguous proxy settings with value-free errors. Keep `HOST=127.0.0.1` default.
- `AuthModule`: credential verification, session creation/resolution/revocation, CSRF and throttling. Keep HTTP parsing/cookie handling in controllers/Fastify boundary, application decisions in service and SQL in repositories.
- `UsersModule`: canonicalization, account administration, password change/disable and repository. The `AuthenticatedActor` contains user UUID, role, session UUID and restricted status; it contains no raw token.
- `AppModule`: global deny-by-default guard, explicit public health/login policy, and structural disabled-assets surface. `main.ts`: register cookie/origin/early asset boundary before listening; validate auth readiness; coordinate shutdown. `SafeHttpExceptionFilter`: only fixed public messages and safe server diagnostics. `swagger.ts`: opt-in loopback development policy.
- Existing asset controller/service/repository/storage code stays available to isolated tests but is not wired into the M10 production API.

## Acceptance tests and verification

1. Unit tests: username/password validation, hash verification and dummy work, session token hashing/entropy, CSRF comparison, cookie construction, config rejection, rate/work limits, actor derivation and error redaction.
2. HTTP tests: login/restricted first use/password change, own session list/revoke/logout-all, admin provisioning/disable, missing/foreign Origin, CSRF failure, duplicate/invalid inputs, disabled account, non-admin denial, unknown routes and framework/Swagger behavior. Real localhost socket tests cover multipart/HEAD/Range and early transport behavior that injection cannot model accurately.
3. Production-composition tests: anonymous, user and admin asset requests receive the specified fixed responses for every route and alias; no asset repository/storage operation occurs. Existing asset upload/media behavior remains covered by a dedicated component-test app, not a production bypass switch.
4. Isolated PostgreSQL tests: fresh, managed and legacy upgrade; immutable asset OID/rows/paths and history; repeat/concurrent application; partial/incompatible schemas; transaction rollback; actual user/session queries, constraints, revoke/expiry, concurrent bootstrap, last-admin protection and login/revoke races. CLI tests never inherit development connection settings.
5. Verify build, typecheck, lint, focused Prettier, unit, HTTP E2E, `npm run test:integration`, `npm run test:migrations`, runtime smoke and `git diff --check` after functional implementation. Record actual commands and outcomes; confirm disposable containers removed.

These are **acceptance targets**, not Phase 10B.1 test results. No PostgreSQL or Docker command is needed for documentation-only 10B.1.

## Phase boundaries

| Phase | Deliverable                                                                                                                                                                        | Boundary                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 10B.1 | This spec, [implementation context](milestone-10-implementation-context.md), proposed ADR                                                                                          | Documentation only; stop for review                                      |
| 10B.2 | Additive auth schema, version-aware migration validation and disposable tests                                                                                                      | No auth HTTP/API behavior; no development migration                      |
| 10B.3 | Passwords, users and local bootstrap/recovery tools                                                                                                                                | No public signup or media access                                         |
| 10B.4 | Browser session internals, cookie/CSRF and independently tested authentication components; production asset lockdown and its regression tests before enabling login in `AppModule` | No runnable composition may combine login with unrestricted asset routes |
| 10B.5 | Admin endpoints and final production route-policy verification                                                                                                                     | Retain the asset lockdown; no M11 ownership work                         |
| 10B.6 | Full regression, reports and updated architecture/roadmap                                                                                                                          | No commit/push/merge without approval                                    |

Phase sequencing must never produce a runnable composition with functional login and ownerless asset access, even temporarily. Review each phase before starting the next.

## Out of scope and remaining risks

No asset owner mapping, sharing, Family Space, albums, mobile transport or app, public registration, email reset, OAuth/OIDC, SSO, MFA, account deletion, administrator impersonation, Redis/BullMQ, RLS or production Docker deployment. Do not change legacy FastAPI code, asset size/type or stored photos.

Temporary-password delivery trusts the administrator and out-of-band channel. In-memory throttling is single-process. A privileged host operator retains direct access. Existing filesystem failure-injection coverage and cross-system crash recovery remain incomplete. Deployment TLS, proxy behavior, backup/restore and real migration rehearsal remain unverified. Authentication alone does not resolve ownerless asset privacy.

## Approved decisions and remaining execution gates

The maintainer approved the M10 architectural direction and the asset-lockdown ordering correction before Phase 10B.2. The approved contract includes:

1. Trusted-host privacy model and closed provisioning with administrator-supplied temporary passwords and mandatory first change.
2. Opaque PostgreSQL browser sessions, seven-day/15-minute expiry and ten-session cap; mobile bearer transport deferred.
3. Production HTTPS, exact `APP_ORIGIN`, cookie naming, Origin + CSRF rules, and loopback-only HTTP development.
4. Local bootstrap/recovery CLI and administrator reauthentication/last-admin rules.
5. Structural asset lockdown and temporary 401/503 contract for **all** callers, including admins.
6. The proposed schema, migration name and version-aware strict validation, with M8 history and development data preserved.
7. The bounded in-memory throttle and Argon2id parameters after benchmark.

The Argon2id cost was benchmarked on the local test host in [the Phase 10B.3 report](milestone-10b3-report.md); deployment hardware still needs its own measurement. Phase 10B.4 authorized login only after the structural asset lockdown was verified and was committed as `d5d91d7`. Phase 10B.5 administrator account management was separately authorized. Applying a migration to the existing development database and starting Phase 10B.6 still require separate authorization. Any change to these contracts during implementation requires a documented review.
