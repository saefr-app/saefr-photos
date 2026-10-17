# Saefr Photos backend

NestJS 12, Fastify, Kysely, PostgreSQL 18 and Sharp. The API is still
unauthenticated and must remain local until authorization is implemented.
Run npm commands from `server-nest/` with Node.js 24.

## Setup and runtime configuration

```bash
npm ci
npm run start:dev
```

Nest loads the root `.env` first, then `server-nest/.env`; the root file takes
precedence if both set the same key. Process environment variables take
precedence over either file. Set `POSTGRES_DB`, `POSTGRES_USER` and
`POSTGRES_PASSWORD` to nonblank values. Optional settings and defaults are:

| Setting | Default |
| --- | --- |
| `POSTGRES_HOST` | `127.0.0.1` |
| `POSTGRES_PORT` | `5432` |
| `HOST` | `127.0.0.1` |
| `PORT` | `3000` |
| `NODE_ENV` | `development` (`test` and `production` also accepted) |
| `STORAGE_ROOT` | `../storage` relative to `server-nest/` |

Ports must be integers from 1 to 65535. A relative `STORAGE_ROOT` is resolved
from the process working directory. Invalid settings stop startup with a
setting-specific error that does not print configured values. An explicit
`HOST` can bind beyond localhost, so keep it local until authorization and
deployment safeguards are implemented. Production mode hides Swagger; it does
not add authentication.

Startup does not run migrations or check database connectivity. Use
`GET /health/ready` for the database check. The API serves Swagger at `/docs`
and OpenAPI JSON at `/docs-json` outside production mode.

## Verification

```bash
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
```

Unit and HTTP E2E tests do not use the real PostgreSQL database. The
integration runner creates a uniquely named `postgres:18` container with
in-memory storage and a random port bound to `127.0.0.1`. It supplies test
credentials to Vitest, verifies container isolation, and removes the
container after normal runs, test failures and handled termination signals.
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
