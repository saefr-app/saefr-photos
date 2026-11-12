# W4/W5 Linux storage test environment — operator runbook

**Status:** Proposed runbook for repository-admin review. Nothing in this
document has been executed. It describes a disposable Linux environment for
accepting W3 gallery/viewer behavior and the coming W4 upload and W5
Trash/lifecycle work with real, synthetic media on a verified ext4 storage
binding.

**Sources:** `AGENTS.md`, [M12C operator notes](milestone-12c-storage-operator-guide.md),
[M12C report](milestone-12c-report.md), [M12F report](milestone-12f-report.md),
[database migrations](database-migrations.md), `server/README.md`,
`server/src/storage/**`, `server/package.json`, the repository-root
`.env.example` (there is no `server/.env.example` in this tree), root
`compose.yml`, `api-integration.md`, `web/docs/w3-gallery-plan.md` and
`web/docs/w2-w3-implementation-report.md`.

> ## READ-ONLY UNTIL APPROVED
>
> This document is a review artifact. Reading it, and running only commands
> explicitly marked **[read-only]**, is allowed during review. Creating a
> database or role, applying migrations, creating the storage root, running
> `storage:provision-fresh`, starting the API or web server, bootstrapping an
> account, uploading synthetic media, exercising Trash/permanent deletion,
> opening an SSH tunnel, stopping or removing containers, dropping the
> disposable database, and deleting the disposable storage root are **not**
> authorized by this document. Each requires a separate, explicit approval
> recorded in the sign-off block at the end.
>
> Do not read, print, copy or commit any `.env` file. Never print passwords,
> cookies, CSRF tokens, session IDs, storage markers or provider keys. Do not
> connect this procedure to the development PostgreSQL database, the root
> `storage/` directory, the `saefr_photos_db_data` Docker volume, or any
> production credential or media.

## 1. Purpose and scope

The W3 gallery was accepted with real authentication but synthetic in-browser
media because the Windows test backend had no storage binding
(`web/docs/w3-gallery-plan.md`). W4 upload and W5 Trash/lifecycle need a real
backend where uploads, thumbnails, originals and permanent deletion can be
exercised against a verified Linux/ext4 binding. This runbook creates that
environment as a **disposable, synthetic-only** installation and defines the
acceptance evidence to collect.

In scope:

- One isolated Linux host or VM with Node.js 24 and a native compiler.
- One empty, disposable PostgreSQL database on loopback, distinct from
  development.
- One dedicated ext4 storage root containing only synthetic test media.
- The existing `LinuxPhysicalStorageObserver` and the `linux-ext4-v1` binding
  contract, unchanged.
- A Windows browser connecting to the isolated API only after the binding has
  been independently verified.

Out of scope and not authorized:

- Any change to the development database, `storage/`, Compose project or
  development credentials.
- Historical adoption, real-data migration, relocation or restoration.
- Production deployment, TLS termination, public exposure, a Windows or NAS
  storage profile, or a claim that power-loss durability is certified.
- Baseten, Modal, or any paid inference/sandbox provider. No provider keys are
  used by this project's upload/lifecycle path.

### Actions that require separate approval

| # | Action | Why it is gated |
| - | ------ | --------------- |
| A1 | Create the disposable database and role | Mutates a PostgreSQL cluster |
| A2 | Apply migrations to the disposable database | Creates schema and ledger rows |
| A3 | Create `/srv/saefr-w45/storage` and empty role directories | Mutates the host filesystem |
| A4 | Run `storage:provision-fresh` | Writes exclusive markers and the binding singleton |
| A5 | Bootstrap an account and create a synthetic test user | Inserts account and session rows |
| A6 | Start the API, start the Windows web server, open the SSH tunnel | Starts processes and network listeners |
| A7 | Upload, Trash, Restore, permanently delete and retry | Writes synthetic media and lifecycle rows |
| A8 | Stop/remove containers or volumes, if any were used | Docker state changes |
| A9 | Drop the disposable database/role and delete the disposable storage root | Irreversible teardown |
| A10 | Any provider key or external paid call | Not part of this runbook; needs a new approval |

Approvals must name the host, exact database, exact storage root and the
operator. Approval for one phase is not approval for the next.

## 2. Target architecture and invariants

```text
Windows workstation                         Isolated Linux host / VM
┌──────────────────────────┐               ┌───────────────────────────────────┐
│ Microsoft Edge           │               │ Node.js 24 API                    │
│ http://localhost:5180    │  SSH local     │ 127.0.0.1:3100                    │
│ SvelteKit dev server     │  port forward  │ POSTGRES_* -> 127.0.0.1:55432     │
│ Vite /api proxy          │ ─────────────> │ STORAGE_ROOT=/srv/saefr-w45/...   │
│ (changeOrigin: false)    │                │ LinuxPhysicalStorageObserver      │
└──────────────────────────┘               │ PostgreSQL 18 (disposable DB)     │
                                            │ ext4 mount (synthetic media only) │
                                            └───────────────────────────────────┘
```

Non-negotiable invariants:

1. **Separate database.** The database name and role are not `saefr_photos` /
   `saefr`, and the cluster is not the root Compose development service or the
   `saefr_photos_db_data` volume. The API connects only to the disposable
   database.
2. **Separate storage.** `STORAGE_ROOT` is an absolute path outside the
   repository. It is not the repository `storage/`, not a symlink, not a bind
   mount of `storage/`, not a network/FUSE/overlay filesystem, and not visible
   through a Windows drive letter or WSL `drvfs`.
3. **Verified ext4.** Both role directories are real directories on the same
   verified ext4 mount. `findmnt` must report `ext4`; `stat -f` alone is not
   authoritative because it can report `ext2/ext3` for ext4.
4. **Observer unchanged.** The repository's `LinuxPhysicalStorageObserver`,
   native helper and `linux-ext4-v1` marker-v2 contract are used as shipped.
   No test-only observer, bypass, symlink fallback or hand-edited marker is
   permitted.
5. **Binding before browser.** The Windows web app and SSH tunnel are not
   started until provisioning succeeds and the binding has been independently
   checked (records below). A marker or a populated singleton is not proof by
   itself; the checks compare the database row, both markers and both observed
   role identities.
6. **Exact origin.** The browser origin and `APP_ORIGIN` must match exactly.
   This runbook uses `http://localhost:5180`. Do not use `127.0.0.1:5180`
   against the same configuration, do not enable CORS, do not set
   `changeOrigin: true`, and do not disable cookie or CSRF enforcement.
