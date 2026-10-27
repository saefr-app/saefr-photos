# M12E.2 — Permanent-deletion HTTP integration

- **Status:** Feature-branch implementation and local/hosted verification complete; ready for independent HTTP security review. M12F, real-data migration and deployment remain separate gates.
- **Base:** M12E.1 focused correction `0515ab7d7467e1c32df99032cd410369ef7345dd`.
- **Date:** 2026-10-28.

## Implementation

`DELETE /api/v1/assets/:assetId` accepts only a current owner's trashed asset with an empty body and strong current lifecycle `If-Match`. Authentication, restricted-session denial, exact Origin and CSRF run in the existing early request gate. Foreign, missing and quarantined assets remain owner-scoped 404s. A storage preflight requires the certified provider's exact-removal, absence and durability capabilities and both physically verified role bindings. A repeated DELETE resolves its existing owner receipt before preflight and never starts another removal attempt.

The new acceptance repository uses one READ COMMITTED transaction with user and session row locks, the existing asset-ID advisory lock, the owned asset row lock and a shared lock on the actual database `storage_binding` singleton. It rechecks account restrictions and database-time session expiry after waits. The journal copies immutable storage identities from the locked singleton and the approved extension from the locked asset. Journal insertion and asset-row deletion commit atomically; no filesystem operation occurs in this transaction. The transaction callback marks known rollbacks separately from an uncertain COMMIT. An uncertain outcome cannot authorize I/O until an independent owner-scoped read positively confirms the same asset, owner, version, extension, layout and binding tuple. An absent or unavailable confirmation returns sanitized 503 without compensation.

After acknowledged or independently confirmed new acceptance, the existing reviewed executor runs at most once with the asset and owner UUIDs. Only a positively read completed journal yields 200; a pending receipt yields 202. `GET /api/v1/assets/deletions/:assetId` only reads the owner receipt. `POST /api/v1/assets/deletions/:assetId/retry` revalidates the current account and session under locks and makes at most one attempt against an existing journal. A completed retry performs no provider I/O. Success responses expose only the five approved receipt fields and preserve PostgreSQL microsecond timestamps. DELETE responses include the status `Location`; private cache and nosniff headers remain in the existing asset gate. The exception filter allows only fixed public messages and logs the route pattern and DELETE method without asset IDs.

Trash is reversible metadata. Accepted deletion is an irreversible PostgreSQL decision. Pending filesystem work requires an explicit retry during M12; it does not promise scheduling. Completed deletion means both canonical role targets were authoritatively removed or absent and their directory persistence was confirmed under the supported profile. It does not erase backups, caches, already-open streams or unrelated staging links.

## Files

- `server-nest/src/assets/asset-deletion-acceptance.repository.ts`, `asset-deletion.service.ts`: transaction, receipt and HTTP orchestration.
- `server-nest/src/assets/assets.controller.ts`, `assets.module.ts`, `dto/asset-response.dto.ts`: routes, dependency injection and OpenAPI receipt.
- `server-nest/src/errors/safe-http-exception.filter.ts`: fixed Trash conflict message and safe DELETE route logging.
- `server-nest/test/asset-deletion-http.integration-spec.ts`, `storage-native-http.integration-spec.ts`: disposable PostgreSQL/real-socket and guarded hosted ext4 HTTP cases.
- `docs/architecture.md`, `docs/roadmap.md`, `server-nest/README.md`, this report: current feature-branch and operational boundaries.

No migration, historical schema validator, executor, authentication implementation or development storage was changed.

## Verification

Run from `server-nest/` under Node.js 24. `npm run test:integration` and `npm run test:migrations` use only the identity-checked, randomly named, localhost-bound, tmpfs `postgres:18` runner; synthetic local HTTP tests use a separately named database inside that disposable container. The native workflow alone creates guarded temporary ext4 images on a GitHub-hosted disposable VM. Migration-only cases overlap the complete integration suite.

