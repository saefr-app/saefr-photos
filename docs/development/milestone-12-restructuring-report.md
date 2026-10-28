# M12 repository restructuring report

**Status:** Local, uncommitted layout change on `feat/m12-asset-lifecycle` from `5823df5377d77d2a56d48133ae91371b21e63300`; awaiting independent review. Draft PR #9 remains open. This report does not authorize real-data migration, storage adoption, deployment or merge.

## Scope and inventory

- Retired exactly 16 tracked FastAPI files from the old `server/`: `app/api/__init__.py`, `app/api/v1/__init__.py`, `app/api/v1/assets.py`, `app/config.py`, `app/database/__init__.py`, `app/database/database.py`, `app/main.py`, `app/models/__init__.py`, `app/models/asset.py`, `app/repositories/__init__.py`, `app/repositories/asset_repository.py`, `app/services/__init__.py`, `app/services/asset_service.py`, `app/storage/__init__.py`, `app/storage/local.py` and `requirements.txt`. Git history retains them.
- Moved all 138 tracked files from `server-nest/` to the identical paths under `server/`, including `src/`, `test/`, `native/`, package files, README and build/test configuration. The exact inventory is the 138 paths under `server-nest/` at the starting HEAD with the prefix replaced by `server/`. Each source and destination pair had identical SHA-256 file content immediately after the move; file modes were preserved by filesystem rename.
- The legacy destination had **no** untracked or ignored files. Ignored generated `server-nest/dist/` and `server-nest/tsconfig.build.tsbuildinfo` in the old source directory were left untouched; they are not tracked backend source. No broad directory removal was used.
- Updated current documentation, the root non-secret `.env.example`, `.gitignore`, and the native ext4 workflow's path filters, cache lockfile and working directory. Corrected 22 relative Markdown link targets in historical M10 documents without changing their phase evidence or status.

## Configuration and data safety

`server/src/app.module.ts` still loads `../.env` before `./.env` relative to the process working directory; process environment values retain precedence. Both old and new backend directories are direct children of the repository, so the unchanged default `STORAGE_ROOT=../storage` resolves to the same root media location. Build, test, migration and operator scripts remain relative to the backend directory. The obsolete Python `DATABASE_URL` example was replaced by Node runtime settings; no real environment file was opened or changed.

The root PostgreSQL Compose service and named volume, `storage/originals/`, `storage/thumbnails/`, real binding markers and existing database records were not modified. No storage provision/adoption/relocation/restoration or real-data migration command ran. M12 authorization, storage identity, journal, deletion and HTTP application source were moved byte-for-byte, without logic changes.

## Local verification

Checks ran from the new `server/` with Node.js `v24.22.0` and Docker Server `29.7.2`. The existing dependency installation had an identical `package-lock.json` SHA-256 and was linked temporarily as ignored `node_modules`; no dependency manifest changed. The database runner used only its owned labeled `postgres:18` tmpfs containers, isolated credentials and loopback ports.

| Command                      | Result                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`              | PASS; `server/dist/main.js` and the native helper were created.                                                                        |
| `npm run typecheck`          | PASS.                                                                                                                                  |
| `npm run lint`               | PASS.                                                                                                                                  |
| `npm run test`               | PASS: 153 tests in 21 files.                                                                                                           |
| `npm run test:e2e`           | PASS: 59 tests in eight files.                                                                                                         |
| `npm run test:integration`   | PASS: 269 tests in 15 executed files; six native-only cases skipped on this non-ext4 host. The owned PostgreSQL container was removed. |
| `npm run test:migrations`    | PASS: 82 tests in one file, overlapping the integration count. Its owned PostgreSQL container was removed.                             |
| `npm run test:runtime-smoke` | PASS: invalid configuration and unavailable authentication database exited safely.                                                     |
| `npm run test:native`        | PASS: six local observer tests; not ext4 certification.                                                                                |

Focused Prettier passed on all changed Markdown and workflow files. All 165 repository-relative Markdown links resolved. `git diff --check` passed for tracked changes, and read-only no-index whitespace checks passed for all 139 untracked files (138 moved backend files plus this report). The hosted ext4 certification from [run 40643838258](https://github.com/saefr-app/saefr-photos/actions/runs/40643838258) applies to the prior implementation checkpoint. A fresh hosted run against this layout is still required before M12 merge review; it was **not** run as part of this local restructuring.

## Remaining gates

Independent review and a separately approved checkpoint are required before updating draft PR #9. M12 is not merged or deployed. No real-data upgrade, matching database/media backup and restore rehearsal, storage adoption or production TLS/proxy validation has been approved. Legacy NULL-owned assets remain quarantined. M13 background maintenance and automatic Trash expiry are future work. The preserved old ignored build cache may be removed only in a separate cleanup decision; it is not part of the tracked backend.