7. **No production claim.** This is disposable synthetic acceptance. It does
   not certify crash recovery, power-loss durability, backup/restore, or a
   production deployment.

## 3. Preconditions and exact naming

### 3.1 Fixed names and placeholders

Use these exact values unless a collision is found during preflight. Values in
angle brackets are placeholders and must never be committed or printed.

| Item | Exact value / placeholder | Notes |
| ---- | ------------------------- | ----- |
| Linux host | `<linux-test-host>` | Dedicated VM or host; operator records FQDN |
| Linux operator | `saefr-ops` | Dedicated unprivileged account; TTY required |
| OS user UID/GID | `<operator-uid>:<operator-gid>` | Recorded, not inferred |
| Node.js | 24.x | `.nvmrc` selects Node 24; `npm` commands run in `server/` |
| PostgreSQL | 18.x, loopback | Local cluster or disposable container; operator confirms |
| DB host / port | `127.0.0.1` / `55432` | Distinct from development `5432` |
| Database | `saefr_w45_env` | Must not be `saefr_photos` |
| Dedicated role | `saefr_w45_ops` | Minimum setup: one dedicated role |
| Optional split roles | `saefr_w45_migrator`, `saefr_w45_app` | Only if DB policy requires least privilege; grants are operator/DBA-confirmed |
| Role password | `<isolated-db-password>` | Stored only in a mode-0600 file outside the repo/media |
| API bind | `127.0.0.1`:`3100` | Loopback only; matches the existing Vite proxy |
| Web dev server | `localhost`:`5180` | Vite `strictPort`; the browser origin |
| Storage root | `/srv/saefr-w45/storage` | Absolute; contains `originals/` and `thumbnails/` |
| Role marker | `.saefr-storage.json` | Written only by the provisioner |
| `APP_ORIGIN` | `http://localhost:5180` | Exact match; development HTTP must be loopback |
| `NODE_ENV` | `development` | Production over HTTP is rejected at startup |
| Test account | `w45-acceptance` | Synthetic only; operator confirms the username policy |
| Evidence directory | `/home/saefr-ops/saefr-w45-evidence` | Mode 0700; outside DB and media roots |

**Forbidden reuse, without exception:**

- Docker volume `saefr_photos_db_data`, container `saefr-photos-db`, or the root
  Compose project.
- Development database `saefr_photos`, development role `saefr`, or any
  development `.env` file.
- Repository `storage/`, `storage/originals/`, `storage/thumbnails/`, or any
  real photograph.
- Production credentials, backups, certificates, or host names.
- Any path that resolves through a symlink or a bind mount into development
  storage.
- Any provider API key. This runbook does not use inference or sandbox
  providers.

### 3.2 Operator identity and TTY

The provisioning CLI and account bootstrap require a real interactive TTY
(`process.stdin.isTTY` and `process.stdout.isTTY`). Run them at the Linux
console or through `ssh -t`, never through CI, cron, a detached service, or a
pipeline that closes stdin. The process runs as the dedicated unprivileged
operator and executes from `server/`, because the native helper is resolved
from `process.cwd()/dist/native/storage-identity-observer`.

### 3.3 Environment variables actually read by the code

Do not invent inference-provider variables; this project does not read them.
Set these through the process environment sourced from protected files, not by
copying the repository's development `.env`.

Runtime API (`server/src/runtime-config.ts` plus `server/src/storage/**`):

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `NODE_ENV` | No; defaults `development` | `development`, `test` or `production` |
| `HOST` | No; defaults `127.0.0.1` | Keep loopback |
| `PORT` | No; defaults `3000`; set `3100` | API listener |
| `POSTGRES_HOST` | No; defaults `127.0.0.1` | Disposable DB host |
| `POSTGRES_PORT` | No; defaults `5432`; set `55432` | Disposable DB port |
| `POSTGRES_DB` | Yes | `saefr_w45_env` |
| `POSTGRES_USER` | Yes | `saefr_w45_ops` (or `saefr_w45_app`) |
| `POSTGRES_PASSWORD` | Yes | Placeholder only in files; never in this document |
| `APP_ORIGIN` | Yes | Exactly `http://localhost:5180` |
| `STORAGE_ROOT` | No; defaults `../storage` | Set the absolute isolated root |
| `STORAGE_ID` | **Required for media** | Printed by provisioning |
| `STORAGE_ORIGINALS_BINDING_ID` | **Required for media** | Printed by provisioning |
| `STORAGE_THUMBNAILS_BINDING_ID` | **Required for media** | Printed by provisioning |
| `STORAGE_ORIGINALS_PROFILE` | **Required for media** | Exactly `linux-ext4-v1` |
| `STORAGE_THUMBNAILS_PROFILE` | **Required for media** | Exactly `linux-ext4-v1` |

> **Documentation gap — operator must confirm:** `server/README.md` and the M12C
> operator guide do not document the five `STORAGE_*` variables above for
> ordinary API startup. The binding verifier reads them and treats a missing or
> non-`linux-ext4-v1` profile as unavailable, so media returns `503` even when
> the database row and markers are valid. They must be present in the API
> process environment.

Migration CLI (`server/src/database/migrations/cli.ts`, documented in
`database-migrations.md`):

| Variable | Purpose |
| -------- | ------- |
| `MIGRATION_POSTGRES_HOST` | Disposable DB host |
| `MIGRATION_POSTGRES_PORT` | `55432` |
| `MIGRATION_POSTGRES_DB` | `saefr_w45_env` |
| `MIGRATION_POSTGRES_USER` | Migration role |
| `MIGRATION_POSTGRES_PASSWORD` | Placeholder in the protected file only |

Storage operator CLI (`server/src/storage/storage-operator-cli.ts`):

| Variable | Purpose |
| -------- | ------- |
| `STORAGE_OPERATOR_POSTGRES_HOST` | Disposable DB host |
| `STORAGE_OPERATOR_POSTGRES_PORT` | `55432` |
| `STORAGE_OPERATOR_POSTGRES_DB` | `saefr_w45_env` |
| `STORAGE_OPERATOR_POSTGRES_USER` | Operator role |
| `STORAGE_OPERATOR_POSTGRES_PASSWORD` | Protected file only |
| `STORAGE_OPERATOR_ROOT` | Exactly `/srv/saefr-w45/storage` |

> **Documentation gap — operator must confirm:** the M12C guide abbreviates the
> operator connection variables as `STORAGE_OPERATOR_POSTGRES_HOST`, `PORT`,
> `DB`, `USER`, `PASSWORD`. The code reads the fully prefixed names shown in
> this table (`STORAGE_OPERATOR_POSTGRES_PORT`, etc.).

