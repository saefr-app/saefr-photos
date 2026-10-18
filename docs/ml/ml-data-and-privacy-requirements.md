# ML data and privacy requirements — draft

These are proposed acceptance requirements for a future service integration.
The current module supplies schemas and tests only; it implements none of the
authentication, database, container or cleanup mechanisms described below.

## Data access and retention

| Data | Responsible component | Proposed handling |
| --- | --- | --- |
| Original media and authoritative metadata | Backend/storage | ML cannot mutate it; worker reads only after current eligibility checks |
| Image payloads | Worker and ML memory | Bounded transient request data; no persistent media cache or library mount |
| Text queries and query vectors | Backend and ML memory | Ephemeral by default, no raw query logging; query results authorized by backend |
| Image embeddings and job state | Backend-owned derived storage | Scoped like source assets; deletion/generation/model-aware lifecycle |
| Model files | Local model registry | Verified immutable revision, hashes/licenses/notices retained separately |
| Diagnostics | Service/worker | Allowlisted code, timing and correlation UUID only; no request bodies, paths, credentials or vectors |

Embeddings are sensitive derived user data, even when originals are absent.
Apply access controls, backup handling and deletion policies to vector stores,
index snapshots and diagnostics as well as photographs. Crash dumps, swapping,
temporary multipart files and backups can extend retention; the deployable
candidate must document and test those platform-specific behaviors before
promising memory-only handling. This draft does not guarantee secure erasure.

## Boundaries to verify

1. Public clients cannot invoke internal inference or claim a scope merely by
   sending its UUID. Authenticate worker calls; live authorization stays in the
   backend. Internal networking does not substitute for authorization.
2. Deny arbitrary input URLs/paths. No inference egress to third-party APIs, model
   telemetry or runtime downloads. Model installation is a separate operation.
3. Restrict image bytes/pixels and text size before expensive processing. Limit
   concurrency, time, temporary disk and process memory. Return overload errors
   instead of allowing unbounded waiting requests.
4. Reject stale results after trash/delete/restore, content change, model change,
   or scope change. Compare-and-set publication must be atomic with the current
   lifecycle state. Cancelled jobs do not prove in-flight data was discarded.
5. Query current authorization when retrieving similar photos; no cross-scope
   results, score leaks or shared embedding caches without an explicit policy.
   Do not assume server-wide blob deduplication approves cross-user ML reuse.
6. ML disable prevents new work and publication. Purge existing vectors and
   index entries per an explicit retention policy; re-enable requires a new
   generation/re-index. State the scope of any retained backup copies.
7. Propagate deletion to derived rows, indexes and caches. Use reliable outbox
   delivery plus reconciliation; monotonic generations prevent reordered events
   from invalidating newly restored/re-indexed assets.

## Privacy acceptance scenarios for later integration tests

- User A cannot retrieve, rank or infer existence of user B's private photo.
- Delete while inference runs: neither the late response nor a retry recreates
  a searchable entry.
- Restore after delete: old result/event cannot overwrite/remove the new entry.
- Disable ML while a batch is pending: the worker skips it; queued work and late
  results cannot silently re-enable indexing.
- Move asset between scopes or revoke access while querying: current backend
  permissions govern results regardless of old embeddings or event delays.
- Restart or miss an event: reconciliation repairs derived state without bulk
  deleting source media. Backups have documented retention/restore behavior.
- Model upgrade: active image/text namespaces stay compatible until a deliberate
  switch; failed upgrades leave the previous supported search available.
- Logs, exception responses, metrics labels and issue reports contain no raw
  photos, queries, embeddings, private paths or credentials.

Current unit tests cover wire validation and pure stale-result comparisons.
They do not prove these end-to-end privacy or lifecycle properties.
