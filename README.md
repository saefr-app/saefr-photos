# saefr-photos

Backend API and processing pipeline. Runs entirely in Docker: NestJS API,
FastAPI ML service, PostgreSQL, and Redis.

## Requirements

- **Docker Desktop** (or Docker Engine + Compose v2) — the only thing you need
  installed. Node and Python run inside containers; nothing is installed on the
  host.
- A drive with room for your photo library.

## First-time setup

**1. Create your `.env`**

```bash
cp .env.example .env
```

**2. Generate a real `JWT_SECRET`**

```bash
openssl rand -base64 32
```

Paste the output into `JWT_SECRET` in `.env`. Never leave the placeholder — it
signs every login token.

**3. Set `DB_PASSWORD`** in `.env` to anything random. It's only used between
the `api` and `postgres` containers, which sit on a network with no route out
of Docker, so you never type it again.

**4. Point `UPLOADS_PATH` at the folder where your originals should live.**
Use forward slashes, even on Windows:

```
UPLOADS_PATH=D:/Saefr Photos
```

This is per-machine — every developer sets their own. It's the library itself,
so put it on a drive with space and include it in your backups.

## Running

Start everything (first run builds the images, takes a few minutes):

```bash
docker compose up --build
```

Or in the background:

```bash
docker compose up -d --build
```

Then open **http://localhost:3000** — the API serves an upload page on the same
port. Sign up, drag photos in, and watch each one move from `uploaded` to
`processing` to `done`.

After the first build, plain `docker compose up -d` is enough. You only need
`--build` again when source code, `package.json`, or a `Dockerfile` changes.

## Everyday commands

Check what's running — all four services up, `postgres` and `redis` healthy:

```bash
docker compose ps
```

Follow the API logs, including the background job worker:

```bash
docker compose logs -f api
```

Stop everything, keeping all data:

```bash
docker compose down
```

Restart just the API after a code change:

```bash
docker compose up -d --build api
```

Open a shell inside the API container:

```bash
docker compose exec api sh
```

Open a psql prompt:

```bash
docker compose exec postgres psql -U saefr -d saefr_photos
```

Wipe the database and start clean. **This deletes every user and asset row.**
Your photo files at `UPLOADS_PATH` survive, which means they'll be orphaned —
delete that folder too if you want a genuine reset:

```bash
docker compose down -v
```

## Verifying it works

```bash
curl -X POST localhost:3000/auth/signup -H "Content-Type: application/json" -d "{\"email\":\"test@example.com\",\"password\":\"testpass123\"}"
```

Returns `{ "accessToken": "..." }`. Use that token for everything below.

```bash
curl localhost:3000/auth/me -H "Authorization: Bearer <token>"
```

```bash
curl -X POST localhost:3000/assets/upload -H "Authorization: Bearer <token>" -F "file=@/path/to/photo.jpg"
```

Returns the asset row with `status: "uploaded"`. Within a second or two:

```bash
curl localhost:3000/assets/<id> -H "Authorization: Bearer <token>"
```

`status: "done"` means the job ran and the ML service answered. Confirm the
file physically exists by looking in your `UPLOADS_PATH` folder.

## Endpoints

| Method | Path               | Notes                                         |
| ------ | ------------------ | --------------------------------------------- |
| POST   | `/auth/signup`     | Creates user + personal library, returns JWT   |
| POST   | `/auth/login`      | Returns JWT                                    |
| GET    | `/auth/me`         | Auth-guarded identity check                    |
| POST   | `/assets/upload`   | `multipart/form-data`, field `file`, 25MB cap  |
| GET    | `/assets`          | Everything in the caller's libraries           |
| GET    | `/assets/:id`      | One asset's metadata                           |
| GET    | `/assets/:id/file` | The stored bytes                               |

All `/assets` routes require `Authorization: Bearer <token>`. Access is checked
against library membership; a caller without membership gets 404 rather than
403, so the endpoint never confirms an asset exists to someone who can't see it.

## Services

| Container    | Role                                                      | Exposed         |
| ------------ | --------------------------------------------------------- | --------------- |
| `api`        | NestJS HTTP server and the BullMQ job consumer, one process | `localhost:3000` |
| `ml-service` | FastAPI service (`/health`, `/analyze`) — stub for now     | internal only   |
| `redis`      | Job queue backing store                                    | internal only   |
| `postgres`   | Database                                                   | internal only   |

Only `api` is reachable from the host. The other three sit on a Docker network
declared `internal: true`, so nothing outside Docker can connect to them — you
reach them through `docker compose exec`.

## Storage

Originals are written to the host filesystem at `UPLOADS_PATH`:

```
<UPLOADS_PATH>/<libraryId>/<uuid>-<sanitised-filename>
```

Postgres stores **only metadata** — filename, MIME type, size, SHA-1 checksum,
status, and the `storageKey` pointing at the file. No image bytes are ever put
in the database. One directory per library keeps each library independently
backup-able and stops any single directory growing without bound.

`originalFilename` in the database preserves the true filename for display;
only the on-disk name is sanitised.

## Data model

Assets belong to a **Library**, not to a user — there is no `userId` column on
`Asset`. Users hold a role in a library through `LibraryMembership`
(`owner` / `contributor` / `viewer`), and that table is the only authorisation
check in the system. Each user gets a personal library created automatically
during signup.

## Project layout

```
api/                     NestJS service
  src/auth/              signup, login, JWT strategy and guard
  src/assets/            upload, listing, file serving
  src/entities/          User, Library, LibraryMembership, Asset
  src/queue/             BullMQ connection and queue registration
  src/processing/        the job consumer
  public/index.html      upload page
ml-service/              FastAPI service
docker-compose.yml       the four services, networks and volumes
```

## Troubleshooting

**Port 3000 already in use** — something else is on that port. Find it with
`netstat -ano | findstr :3000` on Windows, then either stop it or change the
published port in `docker-compose.yml`.

**`api` exits immediately on startup** — usually a missing or malformed `.env`.
Check `docker compose logs api`; a `JWT_SECRET` that's empty is the most common
cause.

**Uploads return 401** — the token expired. They last 24 hours; log in again.

**Uploads return 413** — the file is over the 25MB cap, set in
`assets.controller.ts`.

**Changed `DB_PASSWORD` and now `api` can't connect** — Postgres only applies
that password when it first initialises its data directory. Run
`docker compose down -v` to recreate it.

## Current limitations

- `synchronize: true` in TypeORM auto-creates tables from the entity classes.
  Convenient for development; must be replaced with migrations before this runs
  anywhere real, since it can drop columns.
- Checksums are recorded but not enforced, so uploading the same file twice
  produces two rows and two files.
- Uploads are buffered in memory by Multer; the 25MB cap is the guardrail until
  streaming uploads are implemented.
- JWTs last 24 hours with no refresh rotation and no password reset.
- Jobs have no retry or backoff policy.
- `ml-service` returns a canned response and loads no models.
- No EXIF extraction — dimensions, date taken, GPS and orientation are not read.
- The upload page fetches full-resolution images for its grid, since thumbnail
  generation doesn't exist yet, and `GET /assets` returns at most 200 rows with
  no pagination.