Account bootstrap (`server/src/users/operator-config.ts`):

| Variable | Purpose |
| -------- | ------- |
| `AUTH_ADMIN_POSTGRES_HOST` | Disposable DB host |
| `AUTH_ADMIN_POSTGRES_PORT` | `55432` |
| `AUTH_ADMIN_POSTGRES_DB` | `saefr_w45_env` |
| `AUTH_ADMIN_POSTGRES_USER` | Operator/admin role |
| `AUTH_ADMIN_POSTGRES_PASSWORD` | Protected file only |

The protected files are created by the operator outside the repository and
outside both media roots, for example
`/home/saefr-ops/.config/saefr-w45/{migration,storage-operator,auth-admin,runtime}.env`,
all mode `0600`, owned by `saefr-ops`. Their contents are never shown in
evidence.

## 4. Read-only preflight

Every command in this section is **[read-only]** with respect to the database,
media and Docker state. Some build or write evidence files; those are noted.
Run them as `saefr-ops`, record raw output in the evidence directory with
secrets redacted, and stop on any mismatch.

### 4.1 Platform, kernel and toolchain

```bash
# [read-only]
uname -srm
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
node --version
npm --version
cc --version | head -1
```

Required result: Linux, Node.js 24.x, and a working `cc` with libc and Linux
UAPI headers for the native helper. The current supported profile is Linux with
a verified ext4 role directory. Windows and macOS cannot run this observer.

### 4.2 Filesystem type and mount

```bash
# [read-only]
findmnt -T /srv/saefr-w45/storage/originals -o TARGET,SOURCE,FSTYPE,OPTIONS
findmnt -T /srv/saefr-w45/storage/thumbnails -o TARGET,SOURCE,FSTYPE,OPTIONS
findmnt -no FSTYPE -T /srv/saefr-w45/storage/originals
findmnt -no UUID -T /srv/saefr-w45/storage/originals
stat -f -c 'stat -f type: %T' /srv/saefr-w45/storage/originals
lsblk -f
```

Required result: `FSTYPE` is exactly `ext4` for both role directories. Record
the mount target, source and filesystem UUID. `stat -f` is supplementary only;
it can collapse ext2/ext3/ext4. If `findmnt` reports anything else, stop. Do not
format, mount or repartition anything as part of this runbook.

### 4.3 Free space and inodes

```bash
# [read-only]
df -h /srv/saefr-w45/storage
df -i /srv/saefr-w45/storage
```

Record bytes and inodes before and after acceptance. This is a small synthetic
library; a full disk is not a tested condition and `ENOSPC` behavior is not
certified.

### 4.4 Directory ownership, mode and symlink ancestry

```bash
# [read-only]
namei -l /srv/saefr-w45/storage
namei -l /srv/saefr-w45/storage/originals
namei -l /srv/saefr-w45/storage/thumbnails
stat -c '%U:%G %a %F %n' \
  /srv/saefr-w45/storage \
  /srv/saefr-w45/storage/originals \
  /srv/saefr-w45/storage/thumbnails
readlink -f /srv/saefr-w45/storage
```

Required result: every component is a directory, not a symbolic link; the
canonical path is `/srv/saefr-w45/storage`; ownership is the dedicated
unprivileged UID/GID. The provisioning primitive rejects a symlink in any path
component and requires both role directories to exist and be empty.

> **Operator must confirm:** the repository does not prescribe a mode for this
> root. Use a restrictive mode (for example `0700` for the operator/runtime
> UID) unless the operator's filesystem policy requires otherwise. The runtime
> UID, not a Windows user, must own and write the role directories.

### 4.5 Database existence and emptiness

Use `psql` with `PG*` variables sourced from the protected file; do not put a
password on the command line or in shell history.

```bash
# [read-only]
psql -X -v ON_ERROR_STOP=1 -Atc \
  "select current_database(), current_user, inet_server_addr(), inet_server_port();"

psql -X -Atc \
  "select datname from pg_database where datname in ('saefr_photos','saefr_w45_env') order by 1;"

# Before migrations, the three tables are expected to be absent.
psql -X -Atc \
  "select to_regclass('public.asset') is null as asset_absent,
          to_regclass('public.asset_deletion') is null as journal_absent,
          to_regclass('public.storage_binding') is null as binding_absent;"
```

After migrations, repeat with the emptiness check:

```bash
# [read-only]
psql -X -Atc \
  "select (select count(*) from public.asset) as assets,
          (select count(*) from public.asset_deletion) as journal,
          (select count(*) from public.storage_binding) as binding;"
```

Required result before provisioning: `assets = 0`, `journal = 0`,
`binding = 0`. `current_database()` must be `saefr_w45_env`, and the only
matching database name on the isolated cluster must be the disposable one. If
`saefr_photos` appears on this host, stop and re-establish isolation.

### 4.6 Port availability

```bash
# [read-only]
ss -ltn
ss -ltn | grep -E ':(55432|3100|5180)\b' || true
```

Required result: `55432` is either the disposable PostgreSQL listener you
intend to use or free before creation; `3100` and `5180` are free on the
relevant hosts. Port `5432` on the Windows development machine is not part of
this procedure.

### 4.7 Exact origin

```bash
# [read-only]
node -e '
const raw = process.env.APP_ORIGIN;
if (!raw) { console.error("APP_ORIGIN is not set"); process.exit(1); }
const u = new URL(raw);
if (u.origin !== raw) { console.error("APP_ORIGIN is not an exact origin"); process.exit(1); }
console.log(u.origin);
'
```

Required result: exactly `http://localhost:5180`. Development HTTP origins must
be loopback. `NODE_ENV=production` with an HTTP origin is rejected at startup.

### 4.8 No existing binding

```bash
# [read-only]
psql -X -Atc "select count(*) from public.storage_binding;"   # after migrations: must be 0
test ! -e /srv/saefr-w45/storage/originals/.saefr-storage.json \
  && echo 'originals marker absent'
test ! -e /srv/saefr-w45/storage/thumbnails/.saefr-storage.json \
  && echo 'thumbnails marker absent'
```

If a marker or binding already exists, stop. Do not delete it to force a fresh
provision; partial or existing marker state is investigation material.

### 4.9 Preflight evidence

Record, in the mode-0700 evidence directory:

- host FQDN, kernel, distro, Node version, `cc` version;
- `findmnt` output, ext4 UUID, mount source and target;
- free bytes/inodes and directory ownership/mode;
- database name, current user, server address/port, and the three emptiness
  counts (or the pre-migration absence result);
