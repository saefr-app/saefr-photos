# ADR 0006 — Asset Lifecycle and Durable Permanent Deletion

**Status:** ACCEPTED

**Reference baseline:** `origin/integration` at `697980974009c1ea882b101805970396694b544f`.

**Related accepted decisions:** [ADR 0002](0002-background-processing-and-ml.md), [ADR 0004](0004-authentication-foundation.md) and [ADR 0005](0005-asset-ownership.md).

**Detailed contract:** [Approved M12 specification](../development/milestone-12-spec.md).

The maintainer approved the M12/M13 direction and **Option B: portable architecture in M12, staged storage certification before advertising additional environments as supported**. This accepted decision does not authorize M12B implementation, storage adoption, real-data migration, deployment or changes to production or the `main` branch.

## Context

M11 provides authenticated, owner-scoped asset access. Administrators have no media-access bypass, and historical NULL-owned assets remain quarantined.

The current implementation:

- Lists owned assets without pagination.
- Has no Trash, Restore or permanent-deletion API.
- Stores metadata in PostgreSQL and originals/thumbnails in the filesystem.
- Preserves files when an upload's database commit outcome is uncertain.
- Uses exact, migration-history-aware schema validation.
- Uses hard-link publication and platform-dependent filesystem operations without a certified cross-platform provider contract.

PostgreSQL and media storage cannot participate in a single atomic transaction. Permanent deletion therefore needs durable authority and recovery information before physical removal.

Linux, Windows and macOS are first-class architectural targets. Actual support depends on the provider, filesystem, mount configuration and verification evidence, not the operating-system name alone.

## Established constraints

This decision preserves:

1. Owner-scoped SQL authorization and no administrator bypass.
2. Exact-Origin/CSRF enforcement and restricted-session denial.
3. Historical NULL-owner quarantine.
4. Immutable historical migrations and schema inspectors.
5. Explicit migrations; API startup never migrates.
6. Conservative retention after uncertain upload commits.
7. Separate authorization for real-data migration, storage adoption and deployment.
8. Redis/BullMQ as the accepted background-processing direction.
9. Independent review and approval before Git checkpoints, integration merges and alpha release.

The breaking replacement of the existing asset-list array with a paginated response is approved. The specification's exact contracts, including a default page size of 50 and maximum of 100, are approved.

## Decision

### Lifecycle and irreversible boundary

```text
ACTIVE ──Trash──> TRASHED ──Accept permanent deletion──> DELETION_PENDING
   ↑                │                                         │
   └────Restore─────┘                                         ▼
                                                            DELETED
```

Trash and Restore modify PostgreSQL state without moving media.

Permanent-deletion acceptance is one transaction that:

1. Revalidates the account and session under locks.
2. Coordinates the asset identifier and locks the owned asset.
3. Checks Trash state and lifecycle version.
4. Inserts an immutable deletion journal.
5. Removes the asset row.
6. Commits.

**That commit is the irreversible boundary.** Restore is unavailable afterward, even if physical deletion has not started.

No filesystem removal occurs before an acknowledged acceptance commit or positive independent confirmation of its committed journal. An absent lookup after an uncertain COMMIT is not proof of rollback: the original transaction may still be unresolved. Do not recreate the asset or remove its journal as compensation.

### Separate deletion journal

Use `asset_deletion`, separate from `asset`.

The journal retains:

- Asset and owner identifiers.
- Accepted lifecycle version.
- Storage-set and individual media-location identities.
- Immutable storage layout/version and original extension.
- Acceptance and completion timestamps.
- A bounded diagnostic category.
- Temporary execution-claim fields.

It has no foreign key to the removed asset. Removing the asset row makes accepted deletion structurally inaccessible through ordinary asset queries. The journal retains the authority and targets needed for retry.

Retain pending and completed journals throughout M12. Do not reuse an asset identifier for a new committed asset. Upload finalization and deletion acceptance must coordinate same-ID database decisions as specified in M12; a prepublication lookup alone is not an atomic reservation.

The journal is business recovery state, not a PostgreSQL job queue. M12 introduces no polling consumer, scheduler or automatic retry loop.

