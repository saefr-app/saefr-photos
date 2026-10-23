# Milestone 11D — Secure asset HTTP exposure

- **Status:** implemented and verified in the feature branch; final independent re-review returned PASS after the startup-test evidence correction. The maintainer approved the M11D Git checkpoint on 2026-10-23.
- **Branch/base:** `feat/m11-asset-ownership`, `a355b138f5f4de6fdd7e2d86cc02acce1d1ce57c` (reviewed 11C).
- **Date:** 2026-10-23.
- **Contracts:** [M11 specification](milestone-11-spec.md), [accepted ADR 0005](../decisions/0005-asset-ownership.md). Historical [11B](milestone-11b-report.md) and [11C](milestone-11c-report.md) evidence is preserved.

## Implementation and request lifecycle

`AppModule` now mounts the reviewed owner-scoped `AssetsModule`. In the same change, bootstrap replaces the blanket M10 401/503 hook with `registerAssetAccess()` and requires exact M11 readiness before opening a listener. There is no bypass switch, static media mount, administrator exception, new credential type or public listener configuration.

The Fastify `onRequest` gate executes before content parsing. It sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, resolves the established cookie/session identity, rejects absent/invalid/expired/revoked/disabled/ambiguous or unsupported credentials with 401, and rejects first-password-change accounts with 403. Unsafe recognized asset-namespace requests require exact `APP_ORIGIN` and the session CSRF token, including unmatched paths/methods. Authentication lookup failures return fixed 503 and log only an allowlisted category.

A private WeakMap in `RequestAuthenticator` reuses successful resolution for the same request and credential. It cannot be populated through request headers or the public `authActor` property. Credential parsing and unsupported Authorization/Proxy-Authorization rejection happen on every call. The existing Nest default-deny guard independently repeats method/Origin/CSRF/restriction policy, then attaches the typed actor; controllers still require that actor. New unit tests prove reuse is request-local, later requests resolve current state, and cached identity does not bypass guard policy. This remains request-time authorization: it is not a promise that an authorized stream can be recalled after revocation. Upload finalization still revalidates locked user/session state after file processing.

The matched Fastify router pattern determines whether actual asset handlers are protected. Unmatched namespace requests also undergo static-path decoding that preserves encoded separators, plus HTTP absolute-form authority removal without dot-segment normalization. The installed `find-my-way` path handling was inspected. Real HTTP tests establish which aliases actually route; no unsupported alias was added. The shared `createHttpAdapter()` retains multipart, 8192-byte non-multipart body limit and trailing-slash behavior. Its `frameworkErrors` handler returns fixed JSON for malformed URL decoding, which runs before hooks and otherwise reflects the raw path in Fastify's default response.

The exception filter retains M9 pre-header JSON/post-header connection termination and clears stale content type, length, disposition and range headers. It adds the asset security headers when handling asset errors. Successful original/thumbnail content type, length and inline disposition remain unchanged. `/api/v1/me` now reports route capability for unrestricted users and administrators; restricted accounts retain `assetsAvailable:false`. No other response fields changed.

## Route and transport results