- port listeners and the exact `APP_ORIGIN`;
- the development fingerprint described in §7.4.

Do not record passwords, cookies, CSRF tokens, session IDs or marker contents.

## 5. Isolation proof

Capture the following before any mutating phase and again at teardown.

### 5.1 Separate database

```bash
# [read-only]
psql -X -Atc "select current_database(), current_user;"
psql -X -Atc \
  "select oid, datname from pg_database where datname in ('saefr_photos','saefr_w45_env') order by 1;"
```

Evidence: current database is `saefr_w45_env`; no connection to
`saefr_photos`. If the disposable database is on a separate host/VM, record the
host FQDN and loopback listener. Do not connect to the development cluster to
"compare" it.

### 5.2 Separate storage root

```bash
# [read-only]
findmnt -T /srv/saefr-w45/storage -o TARGET,SOURCE,FSTYPE
readlink -f /srv/saefr-w45/storage
stat -c '%d:%i %n' /srv/saefr-w45/storage /srv/saefr-w45/storage/originals /srv/saefr-w45/storage/thumbnails
mount | grep -E 'saefr|/storage' || true
```

Evidence: the root is `/srv/saefr-w45/storage`, its mount source is the
dedicated ext4 device, and no mount entry maps it to the repository `storage/`
or a development path. There is no symlink component.

### 5.3 No shared Docker volume, container or sandbox

Run only if Docker is present on the isolated host. These commands are
**[read-only]**; do not stop or prune anything.

```bash
# [read-only]
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker volume ls
docker volume inspect saefr_photos_db_data 2>/dev/null || echo 'development volume not present on this host'
```

Evidence: no isolated-test container or volume is attached to
`saefr_photos_db_data`; the development volume, if present, has the same
`CreatedAt` before and after this run. If the runbook uses a disposable
PostgreSQL container instead of a local cluster, record its exact name and
confirm it is not `saefr-photos-db`.

Modal sandboxes are expected to be zero because this runbook uses no Modal
keys. Do not call Modal to "verify" cleanup.

### 5.4 Exact host and origin

```bash
# [read-only]
hostname -f
ip -brief address
node -e 'console.log(new URL(process.env.APP_ORIGIN).origin)'
```

Evidence: the Windows browser reaches `http://localhost:5180`, the Vite proxy
forwards `/api` to `http://127.0.0.1:3100`, and the browser's `Origin` header
for login and unsafe requests is exactly `http://localhost:5180`. The API
listens only on `127.0.0.1:3100` on the Linux host. Record a browser DevTools
capture showing the request `Origin` and the absence of an `Access-Control-*`
relaxation.

### 5.5 Isolation gate

**Do not proceed to §6 until all of the following are true and recorded:**

- [ ] `findmnt` reports ext4 for both role directories.
- [ ] The storage root is outside the repository and not a symlink/bind mount.
- [ ] `current_database()` is `saefr_w45_env`; no development database name.
- [ ] No development Docker volume/container is attached.
- [ ] Ports `55432`, `3100` and `5180` are as expected.
- [ ] `APP_ORIGIN` is exactly `http://localhost:5180`.
- [ ] `storage_binding` is empty and both markers are absent.
- [ ] The development fingerprint from §7.4 is recorded.

## 6. Gated provisioning procedure

Each subsection is a separate approval. Stop at the first unexpected output.
Never "make a test pass" by changing a confirmation flag, reusing a development
credential, deleting a partial marker or increasing a limit.

### 6.1 Create the disposable database and role — [mutating]

**Approval A1 required.** The repository does not document a canonical
create-database SQL for this profile, so the exact DDL is **operator must
confirm** with the database administrator. It must satisfy all of:

- a new role named `saefr_w45_ops` (or the approved split roles) with a
  password stored only in the protected file;
- a new database `saefr_w45_env` owned by that role;
- no grant to, or dependency on, `saefr_photos` or the development role;
- connection only over loopback `127.0.0.1:55432`;
- no reuse of the Compose project or `saefr_photos_db_data` volume.

Do not put the password in a shell argument or history. Suggested shape, with
the password entered interactively or supplied by the protected file, not
printed:

```bash
# [mutating — approval A1]
# --pwprompt keeps the password out of argv and shell history.
createuser --host=127.0.0.1 --port=55432 --login --createdb --pwprompt saefr_w45_ops

# The new role has CREATEDB, so it may create its own database. If cluster
# policy instead requires a superuser, use that approved path; do not expand
# the disposable role's privileges just to make this command pass.
createdb --host=127.0.0.1 --port=55432 \
  --username=saefr_w45_ops --owner=saefr_w45_ops saefr_w45_env
```

If your PostgreSQL policy requires a superuser to create the database, the
operator performs that step and records only the role/database names, never the
credential. If split roles are used, the grant SQL is operator/DBA-confirmed.

Verify with the §4.5 read-only queries. `saefr_w45_env` must be empty and
distinct.

### 6.2 Apply migrations — [mutating]

**Approval A2 required.** This is the documented migration path, not a custom
runner. Source the protected migration environment, then run from `server/`:

```bash
# [mutating — approval A2; writes schema and ledger rows to saefr_w45_env]
cd /home/saefr-ops/saefr-photos/server
set -a; . /home/saefr-ops/.config/saefr-w45/migration.env; set +a

npm run db:status
npm run db:migrate -- --confirm-database="$MIGRATION_POSTGRES_DB"
```

Expected: `db:status` inspects the empty database without creating metadata;
`db:migrate` applies the current managed history for this commit. On this tree
the core history includes
`202610170001_initial_asset`,
`202610210001_authentication_foundation`,
`202610220001_asset_ownership` and
`202610260001_asset_lifecycle`; the current provider also registers
`202610290001_maintenance_recovery`. The provisioning CLI requires the four
core versions to be applied. Do not use `--baseline-legacy` for a fresh
database. Do not run this against `saefr_photos`.

Then repeat the §4.5 emptiness check. All three tables must be empty. If any
migration, inspector or history check fails, stop; do not edit the ledger, drop
objects, or retry with a different confirmation.

### 6.3 Pre-provision metadata-only and 503 check — [mutating: starts a process]

**Approval A6 is required to start the API.** This optional but recommended
check proves the documented `503` behavior before media exists. Start the API
with the runtime environment but **without** a binding (the database is
migrated and empty). The three binding IDs do not exist yet, so omit
`STORAGE_ID`, `STORAGE_ORIGINALS_BINDING_ID` and
`STORAGE_THUMBNAILS_BINDING_ID` for this phase; the verifier must treat the
unbound environment as metadata-only. Exact M12 history admits authenticated
metadata only.