### Short execution claims

Filesystem work must occur outside database transactions and without a checked-out database connection.

A short transaction assigns a random execution token and expiry to a pending journal. Subsequent renewal and result updates must match that token.

A claim:

- Coordinates attempts and limits unnecessary overlap.
- Can expire and be reclaimed by a later explicit request.
- Does not cancel an already issued filesystem operation.
- Does not guarantee exactly-once execution.

Correctness comes from immutable targets, repeat-safe removal, prevention of successful asset-ID reuse and guarded journal updates.

An expired executor may finish an already submitted unlink. It must not start further destructive steps after discovering claim loss, or overwrite results belonging to a newer attempt. An uncertain claim COMMIT also requires positive confirmation of the current token before I/O.

Bound active I/O, including operations continuing after an HTTP timeout. Do not free capacity merely because a response was cancelled. No background heartbeat or detached replacement attempt is introduced in M12. A later explicit request performs recovery; automatic scheduling belongs to M13.

### Storage-provider contract

Lifecycle services depend on semantic storage operations, not Linux-specific syscalls:

- Verify an adopted storage binding.
- Stage and publish a complete file without overwriting.
- Open an authorized regular file.
- Remove an exact immutable target.
- Distinguish confirmed absence from unavailable or uncertain storage.
- Satisfy the provider's certified deletion-durability contract.

The provider handles platform-specific paths, permissions, symlinks/reparse points, publication and persistence operations. Authorization remains in application/database services.

No generic plugin system, object-storage implementation or arbitrary-path API is introduced. The existing M11 upload/read behavior must pass through this boundary without weakening byte preservation, publication safety or uncertain-commit handling.

### Distinct media-location identities

Originals and thumbnails may be independently mounted. Each must have its own adopted binding identity and role marker. Each bounded, versioned marker records provider-specific physical identity established by explicit provisioning or adoption. Runtime validation compares that evidence with fresh observations of the actual opened role directory and its filesystem, independently for each role. Matching logical IDs, pathname strings or copied markers alone are insufficient; configuration only locates a candidate and cannot authorize reassignment. Missing, mismatched, unsupported or uncertain physical evidence fails closed.

PostgreSQL remains the logical provenance authority. No additional mandatory external runtime installation receipt is required: protected operator pairing/recovery manifests document adoption and cutover, not a second runtime authority. The specification defines marker version 2, independently of database storage layout 1, and the initial Linux/ext4 identity-observation feasibility gate. Native observation must work under the intended unprivileged deployment identity; any new helper/dependency needs separate approval, with no pathname-only, inode-only or device-number-only fallback. This amendment does not certify a profile or authorize M12C implementation.

Existing assets have no per-asset storage identity. Use one database-resident `storage_binding` singleton as their provenance anchor: storage-set ID, distinct originals/thumbnail binding IDs and layout version. M12 supports exactly one adopted storage set for the entire asset population, including quarantined rows. This small installation record is necessary because configuration and markers alone cannot prove which storage belongs to the database; it is not a multi-storage management system.

The migration creates the empty table, never infers or seeds an identity from environment variables or media paths. A separately authorized adoption procedure verifies the database/media pairing before committing the singleton. All subsequent uploads and media operations use that binding. Missing, uncertain or mismatched provenance blocks upload publication, media access and new deletion acceptance. Metadata-only operations may remain available under the existing authorization rules.

Before acceptance, verify both independently mounted roles against the database anchor and configuration. Inside the acceptance transaction, recheck the anchor and copy its identities into the journal; never stamp current environment values onto an existing asset. Execution requires the journal, anchor and provider bindings to agree. The application cannot update or delete the anchor, and configuration changes cannot reassign existing assets.

First adoption of historical data requires operator-reviewed pairing evidence, not a basename match, a copied marker or the mere presence/absence of a target. Ambiguous or mixed historical roots remain unadopted. Approved relocation preserves the logical identities only after stopped executors, verified copying of the same storage set and a controlled cutover; restoration requires a matched database/media recovery procedure. Neither operation silently rebinds assets or rewrites journals. The specification defines these gates.

