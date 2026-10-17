# Milestone 9 — Phase 9B: Upload and filesystem safety hardening

- **Status:** Implemented; awaiting maintainer review; uncommitted
- **Branch and base commit:** `refactor/nestjs-migration`, `f8930be` (committed Phase 9A)
- **Date:** 2026-10-17 IST
- **Scope:** Phase 9B only. No separate Phase 9B specification file exists.

## Implementation and decisions

The upload controller now parses a single multipart `file` part and verifies the parser reaches the end of the request before storage publishes either file. It starts forwarding the file stream immediately through a bounded Node `PassThrough` so delayed directory setup cannot stall multipart parsing. Premature or malformed multipart input is rejected, and a client disconnect or stream error causes temporary-file cleanup. Extra fields/files and uploads over 20 MiB are rejected. The storage service independently enforces the same 20 MiB limit, including callers outside HTTP. Fixed HTTP messages cover recognized multipart errors without reflecting client input.

Storage continues to preserve the uploaded original byte for byte and uses Sharp only to validate format/dimensions and make the thumbnail. JPEG, PNG and WebP remain the accepted formats. The 40-million-pixel limit and multi-page rejection remain in place. Temporary originals and thumbnails are mode `0600` before publication. Final filenames come from validated UUIDs; hard-link publication fails on a collision instead of replacing an existing file. Read/write directory checks reject child-directory symlinks, including aliases within the root; reads also retain `O_NOFOLLOW` for final files. Cleanup attempts are logged with fixed messages if removal fails.

The service still publishes files before inserting PostgreSQL metadata and attempts to remove its newly published files when insertion fails. This preserves the existing API and schema. It does not run broad media reconciliation or delete pre-existing files.

## Changed files

| File | Purpose |
| --- | --- |
| `server-nest/src/assets/assets.controller.ts` | Multipart completion, limits, stream lifecycle and safe error mapping |
| `server-nest/src/assets/assets.service.ts` | Pass completion check to storage; safe cleanup logging |
| `server-nest/src/main.ts` | Register Fastify multipart for manual streaming |
| `server-nest/src/storage/image-limits.ts` | Shared upload and pixel limits |
| `server-nest/src/storage/local-storage.service.ts` | Byte cap, private temp files, path validation and cleanup reporting |
| `server-nest/src/storage/local-storage-upload.spec.ts` | Stream, image, collision and filesystem failure tests |
| `server-nest/src/storage/local-storage.service.spec.ts` | Symlink and invalid identifier tests |
| `server-nest/test/upload.e2e-spec.ts` | HTTP multipart limit and invalid-part cases |
| `server-nest/test/upload-storage.e2e-spec.ts` | Real storage with temporary roots; complete/truncated/disconnected uploads, byte preservation and DB failure compensation |
| `docs/architecture.md`, `docs/roadmap.md` | Current flow, status and limits |
| This report | Verification and remaining risks |

## Verification

All npm commands ran in `server-nest/` on Node.js `v24.22.0`. Docker-backed tests used the existing isolated runner, which created a unique PostgreSQL 18 container with tmpfs data, test-only credentials and a random localhost port; it reported removal afterward. The development Compose volume, database and media directories were not used.

| Command | Final result | Evidence |
| --- | --- | --- |
| `npm run build` | PASS | Nest build completed |
| `npm run typecheck` | PASS | TypeScript no-emit check completed |
| `npm run lint` | PASS | Type-aware oxlint completed |
| `npm run test` | PASS | 7 files, 55 unit tests |
| `npm run test:e2e` | PASS | 5 files, 28 HTTP tests; repository mocked, with seven cases using real storage in temporary directories |
| `npm run test:integration` | PASS | 2 files, 35 tests against disposable PostgreSQL 18; container removed |
| Targeted Prettier check and `git diff --check` | PASS | Changed TypeScript files formatted; no whitespace errors |

During development, a real-storage truncated-body case exposed an HTTP injector stall. It is now tested over a real localhost socket, and immediate stream forwarding prevents the parser/storage timing deadlock. The first full E2E run with an injector-only truncated case timed out; that duplicate injector case was removed after the real-socket case passed. An intermediate typecheck rejected a Node `Buffer` as a Fetch body; the test now supplies a `Uint8Array`, and the subsequent typecheck passed. The deliberate simulated DB failure logs a Nest test error but the E2E suite passes and verifies compensation.

## Safety guarantees and limits

During ordinary handled failures, incomplete multipart bodies, interrupted streams, over-limit payloads, invalid images, failed thumbnail processing and final-name collisions do not intentionally publish an asset. Storage attempts to remove partial temporary files and any newly published file if a later step fails. Tests confirm existing colliding files and an unrelated sentinel remain unchanged. Tests use newly created OS temporary directories and do not address the development `storage/` tree.

PostgreSQL and the filesystem are not one transaction. A process or host crash can leave temporary files, only one published file, or published files without metadata. A database insert error with an uncertain commit outcome can also leave a metadata row whose files were removed by compensation. Filesystem errors or permission changes can make cleanup fail; the service logs this but cannot guarantee removal. No automatic startup cleanup or broad deletion was added because it could destroy legitimate media. The configured storage root and its parent must be controlled by the operator; concurrent replacement by a privileged local actor and remote/NAS semantics remain outside this phase. The 40-million-pixel cap limits decoded image dimensions but does not impose a separate CPU-time or memory ceiling on Sharp. Authentication and authorization are still absent, so the API must remain localhost-only by default.

## Repeating verification

```bash
cd /home/kartik/Saefr/saefr-photos/server-nest
npm run build
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:integration
```

The integration command requires Docker and uses only its verified disposable PostgreSQL container. It must not be replaced with migrations or tests pointed at the development database. Manual checks before deployment: inspect storage-root ownership/permissions and test backup/recovery for interrupted publication and uncertain DB commits in a separate installation.

## Review gate

- [ ] Maintainer reviewed Phase 9B diff
- [x] Required automated checks passed on the implementation
- [x] Development database, Docker volume and stored photographs preserved
- [ ] Commit or push approved
- [x] Phase 9C not started
