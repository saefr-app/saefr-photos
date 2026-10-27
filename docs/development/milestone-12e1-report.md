# M12E.1 — Internal permanent-deletion executor

- **Status:** Implemented on `feat/m12-asset-lifecycle`; independent destructive-core review and M12E.2 HTTP activation remain separate gates.
- **Base:** M12D checkpoint `29858cddb974fe2243b3336e4acbcb7784ba0195`.
- **Date:** 2026-10-27.

## Implementation

`AssetDeletionExecutor` accepts a journal asset UUID and owner UUID, never a path or storage tuple from a caller. The committed `asset_deletion` row is read under owner scope, with PostgreSQL's full microsecond `requested_at` text retained for immutable-target comparison. A completed receipt returns without I/O. A live asset, unsupported layout/extension, absent journal, mismatched database anchor or unverified physical binding cannot authorize removal. The existing `StorageBindingVerifier` checks configuration, both role markers and observed ext4 identity; the executor compares its returned anchor with the journal tuple. The provider derives the two layout-1 names from the UUID and approved extension and pins each verified role directory. No upload-compensation method is used.

The existing PostgreSQL claim implementation issues a random token for 60 seconds using database time. It atomically rejects an active competing claim and live asset row; an uncertain claim acknowledgement needs a positive independent read. Renewal, completion and failure recording use short row-locked transactions that recheck token and expiry after lock acquisition. The executor holds at most two local slots, refuses an unbounded waiting queue, and stops starting further work after its 30-second budget, cancellation, claim loss or database unavailability. Every issued provider promise drains before a slot is released. No SQL transaction or checked-out database connection spans filesystem I/O.

For each immutable target, the executor rechecks the claim, the full-microsecond journal tuple and both bindings, calls exact removal, and verifies role-directory persistence. It passes the journal's binding tuple into the provider, which rechecks that expected tuple when pinning and rechecking each directory; a rebind between executor preflight and the storage call fails closed. It advances from original to thumbnail only after the original operation has returned a durable outcome and the current token can renew. It records completion only after both outcomes and both persistence checks pass under a current token. A lost completion acknowledgement is resolved by an independent matching completed-receipt read. Safe journal error categories are best-effort; partial and uncertain results remain pending for explicit future retry. Claim expiry permits overlapping already-started syscalls, so the protocol is repeat-safe rather than exactly once.

`AssetsModule` registers the internal executor and repository for future approved integration. **No public DELETE, retry route, deletion CLI, scheduler, BullMQ worker or automatic expiry is added.** The M12D pending-deletion listing remains read-only. `LocalStorageProvider` advertises the exact-removal and durability mechanics only alongside the mandatory live `linux-ext4-v1` binding verification. Unsupported or unverified storage still fails closed.

## Files changed

- `server-nest/src/assets/asset-deletion.executor.ts` (new), `asset-deletion.repository.ts`, `assets.module.ts`: execution orchestration, exact-timestamp journal reads and internal dependency injection.
- `server-nest/src/storage/local-storage.provider.ts`, `storage-binding.service.ts`, `storage-provider.ts`: verified-profile capabilities and expected-binding checks inside exact removal and directory persistence; other provider mechanics remain unchanged.
- `server-nest/test/asset-deletion-executor.integration-spec.ts` (new): isolated PostgreSQL and synthetic temporary-directory fault and concurrency tests.
- `server-nest/test/storage-native-http.integration-spec.ts`, `native-deletion-child.mjs` (new), `.github/workflows/m12c-native-ext4.yml`: guarded hosted ext4 journal execution, repeat absence, process-kill recovery and workflow trigger.
- `docs/architecture.md`, `docs/roadmap.md`, `server-nest/README.md`, this report: current feature-branch status and operational limits.

No migration, schema type, authentication code or public asset route changed.

## Verification