| Case                                      | Verified behavior                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List / metadata / original / thumbnail    | Only the actor's own rows; unchanged public DTO, original bytes and JPEG thumbnails. Admins see only their own media.                                                                                       |
| Foreign / legacy NULL / absent valid UUID | Identical sanitized `Asset not found` 404, including HEAD/Range cases; no storage open, private disposition, range headers, owner or path. JSON responses have their own envelope length, not media length. |
| Invalid UUID                              | Anonymous 401; authenticated fixed 400.                                                                                                                                                                     |
| Upload                                    | Early credential/Origin/CSRF checks; existing multipart/image safeguards; actor-owned row and exact original bytes. Forged owner headers/query are ignored; owner form field is rejected.                   |
| HEAD                                      | Every applicable GET route uses the same authorization/scoping and returns no body. Owned media has the corresponding successful GET length; denied HEAD has only error-response headers.                   |
| Range                                     | Authorized requests retain full 200 responses; no partial-content behavior. Denied requests reveal no media bytes or range headers.                                                                         |
| Recognized aliases                        | Trailing slash, `%61ssets`, `%6friginal`, encoded UUID hyphen, query strings and accepted HTTP absolute-form targets take the same gate and scoped route.                                                   |
| Unsupported aliases                       | Encoded separator in the static asset segment, double-encoded static segment and duplicate slash remain 404. No route support was added.                                                                    |
| Unknown unsafe namespace                  | DELETE/OPTIONS/PATCH and unknown nested paths require Origin/CSRF before parsing; valid authorization reaches sanitized 404.                                                                                |
| Invalid URL escapes                       | Fixed 400 JSON with no raw URL/framework details and no storage access.                                                                                                                                     |
| Stream failure before bytes               | Fixed JSON 500, correct JSON content type/length, no stale media headers or private error text. Original and thumbnail cases covered.                                                                       |
| Stream failure after bytes                | Incomplete response terminates; no second JSON response or unhandled test-runner exception; subsequent health request succeeds. Already-transmitted media headers/bytes cannot be recalled.                 |

## Startup readiness

`AuthSessionService.assertReady()` uses the existing read-only `getMigrationStatus()` strict catalog/history validation and explicitly requires the applied M8, M10 and M11 versions. It does not migrate, baseline, repair or alter the ledger. The actual compiled bootstrap is exercised in four disposable databases: valid M10-only, correct M11, partial M11 (missing owner index), and tampered history. M10-only/partial/tampered targets exit nonzero without successfully serving health; correct M11 starts and shuts down on SIGTERM. Before/after snapshots compare ledger/lock rows, columns, constraints, indexes, and complete asset/user/session records. Each database has a deterministic legacy asset inserted before M11, a user and a validly linked session; M11-ready databases also have an owned asset. The tests assert nonzero fixture counts and known IDs, owners, timestamps and paths before startup, then compare the complete snapshots afterward. The source ordering places the readiness check before `app.listen()`; tests also probe the actual loopback listener.

The independent Astra review found a **MEDIUM test-evidence defect**: the original startup scenarios compared empty asset, user and session tables, so the prior report's claim about preservation of real synthetic rows was unsupported. The corrected fixtures keep the historical M10-only asset schema and insert the legacy NULL-owned row before M11's enforced `NOT VALID` check. They seed user/session rows with intact foreign keys, add an owner-linked asset only after M11, and introduce partial-schema or ledger drift only after the fixtures are in place. No production code or migration was changed. These snapshots test startup preservation of synthetic existing records; they are not a real-data upgrade or restore rehearsal.

## Changed files (17)

