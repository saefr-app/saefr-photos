# ML lifecycle, privacy and versioned re-indexing

Date: 18 October 2026. Branch: `codex/ml-lifecycle`. The user approved finishing
the remaining core modules as one batch; tested module dependencies are combined
on the local `codex/ml-suite`, not on shared integration/main.

Implemented the scoped coordinator HTTP API, hashed capability credentials,
request-time permission rechecks, trash/delete/restore and scope moves, ML
disable/re-enable, physical source-cache cleanup, job-payload scrubbing and
versioned model re-index/activation/pruning. A replacement model cannot become
active before complete eligible coverage; old image/query identity stays paired
until activation. Deletion and result publication compare state inside one
SQLite transaction. Permanent deletion leaves a minimal monotonic tombstone and
does not permit UUID reuse. Disabling ML purges derived vectors and managed
source copies; re-enable requires source resupply.

A UUID/expiry-based API lease fences stale writers inside transactions and
survives reused container PIDs. One API mutation is admitted at a time; worker
processes use independent SQLite connections and BullMQ locks. Missing input
cache is surfaced for safe resupply rather than leaving an unrecoverable hidden
pointer. Recognized orphan copies are reconciled without visiting originals.

Validation: 22 coordinator tests pass on the host. They include HTTP scope
isolation, permissions revoked during inference, physical cache deletion,
source repair, database-connection deletion races, stale writers, out-of-order
events, restore, scope moves, incomplete model activation and retry semantics.
An earlier 21-test snapshot also passed in the Linux resource-limited image;
the final combined integration verification records the updated totals.

The local index is application-owned derived state, not the canonical asset DB.
Logical deletion does not promise forensic secure erasure of disk blocks,
SQLite journals or backups. Private backups need explicit retention and an
authoritative lifecycle reconciliation before restored indexes are exposed.
No face identification, inferred sensitive attributes or automatic deletion is
performed. End-user account/session integration remains backend-owned.