- `GET /api/v1/me` and `GET /api/v1/assets` return `200` for an authenticated
  synthetic account.
- `POST /api/v1/assets/upload` and media reads return sanitized `503`.
- Startup must not create markers, provision storage or migrate.

Record the status codes and the absence of files/markers. Stop the API before
§6.4; provisioning requires stopped writers. If you cannot authenticate without
a binding, skip this check and record why; do not weaken authentication.

### 6.4 Create the empty storage root — [mutating]

**Approval A3 required.** Create only the dedicated directories, owned by the
unprivileged runtime/operator UID. The provisioning primitive requires the
directories to exist, be real directories, have no symlink component, and be
empty; it does not create them.

```bash
# [mutating — approval A3]
install -d -m 0700 -o saefr-ops -g saefr-ops /srv/saefr-w45/storage
install -d -m 0700 -o saefr-ops -g saefr-ops /srv/saefr-w45/storage/originals
install -d -m 0700 -o saefr-ops -g saefr-ops /srv/saefr-w45/storage/thumbnails
```

If the root is a dedicated mount point, the operator mounts it first; mounting
and formatting are separate mutating actions and are **operator must confirm**.
Do not place the root on the repository filesystem or a network share.

Re-run §4.2, §4.4 and §4.8. Both role directories must be empty, real
directories on ext4 with no marker.

### 6.5 Provision fresh — [mutating]

**Approval A4 required.** This is the exact documented operator primitive. It
requires a TTY, the exact `--confirm-database` and `--confirm-root` arguments,
an absolute root, complete migration history, empty core tables and empty role
directories. Run it as `saefr-ops` from `server/`:

```bash
# [mutating — approval A4; writes markers and the binding singleton]
# Use an interactive console or: ssh -t saefr-ops@<linux-test-host>
cd /home/saefr-ops/saefr-photos/server
set -a; . /home/saefr-ops/.config/saefr-w45/storage-operator.env; set +a

test "$STORAGE_OPERATOR_ROOT" = "/srv/saefr-w45/storage" || {
  echo 'refusing: unexpected storage root'; exit 1;
}

npm run storage:provision-fresh -- \
  --confirm-database="$STORAGE_OPERATOR_POSTGRES_DB" \
  --confirm-root="$STORAGE_OPERATOR_ROOT"
```

Expected success output: exit code 0 and exactly one JSON line with three
UUIDs, in these camel-case keys:

```json
{"storageId":"<uuid>","originalsBindingId":"<uuid>","thumbnailsBindingId":"<uuid>"}
```

Copy those three values only into the protected runtime environment. Do not
print them in review evidence; record that they were captured. The command
calls the binding verifier before returning, so success means the database
singleton, both markers and both observed role identities agreed at that
moment. Ordinary startup re-verifies at each media operation.

Expected failure output: exit code 1 and
`Storage provisioning unavailable; inspect operator prerequisites.` The CLI
deliberately hides credentials, paths, SQL and physical identities. **Stop.**
Do not rerun with new IDs, do not delete a partial marker, and do not edit the
database by hand. The documented rule is that partial marker writes are
retained for operator investigation and cannot be retried as a fresh adoption
with new IDs.

### 6.6 Post-provision verification — [read-only]

**Independent binding check before the Windows frontend connects.** Verify the
database row, both markers and both paths; do not trust the provisioning stdout
alone.

```bash
# [read-only]
psql -X -Atc \
  "select storage_id, originals_binding_id, thumbnails_binding_id,
          storage_layout_version
     from public.storage_binding;"
psql -X -Atc "select count(*) from public.storage_binding;"

for role in originals thumbnails; do
  test -f "/srv/saefr-w45/storage/$role/.saefr-storage.json" \
    && echo "$role marker present"
  stat -c '%U:%G %a %s %n' "/srv/saefr-w45/storage/$role/.saefr-storage.json"
  sha256sum "/srv/saefr-w45/storage/$role/.saefr-storage.json"
done
```

Required result:

- exactly one `storage_binding` row with `storage_layout_version = 1`;
- its three IDs equal the captured provisioning IDs;
- originals and thumbnails binding IDs are different;
- both markers are regular files at the expected paths, owned by the runtime
  UID, and their hashes are recorded (contents not printed).

If any check disagrees, stop. The provisioning output alone is not the
binding proof. This is the gate that must pass before §7.2 starts the tunnel.

## 7. Backend and test startup

### 7.1 Runtime environment

Create the protected runtime file with the values from §3.3 and the three IDs
captured in §6.5. Do not copy the repository `.env` or the development
credentials. The API process environment takes precedence over any `.env` file
loaded by Nest. The five `STORAGE_*` variables in §3.3 are mandatory for media.

A shape only — every value below is a placeholder or the exact non-secret value:

```text
NODE_ENV=development
HOST=127.0.0.1
PORT=3100
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=55432
POSTGRES_DB=saefr_w45_env
POSTGRES_USER=saefr_w45_ops
POSTGRES_PASSWORD=<isolated-db-password>
APP_ORIGIN=http://localhost:5180
STORAGE_ROOT=/srv/saefr-w45/storage
STORAGE_ID=<printed-storage-id>
STORAGE_ORIGINALS_BINDING_ID=<printed-originals-binding-id>
STORAGE_THUMBNAILS_BINDING_ID=<printed-thumbnails-binding-id>
STORAGE_ORIGINALS_PROFILE=linux-ext4-v1
STORAGE_THUMBNAILS_PROFILE=linux-ext4-v1
```

### 7.2 Start the API — [mutating: starts a process]

**Approval A6 required.**

```bash
# [mutating — approval A6]
cd /home/saefr-ops/saefr-photos/server
set -a; . /home/saefr-ops/.config/saefr-w45/runtime.env; set +a

npm run build
npm run start:prod    # node dist/main; does not rebuild
```

Expected: the API listens on `127.0.0.1:3100`; startup checks exact schema
history and, for M12, runs the binding assessment. Startup does not migrate or
provision. A successful listen is not by itself proof of media readiness; the
provisioning verifier already passed in §6.5, and each media operation
re-verifies. If media returns `503`, re-check the five `STORAGE_*` variables
first, then the markers/binding; do not bypass the verifier.

Read-only health check:

```bash
# [read-only]
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/health/ready
```

Record the status. `/health/ready` checks database connectivity, not storage
readiness.

### 7.3 Bootstrap the acceptance account — [mutating]