All commands below run from `server-nest/` with Node.js 24. PostgreSQL tests use only `test/run-integration.mjs`: a randomly named, labeled `postgres:18` container with tmpfs data, generated isolated credentials and a random localhost port. It verifies identity before SQL and removes its own container after the run. Synthetic file tests use private `/tmp` directories. Native ext4 runs only on the guarded GitHub-hosted disposable VM workflow.

| Check                                            | Result                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run build`                                  | PASS, including native helper build                                                             |
| `npm run typecheck`                              | PASS                                                                                            |
| `npm run lint`                                   | PASS                                                                                            |
| `npm run test`                                   | PASS: 146 unit cases, 20 files                                                                  |
| `npm run test:e2e`                               | PASS: 59 HTTP cases, 8 files                                                                    |
| `npm run test:integration`                       | PASS: 241 cases across 14 files, with 5 native-only cases skipped; disposable container removed |
| `npm run test:migrations`                        | PASS: 82 cases in one file; included within the integration total                               |
| `npm run test:runtime-smoke`                     | PASS: invalid configuration and unavailable authentication database exit safely                 |
| `npm run test:native`                            | PASS: six synthetic observer protocol cases; not ext4 certification                             |
| Hosted native ext4 deletion conformance          | PENDING push-triggered run; no hosted result claimed yet                                        |
| Focused Prettier, Markdown links, Git whitespace | PASS: changed files formatted, 23 relative links resolved, tracked/new-file whitespace clean   |

An initial integration run failed one new fixture that inserted `asset` columns positionally; the MIME type landed in an integer column. The fixture now names its columns. Subsequent full runs passed 235, 237 and 240 cases as coverage grew. The final post-binding-check run passed all 241 cases. Every owned disposable container was removed.

The new synthetic tests exercise exact targets and extension, neighbor preservation, authoritative absence, partial original/thumbnail state, unlink and directory-sync faults, unexpected symlink, missing root, anchor mismatch including a rebind at provider pin, unsupported capabilities, live asset, bounded slots under cancellation, claim overlap/takeover, a changed microsecond journal field during I/O, database loss after original I/O, completion failure and lost completion acknowledgement. Existing M12B tests cover separate PostgreSQL pools, row-lock expiry, stale renewal/completion/failure and historical schema validation. The hosted test adds actual ext4 removal and process-kill points before first unlink, after original removal and after both removals, followed by explicit expiry simulation and repeat-safe recovery. A process kill does **not** prove hardware power-loss durability.

## Safety and remaining gates

No command in this phase targets the existing development database, development media, persistent Docker volumes or `/boot`. No operator provisioning/adoption/relocation command was run. The executor is not reachable from HTTP. A journal accepted in a previous transaction is irreversible; M12E.1 provides execution only, not acceptance. A missing or changed binding, failed unlink/sync, unavailable database or uncertain operation never becomes a false completed receipt. The provider does not recursively remove files or sweep staging links. An accepted deletion can remain pending until an explicit retry or future M13 worker; M13 must call this executor using journal authority.

Remaining limits: no public acceptance/status/retry integration (M12E.2), no automatic recovery/Trash expiry (M13), no arbitrary NAS or non-ext4 certification, no VM crash or actual power-loss evidence, and no full real-data migration/backup/restore/deployment approval. Storage path parents must remain operator controlled; privileged adversarial path replacement is outside the adopted profile. An already-started unlink can finish after claim loss or cancellation, and an already-open media stream can finish after acceptance. Upload staging links or unrelated orphan files are not swept. Local synthetic tests do not substitute for hosted ext4 evidence. Independent Astra High review is required before enabling destructive HTTP behavior.

## Repeat checks

From `server-nest/`, run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations`, `npm run test:runtime-smoke` and `npm run test:native`. The native ext4 workflow is `.github/workflows/m12c-native-ext4.yml` on GitHub-hosted Ubuntu; do not run its formatting/mount script on the development machine. Review the source/fixture diff and its hosted run before M12E.2.
