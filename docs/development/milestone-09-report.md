# Milestone 9 — Backend hardening consolidated report

- **Status:** Phases 9A and 9B committed; Phase 9C implemented and awaiting review
- **Branch:** `refactor/nestjs-migration`; no integration branch created
- **Date:** 2026-10-17 IST

## Phase summary

| Phase | Status and evidence | Implemented protection |
| --- | --- | --- |
| [9A](milestone-09a-report.md) | Committed as `f8930be` | Central runtime configuration validation, localhost defaults, safe startup failure handling, removal of unused Express/Mau dependencies |
| [9B](milestone-09b-report.md) | Committed as `69dbeaf` | Multipart completion before publication, upload size and image limits, stream/temporary-file cleanup, path and symlink checks, no-overwrite publication, byte-for-byte originals |
| [9C](milestone-09c-report.md) | Uncommitted; awaiting review | Sanitized HTTP errors, allowlisted request/startup/cleanup diagnostics, safe pool-shutdown failure handling, final regression and runtime smoke checks |

## Final regression evidence

With Node.js `v24.22.0` on the current branch, Phase 9C verification passed: `npm run build`, `npm run typecheck`, `npm run lint`, targeted Prettier, 59 unit tests, 34 HTTP E2E tests, 35 isolated PostgreSQL integration tests, 28 migration-only tests, the invalid-config/occupied-port/SIGTERM runtime smoke command, and `git diff --check`. The final runner also passed `node --check` and targeted Prettier after its test-selection correction. Both PostgreSQL 18 test containers were removed. Details and the initial smoke assertion correction are in the [Phase 9C report](milestone-09c-report.md). Earlier phase-specific commands and outcomes remain recorded in their reports; the current checks exercise the committed 9A and 9B code together with 9C.

## Implemented safety boundary

Configuration rejects missing or malformed required values without printing supplied secrets. The unauthenticated API defaults to `127.0.0.1`. Uploads validate actual image data, cap file size and decoded pixels, preserve original bytes and avoid overwriting existing final files. Handled failures attempt to remove temporary and newly published files. HTTP clients receive fixed messages for unexpected failures; server logs retain a safe route/category diagnostic without raw driver messages, database URLs, storage paths or photo contents. Migration execution remains a separate, explicitly confirmed command; API startup never runs migrations.

All new filesystem tests use temporary directories. Real database tests use verified disposable PostgreSQL 18 containers with tmpfs data and separate credentials. The development PostgreSQL volume, asset records and photographs were not modified or migrated.

## Outstanding risks and release boundary

- **No public access yet:** Authentication, per-asset authorization and deployment controls are absent. An explicitly configured non-local `HOST` can expose the API; localhost is the safe default.
- **No cross-system transaction:** A crash or ambiguous database commit can leave files and metadata inconsistent. Cleanup can fail when storage is unavailable, and there is no automatic reconciliation. Restore and recovery procedures need design and testing.
- **Runtime limits:** Sharp has upload/pixel bounds but no separate CPU-time ceiling. Storage assumes an operator-controlled local root; concurrent privileged replacement and NAS semantics remain unverified.
- **Error/operation limits:** Nest HTTP errors are sanitized, but pre-route Fastify errors and already-started media streams have different failure semantics. Logs have no correlation IDs, retention, alerting or external observability service.
- **Deployment validation remains:** No Dockerized API stack, production backup/restore rehearsal, real deployment shutdown under hung I/O, or end-to-end security review has been completed.

Milestone 9 therefore hardens the development backend; it does not establish deployment readiness or a secure public service. The proposed `integration` branch and authentication module require separate maintainer approval after review.

## Review gate

- [ ] Maintainer reviewed Phase 9C and this consolidated report
- [x] Final automated regression commands passed
- [ ] Phase 9C commit/push approved
- [ ] Integration branch approved
- [x] No authentication or later milestone work started