**Approval A5 required.** This is the documented account operator command; it
requires a TTY and hidden password entry.

```bash
# [mutating — approval A5]
cd /home/saefr-ops/saefr-photos/server
set -a; . /home/saefr-ops/.config/saefr-w45/auth-admin.env; set +a

npm run auth:bootstrap -- \
  --confirm-database="$AUTH_ADMIN_POSTGRES_DB" \
  --username=w45-acceptance
```

Enter the synthetic password at the prompt; never put it in shell history or
evidence. If the account is marked `passwordChangeRequired`, complete the
change-password flow before gallery/lifecycle testing. Alternatively, create an
ordinary synthetic user through the admin API; that is also a mutating action
under A5. No public registration exists.

### 7.4 Windows frontend connection

**Approval A6 required.** Connect the Windows browser only after §6.6 passed.
The Linux API stays bound to loopback on the isolated host; expose it to the
Windows machine with an SSH local port forward, not a public listener.

On Windows:

```powershell
# [mutating — approval A6: opens a local forwarding listener]
ssh -N -T -L 127.0.0.1:3100:127.0.0.1:3100 saefr-ops@<linux-test-host>
```

In a second Windows terminal:

```powershell
# [mutating — approval A6: starts the Vite dev server]
# operator must confirm the exact checkout/branch under test
cd <path-to-web-checkout>\web
npm ci
npm run dev
```

Open **Microsoft Edge** at `http://localhost:5180` (the project's approved
Browse platform), not `http://127.0.0.1:5180`.

The existing `web/vite.config.ts` proxy already targets
`http://127.0.0.1:3100` with `changeOrigin: false`, and the dev server uses
port `5180` with `strictPort`. That preserves the browser `Origin`, cookies and
CSRF semantics:

- The browser origin is `http://localhost:5180`; `APP_ORIGIN` must match it
  exactly.
- The dev session cookie is host-only for `localhost`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, and not `Secure` because `NODE_ENV=development`.
  It flows through the same-origin Vite proxy normally.
- Unsafe authenticated requests still need `X-CSRF-Token` from `/api/v1/me`;
  do not disable CSRF or add a CORS shortcut.
- Do not set `changeOrigin: true`, do not bind the API to `0.0.0.0`, do not use
  `NODE_ENV=production` over HTTP, and do not mount the Linux storage root on
  Windows.

If a port or hostname change is unavoidable, it is a separate reviewed change
to `web/vite.config.ts` and `APP_ORIGIN`; do not patch around it during
acceptance. **Operator must confirm** that no stale proxy or tunnel from a
different environment is running.

## 8. Acceptance checklist for W3/W4/W5

### 8.1 Phase availability caveat

At this branch baseline, W3 is implemented; the W4 upload UI and W5
Trash/lifecycle UI are explicitly deferred in
`web/docs/w3-gallery-plan.md` and `web/docs/w2-w3-implementation-report.md`.
**Operator must confirm** that the branch under test actually contains the W4
and W5 frontend work. Until it does:

- API-level checks below may validate the backend, but must not be recorded as
  UI acceptance.
- W3 UI checks may run, and the previously documented synthetic-media
  limitation no longer applies once §6.6 passes.
- Do not show or claim a UI action that the branch does not implement.

### 8.2 Checks and expected results

Use only synthetic images created for this environment. A small JPEG, PNG and
WebP under 20 MiB is sufficient. Uploads are one multipart part with field name
exactly `file`; unsupported extra parts/fields are rejected. The limit is
20 MiB (`20 * 1024 * 1024`).

| Phase | Check | Expected result | Evidence to record |
| ----- | ----- | --------------- | ------------------ |
| W3 | `GET /api/v1/assets?limit=50` | `200` `{items,next_cursor}`; owner-scoped; no count field | Status, item count, cursor presence |
| W3 | Thumbnail `GET /api/v1/assets/:id/thumbnail` | `200`, `image/jpeg`, private `no-store` | Status, content type, bytes |
| W3 | Original `GET /api/v1/assets/:id/original` | `200`; exact original bytes | SHA-256 before/after upload |
| W3 | Gallery pagination and viewer (Edge) | Server order preserved; opaque cursor; scroll restored; no fake counts | Screenshots and request log |
| W3 | Direct link / unknown UUID | Safe not-found; no fixture fallback | Status and UI state |
| W4 | Upload JPEG | `201`, `AssetResponse`, initial lifecycle ETag | Status, ETag, response fields |
| W4 | Upload PNG | `201`, `mime_type = image/png` | Status, MIME, bytes |
| W4 | Upload WebP | `201`, `mime_type = image/webp` | Status, MIME, bytes |
| W4 | Original byte preservation | Downloaded bytes hash equals uploaded bytes | Two SHA-256 values |
| W4 | Thumbnail generation | JPEG thumbnail exists; valid `image/jpeg` | Status, content type, bytes |
| W4 | Oversize file | `413` | Status, measured input size |
| W4 | Invalid/unsupported image | `415` | Status, synthetic file name |
| W4 | Missing/extra multipart part | `400` | Status, request shape |
| W4 | Uncertain disconnect/timeout | No automatic retry; UI says check gallery before retry | UI screenshot and network log |
| W5 | Trash with current strong `If-Match` | `200` + new ETag; item in Trash | Status, old/new ETag |
| W5 | Trashed original | `404`; no public original route | Status |
| W5 | Trash thumbnail | `200`, owner-only JPEG | Status, content type |
| W5 | Restore with current `If-Match` | `200` + new ETag; active again | Status, old/new ETag |
| W5 | Permanent delete of active asset | `409` | Status |
| W5 | Permanent delete of trashed asset | `200` completed or `202` accepted/pending; receipt + `Location` | Status, `Location`, receipt body |
| W5 | Receipt status | `GET .../deletions/:id` `200`; pending or completed; no internal tokens/paths | Receipt JSON (redacted) |
| W5 | Pending retry | `POST .../deletions/:id/retry` empty body, no `If-Match`; `200` or `202`; completed receipt is a no-op | Status, receipt state |
| W5 | Stale lifecycle version | `412` | Status and refreshed version |
| W5 | Missing `If-Match` | `428` | Status |
| W5 | Active/foreign/trashed not-found semantics | `404`; no existence disclosure | Status |
| Auth | Session revoked or expired | `401`; UI clears local state and redirects to login with safe `next` | Status, redirect path |
| Storage | Storage unavailable | Sanitized `503`; never success copy | Status and UI state |

