# Saefr Photos backend

NestJS 12, Fastify, Kysely, PostgreSQL 18 and Sharp. M10 authentication
was merged into `integration` as `acf6ed4`. M11 ownership and secure asset
authorization were merged through [PR #4](https://github.com/saefr-app/saefr-photos/pull/4)
as `2141bb9` and passed local post-merge verification. Legacy NULL-owned assets
remain inaccessible. No real-data upgrade or production deployment has occurred.
Keep the API local until the deployment gates are reviewed. Run npm commands
from `server-nest/` with Node.js 24.

## Setup and runtime configuration

```bash
npm ci
npm run start:dev
```

Nest loads the root `.env` first, then `server-nest/.env`; the root file takes
precedence if both set the same key. Process environment variables take
precedence over either file. Set `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD` and an exact `APP_ORIGIN` to nonblank values. Production
requires an HTTPS origin; development/test HTTP origins must be loopback.
Optional settings and defaults are:

| Setting         | Default                                               |
| --------------- | ----------------------------------------------------- |
| `POSTGRES_HOST` | `127.0.0.1`                                           |
| `POSTGRES_PORT` | `5432`                                                |
| `HOST`          | `127.0.0.1`                                           |
| `PORT`          | `3000`                                                |
| `NODE_ENV`      | `development` (`test` and `production` also accepted) |
| `STORAGE_ROOT`  | `../storage` relative to `server-nest/`               |

Ports must be integers from 1 to 65535. A relative `STORAGE_ROOT` is resolved
from the process working directory. Invalid settings stop startup with a
setting-specific error that does not print configured values. An explicit
`HOST` can bind beyond localhost, so keep it local until deployment safeguards
are reviewed. The merged M11 composition mounts owner-scoped asset
routes behind early cookie/session and Origin/CSRF authorization; this is not
public-deployment approval.

The merged M12B schema introduces lifecycle metadata, deletion receipts and an empty storage-binding table. On an applied M12 schema the current application refuses HTTP startup until storage provenance has been implemented and certified. The M12C feature branch builds a Linux-only descriptor-based identity helper using `cc` and the installed Linux UAPI headers; `npm run build:native` is included in `npm run build` on Linux. It requires no additional runtime privileges, but has not passed disposable ext4 certification. The provider is registered for injection but does not replace the active M11 asset-storage service; the M12 startup gate remains. The fresh-only storage operator command is not approved for real-data use. Do not use a marker or a populated singleton as a startup workaround. See the [M12C operator notes](../docs/development/milestone-12c-storage-operator-guide.md).

Startup does not run migrations. It checks the exact managed M8, M10 and
M11 schema/history before listening and fails safely if the database is unavailable or incompatible.
The existing development database has not been approved for this upgrade;
do not run the migration or operator commands against it to make startup pass.
`GET /health/ready` checks database connectivity. Swagger is disabled by
default during the M10 authorization transition. Auth endpoints are under
`/api/v1/auth`; `/api/v1/me` returns the current user and CSRF token.
Administrator-only `/api/v1/users` routes create ordinary accounts, list
accounts and disable accounts after current-password reauthentication.

## Verification

```bash
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
npm run test:migrations
npm run test:runtime-smoke
```

Unit and legacy asset HTTP E2E tests do not use the real PostgreSQL database. The
integration runner creates a uniquely named `postgres:18` container with
in-memory storage and a random port bound to `127.0.0.1`. It supplies test
credentials to Vitest, verifies container isolation, and removes the
container after normal runs, test failures and handled termination signals.
Selected M10 authentication and M11 ownership integration tests run real
HTTP against a localhost socket and random databases inside that disposable
container, using
synthetic users/assets and temporary storage.
It does not use the root Compose project, `.env`, the development database
volume, or files under `storage/`. If the runner is killed before cleanup,
inspect containers labeled `dev.saefr.purpose=milestone-07-integration` and
stop only the specific test container after confirming its identity.

## Database migrations

`npm run db:status` inspects migration state. `npm run db:migrate` requires
explicit `MIGRATION_POSTGRES_*` settings and a matching `--confirm-database`
argument. Existing legacy tables additionally require `--baseline-legacy`
after schema review and backup approval. API startup never runs migrations.
See [the migration guide](../docs/development/database-migrations.md) for
configuration, baseline safety and recovery instructions. Do not run these
commands against the existing development database without separate approval.

The backend is not yet Dockerized. The root Compose file starts only the
existing development PostgreSQL service; its volume and the local media files
must be preserved.