A valid marker above a mount does not establish that the mounted media directory is available. Cached marker reads alone do not prove that a NAS is reachable.

Runtime validation compares the database anchor, journal, configuration and provider-observed binding. Missing or unverifiable storage must never be treated as successful file absence. Do not impose a universal same-device-number requirement on explicitly adopted locations.

Adoption and restoration are explicit operator procedures. Physical identity establishes continuity after adoption, not the correctness of the original historical pairing. Relocation/restoration onto changed physical locations requires controlled marker re-establishment after pairing verification, while preserving database logical identities and journal targets. Normal startup never creates, upgrades or repairs markers, rewrites paths or adopts an unfamiliar disk. Identity comparison assumes an operator-controlled namespace and does not defeat malicious concurrent host mutation. Privileged deliberate cloning/tampering remains outside the application threat boundary; an undetectable physical clone preserving all observed identities cannot be distinguished by this mechanism.

### Strict completion

Deletion is completed only when:

1. Both exact targets are removed or authoritatively confirmed absent on the intended bindings.
2. Both locations satisfy the certified removal-durability contract.
3. Completion is committed to PostgreSQL by the current execution token.

Unsupported durability, disconnected storage and unknown filesystem outcomes leave the journal pending. New acceptance fails closed when required capabilities or bindings are known to be unavailable. No weaker namespace-only completion fallback is included.

Completion does not mean:

- Secure erasure.
- Removal from backups or client caches.
- Removal of unknown temporary files or additional hard links.
- Termination of streams already opened.
- Protection against faulty hardware or an untrusted host administrator.

### Authorization and concurrent activity

Every HTTP operation remains owner-scoped. State-changing commands revalidate account/session state and expiry after acquiring their transaction locks. Lifecycle versions prevent stale Trash, Restore and deletion requests.

- Restore winning first invalidates a stale deletion request.
- Acceptance winning first prevents Restore.
- Revocation winning authorization locks prevents new acceptance.
- Revocation after acceptance does not cancel committed deletion.
- Retry/status endpoints remain restricted to the current authorized owner.
- Future workers execute already committed authority without creating synthetic user sessions.
- Already-started media streams may finish.

User/session locks are never held throughout filesystem work.

### M12 and M13 boundary

**M12 provides:** keyset pagination; Trash/Restore; owner-only Trash previews; durable manual deletion; status and explicit retry; storage-provider integration and applicable compatibility certification.

**M13 provides:** Redis/BullMQ; scheduled expiry under a separately approved retention policy; automatic retry of accepted operations; integrity scanning and report-first orphan handling; retry monitoring and failed-job recovery.

M13 must reuse M12's journal, acceptance invariants and executor. A queue message is a reference to committed authority, not independent permission to delete a path. Redis loss must not erase PostgreSQL deletion authority.

Automatic Trash expiry and safe background maintenance remain requirements before first-alpha approval. Thirty days is provisional, not an adopted M12 retention rule.

## Alternatives and rationale

| Alternative                                 | Assessment                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Delete files before committing intent       | Rejected: rollback could retain metadata after destroying media                          |
| Remove metadata without a journal           | Rejected: loses authoritative recovery information                                       |
| Retain an asset row in a deleting state     | Viable, but requires every asset query to exclude irreversible deletion correctly        |
| Hold database locks across filesystem calls | Rejected as the general design: slow storage can monopolize transactions and connections |
| Uncoordinated duplicate execution           | Potentially safe for immutable targets, but wastes resources and complicates diagnostics |
| Short claims with idempotent execution      | Preferred: limits normal overlap without depending on long database locks                |
| Introduce workers in M12                    | Unnecessary for durable acceptance and manual recovery; remains M13 scope                |

## Immich comparison

The reference inspection used Immich commit `256eb55dbe92ac77e02794442f9487e88ffed2b1`; these are observations of that pinned source, not claims about every later version or results of running Immich crash tests.