Lifecycle mutation requests must send **no body at all** (not `{}`, `null`, a
placeholder or multipart) and must include the exact strong ETag including
double quotes. A `202` means accepted but unfinished, not scheduled and not an
automatic retry.

### 8.3 Negative-test safety

- Test the `503` path in the pre-provision metadata-only phase (§6.3) or in a
  separate disposable instance. Do not intentionally break the accepted
  binding/markers on the instance used for positive acceptance.
- Do not update `auth_session.expires_at` in SQL or otherwise tamper with auth
  rows to force expiry. The supported 401 proxy is revoking the current
  session (`DELETE /api/v1/auth/sessions/:id`) or `logout-all`. A real clock
  expiry is 7 days for an ordinary session and 15 minutes only when
  `passwordChangeRequired`; **operator must confirm** whether waiting for a
  real expiry is practical. If not, record that the tested path was revocation,
  not clock expiry.
- Do not edit markers, the binding row, the deletion journal or asset rows by
  hand. Do not run `storage:adopt-historical`, `storage:reestablish-location`
  or any recovery command as part of acceptance.

### 8.4 Evidence to record

For each check, record in the mode-0700 evidence directory:

- exact command or UI action, timestamp, and actor;
- HTTP status, `ETag`, `Location`, content type and response byte count;
- whether `Origin`, cookie and CSRF were enforced (yes/no, without printing
  the token);
- the synthetic file's SHA-256 and size before upload and the downloaded
  original's SHA-256 and size;
- read-only database counts before and after:
  `asset`, `asset_deletion`, and the receipt's `status`/`last_error_code`;
- file counts under `originals/` and `thumbnails/`, and free-space/inode
  deltas;
- Edge screenshots of the honest loading, empty, error, retry, 412/428 and 503
  states;
- the exact tested commit SHA and branch.

Redact or omit cookies, CSRF tokens, session IDs, passwords, marker contents
and full binding IDs from public review evidence. Redirect `Set-Cookie`
headers and the login response's `csrfToken` before saving.

### 8.5 Spend and cleanup note

This environment uses no Baseten, Modal or other paid provider and requires no
API keys. Expected spend is **$0** and expected Modal sandboxes are **zero**.
Do not add provider keys to make a test pass. If a future acceptance introduces
a paid provider, stop, obtain separate approval, apply the repository's token,
sandbox-time and cost caps, record measured usage, and destroy every sandbox in
a `finally` block.

## 9. Teardown

Teardown is a separate approval (A8/A9) and must not run until the acceptance
evidence has been reviewed and copied out of the disposable environment.

### 9.1 Stop services and the tunnel

Stop the API and the Vite dev server with their normal foreground interrupt or
the operator-confirmed service manager. Close the SSH tunnel. Confirm no
listener remains on `3100` or `5180` (the Linux API and the Windows dev server,
respectively) and no stray PostgreSQL listener other than the disposable one
you intend to remove.

```bash
# [read-only]
ss -ltn | grep -E ':(55432|3100|5180)\b' || true
```

### 9.2 Verify zero containers, volumes and sandboxes

```bash
# [read-only]
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker volume ls
docker volume inspect saefr_photos_db_data 2>/dev/null || true
```

Expected: no isolated-test container or volume remains; the development
`saefr_photos_db_data` volume, if present, is unchanged (same `CreatedAt` as the
preflight fingerprint). If a disposable container was used, remove only that
exact container after confirming its name and labels; never run
`docker compose down -v`, `docker volume rm`, `docker system prune --volumes`
or an equivalent bulk cleanup.

Modal sandboxes: expected zero. Do not create keys or call Modal during
teardown. If any were created by a separately approved run, destroy them and
record the zero-sandbox verification.

### 9.3 Drop the disposable database/role — [mutating]

**Approval A9 required.** Confirm the connection first, then drop only the
exact disposable database.

```bash
# [mutating — approval A9]
psql -X -Atc "select current_database(), current_user;"   # must be saefr_w45_env
dropdb --host=127.0.0.1 --port=55432 --username=saefr_w45_ops saefr_w45_env

# Do not connect as the role being dropped. Use the approved cluster-admin
# role, which is operator/DBA-confirmed, not invented here.
dropuser --host=127.0.0.1 --port=55432 --username=<cluster-admin-role> saefr_w45_ops
```

Do not drop `saefr_photos`, the development role, the PostgreSQL cluster, or the
Compose volume. If the disposable database was created inside a dedicated
container, removing that container is a separate, explicitly confirmed action;
inspect its identity first. **Operator must confirm** whether the role owns
objects in any other database before dropping it.

### 9.4 Remove the disposable storage root — [mutating]

**Approval A9 required.** This is irreversible. Guard the exact path and prove
it is not development storage or a mount into it before removing anything.

```bash
# [read-only guards, then mutating removal under approval A9]
test "$ISOLATED_ROOT" = "/srv/saefr-w45/storage" || {
  echo 'refusing: unexpected root'; exit 1;
}
findmnt -T "$ISOLATED_ROOT" -o TARGET,SOURCE,FSTYPE
readlink -f "$ISOLATED_ROOT"
namei -l "$ISOLATED_ROOT"
case "$(readlink -f "$ISOLATED_ROOT")" in
  */Documents/saefr-photos/storage*|*/storage) echo 'refusing: development storage'; exit 1;;
esac

rm -rf --one-file-system -- "$ISOLATED_ROOT"
```

If the root is a dedicated mount point, `rm -rf` removes its contents but not
the mount; unmounting and removing the underlying device are separate
operator-confirmed actions. Do not use a wildcard, a variable that can be
empty, or a bulk Docker/filesystem cleanup.

### 9.5 Prove development data is untouched

On the Windows development machine, run only read-only checks:

```powershell
# [read-only]
git -C C:\Users\Sahil\Documents\saefr-photos status --short
git -C C:\Users\Sahil\Documents\saefr-photos rev-parse HEAD
(Get-ChildItem -Recurse -File C:\Users\Sahil\Documents\saefr-photos\storage |
  Measure-Object).Count
docker volume inspect saefr_photos_db_data
```

Compare with the preflight fingerprint:

- repository HEAD and `git status` unchanged;
- `storage/` file count and newest timestamps unchanged;
- `saefr_photos_db_data` `CreatedAt` and mountpoint unchanged;
- no isolated-test container, volume or sandbox remains.

Do **not** connect to the development database to "prove" it is untouched; the
absence of any development credential in this procedure, plus the unchanged
volume metadata and repository fingerprint, is the evidence. If any
development path was touched, stop, preserve evidence, and follow the
repository's recovery-plan rules; do not delete or restore over it.