| Command or check                       | Result                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                        | PASS after implementation and again as part of integration, migration and runtime smoke commands.                                                                                   |
| `npm run typecheck`                    | PASS after the final source and test changes.                                                                                                                                       |
| `npm run lint`                         | PASS, no warnings after removing a test-only unused import and adding an explicit sort comparator.                                                                                  |
| `npm run test`                         | PASS: 153 unit tests in 21 files.                                                                                                                                                   |
| `npm run test:e2e`                     | PASS: 59 HTTP E2E tests in 8 files.                                                                                                                                                 |
| `npm run test:integration`             | PASS: 253 cases in 15 files; six guarded native cases skipped on this non-ext4 local host.                                                                                          |
| `npm run test:migrations`              | PASS on sequential rerun: 82 cases in one file, included in the 253 integration cases.                                                                                              |
| `npm run test:runtime-smoke`           | PASS: invalid configuration and unavailable authentication database exited safely with nonzero status.                                                                              |
| `npm run test:native`                  | PASS: six native-observer unit cases.                                                                                                                                               |
| Hosted ext4 HTTP conformance           | PASS: [run 40565724622](https://github.com/saefr-app/saefr-photos/actions/runs/40565724622) on `bc9fa3bd6f28bd3203f7b7b79483a21026933b02`; six native HTTP/PostgreSQL cases passed. |
| Focused Prettier, links and whitespace | Focused Prettier and 26 relative Markdown links passed; tracked whitespace passed, with staged whitespace checked at checkpoint.                                                    |

The initial complete integration run passed 247 cases and removed its owned container. A later run passed 250 cases after adding rollback, storage-anchor and lost-acknowledgement injection. A subsequent run timed out in two new race tests because their lock holder and wait observer mistakenly shared a single-connection test pool; the tests were corrected to use an independent pool, and the fresh 253-case run passed. An initial migration-only run overlapped another build that replaced `dist` while its CLI tests were executing; two CLI tests failed with a missing compiled module. The sequential rerun passed all 82 cases. Every disposable runner container was removed; a final `docker ps -a` filter for its container prefix returned no entries. These failures were test orchestration and fixture issues, not application or migration changes. The lost-acknowledgement fixture commits through real Kysely/PostgreSQL, then throws a synthetic client acknowledgement error; it proves the application's confirmation gate but does not simulate a physical network break. The rollback fixture uses a temporary database trigger and verifies the asset remains and no provider removal begins. Both fixtures are confined to the disposable database.

The hosted disposable-ext4 workflow ran the new HTTP acceptance, owner denial, changed/missing binding, partial-removal retry and repeated-DELETE checks on the approved non-root native fixture. Its six guarded cases passed against a disposable PostgreSQL container. The log confirms that the owned container and ext4 mounts/image files were removed. This is native ext4 conformance for that hosted profile, not a hardware power-loss test or certification for other filesystems.

## Security self-audit and limits

- New acceptance copies no path or binding from an HTTP request. The journal is durable before the executor sees it. The storage provider verifies both adopted physical identities again at execution. The original and thumbnail are removed only through the M12E.1 exact-target provider.
- Owner scope precedes lifecycle precondition errors. A last-moment concurrent acceptance is rediscovered through the owner journal; a Restore that wins the asset lock changes the version and prevents stale acceptance. A committed acceptance makes later Restore return 404. Session expiry is checked with PostgreSQL wall time after the asset and binding lock waits.
- Database and storage errors produce fixed public 503s; execution tokens, expiry, binding identifiers, paths, filenames, SQL and raw exceptions are absent from the receipt. The safe filter logs only an allowlisted route pattern and code category.
- The supported profile is the specifically verified Linux/ext4 deployment arrangement. Windows, macOS, NAS and hardware power-loss behavior remain uncertified. An already-issued filesystem call or stream may finish after cancellation/revocation. M13 owns scheduled retries, expiry and maintenance. Backup/restore rehearsal, real-data migration, storage adoption and deployment remain unapproved.

The draft [milestone PR #9](https://github.com/saefr-app/saefr-photos/pull/9) remains the review vehicle. A passing implementation checkpoint does not approve PR merge, real media deletion or production deployment.