- `server-nest/src/app.module.ts`
- `server-nest/src/main.ts`
- `server-nest/src/http-adapter.ts` (new)
- `server-nest/src/auth/asset-lockdown.ts`
- `server-nest/src/auth/request-auth.ts`
- `server-nest/src/auth/request-auth.spec.ts`
- `server-nest/src/auth/auth-session.service.ts` (readiness only)
- `server-nest/src/auth/auth.controller.ts` (`/me` capability only)
- `server-nest/src/errors/safe-http-exception.filter.ts`
- `server-nest/test/asset-lockdown.e2e-spec.ts`
- `server-nest/test/auth-http.integration-spec.ts`
- `server-nest/test/users-http.integration-spec.ts`
- `server-nest/test/migrations.integration-spec.ts` (date-independent fixture only)
- `server-nest/test/asset-ownership-http.integration-spec.ts` (new)
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/development/milestone-11d-report.md` (new)

## Verification actually performed

Commands run from `server-nest/` on Node.js 24.22.0, with authorized writable execution in the M11 worktree. Docker server 29.7.2 was available. No dependencies were installed.

| Command / check              | Final actual result                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`              | PASS, compiled as part of the final integration and runtime-smoke commands.                                                                                                                     |
| `npm run typecheck`          | PASS after all source/test changes.                                                                                                                                                             |
| `npm run lint`               | PASS, no warnings.                                                                                                                                                                              |
| `npm run test`               | PASS: 13 files, 98 tests, including all original credential-policy assertions and four new cache/guard cases.                                                                                   |
| `npm run test:e2e`           | PASS: 7 files, 52 tests.                                                                                                                                                                        |
| `npm run test:integration`   | PASS: 7 files, 173 tests; includes 36 new real-socket HTTP/readiness tests and the full 11C concurrency/compensation suite.                                                                     |
| `npm run test:migrations`    | PASS: 1 file, 65 tests. The final full integration run also reran all 65 after the later HTTP/cache test additions.                                                                             |
| `npm run test:runtime-smoke` | PASS: invalid configuration and unavailable authentication database produced safe nonzero exits. Real listener/SIGTERM and M11 readiness tests also passed in the disposable integration suite. |
| Focused Prettier             | PASS over all 17 changed/new files.                                                                                                                                                             |
| Markdown links               | PASS for relative links in all three changed/new Markdown files.                                                                                                                                |
| Git whitespace               | PASS: `git diff --check` and `git diff --no-index --check /dev/null <file>` for all three new files (exit 1 for a difference is expected).                                                      |
| Protected-source comparison  | PASS: assets/storage/database/users source, 11C ownership integration tests, accepted ADRs and disposable runner match HEAD.                                                                    |
| Final file/index inspection  | Exactly 14 modified tracked files and 3 new files; empty index. No environment files, real credentials, media, dumps, generated artifacts or unrelated files found in this change set.          |

### Independent review correction verification

The affected startup cases cannot be selected individually through the unchanged disposable runner; it supports the full integration suite and the migration-only suite. The first post-correction `npm run test:integration` therefore executed all four corrected compiled-bootstrap cases with the other integration tests: **7 files, 173 tests passed**. It removed container `saefr-m7-test-12c2cba0a9f3`. The cases assert one legacy asset, one user and one session in every startup database, plus an owner-linked asset in each M11 database. They compare all selected columns in those rows, as well as ledger and schema snapshots, after valid startup or a strict non-listening failure. A deletion, owner/path/timestamp change or other stored-field change to a seeded row would break the complete snapshot comparison.

After that run, `npm run typecheck`, `npm run lint`, `npm run test` (**13 files, 98 tests**), `npm run test:e2e` (**7 files, 52 tests**), `npm run test:migrations` (**1 file, 65 tests**) and `npm run test:runtime-smoke` all passed. Build passed as part of the integration, migration and smoke commands. The migration-only runner removed container `saefr-m7-test-e8b55707d5fe`. Focused Prettier and relative Markdown-link checks passed for the corrected files. Git tracked/staged/untracked whitespace checks passed. All 15 other pending M11D files matched their pre-correction SHA-256 hashes, protected assets/storage/database/users source and the disposable runner matched HEAD, the index remained empty, and a filtered `docker ps -a` found no disposable containers. No test failure or fixture correction occurred in this review-correction run.

All four containers created during the original 11D implementation were reported removed: initial failed integration `saefr-m7-test-02cd85cc826a`, successful rerun `saefr-m7-test-4054b744e6a2`, migration-only `saefr-m7-test-033db843bd82`, and final integration `saefr-m7-test-72f5f1ada680`. The two later review-correction containers and their removal are recorded above. A separate `docker ps -a --filter name=saefr-m7-test-` returned no remaining containers after each verification period. The original final full integration run completed in 58.43 seconds. The unchanged migration-only suite passed before the final HTTP/cache additions; those additions did not alter migration source or tests.

The new integration file has 36 tests using the actual production AppModule, shared adapter, early gate, default-deny guard, real session resolution/PostgreSQL and temporary storage on localhost sockets. It includes A/B/admin own assets, a pre-M11 legacy NULL row, restricted/disabled/revoked/expired sessions, both unsupported credential headers, invalid/duplicate cookies, malformed/missing/null Origin and missing/malformed/incorrect CSRF. Header-only unfinished multipart requests receive denial before the test's `preParsing` observer, asset queries or storage. Storage spies prove scope-before-open. Fault-injection cases replace a storage stream or session lookup; normal ownership and byte-preservation tests use real implementations. Existing M10 login/logout/revocation/account tests and 11C lock/compensation tests remain in the full suite.

