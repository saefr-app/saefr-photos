# Saefr Photos — MVP milestone 1

Self-hosted, AI-powered photo and video backup. This milestone proves one loop
end to end: **sign up → log in → upload a real file → file on disk + row in
Postgres → background job runs → status flips to `done`.** The ML work itself is
a stub; everything around it is real.

## Container topology (exactly 4)

| Container    | Role                                                        | Networks         |
| ------------ | ----------------------------------------------------------- | ---------------- |
| `api`        | NestJS HTTP server **and** the BullMQ consumer, one process | `edge`, `internal` |
| `ml-service` | FastAPI stub (`/health`, `/analyze`)                        | `internal` only  |
| `redis`      | BullMQ backing store                                        | `internal` only  |
| `postgres`   | Primary database                                            | `internal` only  |

`internal` is declared `internal: true`, so nothing but `api` is reachable from
outside Docker. `api` publishes `3000:3000` because there is no reverse proxy
or domain yet.

## Data model

Assets belong to a **Library**, never to a user. `Asset` has no `userId`
column — users hold a role in a library via `LibraryMembership`
(`owner` / `contributor` / `viewer`), and that table is the only authorisation
point. Every user gets a personal library auto-created inside `AuthService.signup`.

This is the deliberate departure from Immich's user-owned-asset model, which
causes duplicate ML processing per viewer on shared photos and blocks
cross-user face matching.

## Running it

```bash
cp .env.example .env      # then set a real JWT_SECRET: openssl rand -base64 32
docker compose up --build
```

Then open **http://localhost:3000** — the `api` container serves a static upload
page on the same port as the API. Sign up, drag photos in, watch each one go
`uploaded → processing → done` in the grid.

## Endpoints

| Method | Path                 | Notes                                       |
| ------ | -------------------- | ------------------------------------------- |
| POST   | `/auth/signup`       | Creates user + personal library, returns JWT |
| POST   | `/auth/login`        | Returns JWT                                  |
| GET    | `/auth/me`           | Auth-guarded identity check                  |
| POST   | `/assets/upload`     | `multipart/form-data`, field `file`, 25MB cap |
| GET    | `/assets`            | Everything in the caller's libraries         |
| GET    | `/assets/:id`        | One asset's metadata                         |
| GET    | `/assets/:id/file`   | The stored bytes                             |

Everything under `/assets` is membership-checked; a caller without a
`LibraryMembership` for the asset's library gets 404, never 403.

## Verifying the loop

```bash
docker compose ps
```

All four services running; `postgres` and `redis` reporting healthy.

```bash
curl -X POST localhost:3000/auth/signup -H "Content-Type: application/json" -d '{"email":"test@saefr.com","password":"testpass123"}'
```

```bash
curl localhost:3000/auth/me -H "Authorization: Bearer <token>"
```

```bash
curl -X POST localhost:3000/assets/upload -H "Authorization: Bearer <token>" -F "file=@/path/to/some/photo.jpg"
```

Returns the asset row with `status: "uploaded"`.

```bash
docker compose logs api
```

Should show the processor picking the job up and logging the `ml-service` response.

```bash
curl localhost:3000/assets/<id> -H "Authorization: Bearer <token>"
```

`status: "done"` here, plus the file actually present in the volume, is the
milestone:

```bash
docker compose exec api ls -R /app/uploads
```

## Known-and-deliberate for this pass

- `synchronize: true` in TypeORM — tables auto-created from entities. Temporary,
  must become migrations before production.
- Checksums are captured but **not** enforced; dedup is one lookup away
  (commented in `AssetsService.upload`).
- Multer buffers uploads in memory; the 25MB cap is the guardrail until
  streaming uploads land.
- JWT is 24h with no refresh rotation and no password reset.
- Jobs have no retry/backoff policy yet.
- `ml-service` loads no models — but all loading is already behind
  `load_models()`, so `select_model(hardware_profile)` slots in later without
  restructuring.
- The upload page is a single static HTML file, not a frontend app. The grid
  downloads full-resolution files as thumbnails because server-side thumbnail
  generation doesn't exist yet, and `GET /assets` is capped at 200 rows with no
  pagination. Both are fine at test scale and wrong at real scale.
