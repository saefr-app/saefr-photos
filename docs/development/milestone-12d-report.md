# Milestone 12D — Pagination and reversible asset lifecycle

- **Status:** Implemented on `feat/m12-asset-lifecycle`. M12E.1 and M12E.2 subsequently passed their focused security gates; milestone-wide M12F verification and independent review remain before a merge decision.
- **Base:** M12C checkpoint `ef67178526d34d239ab63ebada23c5a1977d89ca`.
- **Date:** 2026-10-27.

## Scope and implementation

M12D adds bounded keyset responses for the active gallery, Trash and pending-deletion receipts. Each uses `items` and `next_cursor`, a default limit of 50, a maximum of 100, an owner predicate in SQL, `limit + 1` fetching and the approved descending timestamp/UUID keys. The cursor carries an exact owner, collection, UUID and six-digit PostgreSQL timestamp; invalid, duplicated and unsupported query parameters return sanitized 400. The active gallery's former plain-array response is intentionally changed.

Owned asset metadata and upload responses now provide strong lifecycle ETags without changing their JSON bodies. Owner-only Trash and Restore use the supplied `If-Match` version, reject missing/malformed/stale preconditions as 428/400/412 after owner authorization, and return the resulting version. Each effective transition increments once; a current-version same-state request is idempotent. A short transaction locks the current user, session, asset ID and owned asset row in order, then rechecks session expiry using PostgreSQL wall time after lock waits. No filesystem operation occurs under those locks.

Owner-scoped SQL excludes trashed rows from ordinary list, metadata, original and thumbnail reads. The new Trash thumbnail route reads only a currently trashed owned row and uses M12C's schema-aware, binding-verified storage path in production. The pending-deletion list is read-only; no DELETE, retry, executor or automatic expiry route is enabled. Historical M11 reads use the bounded page path with a synthetic version `0` and do not query M12 columns. M12-only routes refuse an M11 schema. M12 startup readiness and storage-unavailable behavior from M12C remain unchanged.

## Changed files

- `server-nest/src/assets/asset-lifecycle-contract.ts` and `.spec.ts`: cursor, limit and ETag contracts with focused unit cases.
- `server-nest/src/assets/assets.repository.ts`, `assets.service.ts`, `assets.controller.ts`, and `dto/asset-response.dto.ts`: parameterized queries, transitions, media filtering, HTTP routes and OpenAPI page/transition schemas.
- `server-nest/src/errors/safe-http-exception.filter.ts`: fixed safe messages for lifecycle precondition errors and unavailable media.
- `server-nest/test/asset-lifecycle.integration-spec.ts`: disposable PostgreSQL and real-socket coverage, including independent-connection lock races and synthetic file-byte preservation.
- `server-nest/test/assets.e2e-spec.ts`, `asset-lockdown.e2e-spec.ts`, `errors.e2e-spec.ts`, `swagger.e2e-spec.ts`, `assets.integration-spec.ts`, `asset-ownership-http.integration-spec.ts`, `auth-http.integration-spec.ts`, and `migrations.integration-spec.ts`: update affected gallery contracts, verify OpenAPI schemas and extend the existing historical NULL-owner fixture to the M12 reads.
- `docs/architecture.md`, `docs/roadmap.md`, `docs/team-workflow.md`, and this report: describe feature-branch state and the adopted one-branch/one-draft-PR milestone workflow.

No schema migration, historical inspector, dependency or production storage implementation changed in M12D.

## Verification

Commands ran from `server-nest/` with Node.js 24 and existing dependencies. PostgreSQL commands used the established randomly named, labeled `postgres:18` test runner with tmpfs data, isolated credentials and a localhost port. The runner removed each owned container after the suite. Counts below are actual executions; migration cases overlap the integration total.

| Command                                             | Result                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                                     | PASS                                                                              |
| `npm run typecheck`                                 | PASS                                                                              |
| `npm run lint`                                      | PASS                                                                              |
| `npm run test`                                      | PASS: 146 unit cases across 20 files                                              |
| `npm run test:e2e`                                  | PASS: 59 HTTP cases across 8 files                                                |
| `npm run test:integration`                          | PASS: 222 cases across 13 files; 4 native-only cases skipped                      |
| `npm run test:migrations`                           | PASS: 82 cases in one file; separate disposable container removed                 |
| `npm run test:runtime-smoke`                        | PASS: invalid configuration and unavailable authentication database exited safely |
| `npm run test:native`                               | PASS: 6 observer protocol cases; no local ext4 certification claimed              |
| Focused Prettier, Markdown links and Git whitespace | PASS after formatting two changed Markdown files; staged check before checkpoint  |

The first implementation typecheck exposed old test calls to the former list method; a bounded historical component-test helper resolved that mismatch without a production unbounded query. The first HTTP E2E and PostgreSQL runs exposed old array expectations and new test-fixture setup issues; these were corrected. One unit assertion mistakenly uppercased a numeric-only UUID and was corrected. A later integration run had one test-fixture failure: a newly inserted NULL-owner row violated M11's enforced `NOT VALID` check. That invalid insert was removed; existing historical-upgrade migration tests preserve legacy NULL-owned rows, while the new test still verifies restricted sessions. The final counts above were rerun after those corrections and the OpenAPI and physical-byte test additions.

The new PostgreSQL cases cover equal timestamps and UUID tie-breakers, microsecond cursor positions, owner isolation, pending receipt filtering, concurrent transitions, same-state and stale versions, session expiry while waiting for an asset-ID lock, and account disabling while a transition waits for the user lock. The historical-upgrade fixture verifies that M12 active/Trash pages and Trash thumbnail lookup cannot read preserved NULL-owned rows. Real localhost-socket requests cover route precedence, Origin/CSRF, restricted sessions, preconditions, ordinary media hiding, Trash preview, unavailable storage and sanitized errors. The media provider is mocked for this local M12D socket fixture; M12C's separate hosted ext4 certification supplies actual bound-provider evidence, not a claim that this local host ran native ext4.

The existing path-limited hosted ext4 workflow will be checked at the pushed M12D commit. Its outcome is not part of the local counts above and must be reported separately.

## Safety and remaining gates

Tests created only disposable database records and temporary synthetic image bytes. The real development PostgreSQL database, persistent Docker volume, original photographs and thumbnails were not accessed or changed. Trash/Restore change only metadata and are reversible; file bytes and storage path remain unchanged. Already-open streams can complete after a lifecycle change or session revocation. Pagination is a live view, not a snapshot or mobile synchronization feed.

M12E must independently implement and review durable permanent deletion; M12F must perform milestone-wide verification and review. Real-data migration, storage adoption, backup/restore rehearsal, deployment, additional storage profiles and crash/power-loss recovery remain separate gates. The draft [milestone PR #9](https://github.com/saefr-app/saefr-photos/pull/9) does not authorize merge or deployment. [Superseded PR #8](https://github.com/saefr-app/saefr-photos/pull/8) was closed without merging and preserves its review history.

## Repeat verification

From `server-nest/`, use Node.js 24 and the existing dependencies. Run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations`, `npm run test:runtime-smoke` and `npm run test:native`. The PostgreSQL scripts require Docker and use their own verified disposable target; never substitute the development database.