## 10. Risks, rollback and stop conditions

| Risk | Control | Stop condition |
| ---- | ------- | -------------- |
| Wrong database targeted | Exact DB name, separate port, `current_database()` preflight, exact `--confirm-database` | Any `saefr_photos` result |
| Development storage reused | Absolute root, `findmnt`, `namei`, `readlink -f` guard | Any repository/`storage` path or bind mount |
| Non-ext4 or symlink path | `findmnt` + `namei`; observer fails closed | Not `ext4`; symlink component |
| Partial marker write | Provisioner leaves markers; docs forbid rerun as fresh | Any provisioning failure |
| Incorrect runtime storage vars | §6.6 check; 503 on first media operation | 503 despite a valid binding |
| Origin/cookie/CSRF mismatch | Exact `APP_ORIGIN`, `changeOrigin: false`, Edge at `localhost:5180` | Login, CSRF or cookie failure |
| Wrong container/volume cleanup | Identify exact name/labels; no bulk prune | Unknown container or dev volume |
| Power-loss durability assumption | No claim; synthetic acceptance only | Any request to call it production-ready |
| Secret leakage | Protected mode-0600 files outside repo/media; redact evidence | Any secret in a log or commit |

**Rollback.** Stop the API, web server and tunnel. Leave the disposable
database, binding row, markers and media in place for investigation. Do not
delete partial markers or retry a failed fresh provisioning with new IDs. Do
not restore anything over development. Only after review should the operator
repeat the approved phase or proceed to teardown. Because the environment is
disposable and separate, rollback of development data is neither needed nor
authorized.

**Global stop conditions.** Stop immediately and report if:

- any command resolves to `saefr_photos`, the development role, the
  `saefr_photos_db_data` volume or the repository `storage/`;
- `findmnt` does not report ext4 for both role directories;
- a marker or binding already exists before provisioning;
- provisioning fails, or its output IDs do not match the database row;
- the API reports media `503` after a verified binding;
- the browser `Origin` differs from `APP_ORIGIN`;
- any step would require a provider key, a security-control bypass, a database
  edit, a hand-written marker, or a confirmation-flag change to proceed.

## 11. Approval and sign-off

Complete this block before each mutating phase. A signature against one phase
does not authorize the next.

| Field | Value |
| ----- | ----- |
| Reviewer / repository admin | |
| Operator (name, Linux UID) | |
| Linux host / FQDN | |
| Distro / kernel | |
| PostgreSQL version / host:port | |
| Exact database / role | `saefr_w45_env` / `saefr_w45_ops` (or approved split roles) |
| Exact storage root / ext4 UUID | `/srv/saefr-w45/storage` / |
| Exact `APP_ORIGIN` | `http://localhost:5180` |
| Tested commit SHA / branch | |
| Evidence directory | `/home/saefr-ops/saefr-w45-evidence` |
| Spend (expected $0; measured) | |
| Sandboxes after run (expected 0) | |

Phase approvals:

- [ ] **A1** Create disposable database/role — date, approver:
- [ ] **A2** Apply migrations — date, approver:
- [ ] **A3** Create storage root/role directories — date, approver:
- [ ] **A4** Run `storage:provision-fresh` — date, approver:
- [ ] **A5** Bootstrap/bootstrap an account and create synthetic test user — date, approver:
- [ ] **A6** Start API, start Windows web server, open SSH tunnel — date, approver:
- [ ] **A7** Upload/Trash/Restore/permanent-delete/retry acceptance — date, approver:
- [ ] **A8/A9** Teardown: containers/volumes, database/role, storage root — date, approver:
- [ ] **A10** Provider keys — **not requested; not authorized by this runbook**

Final attestations:

- [ ] Preflight and isolation evidence captured and reviewed.
- [ ] Independent binding verification (§6.6) passed before the Windows
  frontend connected.
- [ ] All acceptance evidence is recorded, with secrets redacted.
- [ ] No development database, development `storage/`, Compose volume or
  production credential was read, copied, modified or deleted.
- [ ] No provider key was added and no paid provider call was made.
- [ ] Teardown removed only the named disposable database/role and storage
  root, and zero isolated containers/volumes/sandboxes remain.
- [ ] The development fingerprint after teardown matches the preflight
  fingerprint.

Operator signature: __________________________  Date: ______________

Reviewer signature: __________________________  Date: ______________

## 12. Known documentation and code discrepancies

Report these to the repository admin before execution; they do not change the
safety rules above.

1. **Missing runtime storage variables in the docs.** Neither `server/README.md`
   nor the M12C operator guide documents `STORAGE_ID`,
   `STORAGE_ORIGINALS_BINDING_ID`, `STORAGE_THUMBNAILS_BINDING_ID`,
   `STORAGE_ORIGINALS_PROFILE` or `STORAGE_THUMBNAILS_PROFILE` for ordinary API
   startup. The verifier reads them; missing or non-`linux-ext4-v1` values make
   media unavailable. This runbook adds them.
2. **Operator variable shorthand.** The M12C guide lists
   `STORAGE_OPERATOR_POSTGRES_HOST`, `PORT`, `DB`, `USER`, `PASSWORD`; the code
   reads the fully prefixed names (`STORAGE_OPERATOR_POSTGRES_PORT`, etc.).
   Use the exact names in §3.3.
3. **No `server/.env.example`.** The only example in this tree is the
   repository-root `.env.example`. Its values are development values
   (`saefr_photos` / `saefr` / `../storage`) and must not be reused.
4. **Historical paths.** M12 reports refer to `server-nest/`; the current tree
   uses `server/`. Commands in this runbook use the current path.
5. **`api-integration.md` is untracked** in the main reference checkout and is
   absent from this worktree. Its own header says it is a draft handoff that
   must be re-read against the current source after M12 merges. This runbook
   treats it as guidance, not an authoritative generated schema.
6. **W4/W5 UI availability.** At this branch baseline the W4 upload UI and W5
   Trash/lifecycle UI are deferred. API-level acceptance can proceed once the
   environment is ready, but UI acceptance must wait for the corresponding
   frontend work and must be recorded separately.
7. **`start:prod` does not build.** It runs `node dist/main`; run
   `npm run build` first (as above), or use `start:dev` for a watched build.
8. **Standalone read-only binding check.** There is no separate documented CLI
   that only verifies an existing binding. The provisioning command verifies
   before it exits, and the app re-verifies at every media operation; §6.6
   supplies the independent database/marker/path checks. **Operator must
   confirm** whether a future reviewed read-only verifier is added.