Earlier attempts and corrections:

- Initial typecheck caught missing adapter callback types, a misplaced test assertion argument, and later an attempted assignment to Fastify's readonly `method` in a unit fixture. All were corrected; the fixture now takes its method at construction. Lint also flagged the misplaced assertion as unused.
- The first full integration run passed 172 tests and failed one existing migration scenario. Its fixed `2026-10-23T00:00:00.000Z` forged ledger timestamp had become earlier than the newly created M10 history, so strict history validation correctly refused it before the intended M11 catalog check. The fixture now derives a later timestamp from the actual preceding entry. Both original schema-rejection assertions and historical-row assertions remain intact. The next full run passed all 173 tests.
- During final diff review, two original credential-policy unit tests were found missing from an intermediate test-file edit. Both original tests were restored verbatim before final verification; the final diff adds four cache/guard cases without removing their assertions. An intermediate 96-unit run is superseded by the final full unit count.
- Source review also identified the router's accepted HTTP absolute-form request targets. Namespace recognition and real-socket tests now cover them without adding route aliases or normalizing dot segments.

## Preservation and isolation

Historical migration versions/inspectors, migration runner/provider, M11C repository/service/controller code, filesystem implementation, account mutation logic and the disposable runner remain unchanged. Only the existing migration test's forged timestamp changed. The asset user-then-session locking, database wall-clock expiry check, known-noncommit cleanup, unknown-COMMIT retention and no automatic retry are preserved and regression-tested.

The test runner and independent `testConfig()` inspector were read before database execution. They verify exact random container identity/name, owner label, PostgreSQL 18 image, generated isolated credentials, auto-removal, tmpfs-only storage/no bind or volume mounts, and a random localhost-only published port before SQL. The new HTTP suite creates additional random databases inside that verified container. It supplies explicit disposable connection settings before importing AppModule; no worktree `.env` files were present. Synthetic media lives under a fresh `mkdtemp` directory and is removed by that suite. Startup subprocesses get explicit disposable settings and localhost binding. No command connected to development PostgreSQL, inspected real media, modified persistent Docker volumes, or ran operator commands against real accounts.

## Remaining risks and review gate

- Independent security review found no confirmed runtime bypass and required the startup-test evidence correction described above. Final independent re-review returned PASS; the maintainer authorized the feature-branch checkpoint. At report finalization, no M11D commit, push, merge, PR, deployment or public listener had been created.
- M11F remains separately authorized: milestone-wide review/regression, final documentation synchronization (including repository/README guidance), consolidated evidence and integration-readiness handoff. Optional 11E mapping remains deferred; NULL-owned records are quarantined.
- Request-time read authorization cannot recall an already-authorized stream after revocation. The private request cache has that same snapshot lifetime; upload has the separately preserved final database checks.
- PostgreSQL/filesystem atomicity, exactly-once client retries, fsync durability and crash recovery are not guaranteed. Uncertain COMMIT retains files; orphans and cleanup failures require separately designed recovery. No broad media cleanup was added.
- Listing remains unpaginated. Comprehensive filesystem write/cleanup failure injection, upload resource controls beyond existing bounds, privileged directory races and NAS behavior remain follow-ups.
- No CI, production TLS/reverse-proxy/cookie deployment verification, real-data upgrade or backup/restore rehearsal was performed. Actual upgrades require explicit approval, backups, recovery planning and isolated rehearsal; old M10 binaries reject M11 schema. Local passing tests do not establish deployment readiness.

To repeat: use Node 24 in `server-nest/`, run the commands listed in the verification table, and use only `npm run test:integration` / `npm run test:migrations` for PostgreSQL. Never invoke integration Vitest against an arbitrary connection or reuse normal development credentials. Keep localhost and synthetic temporary storage; check disposable-container removal afterward.