Its observed flow stores Trash/deleted state in asset rows, queues asset-deletion work, removes the asset record and then queues file deletion. Individual file-unlink errors are logged while that file handler returns success. This creates a database-removal-to-job-submission recovery gap and does not make every unlink failure a failed job. See the [asset service](https://github.com/immich-app/immich/blob/256eb55dbe92ac77e02794442f9487e88ffed2b1/server/src/services/asset.service.ts#L278-L384) and [storage service](https://github.com/immich-app/immich/blob/256eb55dbe92ac77e02794442f9487e88ffed2b1/server/src/services/storage.service.ts#L137-L155).

Immich also has surviving asset audit records, scheduled enumeration and persistent integrity reports. These provide recovery tooling, but the inspected audit record does not retain a complete deletion target manifest or completion protocol. See the [audit schema](https://github.com/immich-app/immich/blob/256eb55dbe92ac77e02794442f9487e88ffed2b1/server/src/schema/tables/asset-audit.table.ts), [scheduled enumeration](https://github.com/immich-app/immich/blob/256eb55dbe92ac77e02794442f9487e88ffed2b1/server/src/services/queue.service.ts#L270-L281) and [integrity service](https://github.com/immich-app/immich/blob/256eb55dbe92ac77e02794442f9487e88ffed2b1/server/src/services/integrity.service.ts#L220-L314). Its [mount markers](https://github.com/immich-app/immich/blob/256eb55dbe92ac77e02794442f9487e88ffed2b1/server/src/services/storage.service.ts#L157-L197) check storage-folder access; they are not deletion-intent-bound storage identities.

No equivalent persistent file-deletion intent/completion journal was found in the inspected deletion flow and related schema. This is a bounded source-review finding, not a claim that Immich has no recovery mechanisms.

Saefr's journal is chosen for explicit per-operation recovery without workers. It costs additional database writes, retained records and concurrency logic. Immich already has broader background and integrity infrastructure. This is a difference in guarantees and scope, not a claim of general superiority.

## Portability and certification — approved Option B direction

Architectural compatibility is broader than verified support.

A profile identifies the provider implementation, runtime, OS, filesystem, mount/server configuration and tested guarantees. Unsupported or unverified destructive capabilities fail closed.

M12's minimum certification work package is **one verified local storage profile**, with Linux/ext4 the recommended first candidate. That candidate is not yet certified. If a narrower profile is required, it must be recorded and verified at the implementation gate, not declared a permanent product limitation.

Linux, Windows and macOS remain first-class architectural targets. Additional Windows/NTFS, macOS/APFS, external-disk and SMB/NFS/NAS profiles require their own implementation or conformance evidence before support is advertised. Their native certification is **not a blanket condition for M12 completion**.

Filesystem probes cannot prove power-loss durability. Certification distinguishes tested behavior, documented platform guarantees and remaining assumptions. There is no universal-filesystem compatibility claim.

## Future compatibility

- Ownership, sharing, library presentation and retention remain separate.
- Future Family Space preservation obligations must be checked before deletion acceptance.
- An accepted irreversible deletion cannot later become restorable through a sharing feature.
- Gallery cursors are not a mobile synchronization protocol.
- Journal retention does not establish a complete client tombstone/change-feed contract.
- Capture time and upload `created_at` remain distinct.
- New storage layouts require explicit version handling; old journal targets must never be silently reinterpreted.

## Consequences and limitations

The design preserves deletion authority across crashes and permits explicit recovery from partial removal. It does not guarantee eventual completion during M12 without another request.

Storage portability is a separately reviewed work package covering uploads and reads as well as deletion. A thin wrapper around existing filesystem calls is insufficient. OS calls may remain blocked after request cancellation, but must not retain PostgreSQL transactions or connections.

Backup restoration must stop all executors and reconcile database and media state before deletion resumes. Claims alone cannot fence stale remote I/O. Unknown upload orphans and unidentified hard links remain outside this deletion protocol.

Completed-journal retention after M12, future sharing preservation policy and later mobile sync semantics require separate decisions. The proposed roadmap adjustment is described in the specification; the existing roadmap is not silently changed.

## Approval boundary

This ADR and its linked M12 specification are accepted/approved architecture contracts. That approval does not authorize M12B implementation, storage adoption, real-data migration, deployment, Git publication or changes to production or the `main` branch.
